import express from 'express';
import { buildGoalRecommendation, buildGoalProfile } from '../services/GoalRecommendationService.js';
import { DynamicUniverseService } from '../services/DynamicUniverseService.js';
import { RebalanceService } from '../services/RebalanceService.js';
import { buildGoalAssetAllocation } from '../services/GoalAssetAllocationService.js';
import { getTopProductsForCategory, FRESHNESS_MAX_AGE_DAYS as PRODUCT_FRESHNESS_MAX_AGE_DAYS } from '../services/GoalProductRecommendationService.js';
import { getMetricsForSymbol } from '../services/StockHistoricalMetricsService.js';
import BhavcopyIngestionStatus from '../models/BhavcopyIngestionStatus.js';
import BootstrapRunLog from '../models/BootstrapRunLog.js';
import StockPriceHistorySnapshot from '../models/StockPriceHistorySnapshot.js';
import StockHistoricalMetricsSnapshot from '../models/StockHistoricalMetricsSnapshot.js';
import StockFundamentalsSnapshot from '../models/StockFundamentalsSnapshot.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { InvestmentProductSnapshot } from '../models/InvestmentProductSnapshot.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';

// Per-dataset states, applied uniformly (rule 5): FAILED beats staleness (a
// FAILED job might have left old-but-real data behind, which must never
// read as merely "stale"), then genuinely-never-populated, then age vs. the
// dataset's own freshness window, then coverage, and only a dataset that is
// both fresh AND (nearly) complete is FRESH.
export const DATASET_STATUSES = Object.freeze(['FRESH', 'PARTIAL', 'STALE', 'FAILED', 'NOT_CONFIGURED_OR_NEVER_RUN']);
const MIN_FRESH_COVERAGE = 0.9; // >=90% of the configured universe -- a handful of genuinely-unresolvable symbols (see BseScripMasterProvider.js) must never block FRESH forever

/**
 * evaluateDatasetStatus - pure. `mostRecentAgeDays` is null when there is no
 * dated evidence at all for records that do exist (treated conservatively,
 * as STALE, never guessed FRESH).
 */
export const evaluateDatasetStatus = ({
  totalCount = 0, universeSize, mostRecentAgeDays = null, freshnessMaxDays, lastAttemptFailedWithNoSuccess = false,
}) => {
  if (lastAttemptFailedWithNoSuccess) return 'FAILED';
  if (!totalCount) return 'NOT_CONFIGURED_OR_NEVER_RUN';
  if (mostRecentAgeDays == null || mostRecentAgeDays > freshnessMaxDays) return 'STALE';
  if (universeSize && totalCount / universeSize < MIN_FRESH_COVERAGE) return 'PARTIAL';
  return 'FRESH';
};

/** deriveOverallProviderStatus - pure. Worst-of, in the order a person actually cares about (a real failure outranks mere staleness). */
export const deriveOverallProviderStatus = (datasetStatuses) => {
  const priority = ['FAILED', 'NOT_CONFIGURED_OR_NEVER_RUN', 'STALE', 'PARTIAL', 'FRESH'];
  const present = new Set(Object.values(datasetStatuses));
  return priority.find((s) => present.has(s)) || 'NOT_CONFIGURED_OR_NEVER_RUN';
};

const daysSince = (date) => (date ? (Date.now() - new Date(date).getTime()) / 86400000 : null);

const lastStageFailedWithNoSuccess = (bootstrapLogs, stageName) => {
  const log = bootstrapLogs.find((l) => l.stage === stageName);
  return Boolean(log?.lastAttempt?.status === 'FAILED');
};

/**
 * buildProviderStatus - a genuine, per-dataset status instead of one blanket
 * string, for every dataset Goals' recommendation reads (rule 5). Backed
 * entirely by DURABLE evidence (the data's own persisted freshness fields,
 * plus scripts/productionBootstrap.js's BootstrapRunLog for "did the last
 * attempted job fail outright") -- never the fundamentals Redis cache alone
 * (StockFundamentalsService.getRefreshMeta): that cache has only a 7-day TTL
 * and is empty whenever Redis itself is unavailable (confirmed: this
 * environment currently reports redisAvailable:false in
 * scripts/productionStatus.js), which is exactly how a real, populated
 * StockFundamentalsSnapshot collection was previously still reporting
 * providerStatus: UNKNOWN -- a successful past fetch masquerading as "no
 * signal" rather than the genuinely-fresh state it was.
 */
