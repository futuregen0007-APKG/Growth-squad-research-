/**
 * storedFundamentals.js
 * ========================
 * Phase 6A: the fallback that turns "temporarily unavailable" into a real,
 * sourced answer when the live provider cannot serve one.
 *
 * WHY THIS EXISTS — measured, not assumed. The Phase 6A baseline ran the
 * five mandatory queries through the real graph with real providers. All
 * five abstained with "temporarily unavailable", because
 * `getCompanyFinancials`/`getCompanyResearch` reach ONLY the live provider
 * (IndianAPI), which was rate-limited. Meanwhile MongoDB already held, for
 * those same companies, thousands of VERIFIED, source-linked facts
 * (`CompanyHistoricalFact`, dataOrigin REAL_RESEARCH) and real
 * NSE-bhavcopy-derived market metrics (`StockHistoricalMetricsSnapshot`).
 * The data was there; nothing in the chat path ever looked at it.
 *
 * WHAT THIS IS NOT. It does not compute, infer, average, or extrapolate a
 * single figure. Every number it returns was extracted from a real filing,
 * stored with its own period, unit, and source URL, and marked verified.
 * Where a metric does not exist for a company, this returns nothing for it
 * — it never substitutes a peer's number, a sector average, or a derived
 * estimate.
 *
 * DELIBERATELY NOT USED: `StockFundamentalsSnapshot`'s derived growth
 * fields. The baseline audit found them to be unusable — HDFCBANK
 * revenueGrowth -81.94%, INFY -70.19%, BHEL +13782.9% — because they are
 * CAGRs computed across sparse, mismatched periods. Surfacing those would
 * be fabrication by derivation, so this module reads the underlying
 * per-period FACTS instead and lets the reader see the periods.
 */
import mongoose from 'mongoose';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import StockHistoricalMetricsSnapshot from '../models/StockHistoricalMetricsSnapshot.js';
import CompanyResearchProfile from '../models/CompanyResearchProfile.js';
import { logger } from '../utils/logger.js';
import { screenFact, FACT_VERDICTS } from './factQuarantine.js';

/** Why a figure is missing. The distinction the baseline conflated into "temporarily unavailable". */
export const UNAVAILABLE_REASONS = Object.freeze({
  PROVIDER_RATE_LIMITED: 'the live data provider is rate-limited right now',
  PROVIDER_UNAVAILABLE: 'the live data provider could not be reached',
  NOT_COLLECTED: 'no verified filing data has been collected for this company yet',
  METRIC_NOT_REPORTED: 'this metric is not reported in the filings held for this company',
});

/**
 * Sector classification, used ONLY to decide which metrics are meaningful
 * to show — never to invent a value. A bank's "operating margin" is not a
 * meaningful figure, and the baseline's fundamentals model stored it as
 * null for every bank while still framing comparisons around it.
 */
export const SECTOR_KINDS = Object.freeze({ BANKING: 'BANKING', GENERAL: 'GENERAL' });

const BANKING_SECTOR_PATTERN = /\b(bank|banking|financial services|nbfc|finance)\b/i;
const BANKING_SYMBOL_HINTS = new Set([
  'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK', 'BANKBARODA', 'PNB', 'FEDERALBNK', 'IDFCFIRSTB',
]);

/**
 * The metrics that actually describe each kind of company. For a bank this
 * is net interest margin, asset quality, and returns — NOT the
 * manufacturing/services operating-margin frame the baseline applied to
 * every symbol alike.
 */
export const SECTOR_METRICS = Object.freeze({
  BANKING: Object.freeze({
    primary: ['NIM', 'ROA', 'ROE', 'GNPA', 'NNPA'],
    supporting: ['PAT', 'REVENUE', 'DEPOSITS', 'LOAN_PORTFOLIO', 'CASA', 'EPS'],
    // Named explicitly so an answer can say why it is NOT showing them.
    notMeaningful: ['OPERATING_MARGIN', 'EBITDA_MARGIN', 'EBITDA'],
    marginLabel: 'net interest margin (NIM)',
  }),
  GENERAL: Object.freeze({
    primary: ['OPERATING_MARGIN', 'EBITDA_MARGIN', 'REVENUE', 'PAT'],
    supporting: ['EBITDA', 'EPS', 'ORDER_BOOK', 'CAPEX', 'ROE', 'DEBT'],
    notMeaningful: [],
    marginLabel: 'operating margin',
  }),
});

