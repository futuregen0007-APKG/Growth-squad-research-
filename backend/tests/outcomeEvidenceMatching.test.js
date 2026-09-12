import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  matchPromiseToIndianApiEvidence, findMetricValueInRaw, searchActualOutcomeFromHistoricalFacts, searchActualOutcomesLocalFirst,
} from '../services/OutcomeEvidenceService.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

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

// ---------------------------------------------------------------------------
// Local-first outcome verification priority (tier a: CompanyHistoricalFact,
// tier b: persisted documents, tier c: IndianAPI as an optional fallback).
// ---------------------------------------------------------------------------
const TEST_SYMBOL = 'ZZTESTOUTCOME';

const cleanupTestFacts = async () => {
  await CompanyHistoricalFact.deleteMany({ symbol: TEST_SYMBOL });
};

test('searchActualOutcomeFromHistoricalFacts matches a real REAL_RESEARCH fact for a compatible period and equivalent metric', async (t) => {
  t.after(cleanupTestFacts);
  await cleanupTestFacts();

  await CompanyHistoricalFact.create({
    dataOrigin: 'REAL_RESEARCH',
    symbol: TEST_SYMBOL,
    companyName: 'ZZ Test Outcome Co',
    date: new Date('2026-04-15'),
    period: 'FY2026',
    category: 'FINANCIAL_PERFORMANCE',
    title: 'FY2026 full-year operating margin',
    fact: 'ZZ Test Outcome Co reported FY2026 operating margin of 22%.',
    metrics: { metric: 'OPERATING_MARGIN', actualValue: 22, unit: 'PERCENTAGE' },
    source: { type: 'EARNINGS_CALL_TRANSCRIPT', title: 'Q4 FY2026 earnings call transcript', url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/zztest-outcome.pdf', publishedAt: new Date('2026-04-15'), excerpt: 'Our FY26 operating margin was at 22%.' },
    confidence: 0.9,
  });

  const promise = { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' };
  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: TEST_SYMBOL }, promise);
  assert.ok(match, 'a compatible REAL_RESEARCH fact must produce a match');
  assert.equal(match.actualValue, 22);
  assert.equal(match.provider, 'company-historical-fact');
  assert.equal(match.outcomeSourceUrl, 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/zztest-outcome.pdf');
});

test('searchActualOutcomeFromHistoricalFacts returns null (never guesses) when no compatible fact exists', async (t) => {
  t.after(cleanupTestFacts);
  await cleanupTestFacts();

  const promise = { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2099' };
  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: TEST_SYMBOL }, promise);
  assert.equal(match, null);
});

test('searchActualOutcomesLocalFirst returns the CompanyHistoricalFact match and never even calls IndianAPI when tier (a) already resolves it', async () => {
  let indianApiCalled = false;
  const promise = { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' };
  const result = await searchActualOutcomesLocalFirst({ symbol: TEST_SYMBOL }, promise, {
    historicalFactsFn: async () => ({ actualValue: 22, actualUnit: 'PERCENT', actualPeriod: 'FY2026', provider: 'company-historical-fact' }),
    persistedDocumentsFn: async () => { throw new Error('tier (b) must never be reached when tier (a) already matched'); },
    indianApiFn: async () => { indianApiCalled = true; return null; },
  });
  assert.ok(result);
  assert.equal(result.provider, 'company-historical-fact');
  assert.equal(indianApiCalled, false, 'IndianAPI must never be consulted once a local tier already answered');
});

test('IndianAPI unavailable (rejects, simulating a rate limit) never blocks verification when local CompanyHistoricalFact evidence exists', async () => {
  const promise = { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' };
  const result = await searchActualOutcomesLocalFirst({ symbol: TEST_SYMBOL }, promise, {
    historicalFactsFn: async () => ({ actualValue: 22, actualUnit: 'PERCENT', actualPeriod: 'FY2026', provider: 'company-historical-fact' }),
    persistedDocumentsFn: async () => null,
    indianApiFn: async () => { throw new Error('IndianAPI rate limit hit during getCompanyResearch: Rate limit exceeded'); },
  });
  assert.ok(result, 'local evidence must resolve the promise even though IndianAPI would have thrown if reached');
  assert.equal(result.provider, 'company-historical-fact');
});

test('searchActualOutcomesLocalFirst falls through to IndianAPI only when neither local tier has an answer', async () => {
  const promise = { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' };
  const result = await searchActualOutcomesLocalFirst({ symbol: TEST_SYMBOL }, promise, {
    historicalFactsFn: async () => null,
    persistedDocumentsFn: async () => null,
    indianApiFn: async () => ({ actualValue: 21, actualUnit: 'PERCENT', actualPeriod: 'FY2026', provider: 'indian-api' }),
  });
  assert.ok(result);
  assert.equal(result.provider, 'indian-api');
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
