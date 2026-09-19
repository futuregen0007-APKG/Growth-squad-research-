import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  acceptCandidate, rejectCandidate, listCandidates, buildCompanyOverride, isAuthorized, resolveSecret,
} from '../scripts/earningsReview.js';
import { saveCandidate } from '../services/PromiseCandidateService.js';
import PromiseCandidate from '../models/PromiseCandidate.js';
import { getCompanyTimeline, reloadCuratedDataset } from '../services/CuratedEarningsIntelligenceService.js';
import { RESOLVED_STATUSES } from '../utils/earningsIntelligenceValidation.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(__dirname, '..', 'data', 'earnings-intelligence');
const COMPANIES_FILE = path.join(DATA_ROOT, 'companies.json');
const PROMISES_DIR = path.join(DATA_ROOT, 'promises');

// getCompanyCoverage/getCompanyTimeline only return non-null for a symbol
// that is actually in SUPPORTED_STOCKS (companies.json overrides for any
// other symbol are safely ignored by the loader) -- so these tests use a
// REAL, obscure, currently-uncurated SUPPORTED_STOCKS symbol (MRF: a tyre
// company, unrelated to and never confused with the 7 profiled Earnings
// Intelligence companies) rather than a fictional one, and clean up fully
// after every test.
const TEST_SYMBOL = 'MRF';
const TEST_SECRET = 'test-review-secret-do-not-use-in-prod';
const promisesPath = path.join(PROMISES_DIR, `${TEST_SYMBOL}.json`);

// Tests below call acceptCandidate/rejectCandidate with this secret by
// default; the two authorization tests explicitly override and restore it
// around a mismatched-secret scenario.
process.env.EARNINGS_REVIEW_SECRET = TEST_SECRET;

const mongoCandidate = (overrides = {}) => ({
  id: `${TEST_SYMBOL}-FY2026-CAND-001`,
  symbol: TEST_SYMBOL,
  dataMode: 'CURATED_VERIFIED',
  reviewStatus: 'PENDING_REVIEW',
  promise: {
    statement: 'Test candidate statement.', originalExcerpt: 'Test candidate statement.',
    category: 'MARGIN', promiseDate: '2025-01-01', targetPeriod: 'FY2026', targetType: 'PERCENTAGE',
    targetValue: 20, targetUnit: 'PERCENT', operator: 'AT_LEAST',
  },
  outcome: { status: 'PENDING', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null },
  promiseEvidence: {
    sourceTitle: 'Test Official Document', sourceType: 'EARNINGS_TRANSCRIPT',
    sourceUrl: 'https://www.example-official-source.com/doc.pdf', publishedAt: '2025-01-01', pageNumber: 1, excerpt: 'Test excerpt supporting the statement.',
  },
  outcomeEvidence: null,
  verification: { verifiedAt: '2026-01-01', verifiedBy: 'AUTOMATED_CANDIDATE_GENERATOR', evidenceConfidence: 0.5, notes: null },
  ...overrides,
});

const cleanupTestSymbol = async () => {
  await PromiseCandidate.deleteMany({ symbol: TEST_SYMBOL });
  if (fs.existsSync(promisesPath)) fs.unlinkSync(promisesPath);
  const companiesFile = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  const filtered = companiesFile.companies.filter((c) => c.symbol !== TEST_SYMBOL);
  if (filtered.length !== companiesFile.companies.length) {
    companiesFile.companies = filtered;
    fs.writeFileSync(COMPANIES_FILE, `${JSON.stringify(companiesFile, null, 2)}\n`);
  }
  // acceptCandidate() calls reloadCuratedDataset() itself when it writes a
  // promotion, but this cleanup edits/deletes those same files directly (a
  // test-only shortcut -- production never removes a promises/<SYMBOL>.json
  // file outside of a redeploy, which rebuilds the cache from scratch
  // anyway), so the in-memory cache must be invalidated here too or a stale
  // JSON record from a prior test lingers and pollutes the next test's merge.
  reloadCuratedDataset();
};

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
test('isAuthorized requires EARNINGS_REVIEW_SECRET to be set and to match exactly', () => {
  const original = process.env.EARNINGS_REVIEW_SECRET;
  try {
    delete process.env.EARNINGS_REVIEW_SECRET;
    assert.equal(isAuthorized('anything'), false, 'no secret configured at all -> never authorized');

    process.env.EARNINGS_REVIEW_SECRET = 'the-real-secret';
    assert.equal(isAuthorized('the-real-secret'), true);
    assert.equal(isAuthorized('wrong-guess'), false);
    assert.equal(isAuthorized(undefined), false);
    assert.equal(isAuthorized(''), false);
  } finally {
    if (original === undefined) delete process.env.EARNINGS_REVIEW_SECRET;
    else process.env.EARNINGS_REVIEW_SECRET = original;
  }
});

