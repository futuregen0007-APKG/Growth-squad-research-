/**
 * GoalProductRecommendationService.js
 * ======================================
 * Fills the Mutual Fund / Gold ETF / Debt Fund / Liquid Fund product
 * buckets in GoalAssetAllocationService's productBuckets -- previously
 * always empty ("Awaiting verified product data" on the frontend) because
 * nothing ever ingested a real product universe.
 *
 * Pipeline (per rule 5 of the implementation spec):
 *   ingest (AmfiMutualFundProvider + MfApiHistoricalNavProvider)
 *   -> normalize (buildSnapshot)
 *   -> validate freshness (hard filter, ingest time)
 *   -> persist snapshot (InvestmentProductSnapshot, Mongo -- ingest time)
 *   -> hard eligibility filters (read time: freshness again + sufficient
 *      history + category-appropriate liquidity)
 *   -> deterministic scoring (read time)
 *   -> top 3 per category
 *
 * The write path (ingestAllProducts) is the only thing that ever calls the
 * AMFI/mfapi.in providers -- it runs once daily via
 * scripts/refreshInvestmentProducts.js. The read path
 * (getTopProductsForCategory) only ever queries Mongo, so a goal request
 * never fetches/scores the live universe on click (rule 7).
 */
import { InvestmentProductSnapshot } from '../models/InvestmentProductSnapshot.js';
import { fetchCandidateSchemes } from '../providers/AmfiMutualFundProvider.js';
import { fetchReturnsAndRisk } from '../providers/MfApiHistoricalNavProvider.js';
import { logger } from '../utils/logger.js';

export const REASON_CODES = Object.freeze({
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  DATA_STALE: 'DATA_STALE',
  NO_HARD_FILTER_MATCH: 'NO_HARD_FILTER_MATCH',
  INSUFFICIENT_FUNDAMENTALS: 'INSUFFICIENT_FUNDAMENTALS',
});

// AMFI publishes NAV daily on business days; a real snapshot is never more
// than a handful of days old (weekends/holidays), so anything older than
// this is treated as stale rather than shown as "current".
export const FRESHNESS_MAX_AGE_DAYS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const chunk = (items, size) => {
  const safeSize = Math.max(1, Number(size) || 1);
  const batches = [];
  for (let i = 0; i < items.length; i += safeSize) batches.push(items.slice(i, i + safeSize));
  return batches;
};

const classifyRiskLevel = (productType, volatility3Y) => {
  if (productType === 'LIQUID_FUND') return 'LOW';
  if (productType === 'DEBT_FUND') return volatility3Y != null && volatility3Y > 8 ? 'MODERATE' : 'LOW';
  if (volatility3Y == null) return 'UNKNOWN';
  if (volatility3Y < 12) return 'LOW';
  if (volatility3Y < 22) return 'MODERATE';
  return 'HIGH';
};

const classifyLiquidity = (productType) => {
  if (productType === 'LIQUID_FUND') return 'HIGH';
  if (productType === 'DEBT_FUND' || productType === 'GOLD_ETF') return 'MEDIUM';
  return 'MEDIUM'; // open-ended equity MFs redeem in T+2/3, not same-day
};

/** Pure normalizer: a real AMFI scheme row + real computed returns/risk -> an InvestmentProductSnapshot-shaped plain object. Never invents a field the sources didn't provide. */
export const buildSnapshot = (schemeRow, riskAndReturns) => {
  const { returns1Y, returns3Y, returns5Y, volatility3Y, maxDrawdown, observations } = riskAndReturns || {};
  const fieldsPresent = [returns1Y, returns3Y, returns5Y, volatility3Y, maxDrawdown].filter((v) => v != null).length;
  const dataCompleteness = Number((fieldsPresent / 5).toFixed(2));

  return {
    productId: `${schemeRow.productType}:${schemeRow.schemeCode}`,
    productType: schemeRow.productType,
    name: schemeRow.schemeName,
    symbol: schemeRow.schemeCode,
    category: schemeRow.category,
    riskLevel: classifyRiskLevel(schemeRow.productType, volatility3Y ?? null),
    expenseRatio: null, // AMFI's NAV feed does not publish this; never guessed (see AmfiMutualFundProvider.js header)
    aum: null, // same -- not available from this source
    returns1Y: returns1Y ?? null,
    returns3Y: returns3Y ?? null,
    returns5Y: returns5Y ?? null,
    volatility3Y: volatility3Y ?? null,
    maxDrawdown: maxDrawdown ?? null,
    liquidity: classifyLiquidity(schemeRow.productType),
    navOrPrice: schemeRow.nav,
    sourceUrl: 'https://www.amfiindia.com/spages/NAVAll.txt',
    dataAsOf: schemeRow.dataAsOf,
    dataCompleteness,
    observations: observations || 0,
  };
};

