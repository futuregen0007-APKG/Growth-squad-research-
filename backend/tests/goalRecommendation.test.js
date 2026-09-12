import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGoalRecommendation, buildGoalProfile } from '../services/GoalRecommendationService.js';
import { DynamicUniverseService } from '../services/DynamicUniverseService.js';
import { RebalanceService } from '../services/RebalanceService.js';
import { buildGoalAssetAllocation, futureValue, requiredMonthlyContribution } from '../services/GoalAssetAllocationService.js';

const allocationTotal = (allocation) => Object.values(allocation).reduce((sum, value) => sum + value, 0);

test('goal allocation is deterministic, complete, and keeps product slots empty without provider data', () => {
  const input = { targetAmount: 5000000, currentAmount: 500000, monthlyContribution: 15000, horizonYears: 7, riskLevel: 'MODERATE', goalType: 'house' };
  const first = buildGoalAssetAllocation(input);
  const second = buildGoalAssetAllocation(input);
  assert.deepEqual(first, second);
  assert.equal(allocationTotal(first.allocation), 100);
  assert.equal(first.monthlySplit.total, 15000);
  assert.equal(first.assumptions.expectedAnnualReturnPct, 9);
  assert.equal(first.methodologyVersion, 'goal-allocation-v1');
  assert.equal(first.productBuckets.mutualFunds.items.length, 0);
  assert.equal(first.productBuckets.stocks.items.length, 0);
  first.glidepath.forEach((row) => assert.equal(allocationTotal({
    equityMutualFundsPct: row.equityMutualFundsPct,
    directEquityPct: row.directEquityPct,
    debtPct: row.debtPct,
    goldPct: row.goldPct,
    liquidPct: row.liquidPct,
  }), 100));
});

test('risk ordering, horizon adjustment, and glidepath reduce equity near the goal', () => {
  const make = (riskLevel, horizonYears) => buildGoalAssetAllocation({ targetAmount: 1000000, currentAmount: 0, monthlyContribution: 10000, horizonYears, riskLevel });
  const conservative = make('CONSERVATIVE', 7).allocation;
  const moderate = make('MODERATE', 7).allocation;
  const aggressive = make('AGGRESSIVE', 7).allocation;
  assert.ok(conservative.equityMutualFundsPct + conservative.directEquityPct < moderate.equityMutualFundsPct + moderate.directEquityPct);
  assert.ok(moderate.equityMutualFundsPct + moderate.directEquityPct < aggressive.equityMutualFundsPct + aggressive.directEquityPct);
  const short = make('AGGRESSIVE', 2).allocation;
  const long = make('AGGRESSIVE', 12).allocation;
  assert.ok(short.equityMutualFundsPct + short.directEquityPct < aggressive.equityMutualFundsPct + aggressive.directEquityPct);
  assert.ok(long.equityMutualFundsPct + long.directEquityPct > aggressive.equityMutualFundsPct + aggressive.directEquityPct);
  const glidepath = make('MODERATE', 7).glidepath;
  assert.ok(glidepath[0].directEquityPct > glidepath.at(-1).directEquityPct);
  assert.ok(glidepath[0].equityMutualFundsPct > glidepath.at(-1).equityMutualFundsPct);
});

test('zero-rate future value and required contribution are safe', () => {
  assert.equal(futureValue({ currentAmount: 1000, monthlyContribution: 200, annualRate: 0, months: 12 }), 3400);
  assert.equal(requiredMonthlyContribution({ targetAmount: 3400, currentAmount: 1000, annualRate: 0, months: 12 }), 200);
});

test('invalid allocation inputs do not receive favorable defaults', () => {
  assert.equal(buildGoalAssetAllocation({ targetAmount: 0, currentAmount: 0, monthlyContribution: 0, horizonYears: 0, riskLevel: 'MODERATE' }).feasibility.status, 'INSUFFICIENT_INPUT');
  assert.equal(buildGoalAssetAllocation({ targetAmount: 1000, currentAmount: -1, monthlyContribution: 0, horizonYears: 5, riskLevel: 'MODERATE' }).feasibility.status, 'INSUFFICIENT_INPUT');
  assert.equal(buildGoalAssetAllocation({ targetAmount: 1000, currentAmount: 0, monthlyContribution: 0, horizonYears: 5, riskLevel: 'UNKNOWN' }).feasibility.status, 'INSUFFICIENT_INPUT');
});

