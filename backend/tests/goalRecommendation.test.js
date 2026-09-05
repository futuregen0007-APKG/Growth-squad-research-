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

// --- Missing-data scoring correctness regression tests ---
// These prove the fix for the bug where stocks with zero real
// volatility/valuation/quality/returns/drawdown data (e.g. BATAINDIA) were
// scoring 95-100 purely from a favorable sector match plus hardcoded
// fallback scores. Missing data must now lower confidence, not score.

const wealthGoal = {
  id: 'goal-wealth',
  type: 'wealth_creation',
  name: 'Wealth Creation',
  targetAmount: 10000000,
  currentAmount: 500000,
  targetYear: new Date().getFullYear() + 10,
  monthlyContribution: 15000,
  riskProfile: 'moderate',
};

test('a BATAINDIA-like stock with no verified metrics cannot score 100 even with a perfect sector match', async () => {
  const bataLikeStock = {
    ticker: 'BATAINDIA',
    name: 'Bata India',
    sector: 'Consumer',
    price: 672.75,
    changePct: 0.5,
    marketCap: '₹19000 Cr',
    // No pe, no roe, no volatility supplied — mirrors the live diagnostic finding.
  };

  // Restricting the universe to the Consumer sector isolates the case: the
  // only candidate has a perfect (100) sector match and nothing else.
  const goalWithSectorMatch = { ...wealthGoal, sector: 'Consumer' };
  const recommendation = await buildGoalRecommendation(goalWithSectorMatch, [bataLikeStock, ...sampleStocks]);
  const bata = recommendation.recommendations.find((item) => item.symbol === 'BATAINDIA');

  // BATAINDIA has zero verified metrics, so it must be excluded from ranked
  // recommendations entirely — a perfect sector match alone is not enough.
  assert.equal(bata, undefined);
  assert.equal(recommendation.recommendations.length, 0);
  assert.equal(recommendation.dataQualitySummary.insufficientDataExcludedCount, 1);
});

test('a stock with entirely missing inputs returns goalFitScore null and INSUFFICIENT_DATA status', async () => {
  const noDataStock = { ticker: 'NODATA', name: 'No Data Corp', sector: 'IT', price: 100, changePct: 0 };
  const recommendation = await buildGoalRecommendation(wealthGoal, [noDataStock, ...sampleStocks], {}, { researchData: [] });
  const found = recommendation.recommendations.find((item) => item.symbol === 'NODATA');
  assert.equal(found, undefined, 'a stock with zero verified metrics must never appear in ranked recommendations');
});

test('sector-only match is insufficient to produce a numeric score', async () => {
  const sectorOnlyStock = { ticker: 'SECTORONLY', name: 'Sector Only Ltd', sector: 'IT', price: 500, changePct: 1.2 };
  const itGoal = { ...wealthGoal, sector: 'IT' };
  const recommendation = await buildGoalRecommendation(itGoal, [sectorOnlyStock, ...sampleStocks]);
  const found = recommendation.recommendations.find((item) => item.symbol === 'SECTORONLY');
  assert.equal(found, undefined);
});

test('a stock with complete, verified metrics produces a deterministic numeric score with HIGH confidence', async () => {
  const completeStock = {
    ticker: 'COMPLETESTOCK',
    name: 'Complete Data Ltd',
    sector: 'Banking',
    price: 1000,
    changePct: 1.0,
    pe: 22,
    roe: 16,
  };
  const researchData = [{
    symbol: 'COMPLETESTOCK',
    // Smooth, low-volatility synthetic series so this stock's real measured
    // risk lands comfortably within the CONSERVATIVE eligibility band below.
    history: Array.from({ length: 252 }, (_, i) => ({ close: 1000 + Math.sin(i / 10) * 20 + i * 0.5 })),
  }];

  const runOnce = () => buildGoalRecommendation(
    { ...wealthGoal, id: `goal-complete-${Math.random()}`, riskProfile: 'conservative' },
    [completeStock, ...sampleStocks],
    {},
    { researchData },
  );
  const first = await runOnce();
  const second = await runOnce();

  const firstMatch = first.recommendations.find((item) => item.symbol === 'COMPLETESTOCK');
  const secondMatch = second.recommendations.find((item) => item.symbol === 'COMPLETESTOCK');

  assert.ok(firstMatch, 'a stock with all 5 verified metrics must be rankable');
  assert.equal(firstMatch.scoreStatus, 'COMPLETE');
  assert.equal(firstMatch.confidence, 'HIGH');
  assert.equal(firstMatch.dataCoveragePct, 100);
  assert.ok(typeof firstMatch.goalFitScore === 'number' && firstMatch.goalFitScore >= 0 && firstMatch.goalFitScore <= 100);
  // Deterministic: identical verified inputs must produce the identical score.
  assert.equal(firstMatch.goalFitScore, secondMatch.goalFitScore);
});

test('missing data lowers coverage, not risk: a stock with no historical candles gets null risk, not a favorable default', async () => {
  const partialStock = {
    ticker: 'PARTIALSTOCK',
    name: 'Partial Data Ltd',
    sector: 'Auto', // distinct from every sampleStocks sector to avoid sector-diversity dedup ambiguity
    price: 800,
    changePct: 0.8,
    pe: 25,
    roe: 14,
    // No historical candle data supplied for this symbol.
  };

  const recommendation = await buildGoalRecommendation({ ...wealthGoal, id: 'goal-partial' }, [partialStock, ...sampleStocks], {}, { researchData: [] });
  const match = recommendation.recommendations.find((item) => item.symbol === 'PARTIALSTOCK');

  assert.ok(match, 'a stock with 2/5 verified metrics (valuation + quality) should still be rankable as PARTIAL');
  assert.equal(match.scoreStatus, 'PARTIAL');
  assert.equal(match.dataCoveragePct, 40);
  assert.deepEqual(match.missingMetrics.sort(), ['maxDrawdown', 'oneYearReturn', 'volatility']);
  // Missing historical data must not be smuggled into a fabricated risk score.
  assert.equal(match.riskScore, null);
  assert.equal(match.risk, 'UNKNOWN');
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