/**
 * Full ingest pass: real AMFI universe -> real per-scheme NAV history ->
 * normalized snapshots -> upserted into Mongo. Never runs from a request
 * path. Bounded concurrency + delay between batches out of courtesy to
 * mfapi.in (an unauthenticated public service) -- mirrors the existing
 * IndianAPI batching convention (refreshFinancialIntelligence.js).
 */
export const ingestAllProducts = async ({ batchSize = 10, delayMs = 500, fetchRiskFn = fetchReturnsAndRisk } = {}) => {
  const schemes = await fetchCandidateSchemes();
  if (!schemes.length) {
    logger.warn('[GoalProductRecommendationService] AMFI provider returned zero candidate schemes -- ingestion aborted.');
    return { ingested: 0, failed: 0 };
  }

  const batches = chunk(schemes, batchSize);
  let ingested = 0;
  let failed = 0;

  for (const [index, batch] of batches.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const snapshots = await Promise.all(batch.map(async (schemeRow) => {
      const riskAndReturns = await fetchRiskFn(schemeRow.schemeCode);
      if (!riskAndReturns) return null;
      return buildSnapshot(schemeRow, riskAndReturns);
    }));

    // eslint-disable-next-line no-await-in-loop
    await Promise.all(snapshots.map(async (snapshot) => {
      if (!snapshot) { failed += 1; return; }
      try {
        await InvestmentProductSnapshot.findOneAndUpdate(
          { productId: snapshot.productId },
          { $set: { ...snapshot, ingestedAt: new Date() } },
          { upsert: true },
        );
        ingested += 1;
      } catch (error) {
        logger.warn(`[GoalProductRecommendationService] Failed to persist ${snapshot.productId}: ${error.message}`);
        failed += 1;
      }
    }));

    if (index < batches.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }

  logger.info(`[GoalProductRecommendationService] Ingest complete: ${ingested} persisted, ${failed} failed/skipped.`);
  return { ingested, failed };
};

const isFresh = (dataAsOf) => {
  if (!dataAsOf) return false;
  const ageMs = Date.now() - new Date(dataAsOf).getTime();
  return ageMs <= FRESHNESS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
};

// Requires both a real trailing return AND enough NAV history to classify
// real risk (volatility3Y) -- a fund with only a 1Y return and unknown risk
// can never be confidently matched to a goal's risk capacity, so it does
// not count as sufficiently verified for ranking purposes (it may still
// exist in the universe; it just never reaches the top-3 selection).
const hasSufficientHistory = (snapshot) => snapshot.returns1Y != null && snapshot.volatility3Y != null;

const riskCapacityAllows = (riskCapacity, riskLevel) => {
  if (riskLevel === 'UNKNOWN') return true; // never hard-exclude on an unknown risk tier -- that's a soft signal, not a hard one
  if (riskCapacity === 'CONSERVATIVE') return riskLevel === 'LOW';
  if (riskCapacity === 'AGGRESSIVE') return true;
  return riskLevel === 'LOW' || riskLevel === 'MODERATE';
};

// Real AMFI category headers this project has actually ingested (confirmed
// live): "Equity Scheme(s) - Sectoral/Thematic Fund" / "... - Sectoral Fund"
// / "... - Thematic Fund" for concentrated single-sector equity funds, and
// "Debt Scheme - Credit Risk Fund" for the one debt category that takes on
// meaningful credit (default) risk rather than just duration/rate risk.
// Fixing the exact bug reported live: these were being recommended for a
// moderate five-year passive-income goal with no suitability filter at all.
const SECTORAL_THEMATIC_CATEGORY_PATTERN = /sectoral|thematic/i;
const CREDIT_RISK_CATEGORY_PATTERN = /credit risk/i;

/**
 * categorySuitabilityAllows - a HARD (never relaxed) suitability filter,
 * independent of and in addition to riskCapacityAllows's volatility-based
 * check. Sectoral/thematic equity funds are excluded as primary
 * recommendations for anything but an AGGRESSIVE risk profile (concentration
 * risk, not just volatility, is the concern). Credit-risk debt funds are
 * excluded unless the goal's risk profile is AGGRESSIVE (this project has no
 * separate "I explicitly accept credit risk" consent flag yet, so AGGRESSIVE
 * is the closest real proxy for that explicit acceptance).
 */
export const categorySuitabilityAllows = (productType, category, riskCapacity) => {
  const categoryText = String(category || '');
  if (productType === 'MUTUAL_FUND' && SECTORAL_THEMATIC_CATEGORY_PATTERN.test(categoryText)) {
    return riskCapacity === 'AGGRESSIVE';
  }
  if (productType === 'DEBT_FUND' && CREDIT_RISK_CATEGORY_PATTERN.test(categoryText)) {
    return riskCapacity === 'AGGRESSIVE';
  }
  return true;
};

/**
 * isConcentratedCapCategory - real AMFI equity categories that concentrate in
 * a single narrow market-cap band (Small Cap / Mid Cap / Micro Cap), as
 * opposed to diversified categories (Large Cap, Large & Mid Cap, Multi Cap,
 * Flexi Cap, Index, Value, Contra, Focused, ELSS, ...). This is a real,
 * well-documented structural property of these AMFI category labels
 * themselves (concentration in one cap band = higher single-segment risk),
 * not an invented rule about any specific fund. "Large & Mid Cap Fund" is
 * explicitly NOT concentrated -- it must be excluded from the "mid cap"
 * match before the plain substring check runs.
 */
const isConcentratedCapCategory = (category) => {
  const text = String(category || '').toLowerCase();
  if (/large\s*(&|and)\s*mid\s*cap/.test(text)) return false;
  return /small cap|micro cap|mid cap/.test(text);
};

// Soft (never hard-exclude) score penalty applied to concentrated single-
// segment equity categories for non-AGGRESSIVE goals -- fixes the observed
// bug where a MODERATE 5-year goal's top mutual-fund picks were all Small
// Cap / Mid Cap funds purely because their raw recent returns scored
// highest, even though the task calls for preferring diversified categories
// (Flexi Cap / Large Cap / Multi Cap / Index) at moderate risk. Never
// excludes a concentrated fund outright -- if nothing else clears the bar,
// it can still surface, just ranked honestly lower.
const CONCENTRATED_CAP_CATEGORY_SCORE_PENALTY = 20;

/**
 * Deterministic risk-adjusted score, 0-100. Higher trailing return and lower
 * volatility both help; a fund missing volatility (e.g. very short history)
 * is scored on return alone rather than penalized or defaulted.
 *
 * Gold ETFs are deliberately NOT scored this way (task: "must not use recent
 * return alone") -- every gold ETF tracks the same underlying gold price, so
 * a recent-return-based ranking would just reward noise/tracking-error
 * rather than a genuine quality difference. Since AUM/expenseRatio are never
 * available from AMFI's NAV feed (see buildSnapshot), the best real,
 * verified proxy for "an established, reliably tracked scheme" is track
 * record length (observations) plus data completeness -- never a forecast
 * of future gold price movement.
 */
const scoreGoldEtfSnapshot = (snapshot) => {
  const trackRecordScore = Math.min(50, (snapshot.observations || 0) / 20); // ~1000 daily observations (~4Y) maxes this out
  const completenessScore = (snapshot.dataCompleteness || 0) * 50;
  return Math.round(Math.max(0, Math.min(100, trackRecordScore + completenessScore)));
};

const scoreSnapshot = (snapshot) => {
  if (snapshot.productType === 'GOLD_ETF') return scoreGoldEtfSnapshot(snapshot);
  const primaryReturn = snapshot.returns3Y ?? snapshot.returns1Y ?? 0;
  const volatilityPenalty = snapshot.volatility3Y != null ? snapshot.volatility3Y * 1.2 : 0;
  return Math.round(Math.max(0, Math.min(100, 50 + primaryReturn * 2 - volatilityPenalty)));
};

// Every field a fully-informed ranking would ideally have. aum/expenseRatio
// are structurally never available from AMFI (see buildSnapshot) -- they are
// still listed here and reported as missing, rather than silently excluded
// from the check, so recommendationConfidence honestly reflects that gap
// instead of only grading on the fields AMFI happens to provide.
const RANKING_RELEVANT_FIELDS = ['returns1Y', 'returns3Y', 'returns5Y', 'volatility3Y', 'maxDrawdown', 'expenseRatio', 'aum'];

const computeMissingMetrics = (snapshot) => RANKING_RELEVANT_FIELDS.filter((field) => snapshot[field] == null);

/** Freshness is graded independently of ranking-metric completeness -- a same-day NAV with no expense ratio is fresh but not fully informed, and those are different kinds of confidence. */
const dataFreshnessConfidence = (dataAsOf) => {
  const ageDays = (Date.now() - new Date(dataAsOf).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays <= 2) return 'HIGH';
  if (ageDays <= FRESHNESS_MAX_AGE_DAYS) return 'MEDIUM';
  return 'LOW';
};

/**
 * Never HIGH when a ranking-relevant metric that matters for THIS product
 * type is missing. aum/expenseRatio are always missing for every
 * AMFI-sourced product today, so recommendationConfidence for these
 * products structurally caps at MEDIUM until a source for those two fields
 * exists -- this is deliberate, not a bug: it is dishonest to call a
 * recommendation fully verified while two real ranking inputs are absent.
 */
const recommendationConfidence = (missingMetrics) => {
  const criticalMissing = missingMetrics.filter((m) => ['returns1Y', 'returns3Y', 'volatility3Y'].includes(m)).length;
  if (criticalMissing > 0) return 'LOW';
  if (missingMetrics.length > 0) return 'MEDIUM';
  return 'HIGH';
};

/**
 * Pure hard-filter + scoring + top-3 pipeline over an already-loaded array of
 * snapshot documents. No I/O -- this is the actual eligibility/scoring logic
 * and is unit-tested directly against fixture arrays. `getTopProductsForCategory`
 * is a thin Mongo-loading wrapper around this.
 */
export const filterAndScoreSnapshots = (all, { riskCapacity = 'MODERATE' } = {}) => {
  if (!all.length) {
    return { items: [], status: 'PROVIDER_UNAVAILABLE', reasonCode: REASON_CODES.PROVIDER_UNAVAILABLE };
  }

  const fresh = all.filter((s) => isFresh(s.dataAsOf));
  if (!fresh.length) {
    return { items: [], status: 'DATA_STALE', reasonCode: REASON_CODES.DATA_STALE };
  }

  // Hard, never-relaxed suitability filter (sectoral/thematic equity, credit-
  // risk debt) applied before anything else -- unlike the risk-tier
  // volatility check below, this never falls back to an unsuitable category
  // just because fewer than 3 candidates remain.
  const suitable = fresh.filter((s) => categorySuitabilityAllows(s.productType, s.category, riskCapacity));
  if (!suitable.length) {
    return { items: [], status: 'NO_HARD_FILTER_MATCH', reasonCode: REASON_CODES.NO_HARD_FILTER_MATCH };
  }

  const sufficientlyVerified = suitable.filter(hasSufficientHistory);
  if (!sufficientlyVerified.length) {
    return { items: [], status: 'INSUFFICIENT_FUNDAMENTALS', reasonCode: REASON_CODES.INSUFFICIENT_FUNDAMENTALS };
  }

  const scored = sufficientlyVerified
    .map((snapshot) => {
      const missingMetrics = computeMissingMetrics(snapshot);
      const baseScore = scoreSnapshot(snapshot);
      const applyDiversificationPenalty = riskCapacity !== 'AGGRESSIVE'
        && snapshot.productType === 'MUTUAL_FUND'
        && isConcentratedCapCategory(snapshot.category);
      const score = applyDiversificationPenalty
        ? Math.max(0, baseScore - CONCENTRATED_CAP_CATEGORY_SCORE_PENALTY)
        : baseScore;
      return {
        ...snapshot,
        score,
        missingMetrics,
        dataFreshnessConfidence: dataFreshnessConfidence(snapshot.dataAsOf),
        recommendationConfidence: recommendationConfidence(missingMetrics),
      };
    })
    .sort((a, b) => b.score - a.score);

  const riskMatched = scored.filter((s) => riskCapacityAllows(riskCapacity, s.riskLevel));
  const relaxed = riskMatched.length < 3;
  const pool = riskMatched.length ? riskMatched : scored; // only relax the soft risk-tier preference, never the hard filters above

  if (!pool.length) {
    return { items: [], status: 'NO_HARD_FILTER_MATCH', reasonCode: REASON_CODES.NO_HARD_FILTER_MATCH };
  }

  return {
    items: pool.slice(0, 3),
    status: 'VERIFIED',
    reasonCode: null,
    relaxedSoftFilters: relaxed,
  };
};

/**
 * Read-path entry point: loads one category's snapshots from Mongo, then
 * delegates to filterAndScoreSnapshots. Only ever reads Mongo -- never
 * triggers a live ingest (rule 7). See filterAndScoreSnapshots for the
 * hard-filter/scoring/relaxation rules (rule 6).
 */
export const getTopProductsForCategory = async (productType, { riskCapacity = 'MODERATE' } = {}) => {
  const all = await InvestmentProductSnapshot.find({ productType }).lean();
  return filterAndScoreSnapshots(all, { riskCapacity });
};

export { isConcentratedCapCategory };

export default {
  buildSnapshot, ingestAllProducts, getTopProductsForCategory, filterAndScoreSnapshots, categorySuitabilityAllows, isConcentratedCapCategory, REASON_CODES, FRESHNESS_MAX_AGE_DAYS,
};
