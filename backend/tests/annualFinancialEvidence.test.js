import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAnnualFact } from '../services/AnnualFinancialEvidence.js';
import { buildFinancialSnapshot, calculateCompanyExecutionScore, calculateConfidence } from '../services/ExecutionScoreService.js';
import { annualFactsFromSections, loadEarningsAnnualFinancials } from '../services/EarningsAnnualFinancials.js';

const annual = (year, value, metric = 'REVENUE') => ({ period: `FY${year}`, verified: true,
  fact: `${metric === 'PAT' ? 'Profit after tax' : 'Total income'} for the year ended March 31, ${year} (Consolidated).`,
  metrics: { metric, actualValue: value, unit: 'INR_CRORE' },
  source: { url: 'https://example.test/results', excerpt: `${value} crore for the year ended March 31, ${year}` } });

test('source reporting year defeats an incorrectly extracted FY tag', () => {
  const wrong = { ...annual(2025, 470915.93), period: 'FY2026' };
  assert.equal(assessAnnualFact(wrong).reason, 'REPORTING_YEAR_MISMATCH');
  const good = annual(2026, 495462.81);
  for (const input of [[good, wrong], [wrong, good]]) assert.equal(buildFinancialSnapshot(input).annualSeries[0].revenue, 495462.81);
});

test('quarterly prose is rejected even when the period tag says annual', () => {
  const wrong = { ...annual(2023, 919599, 'PAT'), fact: '919599 lac for the quarter ended June 30, 2022.' };
  assert.equal(assessAnnualFact(wrong).reason, 'SUB_YEAR_SOURCE');
  assert.equal(buildFinancialSnapshot([wrong]).patCagr, null);
});

test('lakhs labelled crores and unsupported monetary units are withheld', () => {
  assert.equal(assessAnnualFact({ ...annual(2023, 919599, 'PAT'), fact: '919599 lac (Consolidated).' }).reason, 'SOURCE_UNIT_MISMATCH');
  const wrong = annual(2023, 100);
  wrong.metrics.unit = 'INR_LAKH';
  assert.equal(assessAnnualFact(wrong).reason, 'UNIT_UNVERIFIED');
  const missing = annual(2023, 1259447, 'PAT');
  missing.source.excerpt = 'Consolidated net profit 1259447';
  assert.equal(assessAnnualFact(missing).reason, 'SOURCE_UNIT_UNVERIFIED');
});

test('deposit facts cannot drive the debt trend', () => {
  const deposit = annual(2023, 160362905, 'DEBT');
  deposit.fact = 'Consolidated deposits as at March 31, 2023.';
  assert.equal(assessAnnualFact(deposit).reason, 'DEPOSITS_ARE_NOT_DEBT');
  assert.equal(buildFinancialSnapshot([deposit]).debtTrend, 'Unavailable');
});

test('equally supported conflicting annual values are withheld independently of order', () => {
  const input = [annual(2025, 100), annual(2025, 200), annual(2026, 220)];
  for (const facts of [input, [...input].reverse()]) {
    const s = buildFinancialSnapshot(facts);
    assert.equal(s.metricHistory.REVENUE[2025], undefined);
    assert.equal(s.revenueCagr, null);
    assert.ok(s.quality.excludedFacts.some(f => f.reason === 'CONFLICTING_ANNUAL_VALUES'));
  }
});

test('consolidated and standalone years never form one CAGR', () => {
  const standalone = annual(2025, 100);
  standalone.fact = standalone.fact.replace('Consolidated', 'Standalone');
  const s = buildFinancialSnapshot([standalone, annual(2026, 200)]);
  assert.equal(s.revenueCagr, null);
  assert.deepEqual(s.coveredYears, ['FY2026']);
});

test('revenue from operations and total income do not form one CAGR', () => {
  const operations = annual(2025, 100);
  operations.fact = operations.fact.replace('Total income', 'Revenue from operations');
  const s = buildFinancialSnapshot([operations, annual(2026, 200)]);
  assert.equal(s.revenueCagr, null);
});

test('XBRL duration is checked, not merely its FY title', () => {
  const q = annual(2026, 100);
  q.source.excerpt = 'context OneD 2026-01-01..2026-03-31';
  assert.equal(assessAnnualFact(q).reason, 'SUB_YEAR_SOURCE');
});

const sections = { incomeStatement: { available: true, fromCache: true, data: {
  isin: 'TEST', statementType: 'CONSOLIDATED', period: 'YEARLY', units: 'INR_CRORE',
  metrics: [
    { financialYear: 'FY2025', value: 470915.93, verifiedDefinition: 'TOTAL_INCOME', verifiedLabel: 'Total income' },
    { financialYear: 'FY2026', value: 495462.81, verifiedDefinition: 'TOTAL_INCOME', verifiedLabel: 'Total income' },
    { financialYear: 'FY2025', value: 73440.17, verifiedDefinition: 'PROFIT_AFTER_TAX' },
    { financialYear: 'FY2026', value: 79219.46, verifiedDefinition: 'PROFIT_AFTER_TAX' },
    { financialYear: 'FY2026', value: 102141.45, verifiedDefinition: 'PROFIT_BEFORE_TAX' },
    { financialYear: 'FY2026', value: 999, verifiedDefinition: null },
  ] } } };

test('on-demand annual statements replace extracted values without merging or writing', () => {
  const providerFacts = annualFactsFromSections('HDFCBANK', sections);
  assert.equal(providerFacts.length, 4, 'PBT and unknown definitions excluded');
  const old = { ...annual(2025, 470915.93), period: 'FY2026' };
  const result = calculateCompanyExecutionScore({ facts: [old, annual(2023, 999999), annual(2022, 99999)], financialFacts: providerFacts });
  const s = result.financialSnapshot;
  assert.equal(s.metricHistory.PAT[2026].value, 79219.46);
  assert.equal(s.revenueLabel, 'Total income');
  assert.equal(s.revenueCagr, 5.21);
  assert.equal(s.patCagr, 7.87);
  assert.deepEqual(s.coveredYears, ['FY2025', 'FY2026']);
  assert.equal(s.ebitdaCagr, null);
});

test('unavailable provider data cannot silently fall back to extracted annual cells', () => {
  const r = calculateCompanyExecutionScore({ facts: [annual(2022, 100), annual(2025, 200), annual(2026, 220)], financialFacts: [] });
  assert.equal(r.executionScore, null);
  assert.deepEqual(r.financialSnapshot.annualSeries, []);
});

test('conflicting historical data prevents HIGH-confidence claims', () => {
  const r = calculateConfidence({ facts: Array(25).fill({}), sources: Array(8).fill({}), coverageYears: ['FY2023', 'FY2024', 'FY2025', 'FY2026'], financialQuality: { excludedFactsCount: 1 } });
  assert.equal(r.level, 'LOW');
});

test('unconfigured Upstox reports unavailable before making database or network calls', async () => {
  assert.equal((await loadEarningsAnnualFinancials('HDFCBANK')).status, 'UNAVAILABLE');
});
