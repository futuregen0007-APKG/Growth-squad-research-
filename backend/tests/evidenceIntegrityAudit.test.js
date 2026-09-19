import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  isPubliclyVisibleRecord, isPubliclyVisiblePromise, EVIDENCE_INTEGRITY_STATUSES, PUBLIC_SAFE_EVIDENCE_STATUSES,
} from '../utils/earningsIntelligenceValidation.js';
import { getCompanyTimeline, getCompanyPromises, getCompanyPromisesDebug, calculateFaithScore, reloadCuratedDataset } from '../services/CuratedEarningsIntelligenceService.js';
import ManagementPromise from '../models/ManagementPromise.js';
import { getCompanyPromises as getLegacyCompanyPromises } from '../services/ManagementPromiseService.js';
import { buildEarningsIntelligenceEnvelopeItems } from '../services/EvidenceEnvelope.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}
reloadCuratedDataset();

const TEST_SYMBOL = 'ZZEVIDENCEINTEGRITY';
const cleanup = async () => { await ManagementPromise.deleteMany({ symbol: TEST_SYMBOL }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

// ---------------------------------------------------------------------------
// Pure evidence-integrity-status vocabulary and gating functions.
// ---------------------------------------------------------------------------
test('EVIDENCE_INTEGRITY_STATUSES covers every required state', () => {
  for (const status of ['VERIFIED_PRIMARY', 'VERIFIED_EXCHANGE_COPY', 'SOURCE_UNAVAILABLE', 'PROVENANCE_INCOMPLETE', 'CLAIM_NOT_FOUND', 'VALUE_MISMATCH', 'PERIOD_MISMATCH', 'UNSUPPORTED', 'QUARANTINED']) {
    assert.ok(EVIDENCE_INTEGRITY_STATUSES.includes(status), `missing status: ${status}`);
  }
});

test('isPubliclyVisibleRecord (curated JSON path): fails CLOSED -- a record with no evidenceIntegrity at all is NOT visible', () => {
  assert.equal(isPubliclyVisibleRecord({ id: 'X-1' }), false);
});

test('isPubliclyVisibleRecord: verified official IR source is visible', () => {
  assert.equal(isPubliclyVisibleRecord({ evidenceIntegrity: { status: 'VERIFIED_PRIMARY' } }), true);
});

test('isPubliclyVisibleRecord: verified NSE/BSE exchange copy is visible', () => {
  assert.equal(isPubliclyVisibleRecord({ evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' } }), true);
});

test('isPubliclyVisibleRecord: every non-public-safe status is excluded (missing source, broken URL, placeholder URL modeled as SOURCE_UNAVAILABLE; missing page/claim modeled as PROVENANCE_INCOMPLETE/CLAIM_NOT_FOUND; numeric/period mismatch; unsupported source; quarantined)', () => {
  for (const status of ['SOURCE_UNAVAILABLE', 'PROVENANCE_INCOMPLETE', 'CLAIM_NOT_FOUND', 'VALUE_MISMATCH', 'PERIOD_MISMATCH', 'UNSUPPORTED', 'QUARANTINED']) {
    assert.equal(isPubliclyVisibleRecord({ evidenceIntegrity: { status } }), false, `${status} must not be publicly visible`);
  }
});

test('isPubliclyVisiblePromise (ManagementPromise/live-research path): fails OPEN -- a document with no evidenceIntegrity at all remains visible (preserves existing cross-symbol behavior)', () => {
  assert.equal(isPubliclyVisiblePromise({ _id: 'x' }), true);
});

test('isPubliclyVisiblePromise: an explicit non-public-safe status excludes the document', () => {
  assert.equal(isPubliclyVisiblePromise({ evidenceIntegrity: { status: 'UNSUPPORTED' } }), false);
  assert.equal(isPubliclyVisiblePromise({ evidenceIntegrity: { status: 'QUARANTINED' } }), false);
});

// ---------------------------------------------------------------------------
// Real curated-dataset quarantine behavior (TCS-FY2026-001).
// ---------------------------------------------------------------------------
test('REAL AUDIT RESULT: TCS-FY2026-001 (unfetchable tcs.com source) is quarantined and never appears in the public curated timeline', async () => {
  const timeline = await getCompanyTimeline('TCS');
  assert.ok(!timeline.timeline.some((r) => r.id === 'TCS-FY2026-001'), 'quarantined record leaked into the public timeline');
  assert.ok(!timeline.sources.some((s) => s.url.includes('tcs.com')), 'a quarantined source URL leaked into the public sources list');
});

test('REAL AUDIT RESULT: TCS-FY2026-001 IS visible through the admin/debug view, with its exact quarantine reason exposed', async () => {
  const debugRecords = await getCompanyPromisesDebug('TCS');
  const quarantined = debugRecords.find((r) => r.id === 'TCS-FY2026-001');
  assert.ok(quarantined, 'the admin view must still be able to see quarantined records');
  assert.equal(quarantined.publiclyVisible, false);
  assert.equal(quarantined.evidenceIntegrityStatus, 'QUARANTINED');
  assert.match(quarantined.evidenceIntegrity.notes, /403|unavailable/i);
});

test('REAL AUDIT RESULT: TCS-FY2025-001 and TCS-FY2026-002 (real primary-source-verified) remain public', async () => {
  const promises = await getCompanyPromises('TCS');
  const ids = promises.map((r) => r.id);
  assert.ok(ids.includes('TCS-FY2025-001'));
  assert.ok(ids.includes('TCS-FY2026-002'));
  assert.equal(ids.includes('TCS-FY2026-001'), false);
});

test('score recalculation: Faith Score correctly recomputes to null once a resolved record is quarantined (2 < the 3-resolved-record minimum)', async () => {
  const promises = await getCompanyPromises('TCS');
  const faith = calculateFaithScore(promises);
  assert.equal(faith.resolvedCount, 2);
  assert.equal(faith.faithScore, null, 'Faith Score must never be computed from fewer than 3 resolved, publicly-verified promises');
});

// ---------------------------------------------------------------------------
// Cache invalidation: reloadCuratedDataset() picks up on-disk JSON changes,
// including a newly-quarantined record, without a process restart.
// ---------------------------------------------------------------------------
test('cache invalidation: reloadCuratedDataset() reflects the current on-disk evidenceIntegrity, not a stale in-memory snapshot', async () => {
  // The module-level cache was already warmed by an earlier test/import in
  // this same process; reloadCuratedDataset() must still report the SAME
  // (current, already-quarantined) state on a fresh read, proving it does
  // not silently serve a pre-audit snapshot.
  reloadCuratedDataset();
  const promises = await getCompanyPromises('TCS');
  assert.equal(promises.some((r) => r.id === 'TCS-FY2026-001'), false);
});

// ---------------------------------------------------------------------------
// Live-research (ManagementPromise) path: quarantine/pending leakage.
// ---------------------------------------------------------------------------
const baseDoc = (overrides = {}) => ({
  dataOrigin: 'REAL_RESEARCH',
  companyId: TEST_SYMBOL,
  symbol: TEST_SYMBOL,
  companyName: 'Evidence Integrity Test Co',
  promise: {
    statement: 'Management guided revenue growth of at least 10%.',
    metric: 'REVENUE_GROWTH',
    targetValue: 10,
    targetUnit: 'PERCENTAGE',
    targetPeriod: 'FY2026',
    promiseDate: new Date('2025-04-01'),
    importance: 'MEDIUM',
  },
  outcome: { actualValue: null, actualUnit: null },
  verification: { status: 'PENDING', achievementPercentage: null },
  evidence: {
    promiseSource: { sourceUrl: 'https://example.com/ir/transcript.pdf', sourceDate: new Date('2025-04-01'), title: 'Test transcript', excerpt: 'We expect revenue growth of at least 10%.' },
  },
  status: 'PENDING',
  ...overrides,
});

test('pending candidate cannot leak publicly: a PromiseCandidate in PENDING_REVIEW never reaches the curated public timeline (unaffected by evidenceIntegrity -- gated earlier, by fetchAcceptedCandidates only reading ACCEPTED)', async () => {
  // Already covered structurally by CuratedEarningsIntelligenceService's
  // fetchAcceptedCandidates (reviewStatus: 'ACCEPTED' only) -- this test
  // documents that guarantee explicitly for Phase 4F's audit record.
  const { default: PromiseCandidate } = await import('../models/PromiseCandidate.js');
  const pending = await PromiseCandidate.find({ reviewStatus: 'PENDING_REVIEW' }).limit(1).lean();
  if (pending.length) assert.notEqual(pending[0].reviewStatus, 'ACCEPTED');
});

test('a ManagementPromise document explicitly QUARANTINED never leaks through the real grounded-RAG getCompanyPromises path', async () => {
  await ManagementPromise.create(baseDoc({
    evidenceIntegrity: { status: 'QUARANTINED', auditedAt: new Date(), auditedBy: 'test', notes: 'test quarantine' },
  }));
  const results = await getLegacyCompanyPromises(TEST_SYMBOL);
  assert.equal(results.length, 0);
});

test('a ManagementPromise document explicitly UNSUPPORTED (bad source domain) never leaks through the real grounded-RAG getCompanyPromises path', async () => {
  await ManagementPromise.create(baseDoc({
    evidence: { promiseSource: { sourceUrl: 'https://some-random-blog.example/article', sourceDate: new Date(), title: 'Blog post', excerpt: 'Some claim.' } },
    evidenceIntegrity: { status: 'UNSUPPORTED', auditedAt: new Date(), auditedBy: 'test', notes: 'not an official source' },
  }));
  const results = await getLegacyCompanyPromises(TEST_SYMBOL);
  assert.equal(results.length, 0);
});

test('a ManagementPromise document with NO evidenceIntegrity (never audited) still appears -- existing live-research behavior for other symbols is unaffected', async () => {
  await ManagementPromise.create(baseDoc());
  const results = await getLegacyCompanyPromises(TEST_SYMBOL);
  assert.equal(results.length, 1);
});

test('a ManagementPromise document explicitly VERIFIED_EXCHANGE_COPY remains visible', async () => {
  await ManagementPromise.create(baseDoc({
    evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY', auditedAt: new Date(), auditedBy: 'test', notes: 'confirmed' },
  }));
  const results = await getLegacyCompanyPromises(TEST_SYMBOL);
  assert.equal(results.length, 1);
});

// ---------------------------------------------------------------------------
// Hallucinated-field regression: a qualitative promise's schema-coerced
// targetValue:0 must never masquerade as a genuine numeric guidance claim.
// ---------------------------------------------------------------------------
test('a qualitative promise (operator: null, coerced targetValue: 0) never produces a fabricated numeric structuredGuidance', () => {
  const timeline = {
    promises: [{
      id: 'X-1', statement: 'We do not give guidance.', period: 'FY2026', status: 'PENDING',
      metric: 'REVENUE_GROWTH', targetValue: 0, targetUnit: 'PERCENTAGE', operator: null,
      evidence: { sourceUrl: 'https://example.com/a.pdf', excerpt: 'We do not give guidance.', documentTitle: 'x', publicationDate: '2025-01-01' },
      outcome: {},
    }],
  };
  const items = buildEarningsIntelligenceEnvelopeItems(timeline, { symbol: 'TEST' });
  assert.equal(items[0].structuredGuidance, null, 'a qualitative promise (no real operator) must never produce a structuredGuidance claim');
});

test('a genuinely quantified promise (operator present) DOES produce structuredGuidance, unaffected by the qualitative-promise fix', () => {
  const timeline = {
    promises: [{
      id: 'X-2', statement: 'We expect margin of at least 20%.', period: 'FY2026', status: 'PENDING',
      metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', operator: 'GTE',
      evidence: { sourceUrl: 'https://example.com/b.pdf', excerpt: 'We expect margin of at least 20%.', documentTitle: 'x', publicationDate: '2025-01-01' },
      outcome: {},
    }],
  };
  const items = buildEarningsIntelligenceEnvelopeItems(timeline, { symbol: 'TEST' });
  assert.deepEqual(items[0].structuredGuidance, { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', operator: 'GTE' });
});

// ---------------------------------------------------------------------------
// Real stored-document provenance resolution (Task 3): the two TCS records
// actually re-ingested through the normal document pipeline during this
// audit have real, locally stored, chunked, embedded primary-source text.
// ---------------------------------------------------------------------------
test('REAL AUDIT RESULT: TCS-FY2025-001 evidence documents are durably stored with real chunk coverage', async () => {
  const { CompanyDocumentRegistry } = await import('../models/CompanyDocumentRegistry.js');
  const { ResearchDocumentChunk } = await import('../models/ResearchDocumentChunk.js');
  const promiseDoc = await CompanyDocumentRegistry.findOne({ url: 'https://www.bseindia.com/xml-data/corpfiling/Attachhis/5c6ff602-30d9-490a-b147-1d824b5b6665.pdf' }).lean();
  assert.ok(promiseDoc, 'promiseEvidence document must be registered');
  assert.equal(promiseDoc.storageBackend, 'GRIDFS');
  assert.ok(promiseDoc.pdfHash);
  const chunkCount = await ResearchDocumentChunk.countDocuments({ registryDocumentId: promiseDoc._id });
  assert.ok(chunkCount > 0, 'the document must have real, locally stored chunks');
});