export const buildProviderStatus = async (universeCount) => {
  const universeSize = Object.keys(SUPPORTED_STOCKS).length;
  const [
    latestBhavcopy, metricsAgg, profileAgg, fundamentalsAgg, productsAgg, bootstrapLogs,
  ] = await Promise.all([
    BhavcopyIngestionStatus.findOne().sort({ tradingDate: -1 }).lean().catch(() => null),
    StockHistoricalMetricsSnapshot.aggregate([{ $group: { _id: null, n: { $sum: 1 }, mostRecent: { $max: '$computedAt' } } }]).catch(() => []),
    CompanyResearchProfile.aggregate([{ $match: { marketCapCr: { $gt: 0 } } }, { $group: { _id: null, n: { $sum: 1 }, mostRecent: { $max: '$lastProfileSyncAt' } } }]).catch(() => []),
    StockFundamentalsSnapshot.aggregate([{ $group: { _id: null, n: { $sum: 1 }, mostRecent: { $max: '$dataAsOf' } } }]).catch(() => []),
    InvestmentProductSnapshot.aggregate([{ $group: { _id: null, n: { $sum: 1 }, mostRecent: { $max: '$dataAsOf' } } }]).catch(() => []),
    BootstrapRunLog.find({}, { stage: 1, lastAttempt: 1 }).lean().catch(() => []),
  ]);

  const historicalPrices = evaluateDatasetStatus({
    totalCount: latestBhavcopy ? 1 : 0, // a durable per-day status doc exists at all -- coverage is validated per-day by symbolsMatched, not summarized here
    universeSize: 1,
    mostRecentAgeDays: latestBhavcopy ? daysSince(latestBhavcopy.tradingDate) : null,
    freshnessMaxDays: 4, // NSE bhavcopy is published every trading day; spans a normal weekend/holiday gap without false-flagging stale on a Monday
    lastAttemptFailedWithNoSuccess: lastStageFailedWithNoSuccess(bootstrapLogs, 'nse-bhavcopy'),
  });
  const historicalMetrics = evaluateDatasetStatus({
    totalCount: metricsAgg[0]?.n || 0,
    universeSize,
    mostRecentAgeDays: daysSince(metricsAgg[0]?.mostRecent),
    freshnessMaxDays: 4, // recomputed immediately after prices land -- same window
    lastAttemptFailedWithNoSuccess: lastStageFailedWithNoSuccess(bootstrapLogs, 'historical-metrics'),
  });
  const companyProfiles = evaluateDatasetStatus({
    totalCount: profileAgg[0]?.n || 0,
    universeSize,
    mostRecentAgeDays: daysSince(profileAgg[0]?.mostRecent),
    freshnessMaxDays: 10, // market cap/BSE identity does not need daily precision
    lastAttemptFailedWithNoSuccess: lastStageFailedWithNoSuccess(bootstrapLogs, 'bse-profile-sync'),
  });
  const fundamentals = evaluateDatasetStatus({
    totalCount: fundamentalsAgg[0]?.n || 0,
    universeSize,
    mostRecentAgeDays: daysSince(fundamentalsAgg[0]?.mostRecent),
    freshnessMaxDays: 30, // IndianAPI fundamentals (P/E, ROE, growth) change on a quarterly cadence, not daily
    lastAttemptFailedWithNoSuccess: lastStageFailedWithNoSuccess(bootstrapLogs, 'stock-fundamentals'),
  });
  const investmentProducts = evaluateDatasetStatus({
    totalCount: productsAgg[0]?.n || 0,
    universeSize: productsAgg[0]?.n || 1, // AMFI's own scheme count, not the equity universe -- coverage is judged against itself
    mostRecentAgeDays: daysSince(productsAgg[0]?.mostRecent),
    freshnessMaxDays: PRODUCT_FRESHNESS_MAX_AGE_DAYS,
    lastAttemptFailedWithNoSuccess: lastStageFailedWithNoSuccess(bootstrapLogs, 'investment-products'),
  });
  const liveQuotes = universeCount > 0 ? 'FRESH' : 'STALE';

  const datasets = {
    historicalPrices, historicalMetrics, companyProfiles, fundamentals, investmentProducts, liveQuotes,
  };
  return { overall: deriveOverallProviderStatus(datasets), ...datasets };
};