test('acceptCandidate refuses without a valid secret, and touches nothing', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  const original = process.env.EARNINGS_REVIEW_SECRET;
  process.env.EARNINGS_REVIEW_SECRET = 'the-real-secret';
  try {
    const result = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: 'wrong-guess' , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /Unauthorized/);
  } finally {
    if (original === undefined) delete process.env.EARNINGS_REVIEW_SECRET;
    else process.env.EARNINGS_REVIEW_SECRET = original;
  }

  assert.equal(fs.existsSync(promisesPath), false);
  const doc = await PromiseCandidate.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(doc.reviewStatus, 'PENDING_REVIEW', 'an unauthorized attempt must never change reviewStatus');
});

test('acceptCandidate refuses without a --reviewer name, even with a valid secret', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  const original = process.env.EARNINGS_REVIEW_SECRET;
  process.env.EARNINGS_REVIEW_SECRET = TEST_SECRET;
  let result;
  try {
    result = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  } finally {
    if (original === undefined) delete process.env.EARNINGS_REVIEW_SECRET;
    else process.env.EARNINGS_REVIEW_SECRET = original;
  }
  assert.equal(result.ok, false);
  assert.match(result.error, /reviewer/);
});

// ---------------------------------------------------------------------------
// resolveSecret (environment-based CLI secret fallback)
// ---------------------------------------------------------------------------
test('resolveSecret falls back to process.env.EARNINGS_REVIEW_SECRET when --secret is omitted', () => {
  const original = process.env.EARNINGS_REVIEW_SECRET;
  try {
    process.env.EARNINGS_REVIEW_SECRET = 'env-secret-value';
    assert.equal(resolveSecret(undefined), 'env-secret-value', '--secret omitted -> falls back to env');
    assert.equal(resolveSecret(''), 'env-secret-value', '--secret= with no value -> falls back to env');
    assert.equal(resolveSecret('explicit-cli-secret'), 'explicit-cli-secret', 'an explicit --secret always wins over env');
  } finally {
    if (original === undefined) delete process.env.EARNINGS_REVIEW_SECRET;
    else process.env.EARNINGS_REVIEW_SECRET = original;
  }
});

test('resolveSecret fails closed (returns null, never throws or guesses) when EARNINGS_REVIEW_SECRET is also unset', () => {
  const original = process.env.EARNINGS_REVIEW_SECRET;
  try {
    delete process.env.EARNINGS_REVIEW_SECRET;
    assert.equal(resolveSecret(undefined), null);
    assert.equal(isAuthorized(resolveSecret(undefined)), false);
  } finally {
    if (original === undefined) delete process.env.EARNINGS_REVIEW_SECRET;
    else process.env.EARNINGS_REVIEW_SECRET = original;
  }
});

test('acceptCandidate via the env-resolved secret succeeds end-to-end exactly like an explicit --secret', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  process.env.EARNINGS_REVIEW_SECRET = TEST_SECRET; // simulates the operator's shell env, no --secret= passed
  const result = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: resolveSecret(undefined) , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  assert.equal(result.ok, true);
});

test('acceptCandidate via the env-resolved secret still fails closed when the CLI passes an explicit wrong secret (explicit --secret is never silently overridden by env)', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  process.env.EARNINGS_REVIEW_SECRET = TEST_SECRET;
  const result = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: resolveSecret('deliberately-wrong') , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unauthorized/);
});

// ---------------------------------------------------------------------------
// buildCompanyOverride (pure function, no I/O)
// ---------------------------------------------------------------------------
test('buildCompanyOverride creates a new CURATED_VERIFIED override with recomputed counts when none existed before', () => {
  const records = [{ outcome: { status: 'ACHIEVED' } }, { outcome: { status: 'PARTIAL' } }, { outcome: { status: 'PENDING' } }];
  const override = buildCompanyOverride('ZZNEWCO', null, records);
  assert.equal(override.dataMode, 'CURATED_VERIFIED');
  assert.equal(override.coverageStatus, 'PARTIAL');
  assert.equal(override.verifiedPromiseCount, 3);
  assert.equal(override.resolvedPromiseCount, 2);
  assert.equal(override.pendingPromiseCount, 1);
});

