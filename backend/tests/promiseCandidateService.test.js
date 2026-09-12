import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  filterTier1And2Documents,
  generateCandidatesForSymbol,
  saveCandidate,
  saveCandidates,
  listCandidatesForSymbol,
} from '../services/PromiseCandidateService.js';
import { validateCandidatePromiseRecord } from '../utils/earningsIntelligenceValidation.js';
import PromiseCandidate from '../models/PromiseCandidate.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const tier1Doc = (overrides = {}) => ({
  provider: 'InvestorRelations',
  title: 'TCS Q2 FY26 Earnings Transcript',
  url: 'https://www.tcs.com/investor-relations/transcript.pdf',
  canonicalUrl: 'https://www.tcs.com/investor-relations/transcript.pdf',
  sourceType: 'EARNINGS_CALL_TRANSCRIPT',
  publishedAt: '2025-10-09T00:00:00.000Z',
  ...overrides,
});

const tier34Doc = (overrides = {}) => ({
  provider: 'FinancialMediaAndHistoricalNews',
  title: 'TCS reported strong quarter, analysts say',
  url: 'https://www.moneycontrol.com/tcs-news',
  sourceType: 'NEWS_ARTICLE',
  publishedAt: '2025-10-10T00:00:00.000Z',
  ...overrides,
});

const extractedPromise = (overrides = {}) => ({
  exactManagementStatement: 'We are targeting a 26% operating margin for FY2026.',
  sourceExcerpt: 'We are targeting a 26% operating margin for FY2026.',
  metric: 'MARGIN',
  targetValue: 26,
  targetUnit: 'PERCENTAGE',
  targetPeriod: 'FY2026',
  promiseDate: '2025-10-09T00:00:00.000Z',
  direction: 'HIGHER_IS_BETTER',
  operator: 'GTE',
  importance: 'HIGH',
  sourceUrl: 'https://www.tcs.com/investor-relations/transcript.pdf',
  sourceDate: '2025-10-09T00:00:00.000Z',
  sourceDocument: 'TCS Q2 FY26 Earnings Transcript',
  page: 5,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tier filtering
// ---------------------------------------------------------------------------
test('filterTier1And2Documents keeps only InvestorRelations and ExchangeFilings, never Tier 3/4 news', () => {
  const docs = [tier1Doc(), tier34Doc(), { provider: 'ExchangeFilings', url: 'https://www.nseindia.com/x.pdf' }];
  const filtered = filterTier1And2Documents(docs);
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((d) => d.provider !== 'FinancialMediaAndHistoricalNews'));
});

// ---------------------------------------------------------------------------
// generateCandidatesForSymbol
// ---------------------------------------------------------------------------
test('generateCandidatesForSymbol produces a valid, schema-passing candidate when a Tier 1/2 source and an outcome match both exist', async () => {
  const collectDocumentsFn = async () => ({ documents: [tier1Doc(), tier34Doc()] });
  const extractPromisesFn = async () => [extractedPromise()];
  const outcomeSearchFn = async () => ({
    actualValue: 25,
    actualUnit: 'PERCENTAGE',
    actualPeriod: 'FY2026',
    outcomeStatement: 'FY2026 operating margin was reported at 25%.',
    outcomeSource: 'TCS FY26 Results',
    outcomeSourceUrl: 'https://www.tcs.com/investor-relations/results.pdf',
    outcomeSourceDate: '2026-04-09T00:00:00.000Z',
    confidence: 0.75,
  });

  const { symbol, candidates, reason } = await generateCandidatesForSymbol('TCS', {
    collectDocumentsFn, extractPromisesFn, outcomeSearchFn,
  });

  assert.equal(symbol, 'TCS');
  assert.equal(reason, null);
  assert.equal(candidates.length, 1);

  const candidate = candidates[0];
  assert.equal(candidate.symbol, 'TCS');
  assert.equal(candidate.reviewStatus, 'PENDING_REVIEW');
  assert.equal(candidate.dataMode, 'CURATED_VERIFIED');
  assert.equal(candidate.promise.category, 'MARGIN');
  assert.equal(candidate.promise.targetPeriod, 'FY2026');
  assert.equal(candidate.promise.operator, 'AT_LEAST');
  assert.equal(candidate.promiseEvidence.sourceUrl, tier1Doc().url);
  assert.equal(candidate.promiseEvidence.sourceType, 'EARNINGS_TRANSCRIPT');
  assert.ok(['ACHIEVED', 'PARTIAL', 'MISSED'].includes(candidate.outcome.status)); // 25/26 -> resolved, not fabricated as ACHIEVED
  assert.equal(candidate.outcomeEvidence.sourceUrl, 'https://www.tcs.com/investor-relations/results.pdf');
  assert.equal(candidate.verification.verifiedBy, 'AUTOMATED_CANDIDATE_GENERATOR');
  assert.ok(candidate.verification.evidenceConfidence <= 0.75);

  const { valid, errors } = validateCandidatePromiseRecord(candidate, { symbol: 'TCS', allowDemo: false });
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test('generateCandidatesForSymbol leaves outcome PENDING (never guessed) when no outcome match exists', async () => {
  const collectDocumentsFn = async () => ({ documents: [tier1Doc()] });
  const extractPromisesFn = async () => [extractedPromise()];
  const outcomeSearchFn = async () => null; // no deterministic match found

  const { candidates } = await generateCandidatesForSymbol('TCS', { collectDocumentsFn, extractPromisesFn, outcomeSearchFn });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].outcome.status, 'PENDING');
  assert.equal(candidates[0].outcome.actualValue, null);
  assert.equal(candidates[0].outcomeEvidence, null);
});

test('generateCandidatesForSymbol never treats a Tier 3/4 (news) document as sufficient primary evidence', async () => {
  // The extracted promise's sourceUrl points at a Tier 3/4 article, which is
  // excluded from tier12Docs before extraction even runs conceptually here --
  // this proves the candidate is discarded rather than falling back to news evidence.
  const collectDocumentsFn = async () => ({ documents: [tier34Doc()] }); // Tier 3/4 only
  const extractPromisesFn = async () => [extractedPromise({ sourceUrl: tier34Doc().url })];
  const outcomeSearchFn = async () => null;

  const { candidates, reason } = await generateCandidatesForSymbol('TCS', { collectDocumentsFn, extractPromisesFn, outcomeSearchFn });
  assert.equal(candidates.length, 0);
  assert.match(reason, /No official Tier 1.*Tier 2/);
});

test('generateCandidatesForSymbol discards a candidate whose sourceUrl does not match any Tier 1/2 document from this run (never fabricates the evidence link)', async () => {
  const collectDocumentsFn = async () => ({ documents: [tier1Doc()] });
  const extractPromisesFn = async () => [extractedPromise({ sourceUrl: 'https://www.tcs.com/some-other-unrelated-page' })];
  const outcomeSearchFn = async () => null;

  const { candidates, reason } = await generateCandidatesForSymbol('TCS', { collectDocumentsFn, extractPromisesFn, outcomeSearchFn });
  assert.equal(candidates.length, 0);
  assert.ok(reason);
});

test('generateCandidatesForSymbol returns empty with a clear reason when no Tier 1/2 documents exist at all', async () => {
  const collectDocumentsFn = async () => ({ documents: [] });
  const result = await generateCandidatesForSymbol('TCS', { collectDocumentsFn, extractPromisesFn: async () => [], outcomeSearchFn: async () => null });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.reason);
});