/**
 * buildResearchData - per-stock historical evidence for goal recommendations,
 * read from the durable StockHistoricalMetricsSnapshot (computed from NSE
 * bhavcopy -- see StockHistoricalMetricsService.js) instead of a live Angel
 * One historical-candle call. Angel One's historical endpoint returned HTTP
 * 403 for the large majority of symbols in this environment regardless of
 * request concurrency -- "provider failure incorrectly represented as zero
 * matches" (task 1's diagnostic list) -- so this is no longer a live,
 * rate-limited external call at all: it's a fast local Mongo read, safe to
 * run for the whole universe on every request with no throttling needed.
 */
const buildResearchData = async (stocks) => Promise.all(stocks.map(async (stock) => {
  const ticker = stock.ticker || stock.symbol;
  const metricsSnapshot = await getMetricsForSymbol(ticker);
  return { symbol: ticker, metricsSnapshot };
}));

/**
 * buildStockCards - `recommendation.recommendations` (the richer object used
 * elsewhere on this page -- news, projections, detail dialog) projected into
 * the stable, contract-only fields "Load Eligible Stocks" and its cards need.
 * Never a second, divergent computation of eligibility/score.
 */
const buildStockCards = (recommendation) => (recommendation.recommendations || []).map((r) => ({
  symbol: r.symbol,
  companyName: r.companyName,
  score: r.goalFitScore,
  goalFit: r.goalFitScore,
  scoreLabel: r.scoreLabel,
  marketCapSegment: r.marketCapSegment,
  ...(Number(r.price) > 0 ? { currentPrice: Number(r.price) } : {}),
  riskLevel: r.risk,
  metricsUsed: r.availableMetrics || [],
  missingMetrics: r.missingMetrics || [],
  dataAsOf: r.fundamentals?.dataAsOf || null,
  source: {
    fundamentalSource: r.fundamentals?.source || null,
    fundamentalSourceUrl: r.fundamentals?.sourceUrl || null,
    isStale: Boolean(r.fundamentals?.isStale),
    provenance: r.fundamentals?.provenance || null,
    historicalSource: r.historical?.source || null,
  },
  // Coverage metadata (never a substitute for the goal's own horizon, which
  // is a suitability input, not an evidence window -- see
  // GoalRecommendationService.js's getSegmentPolicy/getGoalBucket): the
  // actual price window this stock's return/volatility/drawdown were
  // computed from, so e.g. a "1Y Return" figure is never mistaken for ten
  // years of evidence just because the goal has a ten-year horizon.
  historicalCoverage: r.historical?.available ? {
    observationCount: r.historical.observations,
    firstDate: r.historical.firstDate,
    lastDate: r.historical.lastDate,
    dataAsOf: r.historical.dataAsOf,
    computedAt: r.historical.computedAt,
    corporateActionAdjustmentStatus: r.historical.corporateActionAdjustmentStatus,
  } : null,
  suggestedMonthlyAmount: r.suggestedMonthlyAmount ?? null,
  dividendSuitability: r.dividendSuitability,
  reasons: (r.reasons || []).filter(Boolean).slice(0, 3),
}));

/**
 * buildStockUniverseSummary - the `stockUniverse` block of the unified goals
 * response (Part K). Distinguishes PROVIDER_UNAVAILABLE / awaiting-refresh /
 * no-stock-passed-eligibility / partial-universe / success rather than
 * collapsing all of them into an empty array with no explanation (the bug
 * this whole feature fixes).
 *
 * Invariants this must satisfy (enforced by GoalRecommendationService, see
 * its own accounting comments): eligibleCount + sum(primary rejectionCounts,
 * excluding the informational STALE_DATA counter) === evaluatedCount, and
 * evaluatedCount + notEvaluatedCount === universeCount.
 */