const sampleStocks = [
  { ticker: 'HDFCBANK', name: 'HDFC Bank', sector: 'Banking', price: 1700, changePct: 1.5, pe: 18, roe: 17, marketCap: '₹12L Cr', volatility: 0.13, marketCapSegment: 'LARGE' },
  { ticker: 'RELIANCE', name: 'Reliance Industries', sector: 'Energy', price: 2910, changePct: 2.2, pe: 26, roe: 9, marketCap: '₹19L Cr', volatility: 0.18, marketCapSegment: 'LARGE' },
  { ticker: 'INFY', name: 'Infosys', sector: 'IT', price: 1540, changePct: 1.1, pe: 27, roe: 28, marketCap: '₹7L Cr', volatility: 0.16, marketCapSegment: 'LARGE' },
  { ticker: 'SUNPHARMA', name: 'Sun Pharmaceuticals', sector: 'Healthcare', price: 1600, changePct: 1.8, pe: 31, roe: 15, marketCap: '₹4L Cr', volatility: 0.17, marketCapSegment: 'LARGE' },
  { ticker: 'TATAPOWER', name: 'Tata Power', sector: 'Green Energy', price: 420, changePct: 2.8, pe: 20, roe: 11, marketCap: '₹1.4L Cr', volatility: 0.22, marketCapSegment: 'LARGE' },
  { ticker: 'LT', name: 'Larsen & Toubro', sector: 'Manufacturing', price: 3540, changePct: 2.1, pe: 20, roe: 13, marketCap: '₹4.8L Cr', volatility: 0.19, marketCapSegment: 'LARGE' },
  { ticker: 'ITC', name: 'ITC', sector: 'FMCG', price: 460, changePct: 0.9, pe: 24, roe: 30, marketCap: '₹6L Cr', volatility: 0.11, marketCapSegment: 'LARGE' }
];

// ~30 observations per stock: enough to clear the volatility minimum sample
// size (20) used by the tightened PARTIAL/COMPLETE eligibility rule, but not
// the drawdown (60) or one-year-return (200) minimums — so together with
// each stock's pe+roe above, these reach PARTIAL (volatility + P/E + ROE = 3
// verified metrics spanning both required categories) rather than
// INSUFFICIENT_DATA, letting the differs-by-goal-profile test below exercise
// real ranked recommendations. Mirrors the real
// StockHistoricalMetricsSnapshot shape (see StockHistoricalMetricsService.js)
// rather than raw candles, since GoalRecommendationService now reads that
// snapshot directly instead of recomputing from a candle series.
const buildSampleMetricsSnapshot = (basePrice, seed, days = 30) => ({
  observationCount: days,
  firstDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
  lastDate: new Date().toISOString(),
  lastClose: basePrice,
  // Base 20 (not a lower value) so the resulting riskScore reliably lands
  // within the MODERATE eligibility band [20,78] used by riskTierAllows even
  // when maxDrawdown is unavailable (days < 60) and Math.abs(null) === 0
  // contributes nothing to the coarse pre-filter's risk score.
  annualizedVolatility: days >= 20 ? Number((20 + (seed % 10)).toFixed(2)) : null,
  maximumDrawdown: days >= 60 ? Number((-(10 + (seed % 15))).toFixed(2)) : null,
  oneYearReturn: days >= 200 ? Number(((seed % 20) - 10).toFixed(2)) : null,
  liquidityClassification: 'HIGH',
  corporateActionAdjustmentStatus: 'NOT_REQUIRED',
  provider: 'NSE_BHAVCOPY',
  dataAsOf: new Date().toISOString(),
});

const sampleResearchData = sampleStocks.map((stock, index) => ({
  symbol: stock.ticker,
  metricsSnapshot: buildSampleMetricsSnapshot(stock.price, index * 3 + 1),
}));

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

  const houseRecommendation = await buildGoalRecommendation(houseGoal, sampleStocks, {}, { researchData: sampleResearchData });
  const retirementRecommendation = await buildGoalRecommendation(retirementGoal, sampleStocks, {}, { researchData: sampleResearchData });

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

