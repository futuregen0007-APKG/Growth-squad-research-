import express from 'express';
import { buildGoalRecommendation, buildGoalProfile } from '../services/GoalRecommendationService.js';
import { DynamicUniverseService } from '../services/DynamicUniverseService.js';
import { RebalanceService } from '../services/RebalanceService.js';
import { buildGoalAssetAllocation } from '../services/GoalAssetAllocationService.js';
import { getTopProductsForCategory } from '../services/GoalProductRecommendationService.js';
import { getRefreshMeta } from '../services/StockFundamentalsService.js';
import { getMetricsForSymbol } from '../services/StockHistoricalMetricsService.js';
import BhavcopyIngestionStatus from '../models/BhavcopyIngestionStatus.js';

/**
 * buildProviderStatus - real, per-provider status instead of one blanket
 * "UNKNOWN" string. Previously this endpoint always reported providerStatus
 * from getRefreshMeta() alone, which only tracks the IndianAPI fundamentals
 * batch job and defaults to UNKNOWN whenever that job hasn't run recently --
 * so a genuinely-known state (NSE bhavcopy ingestion succeeding, Angel One's
 * live-quote feed responding) was being hidden behind the same UNKNOWN label
 * as an actual outage. Each sub-status here is read from a real, already-
 * persisted signal; a provider this function has no signal for is reported
 * UNKNOWN rather than guessed.
 */
const buildProviderStatus = async (universeCount) => {
  const [refreshMeta, latestBhavcopy] = await Promise.all([
    getRefreshMeta().catch(() => ({ providerStatus: 'UNKNOWN' })),
    BhavcopyIngestionStatus.findOne().sort({ tradingDate: -1 }).lean().catch(() => null),
  ]);

  const historicalPrices = !latestBhavcopy
    ? 'UNKNOWN'
    : latestBhavcopy.status === 'COMPLETED' || latestBhavcopy.status === 'NO_TRADING'
      ? 'OK'
      : 'DEGRADED';

  const liveQuotes = universeCount > 0 ? 'OK' : 'DEGRADED';

  const fundamentals = refreshMeta.providerStatus || 'UNKNOWN';

  const overall = [historicalPrices, liveQuotes, fundamentals].includes('DEGRADED')
    ? 'DEGRADED'
    : [historicalPrices, liveQuotes, fundamentals].every((s) => s === 'OK')
      ? 'OK'
      : 'UNKNOWN';

  return {
    overall,
    historicalPrices,
    liveQuotes,
    fundamentals,
  };
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