test('buildCompanyOverride preserves an existing COMPLETE coverageStatus rather than downgrading it', () => {
  const existing = { symbol: 'X', companyName: 'X Co', sector: 'IT', dataMode: 'CURATED_VERIFIED', coverageStatus: 'COMPLETE', coverageStart: '2022-01-01', coverageEnd: null, lastVerifiedAt: null, nextReviewAfter: null, verifiedPromiseCount: 5, resolvedPromiseCount: 5, pendingPromiseCount: 0, notes: 'hand-reviewed' };
  const override = buildCompanyOverride('X', existing, [{ outcome: { status: 'ACHIEVED' } }]);
  assert.equal(override.coverageStatus, 'COMPLETE');
  assert.equal(override.notes, 'hand-reviewed');
});

// ---------------------------------------------------------------------------
// acceptCandidate / rejectCandidate (real Mongo + isolated JSON files)
// ---------------------------------------------------------------------------
test('acceptCandidate promotes a valid PENDING_REVIEW candidate into promises/<SYMBOL>.json, Mongo, and companies.json', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  const result = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  assert.equal(result.ok, true);

  assert.ok(fs.existsSync(promisesPath));
  const promisesFile = JSON.parse(fs.readFileSync(promisesPath, 'utf8'));
  assert.equal(promisesFile.records.length, 1);
  assert.equal(promisesFile.records[0].id, `${TEST_SYMBOL}-FY2026-CAND-001`);
  assert.equal(promisesFile.records[0].reviewStatus, undefined);

  const companiesFile = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  assert.ok(companiesFile.companies.find((c) => c.symbol === TEST_SYMBOL));

  const doc = await PromiseCandidate.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(doc.reviewStatus, 'ACCEPTED');
  assert.equal(doc.reviewedBy, 'tester');
  assert.ok(doc.reviewedAt);
});

test('acceptCandidate is idempotent: accepting the same id twice never duplicates the record', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  const second = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);

  const promisesFile = JSON.parse(fs.readFileSync(promisesPath, 'utf8'));
  assert.equal(promisesFile.records.length, 1);
});

test('acceptCandidate refuses to promote a candidate that fails validateManagementPromiseRecord', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate({
    promiseEvidence: { sourceTitle: 'Bad', sourceType: 'EARNINGS_TRANSCRIPT', sourceUrl: 'https://www.moneycontrol.com/bad-source', publishedAt: '2025-01-01', pageNumber: 1, excerpt: 'x' },
  }));

  const result = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /validateManagementPromiseRecord/);
  assert.equal(fs.existsSync(promisesPath), false);

  const doc = await PromiseCandidate.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(doc.reviewStatus, 'PENDING_REVIEW', 'a refused acceptance must not be marked ACCEPTED');
});

test('acceptCandidate refuses an unknown candidate id', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  const result = await acceptCandidate(TEST_SYMBOL, 'NOT-A-REAL-ID', { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(promisesPath), false);
});

test('rejectCandidate marks REJECTED, and acceptCandidate then permanently refuses it', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  const rejectResult = await rejectCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: TEST_SECRET });
  assert.equal(rejectResult.ok, true);

  const doc = await PromiseCandidate.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(doc.reviewStatus, 'REJECTED');
  assert.equal(doc.reviewedBy, 'tester');

  const acceptResult = await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  assert.equal(acceptResult.ok, false);
  assert.equal(fs.existsSync(promisesPath), false);
});

test('rejectCandidate also requires authorization', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  const result = await rejectCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: 'wrong' });
  assert.equal(result.ok, false);
  const doc = await PromiseCandidate.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(doc.reviewStatus, 'PENDING_REVIEW');
});

test('listCandidates does not require a secret (read-only)', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  const results = await listCandidates(TEST_SYMBOL);
  assert.equal(results.length, 1);
});

// ---------------------------------------------------------------------------
// Faith Score visibility: retained evidence + reviewer metadata, and the
// exact 3-record threshold (corrections #5, #6, #10).
// ---------------------------------------------------------------------------
test('accepted records retain promise/outcome evidence, dates, page references, confidence and reviewer metadata all the way through to the public timeline', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();

  const resolvedCandidate = mongoCandidate({
    outcome: { status: 'ACHIEVED', actualValue: 22, actualUnit: 'PERCENT', evaluationDate: '2026-05-01', explanation: 'Beat target.' },
    outcomeEvidence: {
      sourceTitle: 'Official Results', sourceType: 'FINANCIAL_RESULTS',
      sourceUrl: 'https://www.example-official-source.com/results.pdf', publishedAt: '2026-05-01', pageNumber: 2, excerpt: 'Reported 22% margin.',
    },
    verification: { verifiedAt: '2026-01-01', verifiedBy: 'AUTOMATED_CANDIDATE_GENERATOR', evidenceConfidence: 0.75, notes: 'auto-generated' },
  });
  await saveCandidate(resolvedCandidate);
  await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'jane.reviewer', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });

  const timeline = await getCompanyTimeline(TEST_SYMBOL);
  const entry = timeline.timeline.find((e) => e.id === `${TEST_SYMBOL}-FY2026-CAND-001`);
  assert.ok(entry, 'accepted record must appear in the public timeline immediately');
  assert.equal(entry.promiseEvidence.sourceUrl, 'https://www.example-official-source.com/doc.pdf');
  assert.equal(entry.promiseEvidence.pageNumber, 1);
  assert.equal(entry.outcomeEvidence.sourceUrl, 'https://www.example-official-source.com/results.pdf');
  assert.equal(entry.outcomeEvidence.pageNumber, 2);
  assert.equal(entry.outcome.evaluationDate, '2026-05-01');
  assert.equal(entry.evidenceConfidence, 0.75);
  assert.equal(entry.reviewedBy, 'jane.reviewer');
  assert.ok(entry.reviewedAt);
});

