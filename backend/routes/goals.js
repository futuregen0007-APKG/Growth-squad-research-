import express from 'express';
import { buildGoalRecommendation, buildGoalProfile } from '../services/GoalRecommendationService.js';
import { DynamicUniverseService } from '../services/DynamicUniverseService.js';
import { RebalanceService } from '../services/RebalanceService.js';
import { buildGoalAssetAllocation } from '../services/GoalAssetAllocationService.js';

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
      const researchData = await Promise.all(stocks.map(async (stock) => {
        try {
          const ticker = stock.ticker || stock.symbol;
          const history = await stockService.getHistoricalData(ticker, '1Y');
          return { symbol: ticker, history };
        } catch (historyError) {
          return { symbol: stock.ticker || stock.symbol, history: [], historyUnavailable: true };
        }
      }));

      const recommendation = await buildGoalRecommendation(goalPayload, stocks, profile, { researchData });
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

      res.status(200).json({
        success: true,
        data: {
          ...recommendation,
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
      const researchData = await Promise.all(stocks.map(async (stock) => {
        try {
          const ticker = stock.ticker || stock.symbol;
          return { symbol: ticker, history: await stockService.getHistoricalData(ticker, '1Y') };
        } catch (historyError) {
          return { symbol: stock.ticker || stock.symbol, history: [], historyUnavailable: true };
        }
      }));
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
      const researchData = await Promise.all(stockUniverse.map(async (stock) => {
        try {
          const ticker = stock.ticker || stock.symbol;
          const history = await stockService.getHistoricalData(ticker, '1Y');
          return { symbol: ticker, history };
        } catch (historyError) {
          return { symbol: stock.ticker || stock.symbol, history: [], historyUnavailable: true };
        }
      }));
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
