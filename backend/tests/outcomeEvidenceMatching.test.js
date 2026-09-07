import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPromiseToIndianApiEvidence, findMetricValueInRaw } from '../services/OutcomeEvidenceService.js';

const financialEvidence = (period, raw, sourceUrl = null) => ({
  evidenceType: 'FINANCIAL_ACTUAL',
  period,
  evidenceDate: '2025-05-15T00:00:00.000Z',
  sourceUrl,
  sourceTitle: 'IndianAPI company financials',
  raw,
});

test('findMetricValueInRaw finds a hinted field and ignores unrelated fields', () => {
  const found = findMetricValueInRaw('REVENUE', { totalRevenue: 25000, unrelatedField: 99 });
  assert.equal(found.value, 25000);
  assert.match(found.rawFieldName, /totalRevenue/);
});

test('findMetricValueInRaw returns null for metrics with no known field hints (never guesses)', () => {
  assert.equal(findMetricValueInRaw('ORDER_BOOK', { orderBookValue: 5000 }), null);
  assert.equal(findMetricValueInRaw('OTHER_QUANTIFIABLE', { anything: 1 }), null);
});

test('matchPromiseToIndianApiEvidence matches an exact-period, compatible-unit promise', () => {
  const promise = { metric: 'REVENUE', targetValue: 250000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2025' };
  const evidence = [financialEvidence('FY2025', { totalRevenue: 260000 })];
  const match = matchPromiseToIndianApiEvidence(promise, evidence);
  assert.ok(match);
  assert.equal(match.actualValue, 260000);
  assert.equal(match.actualUnit, 'INR_CRORE');
  assert.equal(match.actualPeriod, 'FY2025');
  assert.equal(match.evidenceType, 'FINANCIAL_ACTUAL');
  assert.equal(match.provider, 'indian-api');
});

test('matchPromiseToIndianApiEvidence converts an equivalent INR unit into the promise\'s own unit', () => {
  // Promise target is in INR_MILLION; IndianAPI reports crore-scale figures.
  // 1 crore = 10 million, so 250,000 crore == 2,500,000 million.
  const promise = { metric: 'REVENUE', targetValue: 2500000, targetUnit: 'INR_MILLION', targetPeriod: 'FY2025' };
  const evidence = [financialEvidence('FY2025', { totalRevenue: 250000 })];
  const match = matchPromiseToIndianApiEvidence(promise, evidence);
  assert.ok(match);
  assert.equal(match.actualUnit, 'INR_MILLION');
  assert.equal(match.actualValue, 2500000);
});

test('matchPromiseToIndianApiEvidence never matches a quarterly actual against an annual promise without an explicit rule', () => {
  const promise = { metric: 'REVENUE', targetValue: 250000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2025' };
  const evidence = [financialEvidence('Q1 FY2025', { totalRevenue: 65000 })];
  assert.equal(matchPromiseToIndianApiEvidence(promise, evidence), null);
});

test('matchPromiseToIndianApiEvidence matches fiscally-equivalent period spellings (FY25 vs FY2025)', () => {
  const promise = { metric: 'PAT', targetValue: 45000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2025' };
  const evidence = [financialEvidence('FY25', { netProfitAfterTax: 46000 })];
  const match = matchPromiseToIndianApiEvidence(promise, evidence);
  assert.ok(match);
  assert.equal(match.actualPeriod, 'FY2025'); // reported using the promise's own period label
});

test('matchPromiseToIndianApiEvidence never matches a USD-denominated promise against INR-convention IndianAPI figures', () => {
  const promise = { metric: 'REVENUE', targetValue: 3000, targetUnit: 'USD_MILLION', targetPeriod: 'FY2025' };
  const evidence = [financialEvidence('FY2025', { totalRevenue: 250000 })];
  assert.equal(matchPromiseToIndianApiEvidence(promise, evidence), null);
});

test('matchPromiseToIndianApiEvidence ignores ANALYST_SNAPSHOT candidates — never treats a forecast as an actual outcome', () => {
  const promise = { metric: 'REVENUE', targetValue: 250000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2025' };
  const evidence = [
    { evidenceType: 'ANALYST_SNAPSHOT', period: 'FY2025', raw: { totalRevenue: 999999 }, sourceUrl: null },
  ];
  assert.equal(matchPromiseToIndianApiEvidence(promise, evidence), null);
});

test('matchPromiseToIndianApiEvidence returns null when no compatible evidence exists at all', () => {
  const promise = { metric: 'REVENUE', targetValue: 250000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2027' };
  const evidence = [financialEvidence('FY2025', { totalRevenue: 260000 })];
  assert.equal(matchPromiseToIndianApiEvidence(promise, evidence), null);
});