test('a PENDING_REVIEW candidate never appears in the public timeline; a REJECTED one never does either', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();
  await saveCandidate(mongoCandidate());

  let timeline = await getCompanyTimeline(TEST_SYMBOL);
  assert.equal(timeline.timeline.length, 0);
  assert.equal(timeline.dataMode, 'RESEARCH_PENDING');

  await rejectCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2026-CAND-001`, { reviewer: 'tester', secret: TEST_SECRET });
  timeline = await getCompanyTimeline(TEST_SYMBOL);
  assert.equal(timeline.timeline.length, 0);
});

test('Faith Score is null with 2 accepted resolved records and becomes a real number at exactly 3, via the real accept workflow end-to-end (isolated test symbol -- never TCS or any real company file)', async (t) => {
  t.after(cleanupTestSymbol);
  await cleanupTestSymbol();

  const resolvedCandidate = (period) => ({
    id: `${TEST_SYMBOL}-${period}-001`,
    symbol: TEST_SYMBOL,
    dataMode: 'CURATED_VERIFIED',
    reviewStatus: 'PENDING_REVIEW',
    promise: {
      statement: `Test-only margin target for ${period}.`, originalExcerpt: `Test-only margin target for ${period}.`,
      category: 'MARGIN', promiseDate: `${period.replace('FY', '')}-05-01`, targetPeriod: period, targetType: 'PERCENTAGE',
      targetValue: 20, targetUnit: 'PERCENT', operator: 'AT_LEAST',
    },
    outcome: { status: 'ACHIEVED', actualValue: 22, actualUnit: 'PERCENT', evaluationDate: `${period.replace('FY', '')}-06-01`, explanation: 'Test fixture.' },
    promiseEvidence: {
      sourceTitle: 'Test fixture document', sourceType: 'EARNINGS_TRANSCRIPT',
      sourceUrl: `https://www.example-official-source.com/${TEST_SYMBOL}-${period}.pdf`, publishedAt: `${period.replace('FY', '')}-05-01`, pageNumber: 1, excerpt: 'Test excerpt.',
    },
    outcomeEvidence: {
      sourceTitle: 'Test fixture results', sourceType: 'FINANCIAL_RESULTS',
      sourceUrl: `https://www.example-official-source.com/${TEST_SYMBOL}-${period}-results.pdf`, publishedAt: `${period.replace('FY', '')}-06-01`, pageNumber: 1, excerpt: 'Test excerpt.',
    },
    verification: { verifiedAt: '2026-01-01', verifiedBy: 'AUTOMATED_CANDIDATE_GENERATOR', evidenceConfidence: 0.9, notes: 'Test fixture.' },
  });

  await saveCandidate(resolvedCandidate('FY2021'));
  await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2021-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });
  await saveCandidate(resolvedCandidate('FY2022'));
  await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2022-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });

  const twoResolved = await getCompanyTimeline(TEST_SYMBOL);
  assert.equal(twoResolved.summary.resolvedPromises, 2);
  assert.equal(twoResolved.summary.faithScore, null, 'must stay null (never fabricated) with only 2 resolved records');

  await saveCandidate(resolvedCandidate('FY2023'));
  await acceptCandidate(TEST_SYMBOL, `${TEST_SYMBOL}-FY2023-001`, { reviewer: 'tester', secret: TEST_SECRET , evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } });

  const threeResolved = await getCompanyTimeline(TEST_SYMBOL);
  assert.equal(threeResolved.summary.resolvedPromises, 3);
  assert.equal(typeof threeResolved.summary.faithScore, 'number');
  assert.equal(threeResolved.summary.faithScore, 100); // all 3 ACHIEVED at 0.9 confidence -> (1*0.9*3)/(0.9*3)*100 = 100
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
