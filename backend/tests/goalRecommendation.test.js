import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGoalRecommendation, buildGoalProfile } from '../services/GoalRecommendationService.js';
import { DynamicUniverseService } from '../services/DynamicUniverseService.js';
import { RebalanceService } from '../services/RebalanceService.js';

const sampleStocks = [
  { ticker: 'HDFCBANK', name: 'HDFC Bank', sector: 'Banking', price: 1700, changePct: 1.5, pe: 18, marketCap: '₹12L Cr', volatility: 0.13 },
  { ticker: 'RELIANCE', name: 'Reliance Industries', sector: 'Energy', price: 2910, changePct: 2.2, pe: 26, marketCap: '₹19L Cr', volatility: 0.18 },
  { ticker: 'INFY', name: 'Infosys', sector: 'IT', price: 1540, changePct: 1.1, pe: 27, marketCap: '₹7L Cr', volatility: 0.16 },
  { ticker: 'SUNPHARMA', name: 'Sun Pharmaceuticals', sector: 'Healthcare', price: 1600, changePct: 1.8, pe: 31, marketCap: '₹4L Cr', volatility: 0.17 },
  { ticker: 'TATAPOWER', name: 'Tata Power', sector: 'Green Energy', price: 420, changePct: 2.8, pe: 20, marketCap: '₹1.4L Cr', volatility: 0.22 },
  { ticker: 'LT', name: 'Larsen & Toubro', sector: 'Manufacturing', price: 3540, changePct: 2.1, pe: 20, marketCap: '₹4.8L Cr', volatility: 0.19 },
  { ticker: 'ITC', name: 'ITC', sector: 'FMCG', price: 460, changePct: 0.9, pe: 24, marketCap: '₹6L Cr', volatility: 0.11 }
];

test('goal profiles should compute required rate and monthly shortfall', () => {
  const goal = {
    id: 'house-1',
    type: 'house',
    name: 'Dream House',
    targetAmount: 5000000,
    currentAmount: 500000,
    targetYear: 2031,
    monthlyContribution: 20000,
  };

  const profile = buildGoalProfile(goal);
  assert.equal(profile.goalType, 'house');
  assert.ok(profile.yearsRemaining > 0);
  assert.ok(profile.requiredFutureValue > 0);
  assert.ok(profile.requiredMonthlyInvestment > 0);
  assert.ok(profile.status === 'UNDERFUNDED' || profile.status === 'SLIGHTLY_UNDERFUNDED');
});

test('recommendations should differ meaningfully by goal profile', async () => {
  const houseGoal = {
    id: 'goal-house',
    type: 'house',
    name: 'Dream House',
    targetAmount: 5000000,
    currentAmount: 500000,
    targetYear: 2031,
    monthlyContribution: 20000,
    riskProfile: 'moderate',
  };

  const retirementGoal = {
    id: 'goal-retirement',
    type: 'retirement',
    name: 'Retirement',
    targetAmount: 200000000,
    currentAmount: 1500000,
    targetYear: 2045,
    monthlyContribution: 30000,
    riskProfile: 'aggressive',
  };

  const houseRecommendation = await buildGoalRecommendation(houseGoal, sampleStocks);
  const retirementRecommendation = await buildGoalRecommendation(retirementGoal, sampleStocks);

  const houseSymbols = houseRecommendation.recommendations.map((item) => item.symbol);
  const retirementSymbols = retirementRecommendation.recommendations.map((item) => item.symbol);

  assert.ok(houseSymbols.length > 0);
  assert.ok(retirementSymbols.length > 0);
  assert.ok(houseSymbols.some((symbol) => !retirementSymbols.includes(symbol)) || houseRecommendation.strategy.horizon !== retirementRecommendation.strategy.horizon);
  assert.ok(houseRecommendation.goalAnalysis.requiredMonthlyInvestment > 0);
  assert.ok(retirementRecommendation.goalAnalysis.requiredMonthlyInvestment > 0);
  assert.ok(houseRecommendation.rebalanceAnalysis);
});

test('DynamicUniverseService should correctly filter market cap and volume', async () => {
  const screener = new DynamicUniverseService();
  assert.equal(screener.parseMarketCapToCr('₹12L Cr'), 1200000);
  assert.equal(screener.parseMarketCapToCr('₹5000 Cr'), 5000);
  assert.equal(screener.parseMarketCapToCr('₹45K Cr'), 45000);

  const universe = await screener.getEligibleUniverse({ minMarketCapCr: 1000 });
  assert.ok(Array.isArray(universe));
  assert.ok(universe.length > 0);
});

test('RebalanceService should evaluate glidepath and detect portfolio drift', () => {
  const nearTermGoal = {
    id: 'goal-car',
    type: 'car',
    targetAmount: 1500000,
    currentAmount: 200000,
    targetYear: new Date().getFullYear() + 2, // 2 years remaining -> SHORT_TERM
    monthlyContribution: 25000,
  };

  const highGrowthHoldings = [
    { symbol: 'INFY', sector: 'IT', allocationPercent: 60 },
    { symbol: 'TATAPOWER', sector: 'Green Energy', allocationPercent: 40 },
  ];

  const analysis = RebalanceService.evaluateGoalDrift(nearTermGoal, {}, highGrowthHoldings);
  assert.equal(analysis.glidepathTier, 'Capital Preservation');
  assert.equal(analysis.recommendedAction, 'REBALANCE_RECOMMENDED');
  assert.ok(analysis.driftPercentage > 0);
  assert.ok(analysis.suggestedAdjustments.length > 0);
});

