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

const xbrlFact = (overrides = {}) => ({
  dataOrigin: 'REAL_RESEARCH',
  symbol: TEST_SYMBOL,
  companyName: 'ZZ Test Outcome Co',
  date: new Date('2026-05-05'),
  period: 'FY2026',
  category: 'FINANCIAL_PERFORMANCE',
  title: 'FY2026 revenue from operations',
  fact: 'ZZ Test Outcome Co reported Revenue from operations of 2200 INR_CRORE for FY2026 (Consolidated, Audited).',
  metrics: { metric: 'REVENUE', actualValue: 2200, unit: 'INR_CRORE' },
  source: { type: 'QUARTERLY_REPORT', title: 'Integrated filing', url: 'https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_ZZTEST_FY26_WEB.xml', publishedAt: new Date('2026-05-05'), excerpt: 'RevenueFromOperations 2200 (Consolidated)' },
  confidence: 0.95,
  ...overrides,
});

test('searchActualOutcomeFromHistoricalFacts matches an exchange XBRL figure of the same line, period and basis', async (t) => {
  t.after(cleanupTestFacts);
  await cleanupTestFacts();
  await CompanyHistoricalFact.create(xbrlFact());

  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: TEST_SYMBOL }, { metric: 'REVENUE', targetValue: 2000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2026' });
  assert.equal(match.actualValue, 2200);
  assert.equal(match.provider, 'nse-xbrl');
  assert.equal(match.actualPeriod, 'FY2026');
  assert.match(match.outcomeStatement, /Revenue from operations/);
  assert.match(match.outcomeStatement, /Consolidated/);
});

test('an unspecified "margin" target is never matched against a specific margin, and a transcript-derived fact is never an actual', async (t) => {
  t.after(cleanupTestFacts);
  await cleanupTestFacts();
  // The kind of fact the old alias table matched a MARGIN target against: a transcript sentence, a specific margin type.
  await CompanyHistoricalFact.create(xbrlFact({
    fact: 'ZZ Test Outcome Co reported FY2026 operating margin of 22%.',
    metrics: { metric: 'OPERATING_MARGIN', actualValue: 22, unit: 'PERCENTAGE' },
    source: { type: 'EARNINGS_CALL_TRANSCRIPT', title: 'Q4 FY2026 earnings call transcript', url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/zztest-outcome.pdf', publishedAt: new Date('2026-04-15'), excerpt: 'Our FY26 operating margin was at 22%.' },
  }));
  const margin = await searchActualOutcomeFromHistoricalFacts({ symbol: TEST_SYMBOL }, { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' });
  assert.equal(margin.actualValue, undefined);
  assert.match(margin.unavailableReason, /no verified exchange-filed actual/);
  const operating = await searchActualOutcomeFromHistoricalFacts({ symbol: TEST_SYMBOL }, { metric: 'EBIT_MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' });
  assert.equal(operating.actualValue, undefined, 'a transcript sentence is not an exchange-filed actual');
});

test('searchActualOutcomeFromHistoricalFacts never guesses: no figure on file gives a specific reason, not a value', async (t) => {
  t.after(cleanupTestFacts);
  await cleanupTestFacts();
  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: TEST_SYMBOL }, { metric: 'REVENUE', targetValue: 20, targetUnit: 'INR_CRORE', targetPeriod: 'FY2099' });
  assert.equal(match.actualValue, undefined);
  assert.match(match.unavailableReason, /no exchange XBRL revenue figures are on file/);
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