/**
 * Unit/range contract per metric — the guard that stops a stored fact from
 * being displayed as something it is not.
 *
 * FOUND IN THE BASELINE AUDIT: the stored corpus contains genuine
 * extraction mistakes where the metric label and the unit disagree — TCS
 * "OPERATING_MARGIN" = 65799 INR_CRORE (an absolute figure, not a margin),
 * INFY "REVENUE" = 4.4 PERCENTAGE (a growth rate, not revenue), TCS "EPS" =
 * 11.2 PERCENTAGE. Every one of those would read as an authoritative,
 * sourced number while being flatly wrong.
 *
 * A fact is shown only when its unit and magnitude are consistent with what
 * the metric means. A fact that fails is DROPPED and counted, never
 * corrected or guessed at — the honest outcome is "not reported", not a
 * repaired number we invented.
 */
// Metrics where only a LEVEL is meaningful to report.
const LEVEL_ONLY_METRICS = new Set(['NIM', 'ROA', 'ROE', 'GNPA', 'NNPA', 'CASA', 'OPERATING_MARGIN', 'EBITDA_MARGIN']);

const PERCENTAGE_UNITS = new Set(['PERCENTAGE', 'PERCENT', 'PCT', '%']);
const MAGNITUDE_UNITS = new Set(['INR_CRORE', 'INR_LAKH', 'INR_MILLION', 'INR_BILLION', 'USD_MILLION', 'USD_BILLION', 'INR']);

const METRIC_CONTRACTS = Object.freeze({
  NIM: { kind: 'PERCENTAGE', min: 0, max: 15 },
  ROA: { kind: 'PERCENTAGE', min: -10, max: 10 },
  ROE: { kind: 'PERCENTAGE', min: -100, max: 100 },
  GNPA: { kind: 'PERCENTAGE', min: 0, max: 30 },
  NNPA: { kind: 'PERCENTAGE', min: 0, max: 30 },
  CASA: { kind: 'PERCENTAGE', min: 0, max: 100 },
  OPERATING_MARGIN: { kind: 'PERCENTAGE', min: -100, max: 100 },
  EBITDA_MARGIN: { kind: 'PERCENTAGE', min: -100, max: 100 },
  REVENUE: { kind: 'MAGNITUDE' },
  PAT: { kind: 'MAGNITUDE' },
  EBITDA: { kind: 'MAGNITUDE' },
  DEPOSITS: { kind: 'MAGNITUDE' },
  LOAN_PORTFOLIO: { kind: 'MAGNITUDE' },
  DEBT: { kind: 'MAGNITUDE' },
  ORDER_BOOK: { kind: 'MAGNITUDE' },
  CAPEX: { kind: 'MAGNITUDE' },
  // EPS is a per-share currency amount. A percentage means a growth rate
  // was captured under the wrong label; a CRORE/MILLION magnitude means an
  // absolute total was - "EPS 29.64 Cr" is not a thing. Only a plain
  // per-share currency unit is accepted.
  EPS: { kind: 'PER_SHARE' },
});

/**
 * Titles that describe a MOVEMENT in a metric rather than its level. A
 * "change in", "impact on", or "bps" figure is a delta: real, but not the
 * value of the metric, and catastrophic if shown as one. INFY's stored
 * "Impact on Operating Margin from Acquisitions" = 0.7% would otherwise be
 * displayed as INFY's operating margin next to TCS's genuine 24.5%.
 */
const DELTA_TITLE_PATTERN = /\b(impact|change|movement|expansion|contraction|improvement|decline|increase|decrease|drop|rise|growth)\b.{0,24}\b(in|on|of|from)\b|\bbps\b|\bbasis points?\b|\byo-?y\b|\bq-?o-?q\b/i;

/** True when a stored fact's own title says it is a delta, not a level. */
export const isDeltaFact = (title) => DELTA_TITLE_PATTERN.test(String(title || ''));

/**
 * validateStoredFact - returns null when the fact is usable, or a machine
 * readable reason why it is not. Exported so the rejection rule is directly
 * testable rather than inferred from behaviour.
 */