test('DynamicUniverseService merges cached P/E and ROE onto stocks that lack them, and never overwrites a real value the price provider already supplied', async () => {
  const fakeStockService = {
    getAllStocks: async () => [
      { ticker: 'NOFUNDAMENTALS', marketCap: '₹5000 Cr', volume: 100 },
      { ticker: 'HASOWNPE', marketCap: '₹5000 Cr', volume: 100, pe: 99 },
    ],
  };
  const cachedFundamentals = { NOFUNDAMENTALS: { pe: 21.5, roe: 16.2 }, HASOWNPE: { pe: 12, roe: 10 } };
  const getFundamentalsFn = async (symbol) => cachedFundamentals[symbol] || null;

  const screener = new DynamicUniverseService(fakeStockService, { getFundamentalsFn });
  const universe = await screener.getEligibleUniverse({ minMarketCapCr: 1000, forceRefresh: true });

  const noFundamentals = universe.find((s) => s.ticker === 'NOFUNDAMENTALS');
  assert.equal(noFundamentals.pe, 21.5);
  assert.equal(noFundamentals.roe, 16.2);

  const hasOwnPe = universe.find((s) => s.ticker === 'HASOWNPE');
  assert.equal(hasOwnPe.pe, 99, 'a real pe already present must never be overwritten by the cached fundamentals value');
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
    marketCapSegment: 'LARGE',
  };
  const researchData = [{
    symbol: 'COMPLETESTOCK',
    // Low volatility/drawdown so this stock's real measured risk lands
    // comfortably within the CONSERVATIVE eligibility band below (riskScore
    // = clamp((12-10)*2.2,0,65) + clamp(3*0.75,0,25) ≈ 6.65, well under the
    // CONSERVATIVE ceiling of 25).
    metricsSnapshot: {
      observationCount: 252, oneYearReturn: 15, annualizedVolatility: 12, maximumDrawdown: -3, liquidityClassification: 'HIGH', corporateActionAdjustmentStatus: 'NOT_REQUIRED', provider: 'NSE_BHAVCOPY', dataAsOf: new Date().toISOString(),
    },
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

  assert.ok(firstMatch, 'a stock with all 5 original verified metrics must be rankable');
  assert.equal(firstMatch.scoreStatus, 'COMPLETE');
  assert.equal(firstMatch.confidence, 'HIGH');
  // Coverage denominator is now 9 (the 4 derived-fundamental metrics --
  // revenueGrowth/profitGrowth/operatingMargin/debtTrend -- were added
  // alongside volatility/oneYearReturn/maxDrawdown/valuation/quality so a
  // stock can reach eligibility via CompanyHistoricalFact-derived data when
  // IndianAPI is unavailable); this stock supplies none of the 4 new ones,
  // so 5/9 = 56%, not the old 5/5 = 100%. scoreStatus is unaffected because
  // COMPLETE is an absolute count (>=4), not a percentage.
  assert.equal(firstMatch.dataCoveragePct, 56);
  assert.ok(typeof firstMatch.goalFitScore === 'number' && firstMatch.goalFitScore >= 0 && firstMatch.goalFitScore <= 100);
  // Deterministic: identical verified inputs must produce the identical score.
  assert.equal(firstMatch.goalFitScore, secondMatch.goalFitScore);
});

test('missing data lowers coverage, not risk: partial historical data (volatility only) never fabricates a risk score', async () => {
  const partialStock = {
    ticker: 'PARTIALSTOCK',
    name: 'Partial Data Ltd',
    sector: 'Auto', // distinct from every sampleStocks sector to avoid sector-diversity dedup ambiguity
    price: 800,
    changePct: 0.8,
    pe: 25,
    roe: 14,
    marketCapSegment: 'LARGE',
  };
  // 30 observations clears the volatility minimum (20) but not the drawdown
  // (60) or one-year-return (200) minimums, so only volatility is verified
  // from the historical side — combined with pe+roe this is a genuine
  // 3-metric, both-category PARTIAL case (see also the dedicated "mixed
  // three-metric PARTIAL" test below).
  const researchData = [{ symbol: 'PARTIALSTOCK', metricsSnapshot: buildSampleMetricsSnapshot(800, 5) }];

  const recommendation = await buildGoalRecommendation({ ...wealthGoal, id: 'goal-partial' }, [partialStock, ...sampleStocks], {}, { researchData });
  const match = recommendation.recommendations.find((item) => item.symbol === 'PARTIALSTOCK');

  assert.ok(match, 'volatility + P/E + ROE (3 metrics spanning both categories) should be rankable as PARTIAL');
  assert.equal(match.scoreStatus, 'PARTIAL');
  // 3/9 (denominator widened by the 4 derived-fundamental metrics -- see the
  // COMPLETESTOCK test above for why).
  assert.equal(match.dataCoveragePct, 33);
  assert.deepEqual(match.missingMetrics.sort(), ['debtTrend', 'maxDrawdown', 'oneYearReturn', 'operatingMargin', 'profitGrowth', 'revenueGrowth']);
  // Drawdown is still unverified (needs 60+ observations) even though
  // volatility is — the risk score must not be fabricated from volatility
  // alone.
  assert.equal(match.riskScore, null);
  assert.equal(match.risk, 'UNKNOWN');
});

// --- Eligibility-tightening regression tests (commit "require sufficient
// evidence for goal scores") ---
// The PARTIAL tier previously allowed a numeric score with just 1 verified
// metric. These prove the new rule: PARTIAL requires >=3/5 metrics spanning
// both the historical and fundamental categories; anything less is
// INSUFFICIENT_DATA with goalFitScore/riskScore null and is excluded from
// ranked recommendations regardless of sector fit.

const tighteningGoal = { ...wealthGoal, id: 'goal-tightening', sector: 'Auto' };

test('only P/E available is insufficient (1 metric)', async () => {
  const stock = { ticker: 'ONLYPE', name: 'Only PE Ltd', sector: 'Auto', price: 300, changePct: 0.4, pe: 19 };
  const recommendation = await buildGoalRecommendation({ ...tighteningGoal, id: 'goal-only-pe' }, [stock], {}, { researchData: [] });
  const match = recommendation.recommendations.find((item) => item.symbol === 'ONLYPE');
  assert.equal(match, undefined, 'a single verified metric must never produce a ranked recommendation');
  assert.equal(recommendation.dataQualitySummary.insufficientDataExcludedCount, 1);
});

test('only volatility available is insufficient (1 metric)', async () => {
  const stock = { ticker: 'ONLYVOL', name: 'Only Volatility Ltd', sector: 'Auto', price: 300, changePct: 0.4 };
  // 30 observations clears the volatility-only minimum (20) but nothing else,
  // and no pe/roe are supplied at all.
  const researchData = [{ symbol: 'ONLYVOL', metricsSnapshot: buildSampleMetricsSnapshot(300, 9) }];
  const recommendation = await buildGoalRecommendation({ ...tighteningGoal, id: 'goal-only-vol' }, [stock], {}, { researchData });
  const match = recommendation.recommendations.find((item) => item.symbol === 'ONLYVOL');
  assert.equal(match, undefined, 'a single verified metric must never produce a ranked recommendation');
  assert.equal(recommendation.dataQualitySummary.insufficientDataExcludedCount, 1);
});

test('two strong metrics (P/E + ROE) are insufficient without any historical evidence', async () => {
  const stock = { ticker: 'TWOSTRONG', name: 'Two Strong Ltd', sector: 'Auto', price: 300, changePct: 0.4, pe: 21, roe: 20 };
  const recommendation = await buildGoalRecommendation({ ...tighteningGoal, id: 'goal-two-strong' }, [stock], {}, { researchData: [] });
  const match = recommendation.recommendations.find((item) => item.symbol === 'TWOSTRONG');
  assert.equal(match, undefined, 'two verified metrics from a single category must never produce a ranked recommendation');
  assert.equal(recommendation.dataQualitySummary.insufficientDataExcludedCount, 1);
});

test('three metrics from a single category (all historical, no fundamentals) is insufficient', async () => {
  const stock = { ticker: 'ALLHIST', name: 'All Historical Ltd', sector: 'Auto', price: 300, changePct: 0.4 };
  // 220 observations clears all three historical minimums (volatility 20,
  // drawdown 60, one-year-return 200), giving 3/5 metrics — but no pe/roe.
  const researchData = [{ symbol: 'ALLHIST', metricsSnapshot: buildSampleMetricsSnapshot(300, 13, 220) }];
  const recommendation = await buildGoalRecommendation({ ...tighteningGoal, id: 'goal-all-hist' }, [stock], {}, { researchData });
  const match = recommendation.recommendations.find((item) => item.symbol === 'ALLHIST');
  assert.equal(match, undefined, 'three metrics confined to one category must never produce a ranked recommendation');
  assert.equal(recommendation.dataQualitySummary.insufficientDataExcludedCount, 1);
});

test('a valid mixed three-metric case (volatility + P/E + ROE) is PARTIAL with a real numeric score', async () => {
  const stock = { ticker: 'MIXEDPARTIAL', name: 'Mixed Partial Ltd', sector: 'Auto', price: 300, changePct: 0.4, pe: 23, roe: 12, marketCapSegment: 'LARGE' };
  const researchData = [{ symbol: 'MIXEDPARTIAL', metricsSnapshot: buildSampleMetricsSnapshot(300, 17) }];
  const recommendation = await buildGoalRecommendation({ ...tighteningGoal, id: 'goal-mixed-partial' }, [stock], {}, { researchData });
  const match = recommendation.recommendations.find((item) => item.symbol === 'MIXEDPARTIAL');

  assert.ok(match, 'volatility + P/E + ROE spans both required categories at 3/9 metrics and must be rankable');
  assert.equal(match.scoreStatus, 'PARTIAL');
  assert.equal(match.confidence, 'MEDIUM');
  assert.equal(match.dataCoveragePct, 33);
  assert.deepEqual(match.missingMetrics.sort(), ['debtTrend', 'maxDrawdown', 'oneYearReturn', 'operatingMargin', 'profitGrowth', 'revenueGrowth']);
  assert.ok(typeof match.goalFitScore === 'number' && match.goalFitScore >= 0 && match.goalFitScore <= 100);
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

// --- "Load Eligible Stocks" fix regression tests ---

test('a stock with volatility + REAL_RESEARCH-derived revenueGrowth + operatingMargin (no pe/roe at all) is rankable as PARTIAL', async () => {
  // Mirrors a real REAL_RESEARCH-derived-fundamentals stock (e.g. TCS) when
  // IndianAPI is unavailable: no pe/roe, but real derived fundamental
  // metrics from CompanyHistoricalFact plus historical evidence.
  const stock = {
    ticker: 'DERIVEDFUND', name: 'Derived Fundamentals Ltd', sector: 'Auto', price: 500, changePct: 0.6,
    revenueGrowth: 18.5, operatingMargin: 24, fundamentalSource: 'REAL_RESEARCH_DERIVED', marketCapSegment: 'LARGE',
  };
  const researchData = [{ symbol: 'DERIVEDFUND', metricsSnapshot: buildSampleMetricsSnapshot(500, 21) }];
  const recommendation = await buildGoalRecommendation({ ...tighteningGoal, id: 'goal-derived-fund' }, [stock], {}, { researchData });
  const match = recommendation.recommendations.find((item) => item.symbol === 'DERIVEDFUND');

  assert.ok(match, 'volatility + revenueGrowth + operatingMargin spans both categories and must be rankable even with zero pe/roe');
  assert.equal(match.scoreStatus, 'PARTIAL');
  assert.ok(match.availableMetrics.includes('revenueGrowth'));
  assert.ok(match.availableMetrics.includes('operatingMargin'));
  assert.equal(match.fundamentals.pe, null);
  assert.equal(match.fundamentals.source, 'REAL_RESEARCH_DERIVED');
});

test('buildGoalRecommendation returns explicit rejectionCounts distinguishing why stocks were excluded', async () => {
  const noHistoryNoFundamentals = { ticker: 'NOCOVERAGE', name: 'No Coverage Ltd', sector: 'Auto', price: 100, changePct: 0 };
  const onlyHistorical = { ticker: 'HISTORYONLY', name: 'History Only Ltd', sector: 'Auto', price: 200, changePct: 0.2 };
  const researchData = [{ symbol: 'HISTORYONLY', metricsSnapshot: buildSampleMetricsSnapshot(200, 3, 220) }]; // all 3 historical metrics clear, no fundamentals at all

  const recommendation = await buildGoalRecommendation({ ...tighteningGoal, id: 'goal-rejection-counts' }, [noHistoryNoFundamentals, onlyHistorical], {}, { researchData });

  assert.equal(recommendation.rejectionCounts.INSUFFICIENT_HISTORY, 1, 'the stock with zero historical AND zero fundamental metrics is INSUFFICIENT_HISTORY (no historical category at all)');
  assert.equal(recommendation.rejectionCounts.AWAITING_FUNDAMENTALS, 1, 'the stock with 3 historical metrics but zero fundamentals is AWAITING_FUNDAMENTALS');
  assert.equal(recommendation.eligibleCount, 0);
  assert.equal(recommendation.evaluatedCount, 2);
});

test('buildGoalRecommendation reports universeCount/evaluatedCount/eligibleCount consistently for a mixed universe', async () => {
  const recommendation = await buildGoalRecommendation({ ...wealthGoal, id: 'goal-counts' }, sampleStocks, {}, { researchData: sampleResearchData });
  assert.equal(recommendation.universeCount, sampleStocks.length);
  assert.equal(recommendation.evaluatedCount, recommendation.dataQualitySummary.screenedCount);
  assert.equal(recommendation.eligibleCount, recommendation.recommendations.length);
});

// --- Part G/H/I: market-cap segment diversity, small-cap eligibility gate ---

const makeVerifiedStock = (overrides) => ({
  price: 500, changePct: 0.4, pe: 20, roe: 15, revenueGrowth: 10, operatingMargin: 20, ...overrides,
});
const makeVerifiedResearch = (symbol, days = 220, snapshotOverrides = {}) => ({
  symbol, metricsSnapshot: { ...buildSampleMetricsSnapshot(500, 11, days), ...snapshotOverrides },
});

test('a mixed-segment universe returns at most 2 large, 2 mid and 1 small candidate (maximums, not quotas)', async () => {
  const stocks = [
    makeVerifiedStock({ ticker: 'LARGE1', sector: 'Banking', marketCapSegment: 'LARGE' }),
    makeVerifiedStock({ ticker: 'LARGE2', sector: 'IT', marketCapSegment: 'LARGE' }),
    makeVerifiedStock({ ticker: 'LARGE3', sector: 'FMCG', marketCapSegment: 'LARGE' }),
    makeVerifiedStock({ ticker: 'MID1', sector: 'Auto', marketCapSegment: 'MID' }),
    makeVerifiedStock({ ticker: 'MID2', sector: 'Energy', marketCapSegment: 'MID' }),
    makeVerifiedStock({ ticker: 'MID3', sector: 'Healthcare', marketCapSegment: 'MID' }),
    makeVerifiedStock({ ticker: 'SMALL1', sector: 'Manufacturing', marketCapSegment: 'SMALL', marketCapCr: 2000 }),
    makeVerifiedStock({ ticker: 'SMALL2', sector: 'Consumer', marketCapSegment: 'SMALL', marketCapCr: 1500 }),
  ];
  const researchData = stocks.map((s) => makeVerifiedResearch(s.ticker, 220, { liquidityClassification: 'HIGH', corporateActionAdjustmentStatus: 'NOT_REQUIRED' }));
  const goal = { ...wealthGoal, id: 'goal-segment-diversity' }; // moderate, 10y remaining -> LARGE/MID/SMALL all allowed, caps 2/2/1
  const recommendation = await buildGoalRecommendation(goal, stocks, {}, { researchData });

  const bySegment = recommendation.recommendations.reduce((acc, r) => { acc[r.marketCapSegment] = (acc[r.marketCapSegment] || 0) + 1; return acc; }, {});
  assert.ok((bySegment.LARGE || 0) <= 2, 'at most 2 large-cap candidates');
  assert.ok((bySegment.MID || 0) <= 2, 'at most 2 mid-cap candidates');
  assert.ok((bySegment.SMALL || 0) <= 1, 'at most 1 small-cap candidate');
  assert.ok((bySegment.LARGE || 0) > 0 && (bySegment.MID || 0) > 0, 'a diverse universe should surface at least one of each larger segment');
});

test('a small-cap stock failing the strict eligibility gate (LOW liquidity) is excluded even when otherwise well-scored', async () => {
  const stocks = [makeVerifiedStock({ ticker: 'ILLIQUIDSMALL', sector: 'Manufacturing', marketCapSegment: 'SMALL', marketCapCr: 1500 })];
  const researchData = [makeVerifiedResearch('ILLIQUIDSMALL', 220, { liquidityClassification: 'LOW', corporateActionAdjustmentStatus: 'NOT_REQUIRED' })];
  const recommendation = await buildGoalRecommendation({ ...wealthGoal, id: 'goal-illiquid-small' }, stocks, {}, { researchData });
  assert.equal(recommendation.recommendations.find((r) => r.symbol === 'ILLIQUIDSMALL'), undefined, 'LOW liquidity must disqualify a small-cap candidate regardless of its score');
});

test('a small-cap stock with an unresolved corporate-action discontinuity is excluded from eligibility', async () => {
  const stocks = [makeVerifiedStock({ ticker: 'DISCONTSMALL', sector: 'Manufacturing', marketCapSegment: 'SMALL', marketCapCr: 1500 })];
  const researchData = [makeVerifiedResearch('DISCONTSMALL', 220, { liquidityClassification: 'HIGH', corporateActionAdjustmentStatus: 'UNVERIFIED' })];
  const recommendation = await buildGoalRecommendation({ ...wealthGoal, id: 'goal-disconts-small' }, stocks, {}, { researchData });
  assert.equal(recommendation.recommendations.find((r) => r.symbol === 'DISCONTSMALL'), undefined, 'an unresolved corporate-action discontinuity must disqualify a small-cap candidate');
});

test('no small-cap candidate is forced into the result when none in the universe qualifies', async () => {
  const stocks = [
    makeVerifiedStock({ ticker: 'ONLYLARGE', sector: 'Banking', marketCapSegment: 'LARGE' }),
    makeVerifiedStock({ ticker: 'BADSMALL', sector: 'Manufacturing', marketCapSegment: 'SMALL', marketCapCr: 500 }), // below the ₹1,000 Cr floor AND illiquid
  ];
  const researchData = [
    makeVerifiedResearch('ONLYLARGE'),
    makeVerifiedResearch('BADSMALL', 220, { liquidityClassification: 'LOW', corporateActionAdjustmentStatus: 'NOT_REQUIRED' }),
  ];
  const recommendation = await buildGoalRecommendation({ ...wealthGoal, id: 'goal-no-small-forced' }, stocks, {}, { researchData });
  assert.equal(recommendation.recommendations.some((r) => r.marketCapSegment === 'SMALL'), false, 'zero qualifying small-caps must mean zero small-cap results, never a forced pick');
  assert.ok(recommendation.recommendations.some((r) => r.symbol === 'ONLYLARGE'), 'the qualifying large-cap must still be returned');
});

test('goal horizon under 3 years excludes direct equity entirely, regardless of how well-scored a stock is', async () => {
  const shortGoal = {
    id: 'goal-short-horizon', type: 'car', name: 'New Car', targetAmount: 800000, currentAmount: 100000, targetYear: new Date().getFullYear() + 2, monthlyContribution: 20000, riskProfile: 'aggressive',
  };
  const stocks = [makeVerifiedStock({ ticker: 'SHORTHORIZON', sector: 'Banking', marketCapSegment: 'LARGE' })];
  const researchData = [makeVerifiedResearch('SHORTHORIZON')];
  const recommendation = await buildGoalRecommendation(shortGoal, stocks, {}, { researchData });
  assert.equal(recommendation.recommendations.length, 0, 'a <3-year goal must never recommend direct equity');
});

test('a CONSERVATIVE 3-5 year goal only ever returns large-cap candidates', async () => {
  const conservativeGoal = {
    id: 'goal-conservative-mid-horizon', type: 'education', name: 'Education Fund', targetAmount: 2000000, currentAmount: 200000, targetYear: new Date().getFullYear() + 4, monthlyContribution: 15000, riskProfile: 'conservative',
  };
  const stocks = [
    makeVerifiedStock({ ticker: 'CONSLARGE', sector: 'Banking', marketCapSegment: 'LARGE' }),
    makeVerifiedStock({
      ticker: 'CONSMID', sector: 'Auto', marketCapSegment: 'MID',
    }),
  ];
  const researchData = stocks.map((s) => makeVerifiedResearch(s.ticker));
  const recommendation = await buildGoalRecommendation(conservativeGoal, stocks, {}, { researchData });
  assert.ok(recommendation.recommendations.every((r) => r.marketCapSegment === 'LARGE'), 'a CONSERVATIVE 3-5 year goal must never surface a mid or small-cap candidate');
});

test('Part K invariant: eligibleCount + sum(primary rejectionCounts, excluding informational STALE_DATA) === evaluatedCount === universeCount', async () => {
  const stocks = [
    makeVerifiedStock({ ticker: 'WINNER', sector: 'Banking', marketCapSegment: 'LARGE' }), // will be eligible
    makeVerifiedStock({ ticker: 'EXCESSLARGE1', sector: 'IT', marketCapSegment: 'LARGE' }),
    makeVerifiedStock({ ticker: 'EXCESSLARGE2', sector: 'FMCG', marketCapSegment: 'LARGE' }), // 3rd LARGE -> excess beyond the cap of 2
    { ticker: 'NODATA', name: 'No Data Co', sector: 'Auto', price: 100, changePct: 0 }, // INSUFFICIENT_DATA
    makeVerifiedStock({ ticker: 'BADSEGSMALL', sector: 'Manufacturing', marketCapSegment: 'SMALL', marketCapCr: 500 }), // below the small-cap floor
  ];
  const researchData = [
    makeVerifiedResearch('WINNER'), makeVerifiedResearch('EXCESSLARGE1'), makeVerifiedResearch('EXCESSLARGE2'),
    makeVerifiedResearch('BADSEGSMALL', 220, { liquidityClassification: 'LOW', corporateActionAdjustmentStatus: 'NOT_REQUIRED' }),
  ];
  const recommendation = await buildGoalRecommendation({ ...wealthGoal, id: 'goal-invariant-check' }, stocks, {}, { researchData });

  const primarySum = Object.entries(recommendation.rejectionCounts)
    .filter(([code]) => code !== 'STALE_DATA')
    .reduce((sum, [, count]) => sum + count, 0);
  assert.equal(recommendation.eligibleCount + primarySum, recommendation.evaluatedCount);
  assert.equal(recommendation.evaluatedCount, recommendation.universeCount);
  assert.equal(recommendation.universeCount, stocks.length);
});

test('dividend suitability is always the honest unverified label -- never an implied dividend/passive-income claim', async () => {
  const passiveIncomeGoal = {
    id: 'goal-passive-income', type: 'passive_income', name: 'Passive Income', targetAmount: 5000000, currentAmount: 500000, targetYear: new Date().getFullYear() + 5, monthlyContribution: 15000, riskProfile: 'moderate',
  };
  const stocks = [makeVerifiedStock({ ticker: 'PASSIVECAND', sector: 'Banking', marketCapSegment: 'LARGE' })];
  const researchData = [makeVerifiedResearch('PASSIVECAND')];
  const recommendation = await buildGoalRecommendation(passiveIncomeGoal, stocks, {}, { researchData });
  const match = recommendation.recommendations.find((r) => r.symbol === 'PASSIVECAND');
  assert.ok(match);
  assert.equal(match.dividendSuitability, 'Growth/quality equity candidate; dividend suitability not verified.');
});