export const buildStockUniverseSummary = (recommendation, universeCount, providerStatus = 'UNKNOWN') => {
  const evaluatedCount = recommendation.evaluatedCount ?? 0;
  const eligibleCount = recommendation.eligibleCount ?? 0;
  const notEvaluatedCount = Math.max(0, universeCount - evaluatedCount);
  const rejectionCounts = recommendation.rejectionCounts || {};

  let status;
  if (eligibleCount > 0 && evaluatedCount >= universeCount) status = 'AVAILABLE';
  else if (eligibleCount > 0) status = 'PARTIAL';
  else status = 'UNAVAILABLE';

  const stocks = buildStockCards(recommendation);
  const byMarketCap = stocks.reduce((acc, s) => {
    if (s.marketCapSegment) acc[s.marketCapSegment] = (acc[s.marketCapSegment] || 0) + 1;
    return acc;
  }, { LARGE: 0, MID: 0, SMALL: 0 });

  const missingDataReasons = Object.entries(rejectionCounts)
    .filter(([, count]) => count > 0)
    .map(([reasonCode, count]) => ({ reasonCode, count }));

  const dataAsOfCandidates = stocks.map((s) => s.dataAsOf).filter(Boolean).map((d) => new Date(d).getTime());
  const dataAsOf = dataAsOfCandidates.length ? new Date(Math.min(...dataAsOfCandidates)).toISOString() : null;

  return {
    stocks,
    status,
    universeCount,
    evaluatedCount,
    eligibleCount,
    notEvaluatedCount,
    byMarketCap,
    rejectionCounts,
    missingDataReasons,
    // A known Angel One 403 (live price/universe listing) must never surface
    // as providerStatus: UNKNOWN when the FUNDAMENTALS provider status is
    // actually known -- historical price no longer depends on Angel One at
    // all (see StockHistoricalMetricsService), so this reflects the one
    // remaining real external dependency (IndianAPI fundamentals refresh).
    providerStatus,
    dataAsOf,
  };
};

const PRODUCT_BUCKET_TO_CATEGORY = { mutualFunds: 'MUTUAL_FUND', gold: 'GOLD_ETF', debt: 'DEBT_FUND', liquid: 'LIQUID_FUND' };

/**
 * Populates the mutualFunds/gold/debt/liquid product buckets from the
 * persisted InvestmentProductSnapshot universe (never a live ingest -- see
 * GoalProductRecommendationService.js). Also collects a `missingDataReasons`
 * entry and the most stale `dataAsOf` across categories for the response's
 * top-level datasetAsOf/confidence fields (rule 10).
 */
const populateProductBuckets = async (allocationPlan, riskLevel) => {
  const missingDataReasons = [];
  let oldestDataAsOf = null;
  let anyItemBelowHighConfidence = false;

  await Promise.all(Object.entries(PRODUCT_BUCKET_TO_CATEGORY).map(async ([bucketKey, productType]) => {
    const bucket = allocationPlan.productBuckets[bucketKey];
    const result = await getTopProductsForCategory(productType, { riskCapacity: riskLevel });
    bucket.items = result.items.map((item) => ({
      productId: item.productId, name: item.name, symbol: item.symbol, category: item.category,
      riskLevel: item.riskLevel, returns1Y: item.returns1Y, returns3Y: item.returns3Y, returns5Y: item.returns5Y,
      volatility3Y: item.volatility3Y, maxDrawdown: item.maxDrawdown, liquidity: item.liquidity,
      navOrPrice: item.navOrPrice, sourceUrl: item.sourceUrl, dataAsOf: item.dataAsOf, score: item.score,
      missingMetrics: item.missingMetrics, dataFreshnessConfidence: item.dataFreshnessConfidence,
      recommendationConfidence: item.recommendationConfidence,
    }));
    bucket.status = result.items.length ? 'VERIFIED_CURRENT_PRODUCTS' : result.status;
    if (result.reasonCode) {
      bucket.reasonCode = result.reasonCode;
      missingDataReasons.push({ bucket: bucketKey, reasonCode: result.reasonCode });
    }
    for (const item of result.items) {
      const asOf = item.dataAsOf ? new Date(item.dataAsOf).getTime() : null;
      if (asOf && (oldestDataAsOf === null || asOf < oldestDataAsOf)) oldestDataAsOf = asOf;
      if (item.recommendationConfidence !== 'HIGH') anyItemBelowHighConfidence = true;
    }
  }));

  allocationPlan.datasetAsOf = oldestDataAsOf ? new Date(oldestDataAsOf).toISOString() : null;
  allocationPlan.missingDataReasons = missingDataReasons;
  // The dataset-level confidence must never claim HIGH while any individual
  // recommendation's own confidence is capped below HIGH (e.g. AMFI's
  // missing aum/expenseRatio) -- that would contradict the per-item field.
  const baseConfidence = missingDataReasons.length === 0 ? 'HIGH' : missingDataReasons.length <= 2 ? 'MEDIUM' : 'LOW';
  allocationPlan.confidence = baseConfidence === 'HIGH' && anyItemBelowHighConfidence ? 'MEDIUM' : baseConfidence;
  return allocationPlan;
};

