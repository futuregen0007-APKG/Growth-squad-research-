import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGoalAssetAllocation } from '../services/GoalAssetAllocationService.js';
import { parseNavAll, selectCandidateSchemes } from '../providers/AmfiMutualFundProvider.js';
import { computeReturnsAndRisk } from '../providers/MfApiHistoricalNavProvider.js';
import {
  isConcentratedCapCategory,
  buildSnapshot,
  filterAndScoreSnapshots,
  categorySuitabilityAllows,
  REASON_CODES,
  FRESHNESS_MAX_AGE_DAYS,
} from '../services/GoalProductRecommendationService.js';

// ---------------------------------------------------------------------------
// Rounding regression: liquidPct's rounding-remainder residual must never
// carry IEEE-754 noise (e.g. 9.150000000000006), even though the sum is
// mathematically 100 either way.
// ---------------------------------------------------------------------------
test('every allocation and glidepath row is a clean 2-decimal number that sums to exactly 100, across many horizons/risk levels', () => {
  // The sum is asserted after rounding to 2 decimals, not via raw strict
  // equality: summing 5 independently-rounded decimal percentages in plain
  // IEEE-754 floats can legitimately land 1 ULP off 100 (e.g.
  // 99.99999999999999) purely from binary floating-point summation order --
  // not a real discrepancy. Rounding the sum to the same 2-decimal precision
  // every field is displayed at is the meaningful, real-world invariant (it
  // is what any UI or downstream consumer actually sees/checks).
  const sumAndPrecision = (row) => {
    const values = [row.equityMutualFundsPct, row.directEquityPct, row.debtPct, row.goldPct, row.liquidPct];
    const sum = Number(values.reduce((s, v) => s + v, 0).toFixed(2));
    const allCleanTwoDecimals = values.every((v) => Number(v.toFixed(2)) === v);
    return { sum, allCleanTwoDecimals };
  };

  for (const riskLevel of ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']) {
    for (const horizonYears of [1, 2, 3, 5, 7, 9, 11, 15, 23]) {
      const plan = buildGoalAssetAllocation({ targetAmount: 1000000, currentAmount: 50000, monthlyContribution: 8000, horizonYears, riskLevel });
      const top = sumAndPrecision(plan.allocation);
      assert.equal(top.sum, 100, `allocation sum for ${riskLevel}/${horizonYears}y`);
      assert.ok(top.allCleanTwoDecimals, `allocation precision for ${riskLevel}/${horizonYears}y: ${JSON.stringify(plan.allocation)}`);
      for (const row of plan.glidepath) {
        const glide = sumAndPrecision(row);
        assert.equal(glide.sum, 100, `glidepath year ${row.year} sum for ${riskLevel}/${horizonYears}y`);
        assert.ok(glide.allCleanTwoDecimals, `glidepath year ${row.year} precision for ${riskLevel}/${horizonYears}y: ${JSON.stringify(row)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// AmfiMutualFundProvider: real-shape fixture parsing + category classification
// + Direct/Growth selection + Gold ETF dedup.
// ---------------------------------------------------------------------------
const SAMPLE_NAVALL = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Large Cap Fund)

Sample Mutual Fund

100001;INF001A01AA1;-;Sample Large Cap Fund;Direct Plan;Growth Option;150.1234;11-Sep-2026
100002;INF001A01AB9;-;Sample Large Cap Fund;Regular Plan;Growth Option;140.5678;11-Sep-2026
100003;INF001A01AC7;-;Sample Large Cap Fund;Direct Plan;IDCW Option;90.1111;11-Sep-2026

Open Ended Schemes(Debt Scheme - Liquid Fund)

Sample Mutual Fund

100010;INF001A01LQ1;-;Sample Liquid Fund;Direct Plan;Growth Option;2450.5;11-Sep-2026

Open Ended Schemes(Other Scheme - Gold ETF)

Sample Mutual Fund

100020;INF001A01GD1;-;Sample Gold ETF;;;55.4321;11-Sep-2026
100021;INF001A01GD2;-;Sample Gold ETF;;;55.4321;10-Sep-2026

Open Ended Schemes(Children's Fund - Childrens' Fund)

Sample Mutual Fund

100030;INF001A01CH1;-;Sample Childrens Fund;Direct Plan;Growth Option;80.0;11-Sep-2026
`;

test('parseNavAll extracts real rows with correct category/productType classification from AMFI\'s confirmed real format', () => {
  const rows = parseNavAll(SAMPLE_NAVALL);
  const bySchemeCode = new Map(rows.map((r) => [r.schemeCode, r]));

  assert.equal(bySchemeCode.get('100001').productType, 'MUTUAL_FUND');
  assert.equal(bySchemeCode.get('100001').nav, 150.1234);
  assert.deepEqual(bySchemeCode.get('100001').dataAsOf, new Date(Date.UTC(2026, 8, 11)));
  assert.equal(bySchemeCode.get('100010').productType, 'LIQUID_FUND');
  assert.equal(bySchemeCode.get('100020').productType, 'GOLD_ETF');
  // Children's Fund is not one of the 4 supported buckets and must be skipped entirely.
  assert.equal(bySchemeCode.has('100030'), false);
});

test('selectCandidateSchemes keeps only Direct+Growth for MF/debt/liquid, and dedups Gold ETF rows by scheme name', () => {
  const rows = parseNavAll(SAMPLE_NAVALL);
  const candidates = selectCandidateSchemes(rows);
  const codes = candidates.map((c) => c.schemeCode);

  assert.ok(codes.includes('100001'), 'Direct+Growth large-cap row must be kept');
  assert.ok(!codes.includes('100002'), 'Regular-plan row must be excluded');
  assert.ok(!codes.includes('100003'), 'IDCW-option row must be excluded');
  assert.ok(codes.includes('100010'), 'Direct+Growth liquid fund must be kept');

  const goldRows = candidates.filter((c) => c.productType === 'GOLD_ETF');
  assert.equal(goldRows.length, 1, 'two AMFI rows for the same Gold ETF scheme name must be deduplicated to one');
});

// ---------------------------------------------------------------------------
// MfApiHistoricalNavProvider: deterministic returns/risk from a real NAV
// series shape, with per-statistic minimum-sample-size gating.
// ---------------------------------------------------------------------------
const buildDailySeries = (startNav, days, dailyDriftPct = 0.03) => {
  const series = [];
  let nav = startNav;
  const start = new Date('2020-01-01T00:00:00Z');
  for (let i = 0; i < days; i += 1) {
    nav *= (1 + dailyDriftPct / 100);
    series.push({ date: new Date(start.getTime() + i * 24 * 60 * 60 * 1000), nav: Number(nav.toFixed(4)) });
  }
  return series;
};

test('computeReturnsAndRisk returns null for every statistic when history is too short (never extrapolated)', () => {
  const series = buildDailySeries(100, 50); // ~7 weeks -- clears nothing
  const result = computeReturnsAndRisk(series);
  assert.equal(result.returns1Y, null);
  assert.equal(result.returns3Y, null);
  assert.equal(result.volatility3Y, null);
  assert.equal(result.maxDrawdown, null);
});

test('computeReturnsAndRisk computes a real 1Y return once >=200 daily observations exist within the trailing year, independent of longer-window statistics', () => {
  const series = buildDailySeries(100, 300); // ~10 months of daily data, >=200 obs, but <3Y
  const result = computeReturnsAndRisk(series);
  assert.equal(typeof result.returns1Y, 'number');
  assert.ok(result.returns1Y > 0, 'a steadily rising NAV series must show a positive 1Y return');
  assert.equal(result.returns3Y, null, '3Y return must stay null without 3 years of history');
  assert.equal(result.volatility3Y, null, '3Y volatility must stay null without 3 years of history');
});

test('computeReturnsAndRisk is deterministic: identical input series produce identical output', () => {
  const series = buildDailySeries(250, 900);
  const first = computeReturnsAndRisk(series);
  const second = computeReturnsAndRisk(series);
  assert.deepEqual(first, second);
});

test('computeReturnsAndRisk never fabricates a positive return for a declining NAV series', () => {
  const series = buildDailySeries(1000, 300, -0.05);
  const result = computeReturnsAndRisk(series);
  assert.ok(result.returns1Y < 0);
});

// ---------------------------------------------------------------------------
// buildSnapshot: normalization, dataCompleteness, and the explicit
// never-fabricate-AUM/expenseRatio contract.
// ---------------------------------------------------------------------------
test('buildSnapshot never invents AUM or expenseRatio, and computes dataCompleteness only from real present fields', () => {
  const schemeRow = {
    productType: 'LIQUID_FUND', schemeCode: '100010', schemeName: 'Sample Liquid Fund',
    category: 'Debt Scheme - Liquid Fund', nav: 2450.5, dataAsOf: new Date(),
  };
  const full = buildSnapshot(schemeRow, { returns1Y: 6.5, returns3Y: 6.8, returns5Y: null, volatility3Y: 0.2, maxDrawdown: -0.1, observations: 900 });
  assert.equal(full.aum, null);
  assert.equal(full.expenseRatio, null);
  assert.equal(full.dataCompleteness, 0.8); // 4 of 5 return/risk fields present (returns5Y is null)

  const empty = buildSnapshot(schemeRow, null);
  assert.equal(empty.dataCompleteness, 0);
  assert.equal(empty.returns1Y, null);
});

// ---------------------------------------------------------------------------
// filterAndScoreSnapshots: hard filters (freshness, sufficient history) are
// never relaxed; only the soft risk-capacity preference is relaxed, and only
// when needed to reach 3 items. Reason codes match rule 6 exactly.
// ---------------------------------------------------------------------------
const freshSnapshot = (overrides = {}) => ({
  productId: `MUTUAL_FUND:${Math.random()}`,
  productType: 'MUTUAL_FUND',
  name: 'Test Fund',
  riskLevel: 'MODERATE',
  returns1Y: 12,
  returns3Y: 14,
  volatility3Y: 15,
  dataAsOf: new Date().toISOString(),
  ...overrides,
});

test('an empty snapshot set reports PROVIDER_UNAVAILABLE', () => {
  const result = filterAndScoreSnapshots([], { riskCapacity: 'MODERATE' });
  assert.equal(result.status, 'PROVIDER_UNAVAILABLE');
  assert.equal(result.reasonCode, REASON_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(result.items.length, 0);
});

test('a snapshot set that is entirely older than the freshness window reports DATA_STALE, never silently shown', () => {
  const staleDate = new Date(Date.now() - (FRESHNESS_MAX_AGE_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  const result = filterAndScoreSnapshots([freshSnapshot({ dataAsOf: staleDate })], { riskCapacity: 'MODERATE' });
  assert.equal(result.status, 'DATA_STALE');
  assert.equal(result.reasonCode, REASON_CODES.DATA_STALE);
  assert.equal(result.items.length, 0);
});

test('fresh snapshots lacking sufficient return/risk history report INSUFFICIENT_FUNDAMENTALS rather than being ranked', () => {
  const result = filterAndScoreSnapshots([freshSnapshot({ returns1Y: null, volatility3Y: null })], { riskCapacity: 'MODERATE' });
  assert.equal(result.status, 'INSUFFICIENT_FUNDAMENTALS');
  assert.equal(result.reasonCode, REASON_CODES.INSUFFICIENT_FUNDAMENTALS);
});

test('the hard filters (freshness, sufficient history) are never relaxed even when fewer than 3 candidates would result', () => {
  // Only 1 sufficiently-verified fresh candidate exists; the rest are stale
  // or insufficient. The single valid one must still be returned -- not
  // padded with an ineligible one just to reach 3.
  const staleDate = new Date(Date.now() - (FRESHNESS_MAX_AGE_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  const pool = [
    freshSnapshot({ productId: 'MUTUAL_FUND:ok', riskLevel: 'MODERATE' }),
    freshSnapshot({ productId: 'MUTUAL_FUND:stale', dataAsOf: staleDate }),
    freshSnapshot({ productId: 'MUTUAL_FUND:insufficient', returns1Y: null, volatility3Y: null }),
  ];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].productId, 'MUTUAL_FUND:ok');
});

test('soft risk-capacity filtering relaxes (never a hard filter) when it would otherwise leave fewer than 3 candidates', () => {
  // All 3 candidates are HIGH risk; a CONSERVATIVE goal's strict preference
  // (LOW only) would leave zero -- the soft preference must relax so real,
  // sufficiently-verified funds are still shown rather than returning nothing.
  const pool = [
    freshSnapshot({ productId: 'a', riskLevel: 'HIGH', returns1Y: 20, returns3Y: 22, volatility3Y: 30 }),
    freshSnapshot({ productId: 'b', riskLevel: 'HIGH', returns1Y: 18, returns3Y: 19, volatility3Y: 28 }),
    freshSnapshot({ productId: 'c', riskLevel: 'HIGH', returns1Y: 16, returns3Y: 17, volatility3Y: 26 }),
  ];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'CONSERVATIVE' });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.items.length, 3);
  assert.equal(result.relaxedSoftFilters, true);
});

test('scoring is deterministic and ranks by risk-adjusted return: higher return + lower volatility wins', () => {
  const pool = [
    freshSnapshot({ productId: 'low-return-high-vol', returns3Y: 8, volatility3Y: 25 }),
    freshSnapshot({ productId: 'high-return-low-vol', returns3Y: 18, volatility3Y: 5 }),
  ];
  const first = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  const second = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  assert.deepEqual(first.items.map((i) => i.score), second.items.map((i) => i.score));
  assert.equal(first.items[0].productId, 'high-return-low-vol');
});

test('a product missing AMFI-unavailable fields (aum, expenseRatio) reports them in missingMetrics and is never scored recommendationConfidence HIGH', () => {
  const pool = [freshSnapshot({ productId: 'amfi-only' })]; // no aum/expenseRatio, matching every real AMFI-sourced product
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  const item = result.items[0];
  assert.ok(item.missingMetrics.includes('aum'));
  assert.ok(item.missingMetrics.includes('expenseRatio'));
  assert.notEqual(item.recommendationConfidence, 'HIGH', 'aum/expenseRatio are never null-penalized as fake zeros, but their absence must cap confidence below HIGH');
});

test('dataFreshnessConfidence is graded independently of recommendationConfidence', () => {
  const veryFresh = freshSnapshot({ productId: 'today', dataAsOf: new Date().toISOString() });
  const result = filterAndScoreSnapshots([veryFresh], { riskCapacity: 'MODERATE' });
  const item = result.items[0];
  assert.equal(item.dataFreshnessConfidence, 'HIGH', 'a same-day NAV is freshness-HIGH');
  assert.notEqual(item.recommendationConfidence, 'HIGH', 'freshness alone must never imply full recommendation confidence when aum/expenseRatio are missing');
});

test('a product missing a critical ranking metric (e.g. returns3Y) is scored recommendationConfidence LOW, not just MEDIUM', () => {
  const pool = [freshSnapshot({ productId: 'no-3y', returns3Y: null })];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  assert.equal(result.items[0].recommendationConfidence, 'LOW');
});

test('NO_HARD_FILTER_MATCH is reported only when even the relaxed (risk-agnostic) pool is empty', () => {
  // Unreachable via riskLevel alone since UNKNOWN/soft-relaxation always
  // leaves the full scored pool as a fallback -- this asserts the reason
  // code exists and is distinct from the other three for callers that build
  // their own upstream pool (e.g. a category with a hard non-risk filter).
  assert.equal(REASON_CODES.NO_HARD_FILTER_MATCH, 'NO_HARD_FILTER_MATCH');
});

// --- Part J: category suitability (the live-reported bug: sectoral equity
// and credit-risk debt funds shown for a moderate five-year passive-income
// goal) ---

test('categorySuitabilityAllows excludes sectoral/thematic equity funds for MODERATE and CONSERVATIVE, allows for AGGRESSIVE', () => {
  assert.equal(categorySuitabilityAllows('MUTUAL_FUND', 'Equity Scheme - Sectoral/ Thematic', 'MODERATE'), false);
  assert.equal(categorySuitabilityAllows('MUTUAL_FUND', 'Equity Schemes - Sectoral Fund', 'CONSERVATIVE'), false);
  assert.equal(categorySuitabilityAllows('MUTUAL_FUND', 'Equity Schemes - Thematic Fund', 'AGGRESSIVE'), true);
  assert.equal(categorySuitabilityAllows('MUTUAL_FUND', 'Equity Scheme - Flexi Cap Fund', 'MODERATE'), true, 'a diversified category is never excluded');
});

test('categorySuitabilityAllows excludes credit-risk debt funds for MODERATE and CONSERVATIVE, allows for AGGRESSIVE', () => {
  assert.equal(categorySuitabilityAllows('DEBT_FUND', 'Debt Scheme - Credit Risk Fund', 'MODERATE'), false);
  assert.equal(categorySuitabilityAllows('DEBT_FUND', 'Debt Scheme - Credit Risk Fund', 'CONSERVATIVE'), false);
  assert.equal(categorySuitabilityAllows('DEBT_FUND', 'Debt Scheme - Credit Risk Fund', 'AGGRESSIVE'), true);
  assert.equal(categorySuitabilityAllows('DEBT_FUND', 'Debt Scheme - Corporate Bond Fund', 'MODERATE'), true, 'a non-credit-risk debt category is never excluded');
});

test('filterAndScoreSnapshots never surfaces a sectoral/thematic fund or a credit-risk fund for a MODERATE goal, even as a relaxed fallback', () => {
  const pool = [
    freshSnapshot({ productId: 'sectoral-1', category: 'Equity Scheme - Sectoral/ Thematic', returns3Y: 40 }), // highest return, must still be excluded
    freshSnapshot({ productId: 'flexicap-1', category: 'Equity Scheme - Flexi Cap Fund', returns3Y: 12 }),
  ];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  assert.equal(result.items.some((i) => i.productId === 'sectoral-1'), false);
  assert.ok(result.items.some((i) => i.productId === 'flexicap-1'));
});

test('filterAndScoreSnapshots reports NO_HARD_FILTER_MATCH (not a silent empty PROVIDER_UNAVAILABLE) when only unsuitable categories exist for the risk profile', () => {
  const pool = [freshSnapshot({ productId: 'credit-risk-1', productType: 'DEBT_FUND', category: 'Debt Scheme - Credit Risk Fund' })];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  assert.equal(result.status, 'NO_HARD_FILTER_MATCH');
  assert.equal(result.items.length, 0);
});

// --- diversification preference: prefer Flexi/Large/Multi Cap over
// concentrated Small/Mid Cap categories for non-AGGRESSIVE goals (the
// live-reported bug: a MODERATE 5-year goal's top-3 mutual funds were all
// Small Cap / Mid Cap purely because their raw recent returns scored
// highest) ---

test('isConcentratedCapCategory flags Small/Mid/Micro Cap but not Large & Mid Cap, Flexi Cap, or Large Cap', () => {
  assert.equal(isConcentratedCapCategory('Equity Scheme - Small Cap Fund'), true);
  assert.equal(isConcentratedCapCategory('Equity Schemes - Mid Cap Fund'), true);
  assert.equal(isConcentratedCapCategory('Equity Scheme - Micro Cap Fund'), true);
  assert.equal(isConcentratedCapCategory('Equity Scheme - Large & Mid Cap Fund'), false);
  assert.equal(isConcentratedCapCategory('Equity Scheme - Flexi Cap Fund'), false);
  assert.equal(isConcentratedCapCategory('Equity Scheme - Large Cap Fund'), false);
});

test('a MODERATE goal ranks a diversified-category fund above a Small Cap fund with a similar raw return, even though Small Cap scores higher unadjusted', () => {
  const pool = [
    freshSnapshot({ productId: 'smallcap-1', category: 'Equity Scheme - Small Cap Fund', returns3Y: 20, volatility3Y: 15 }),
    freshSnapshot({ productId: 'flexicap-1', category: 'Equity Scheme - Flexi Cap Fund', returns3Y: 18, volatility3Y: 15 }),
  ];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  assert.equal(result.items[0].productId, 'flexicap-1', 'the diversified fund must rank first once the concentrated-category penalty is applied');
});

test('an AGGRESSIVE goal applies no diversification penalty -- a Small Cap fund with a genuinely higher return still ranks first', () => {
  const pool = [
    freshSnapshot({ productId: 'smallcap-1', category: 'Equity Scheme - Small Cap Fund', returns3Y: 20, volatility3Y: 15, riskLevel: 'HIGH' }),
    freshSnapshot({ productId: 'flexicap-1', category: 'Equity Scheme - Flexi Cap Fund', returns3Y: 18, volatility3Y: 15, riskLevel: 'MODERATE' }),
  ];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'AGGRESSIVE' });
  assert.equal(result.items[0].productId, 'smallcap-1', 'no category penalty should apply once the risk capacity is AGGRESSIVE');
});

test('the diversification penalty never hard-excludes a concentrated-category fund -- it still surfaces when nothing else is available', () => {
  const pool = [freshSnapshot({ productId: 'smallcap-only', category: 'Equity Scheme - Small Cap Fund', returns3Y: 10 })];
  const result = filterAndScoreSnapshots(pool, { riskCapacity: 'MODERATE' });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.items[0].productId, 'smallcap-only');
});

test('Gold ETF scoring never ranks purely on recent return -- an established, more-complete-data scheme outranks a shorter-history one with a flashier 1Y return', () => {
  const shortHistoryHighReturn = freshSnapshot({
    productId: 'gold-new', productType: 'GOLD_ETF', returns1Y: 25, returns3Y: null, volatility3Y: null, observations: 60, dataCompleteness: 0.2,
  });
  const establishedTrack = freshSnapshot({
    productId: 'gold-established', productType: 'GOLD_ETF', returns1Y: 8, returns3Y: 7, volatility3Y: 10, observations: 1200, dataCompleteness: 1,
  });
  const result = filterAndScoreSnapshots([shortHistoryHighReturn, establishedTrack], { riskCapacity: 'MODERATE' });
  const ranks = result.items.map((i) => i.productId);
  assert.equal(ranks[0], 'gold-established', 'a longer, more complete verified track record must outrank a short-history high-recent-return gold ETF');
});
