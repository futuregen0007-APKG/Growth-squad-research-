import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeIncomeStatement, normalizeBalanceSheet, normalizeCashFlow, normalizeKeyRatios } from '../providers/upstox/UpstoxNormalizer.js';
import { annualFactsFromSections } from '../services/EarningsAnnualFinancials.js';
import { buildFinancialSnapshot, calculateCompanyExecutionScore } from '../services/ExecutionScoreService.js';
import { buildStockDetailFinancials, selectVerifiedGrowth } from '../services/StockDetailFinancials.js';
import { getStockDetail } from '../services/StockDetailAggregationService.js';
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/upstoxFinancialsLive.json', import.meta.url)));
const normalizers = { incomeStatement: normalizeIncomeStatement, balanceSheet: normalizeBalanceSheet, cashFlow: normalizeCashFlow, keyRatios: normalizeKeyRatios };
const sectionsFor = symbol => Object.fromEntries(Object.entries(fixtures[symbol]).map(([key, raw]) => [key, { available: true, status: 'AVAILABLE', fromCache: true, asOf: '2026-10-01T21:00:00Z', data: normalizers[key](raw, { symbol, isin: 'TEST', fetchedAt: '2026-10-01T21:00:00Z' }) }]));

for (const symbol of Object.keys(fixtures)) test(`${symbol}: replay captured production statements into annual rows and current ratios`, () => {
  const sections = sectionsFor(symbol);
  const snapshot = buildFinancialSnapshot(annualFactsFromSections(symbol, sections));
  const latest = snapshot.annualSeries.at(-1);
  const eps = sections.incomeStatement.data.epsMetrics;
  for (const [label, field] of [['eps_basic', 'basicEps'], ['eps_diluted', 'dilutedEps']]) {
    assert.equal(latest[field], eps.find(m => m.financialYear === latest.period && m.label === label).value);
    assert.equal(snapshot.metricHistory[label === 'eps_basic' ? 'BASIC_EPS' : 'DILUTED_EPS'][latest.year].unit, 'INR_PER_SHARE');
  }
  assert.ok(latest.totalAssets > 0);
  assert.ok(latest.totalLiabilities > 0);
  assert.ok(Number.isFinite(latest.investingCashFlow));
  assert.ok(Number.isFinite(latest.financingCashFlow));
  assert.ok(Number.isFinite(latest.pbt));
  for (const field of ['ebitda', 'adjustedPat', 'debt', 'freeCashFlow', 'roe', 'roce']) assert.equal(latest[field], null);
  const view = buildStockDetailFinancials({ data: { sections } });
  assert.ok(view.currentRatios.ratios.some(r => r.name === 'P/E'));
  assert.ok(view.currentRatios.ratios.every(r => !('financialYear' in r)));
  assert.equal(view.annualFinancials.incomeStatement.fromCache, true);
  assert.equal(view.annualFinancials.incomeStatement.asOf, sections.incomeStatement.asOf);
});

test('quarterly, standalone, and wrong-unit statements cannot enter annual rows or score growth', () => {
  for (const override of [{ type: 'standalone' }, { time_period: 'quarterly' }, { units_in: 'lakh' }]) {
    const raw = structuredClone(fixtures.TCS.incomeStatement);
    Object.assign(raw.data, override);
    const data = normalizeIncomeStatement(raw, { isin: 'TEST' });
    const sections = { incomeStatement: { available: true, data } };
    assert.deepEqual(annualFactsFromSections('TCS', sections), []);
    const view = buildStockDetailFinancials({ data: { sections } });
    assert.equal(view.annualFinancials.incomeStatement.rows.length, 0);
    assert.ok(view.missingSections.includes('incomeStatement'));
    assert.notEqual(view.dataCoveragePct, 100);
    assert.equal(view.growthInputs.revenueGrowth, null);
    if (override.type || override.time_period) assert.equal(view.perShareFinancials.length, 0);
  }
});

test('growth uses consecutive figures, rejects conflicting duplicates, and withholds an invalid latest year', () => {
  const rows = [{ label: 'revenue', financialYear: 'FY2025', value: 100, verifiedDefinition: 'TOTAL_INCOME' }, { label: 'revenue', financialYear: 'FY2026', value: 110, changePct: 999, verifiedDefinition: 'TOTAL_INCOME' }];
  assert.equal(selectVerifiedGrowth(rows, 'revenue').value, 10);
  assert.equal(selectVerifiedGrowth([...rows, { ...rows[1], value: 120 }], 'revenue'), null);
  assert.equal(selectVerifiedGrowth([...rows, { ...rows[1], financialYear: 'FY2027', verifiedDefinition: null }], 'revenue'), null);
});

test('score never reads legacy fundamentals, reports missing unsupported inputs and actual normalized weights', async () => {
  const view = buildStockDetailFinancials({ data: { sections: sectionsFor('HDFCBANK') } });
  const detail = await getStockDetail('HDFCBANK', { deps: {
    findProfile: async () => ({ companyName: 'HDFC Bank', marketCapCr: 123, isin: 'TEST' }),
    getMetrics: async () => ({ annualizedVolatility: 21.07, annualizedReturn: null, maxDrawdown: null, dataAsOf: '2026-09-28', verifiedMetrics: { volatility: true, return: false, drawdown: false } }),
    getFundamentalsFn: async () => { throw new Error('Legacy fundamentals must never be called'); },
    getResearchBundle: async () => ({ sections: {} }), getFinancials: async () => view,
  } });
  const score = detail.research.analystData.ownScore;
  assert.ok(score.missingMetrics.includes('operatingMargin'));
  assert.ok(score.missingMetrics.includes('debtTrend'));
  assert.ok(score.availableMetrics.includes('quality'));
  assert.notEqual(score.scoreStatus, 'COMPLETE');
  assert.notEqual(score.confidence, 'HIGH');
  assert.equal(score.inputWeights.operatingMargin, 0);
  assert.equal(score.inputWeights.debtTrend, 0);
  assert.ok(Math.abs(Object.values(score.inputWeights).reduce((a,b) => a+b,0)-100) < 0.05);
  assert.equal(detail.identity.marketCapCr, 123, 'company market cap stays independent of sector cap');
  assert.deepEqual(detail.research.financials.rows, []);
});


test('execution score withholds unsupported capital, strategy and operations components and exposes actual weights', () => {
  const financialFacts = annualFactsFromSections('TCS', sectionsFor('TCS'));
  const result = calculateCompanyExecutionScore({ facts: financialFacts, financialFacts });
  assert.equal(result.scoreBreakdown.capitalAllocation, null);
  assert.equal(result.scoreBreakdown.strategicExecution, null);
  assert.equal(result.scoreBreakdown.operationalDelivery, null);
  assert.equal(result.weightsUsed.capitalAllocation, 0);
  assert.equal(result.weightsUsed.financialDelivery, 100);
  assert.equal(result.executionScore, Math.round(result.scoreBreakdown.financialDelivery));
});