export const createGoalRoutes = (stockService) => {
  const router = express.Router();
  const dynamicUniverseService = new DynamicUniverseService(stockService);

  const parseGoalPayload = (req) => {
    const rawGoal = req.query.goal || req.body?.goal || '{}';
    const parsedGoal = typeof rawGoal === 'string' ? JSON.parse(rawGoal) : rawGoal;
    const profile = req.query.profile || req.body?.profile || '{}';
    const parsedProfile = typeof profile === 'string' ? JSON.parse(profile) : profile;
    const filters = req.body && !req.body.goal ? req.body : {};

    return {
      goal: { ...(parsedGoal || {}), ...filters },
      profile: parsedProfile || {},
    };
  };

  const getScreenedUniverse = async (goal) => {
    const eligibleStocks = await dynamicUniverseService.getEligibleUniverse({ minMarketCapCr: 1000 });
    const stocksToUse = eligibleStocks.length > 0 ? eligibleStocks : await stockService.getAllStocks();
    return stocksToUse;
  };

  router.get('/:goalId/allocation-plan', async (req, res, next) => {
    try {
      const { goal, profile } = parseGoalPayload(req);
      const goalId = req.params.goalId || goal.id || 'goal';
      const riskLevel = req.query.riskLevel || goal.riskLevel || goal.riskProfile || profile.riskLevel || profile.riskProfile || 'MODERATE';
      const horizonYears = req.query.horizonYears ?? goal.horizonYears ?? (Number(goal.targetYear) - new Date().getFullYear());
      const monthlyContribution = req.query.monthlyContribution ?? goal.monthlyContribution ?? goal.monthlySavings;
      const allocationPlan = buildGoalAssetAllocation({
        targetAmount: goal.targetAmount ?? goal.target,
        currentAmount: goal.currentAmount ?? goal.current ?? 0,
        monthlyContribution: monthlyContribution ?? 0,
        horizonYears,
        riskLevel,
        goalType: goal.type || goal.goalType,
      });
      if (allocationPlan.feasibility.status !== 'INSUFFICIENT_INPUT') {
        await populateProductBuckets(allocationPlan, riskLevel);
      }
      res.status(200).json({ success: true, data: allocationPlan, goalId });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:goalId/recommendations', async (req, res, next) => {
    try {
      const { goal, profile } = parseGoalPayload(req);
      const goalId = req.params.goalId || goal.id || 'goal';
      const goalPayload = {
        ...goal,
        id: goalId,
        goalId,
      };

      const stocks = await getScreenedUniverse(goalPayload);
      const researchData = await buildResearchData(stocks);

      const recommendation = await buildGoalRecommendation(goalPayload, stocks, profile, { researchData });
      const providerStatusDetail = await buildProviderStatus(stocks.length);
      const stockUniverse = buildStockUniverseSummary(recommendation, stocks.length, providerStatusDetail);

      const allocationPlan = buildGoalAssetAllocation({
        targetAmount: goalPayload.targetAmount,
        currentAmount: goalPayload.currentAmount,
        monthlyContribution: goalPayload.monthlyContribution,
        horizonYears: goalPayload.horizonYears || goalPayload.targetYear - new Date().getFullYear(),
        riskLevel: goalPayload.riskProfile || profile.riskProfile,
        goalType: goalPayload.type || goalPayload.goalType,
      });
      allocationPlan.productBuckets.stocks.items = recommendation.recommendations || [];
      allocationPlan.productBuckets.stocks.status = allocationPlan.productBuckets.stocks.items.length ? 'VERIFIED_ELIGIBLE_STOCKS' : 'AWAITING_FUNDAMENTALS';
      await populateProductBuckets(allocationPlan, goalPayload.riskProfile || profile.riskProfile);

      // Part K: the unified goals response. A historical-provider failure
      // (stockUniverse) must never erase the fund/ETF results computed
      // independently above -- both are always present together.
      const stockDataAsOfAgeDays = stockUniverse.dataAsOf ? (Date.now() - new Date(stockUniverse.dataAsOf).getTime()) / (24 * 60 * 60 * 1000) : null;
      const dataFreshnessConfidence = stockDataAsOfAgeDays == null ? 'LOW' : stockDataAsOfAgeDays <= 5 ? 'HIGH' : stockDataAsOfAgeDays <= 30 ? 'MEDIUM' : 'LOW';
      const combinedMissingDataReasons = [...(allocationPlan.missingDataReasons || []), ...stockUniverse.missingDataReasons.map((r) => ({ bucket: 'stocks', reasonCode: r.reasonCode, count: r.count }))];

      res.status(200).json({
        success: true,
        data: {
          ...recommendation,
          allocation: allocationPlan.allocation,
          glidepath: allocationPlan.glidepath,
          products: {
            mutualFunds: allocationPlan.productBuckets.mutualFunds.items,
            stocks: stockUniverse.stocks,
            debt: allocationPlan.productBuckets.debt.items,
            gold: allocationPlan.productBuckets.gold.items,
            liquid: allocationPlan.productBuckets.liquid.items,
          },
          stockUniverse,
          datasetAsOf: allocationPlan.datasetAsOf,
          dataFreshnessConfidence,
          recommendationConfidence: allocationPlan.confidence,
          missingDataReasons: combinedMissingDataReasons,
          // Legacy/back-compat fields other existing consumers of this
          // endpoint already read (recPlan/recAllocation/rebalanceAnalysis in
          // Goals.jsx, etc.) -- never removed, only added to.
          ...stockUniverse,
          providerStatus: providerStatusDetail.overall,
          allocationPlan,
          universeStats: {
            screenedCount: stocks.length,
            marketCapThreshold: '₹1,000 Cr+',
            dynamicScreenerActive: true,
          },
        },
        goalId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:goalId/recommendations', async (req, res, next) => {
    try {
      const { goal, profile } = parseGoalPayload(req);
      const goalId = req.params.goalId || goal.id || 'goal';
      const stocks = await getScreenedUniverse(goal);
      const researchData = await buildResearchData(stocks);
      const recommendation = await buildGoalRecommendation({ ...goal, id: goalId, goalId }, stocks, profile, { researchData });
      res.status(200).json({
        success: true,
        data: {
          ...recommendation,
          universeStats: {
            screenedCount: stocks.length,
            marketCapThreshold: '₹1,000 Cr+',
            dynamicScreenerActive: true,
          },
        },
        goalId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:goalId/rebalance-check', async (req, res, next) => {
    try {
      const { goal, profile } = parseGoalPayload(req);
      const goalId = req.params.goalId || goal.id || 'goal';
      const stocks = await getScreenedUniverse(goal);
      const recommendation = await buildGoalRecommendation({ ...goal, id: goalId, goalId }, stocks, profile);
      const rebalanceAnalysis = RebalanceService.evaluateGoalDrift(goal, profile, recommendation.recommendations || []);

      res.status(200).json({
        success: true,
        data: rebalanceAnalysis,
        goalId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:goalId/rebalance', async (req, res, next) => {
    try {
      const { goal, profile } = parseGoalPayload(req);
      const goalId = req.params.goalId || goal.id || 'goal';
      const stocks = await getScreenedUniverse(goal);
      const recommendation = await buildGoalRecommendation({ ...goal, id: goalId, goalId, enableAiAnalysis: true }, stocks, profile);
      const rebalanceAnalysis = RebalanceService.evaluateGoalDrift(goal, profile, recommendation.recommendations || []);

      res.status(200).json({
        success: true,
        message: 'Goal portfolio successfully evaluated and rebalanced according to current glidepath.',
        data: {
          rebalancedRecommendations: recommendation.recommendations,
          rebalanceAnalysis,
          glidepath: rebalanceAnalysis.glidepathTier,
        },
        goalId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:goalId/recommendations/:symbol', async (req, res, next) => {
    try {
      const { goal, profile } = parseGoalPayload(req);
      const goalId = req.params.goalId || goal.id || 'goal';
      const symbol = String(req.params.symbol || '').toUpperCase();
      const stockUniverse = await getScreenedUniverse(goal);
      const researchData = await buildResearchData(stockUniverse);
      const recommendation = await buildGoalRecommendation({ ...goal, id: goalId, goalId }, stockUniverse, profile, { researchData });
      const match = recommendation.recommendations.find((item) => String(item.symbol).toUpperCase() === symbol);

      if (!match) {
        return res.status(404).json({ success: false, message: 'Recommendation not found for this goal and stock.' });
      }

      res.status(200).json({
        success: true,
        data: {
          goalId,
          goal: recommendation.goalAnalysis,
          stock: match,
          ...match,
          whyRecommended: match.whyRecommended,
          investmentPlan: match.investmentPlan,
          projection: match.projection,
          news: match.news,
          risks: match.risks,
          sentimentScore: match.sentimentScore,
          sentimentConfidence: match.sentimentConfidence,
          sentimentDrivers: match.sentimentDrivers,
          sentimentBadge: match.sentimentBadge,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};

export default createGoalRoutes;