export const validateStoredFact = ({ metric, value, unit } = {}) => {
  const contract = METRIC_CONTRACTS[metric];
  if (!contract) return null; // unconstrained metric: nothing to contradict
  if (!Number.isFinite(value)) return 'VALUE_NOT_NUMERIC';
  const normalizedUnit = String(unit || '').toUpperCase();

  if (contract.kind === 'PERCENTAGE') {
    if (!PERCENTAGE_UNITS.has(normalizedUnit)) return 'UNIT_NOT_PERCENTAGE';
    if (value < contract.min || value > contract.max) return 'VALUE_OUT_OF_PLAUSIBLE_RANGE';
    return null;
  }
  if (contract.kind === 'MAGNITUDE') {
    if (PERCENTAGE_UNITS.has(normalizedUnit)) return 'MAGNITUDE_REPORTED_AS_PERCENTAGE';
    if (!MAGNITUDE_UNITS.has(normalizedUnit)) return 'UNIT_NOT_A_CURRENCY_MAGNITUDE';
    return null;
  }
  if (contract.kind === 'NOT_PERCENTAGE' && PERCENTAGE_UNITS.has(normalizedUnit)) return 'UNIT_NOT_PERCENTAGE_EXPECTED';
  if (contract.kind === 'PER_SHARE') {
    if (PERCENTAGE_UNITS.has(normalizedUnit)) return 'UNIT_NOT_PERCENTAGE_EXPECTED';
    if (MAGNITUDE_UNITS.has(normalizedUnit) && normalizedUnit !== 'INR') return 'PER_SHARE_REPORTED_AS_TOTAL';
  }
  return null;
};

/** Metric aliases seen in stored titles/facts, so a real figure is not missed by naming alone. */
const METRIC_TITLE_PATTERNS = Object.freeze({
  NIM: /\bnet interest margin\b|\bNIM\b/i,
  GNPA: /\bgross NPA\b|\bGNPA\b|gross non[- ]performing/i,
  NNPA: /\bnet NPA\b|\bNNPA\b|net non[- ]performing/i,
  ROA: /\breturn on assets?\b|\bROA\b/i,
  ROE: /\breturn on equity\b|\bROE\b/i,
  CASA: /\bCASA\b/i,
  OPERATING_MARGIN: /\boperating margin\b|\bEBIT margin\b/i,
  EBITDA_MARGIN: /\bEBITDA margin\b/i,
});

/**
 * classifySector - banking or general, from the stored research profile's
 * own sector string, with a small symbol allow-list as backstop. Never
 * guesses from the company name.
 */
export const classifySector = (profile, symbol) => {
  const sector = profile?.sector || '';
  if (BANKING_SECTOR_PATTERN.test(sector)) return SECTOR_KINDS.BANKING;
  if (BANKING_SYMBOL_HINTS.has(String(symbol || '').toUpperCase())) return SECTOR_KINDS.BANKING;
  return SECTOR_KINDS.GENERAL;
};

/**
 * isStoreReachable - MongoDB connected RIGHT NOW.
 *
 * Without this check, a query issued while the connection is down does not
 * fail fast: mongoose BUFFERS it for its 10s default and only then rejects.
 * On the request path that is 10 seconds of dead wait per lookup, enough to
 * exhaust a turn's deadline and silently change routing. (It did exactly
 * that in the deterministic test suite, which runs with no database - the
 * turn blew its budget and fell through to a different branch, which looked
 * like a flaky intent classifier and was not.)
 *
 * A store we cannot reach is simply a store with nothing in it: the caller
 * reports NOT_COLLECTED and the live provider result stands on its own.
 */
export const isStoreReachable = () => mongoose.connection?.readyState === 1;

/** A stored fact is usable only if it is real research AND verified. Mirrors the Phase 4 integrity gate. */
const isUsableFact = (fact) => Boolean(fact) && fact.dataOrigin === 'REAL_RESEARCH' && fact.verified === true;

/** Resolves the metric name for a fact, falling back to its title when the enum says OTHER. */
export const resolveFactMetric = (fact) => {
  const declared = fact?.metrics?.metric;
  if (declared && declared !== 'OTHER') return declared;
  const haystack = `${fact?.title || ''} ${fact?.fact || ''}`;
  for (const [metric, pattern] of Object.entries(METRIC_TITLE_PATTERNS)) {
    if (pattern.test(haystack)) return metric;
  }
  return declared || null;
};

/** Newest period first; a fact with no period sorts last. */
const byRecency = (a, b) => {
  const pa = a.period || '';
  const pb = b.period || '';
  if (pa === pb) return new Date(b.date || 0) - new Date(a.date || 0);
  return pb.localeCompare(pa);
};

/**
 * getStoredFinancialFacts - the verified, source-linked facts held for one
 * company, newest first, keyed by metric. Returns only what exists.
 */