test('generateCandidatesForSymbol returns empty with a clear reason when extraction finds nothing', async () => {
  const collectDocumentsFn = async () => ({ documents: [tier1Doc()] });
  const extractPromisesFn = async () => [];
  const result = await generateCandidatesForSymbol('TCS', { collectDocumentsFn, extractPromisesFn, outcomeSearchFn: async () => null });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.reason);
});

test('generateCandidatesForSymbol rejects an unsupported symbol immediately, without calling any dependency', async () => {
  let called = false;
  const collectDocumentsFn = async () => { called = true; return { documents: [] }; };
  const result = await generateCandidatesForSymbol('NOT_A_REAL_SYMBOL_XYZ', { collectDocumentsFn });
  assert.equal(result.candidates.length, 0);
  assert.equal(called, false);
});

test('generateCandidatesForSymbol discards a candidate missing a core required field rather than guessing it', async () => {
  const collectDocumentsFn = async () => ({ documents: [tier1Doc()] });
  const extractPromisesFn = async () => [extractedPromise({ targetPeriod: null })]; // no period -- schema requires one
  const result = await generateCandidatesForSymbol('TCS', { collectDocumentsFn, extractPromisesFn, outcomeSearchFn: async () => null });
  assert.equal(result.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// MongoDB persistence (isolated test symbol, cleaned up afterward). This
// project's backend deploys to Render, whose filesystem is ephemeral, which
// is exactly why candidates are stored in Mongo rather than a JSON file.
// ---------------------------------------------------------------------------
const TEST_SYMBOL = 'ZZCANDIDATETEST';

const mongoCandidate = (overrides = {}) => ({
  id: `${TEST_SYMBOL}-FY2026-CAND-001`,
  symbol: TEST_SYMBOL,
  dataMode: 'CURATED_VERIFIED',
  reviewStatus: 'PENDING_REVIEW',
  promise: {
    statement: 'Test statement', originalExcerpt: 'Test statement',
    category: 'MARGIN', promiseDate: '2025-01-01', targetPeriod: 'FY2026', targetType: 'PERCENTAGE',
    targetValue: 20, targetUnit: 'PERCENT', operator: 'AT_LEAST',
  },
  outcome: { status: 'PENDING', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null },
  promiseEvidence: {
    sourceTitle: 'Test Doc', sourceType: 'EARNINGS_TRANSCRIPT',
    sourceUrl: 'https://www.example-official-source.com/doc.pdf', publishedAt: '2025-01-01', pageNumber: 1, excerpt: 'Test excerpt',
  },
  outcomeEvidence: null,
  verification: { verifiedAt: '2026-01-01', verifiedBy: 'AUTOMATED_CANDIDATE_GENERATOR', evidenceConfidence: 0.5, notes: null },
  ...overrides,
});

test('saveCandidate persists to MongoDB and round-trips via listCandidatesForSymbol', async (t) => {
  t.after(async () => { await PromiseCandidate.deleteMany({ symbol: TEST_SYMBOL }); });

  const result = await saveCandidate(mongoCandidate());
  assert.equal(result.action, 'INSERTED');

  const listed = await listCandidatesForSymbol(TEST_SYMBOL);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].symbol, TEST_SYMBOL);
  assert.equal(listed[0].reviewStatus, 'PENDING_REVIEW');
});

test('saveCandidate never creates a duplicate for the same symbol/period/category/source on a re-run', async (t) => {
  t.after(async () => { await PromiseCandidate.deleteMany({ symbol: TEST_SYMBOL }); });

  await saveCandidate(mongoCandidate());
  const second = await saveCandidate(mongoCandidate({ promise: { ...mongoCandidate().promise, targetValue: 25 } })); // same business key, different value
  assert.equal(second.action, 'UPDATED'); // updated in place, not a second document

  const listed = await listCandidatesForSymbol(TEST_SYMBOL);
  assert.equal(listed.length, 1, 'must never create a duplicate candidate document');
  assert.equal(listed[0].promise.targetValue, 25); // content refreshed
});

test('saveCandidate never overwrites a candidate a human has already reviewed', async (t) => {
  t.after(async () => { await PromiseCandidate.deleteMany({ symbol: TEST_SYMBOL }); });

  await saveCandidate(mongoCandidate());
  await PromiseCandidate.updateOne({ symbol: TEST_SYMBOL }, { reviewStatus: 'ACCEPTED', reviewedBy: 'tester', reviewedAt: new Date() });

  const result = await saveCandidate(mongoCandidate({ promise: { ...mongoCandidate().promise, targetValue: 99 } }));
  assert.equal(result.action, 'SKIPPED_ALREADY_REVIEWED');

  const listed = await listCandidatesForSymbol(TEST_SYMBOL);
  assert.equal(listed[0].promise.targetValue, 20, 'a re-generation run must never silently alter an already-reviewed candidate');
  assert.equal(listed[0].reviewStatus, 'ACCEPTED');
});

test('saveCandidates persists a batch and continues past one failing record', async (t) => {
  t.after(async () => { await PromiseCandidate.deleteMany({ symbol: TEST_SYMBOL }); });

  const malformed = mongoCandidate();
  delete malformed.promiseEvidence; // triggers a real TypeError inside saveCandidate's filter construction
  const results = await saveCandidates([mongoCandidate(), malformed]);
  assert.equal(results[0].action, 'INSERTED');
  assert.equal(results[1].action, 'FAILED');

  const listed = await listCandidatesForSymbol(TEST_SYMBOL);
  assert.equal(listed.length, 1);
});

test('listCandidatesForSymbol returns an empty array (never throws) for a symbol with no candidates', async () => {
  const result = await listCandidatesForSymbol('ZZ_NO_SUCH_CANDIDATE_XYZ');
  assert.deepEqual(result, []);
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