export const getStoredFinancialFacts = async (symbol, { limit = 400 } = {}) => {
  const normalized = String(symbol || '').toUpperCase();
  if (!normalized || !isStoreReachable()) {
    return { symbol: normalized || null, facts: [], byMetric: {}, rejected: [], quarantined: [], available: false, reason: UNAVAILABLE_REASONS.NOT_COLLECTED };
  }

  let rows = [];
  try {
    rows = await CompanyHistoricalFact.find({ symbol: normalized, dataOrigin: 'REAL_RESEARCH', verified: true })
      .sort({ period: -1, date: -1 })
      .limit(limit)
      .lean();
  } catch (error) {
    logger.warn(`[storedFundamentals] fact lookup failed for ${normalized}: ${error.message}`);
    return { symbol: normalized, facts: [], byMetric: {}, available: false, reason: UNAVAILABLE_REASONS.NOT_COLLECTED };
  }

  const usable = rows.filter(isUsableFact);
  if (!usable.length) {
    return { symbol: normalized, facts: [], byMetric: {}, rejected: [], available: false, reason: UNAVAILABLE_REASONS.NOT_COLLECTED };
  }

  const byMetric = {};
  const rejected = [];
  const quarantined = [];
  for (const fact of usable) {
    const metric = resolveFactMetric(fact);
    if (!metric) continue;
    const value = fact.metrics?.actualValue;
    if (value === null || value === undefined) continue;
    const rejection = validateStoredFact({ metric, value, unit: fact.metrics?.unit });
    if (rejection) { rejected.push({ metric, value, unit: fact.metrics?.unit || null, period: fact.period || null, reason: rejection }); continue; }
    // A ratio/margin metric whose title describes a movement is a delta,
    // not a level - drop it rather than present it as the metric itself.
    if (LEVEL_ONLY_METRICS.has(metric) && isDeltaFact(fact.title)) {
      rejected.push({ metric, value, unit: fact.metrics?.unit || null, period: fact.period || null, reason: 'DELTA_NOT_LEVEL' });
      continue;
    }
    // Phase 6B: dimensional/semantic screen. A suspicious fact is
    // QUARANTINED - withheld and recorded with a reason - never corrected
    // into a number the source did not state.
    const screen = screenFact({ metric, value, unit: fact.metrics?.unit, title: fact.title, statement: fact.fact });
    if (screen.verdict !== FACT_VERDICTS.USABLE) {
      quarantined.push({
        metric, value, unit: fact.metrics?.unit || null, period: fact.period || null,
        verdict: screen.verdict, reason: screen.reason, detail: screen.detail,
        sourceUrl: fact.source?.url || null,
      });
      continue;
    }
    (byMetric[metric] = byMetric[metric] || []).push({
      metric,
      value,
      unit: fact.metrics?.unit || null,
      previousValue: fact.metrics?.previousValue ?? null,
      changePercent: fact.metrics?.changePercent ?? null,
      period: fact.period || null,
      title: fact.title || null,
      statement: fact.fact || null,
      asOf: fact.date || null,
      sourceUrl: fact.source?.url || null,
      sourceTitle: fact.source?.title || null,
      sourceType: fact.source?.type || null,
      pageNumber: fact.source?.pageNumber ?? null,
      excerpt: fact.source?.excerpt || null,
      confidence: fact.confidence ?? null,
    });
  }
  for (const list of Object.values(byMetric)) list.sort(byRecency);

  return { symbol: normalized, facts: usable, byMetric, rejected, quarantined, available: true, reason: null };
};

/**
 * getStoredMarketMetrics - real market metrics derived from NSE bhavcopy
 * history (close, 52-week range, one-year return, volatility, drawdown,
 * liquidity). Genuinely computed from real price observations, and present
 * for far more symbols than filing facts are — this is what lets a
 * comparison say something true about a company with no stored filings.
 */
export const getStoredMarketMetrics = async (symbol) => {
  const normalized = String(symbol || '').toUpperCase();
  if (!normalized || !isStoreReachable()) return null;
  try {
    const snapshot = await StockHistoricalMetricsSnapshot.findOne({ symbol: normalized }).lean();
    if (!snapshot) return null;
    return {
      symbol: normalized,
      lastClose: snapshot.lastClose ?? null,
      fiftyTwoWeekHigh: snapshot.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: snapshot.fiftyTwoWeekLow ?? null,
      oneYearReturn: snapshot.oneYearReturn ?? null,
      threeYearCagr: snapshot.threeYearCagr ?? null,
      annualizedVolatility: snapshot.annualizedVolatility ?? null,
      maximumDrawdown: snapshot.maximumDrawdown ?? null,
      liquidityClassification: snapshot.liquidityClassification ?? null,
      observationCount: snapshot.observationCount ?? null,
      provider: snapshot.provider || null,
      dataAsOf: snapshot.dataAsOf || null,
      missingMetrics: snapshot.missingMetrics || [],
    };
  } catch (error) {
    logger.warn(`[storedFundamentals] market metrics lookup failed for ${normalized}: ${error.message}`);
    return null;
  }
};

/** getCompanyProfile - stored sector/name, used for sector-aware metric selection. */
export const getStoredProfile = async (symbol) => {
  if (!isStoreReachable()) return null;
  try {
    return await CompanyResearchProfile.findOne({ symbol: String(symbol || '').toUpperCase() }).lean();
  } catch {
    return null;
  }
};

/**
 * buildStoredFundamentalsView - everything this module can honestly say
 * about one company, sector-aware, with provenance and an as-of date on
 * every figure, plus an explicit account of what is missing and WHY.
 */
export const isStoredFallbackDisabled = () => process.env.STORED_FALLBACK_DISABLED === 'true';

export const buildStoredFundamentalsView = async (symbol) => {
  // Eval seam + operational kill-switch: reproduces pre-Phase-6A behaviour
  // (live provider only) so the evaluation suite can measure baseline and
  // final with the SAME scorer, and so stored data can be switched off
  // immediately if it is ever found to be wrong.
  if (isStoredFallbackDisabled()) {
    return {
      symbol: String(symbol || '').toUpperCase(), companyName: null, sector: null, sectorKind: SECTOR_KINDS.GENERAL,
      marginLabel: null, notMeaningfulMetrics: [], metrics: [], missingMetrics: [], marketMetrics: null,
      hasFilingData: false, hasMarketData: false, hasAnyData: false, rejectedFacts: [], disabled: true,
    };
  }

  const normalized = String(symbol || '').toUpperCase();
  const [factsResult, marketMetrics, profile] = await Promise.all([
    getStoredFinancialFacts(normalized),
    getStoredMarketMetrics(normalized),
    getStoredProfile(normalized),
  ]);

  const sectorKind = classifySector(profile, normalized);
  const spec = SECTOR_METRICS[sectorKind];

  const present = [];
  const missing = [];
  for (const metric of [...spec.primary, ...spec.supporting]) {
    const entries = factsResult.byMetric[metric];
    if (entries?.length) present.push({ ...entries[0], history: entries.slice(0, 4) });
    else if (spec.primary.includes(metric)) {
      missing.push({
        metric,
        reason: factsResult.available ? UNAVAILABLE_REASONS.METRIC_NOT_REPORTED : UNAVAILABLE_REASONS.NOT_COLLECTED,
      });
    }
  }

  return {
    symbol: normalized,
    companyName: profile?.companyName || null,
    sector: profile?.sector || null,
    // UI Phase 1C.1: a real, stored field (models/CompanyResearchProfile.js
    // — generated from the actual BSE/NSE scrip master, never invented) —
    // exposed here additively for services/responseBlocks.js's
    // buildCompanyHeaderBlock, which infers `exchange: 'NSE'` only when
    // this is genuinely present, never as a blanket assumption.
    nseSymbol: profile?.nseSymbol || null,
    sectorKind,
    marginLabel: spec.marginLabel,
    notMeaningfulMetrics: spec.notMeaningful,
    metrics: present,
    missingMetrics: missing,
    marketMetrics,
    hasFilingData: present.length > 0,
    hasMarketData: Boolean(marketMetrics),
    // Nothing at all is a genuine, reportable state — not an error to hide.
    hasAnyData: present.length > 0 || Boolean(marketMetrics),
    // Facts dropped for failing their unit/range contract — surfaced for
    // observability, never shown to a user as a figure.
    rejectedFacts: factsResult.rejected || [],
    // Withheld as ambiguous rather than wrong - shown in diagnostics with
    // its coverage impact, never rendered into an answer.
    quarantinedFacts: factsResult.quarantined || [],
  };
};

export default {
  buildStoredFundamentalsView, getStoredFinancialFacts, getStoredMarketMetrics, getStoredProfile,
  classifySector, resolveFactMetric, validateStoredFact, isDeltaFact, isStoreReachable, SECTOR_METRICS, SECTOR_KINDS, UNAVAILABLE_REASONS,
};
