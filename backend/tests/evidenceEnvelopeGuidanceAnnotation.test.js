import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';
import { getVerifiedAnnotationsByChunkIds } from '../services/guidanceAnnotationLookup.js';
import { buildResearchEvidenceEnvelope, reconcileEvidenceEnvelope } from '../services/EvidenceEnvelope.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZENVELOPEANNOT';
const cleanup = async () => { await ResearchGuidanceAnnotation.deleteMany({ symbol: TEST_SYMBOL }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

// ---------------------------------------------------------------------------
// buildResearchEvidenceEnvelope's own chunkAnnotationsByChunkId param
// (Phase 4E.1 Part 7) — EvidenceEnvelope.js performs NO database I/O
// anywhere; this is a pure, synchronous function that only ever consumes a
// plain Map its caller (graph/tools/toolRegistry.js's retrieveGroundedEvidence,
// the async orchestration layer) already built.
// ---------------------------------------------------------------------------
const makeResult = (overrides = {}) => ({
  chunkId: 'chunk-1', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'EARNINGS_CALL_TRANSCRIPT',
  registryDocumentId: 'doc-1', title: 'title', sourceAuthority: 'EXCHANGE_FILING', publishedAt: '2025-10-09',
  sourceUrl: 'https://example.com/f.pdf', pageStart: 1, pageEnd: 1, text: 'some retrieved text', score: 1,
  ...overrides,
});

test('buildResearchEvidenceEnvelope attaches chunkAnnotation from a pre-fetched Map, with no database access of its own', () => {
  const annotationMap = new Map([['chunk-1', {
    status: 'VERIFIED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'ORIGINAL',
    valueType: 'range', lowerBound: 26, upperBound: 28, unit: 'PERCENTAGE', supportingSpan: 'margin of 26% to 28%',
  }]]);
  const envelope = buildResearchEvidenceEnvelope([makeResult()], { chunkAnnotationsByChunkId: annotationMap });
  assert.ok(envelope.items[0].chunkAnnotation);
  assert.equal(envelope.items[0].chunkAnnotation.metricKey, 'operating_margin');
});

test('buildResearchEvidenceEnvelope: an item whose chunkId has no Map entry gets no chunkAnnotation key at all', () => {
  const envelope = buildResearchEvidenceEnvelope([makeResult({ chunkId: 'chunk-unrelated' })], { chunkAnnotationsByChunkId: new Map() });
  assert.equal('chunkAnnotation' in envelope.items[0], false);
});

test('omitting chunkAnnotationsByChunkId entirely behaves exactly like passing an empty Map -- existing Phase 4D callers are unaffected', () => {
  const envelope = buildResearchEvidenceEnvelope([makeResult()]);
  assert.equal('chunkAnnotation' in envelope.items[0], false);
});

// ---------------------------------------------------------------------------
// Pre-budget integration proof (Task 7/8): a current, VERIFIED-annotated
// record must survive a tight MAX_EVIDENCE_ITEMS budget even when its own
// retriever rank/score would otherwise place it outside the budget window,
// and its SUPERSEDED predecessor -- even though it ranks/scores higher --
// must be the one pushed out instead. This is only possible because
// chunkAnnotationsByChunkId is threaded into the SAME canonicalForBudgeting
// pass that decides prioritization BEFORE the budget cut runs.
// ---------------------------------------------------------------------------
test('pre-budget prioritization: current annotated evidence survives a tight budget while its superseded predecessor is pushed out', () => {
  // Item "superseded" ranks FIRST by retriever score (would normally win a
  // budget slot outright) but is an OLDER, ORIGINAL guidance figure for the
  // exact same (symbol, metric, fiscalYear, fiscalQuarter) scope.
  const superseded = makeResult({
    chunkId: 'chunk-superseded', score: 100, publishedAt: '2025-07-10',
    text: 'We are targeting operating margin of 21% to 22% for FY2026.',
  });
  // Item "current" ranks LAST (score 1) -- without prioritization it would
  // be the 7th item and fall outside MAX_EVIDENCE_ITEMS (6), but it carries
  // a VERIFIED, explicitly-REVISED annotation with a LATER date for the
  // SAME canonical scope, so it must supersede "superseded" and win a slot.
  const current = makeResult({ chunkId: 'chunk-current', score: 1, publishedAt: '2025-10-09', text: 'ambiguous text with ambiguous phrasing standing alone' });
  const fillers = Array.from({ length: 5 }, (_, i) => makeResult({
    chunkId: `chunk-filler-${i}`, score: 50 - i, fiscalYear: 'FY2025', text: `Unrelated filler evidence number ${i}.`,
  }));

  const annotationMap = new Map([['chunk-current', {
    status: 'VERIFIED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'REVISED',
    valueType: 'range', lowerBound: 26, upperBound: 28, unit: 'PERCENTAGE', supportingSpan: 'revised to 26% to 28%',
  }]]);

  const results = [superseded, ...fillers, current]; // 7 total, budget is 6
  const envelope = buildResearchEvidenceEnvelope(results, { chunkAnnotationsByChunkId: annotationMap });

  assert.equal(envelope.items.length, 6, 'the budget must still cap total items at 6');
  const includedChunkIds = envelope.items.map((i) => i.chunkId);
  assert.ok(includedChunkIds.includes('chunk-current'), 'the current, verified-revised record must survive the tight budget');
  assert.ok(!includedChunkIds.includes('chunk-superseded'), 'its superseded predecessor must be the one pushed out, despite ranking first by score');

  // The final reconciliation pass must also agree: "current" is CURRENT,
  // and had "superseded" survived, it would show SUPERSEDED -- but since it
  // was already dropped by budgeting, the surviving envelope simply never
  // carries it.
  const reconciled = reconcileEvidenceEnvelope(envelope);
  const currentItem = reconciled.items.find((i) => i.chunkId === 'chunk-current');
  assert.equal(currentItem.temporalStatus, 'CURRENT');
});

// --- reconcileEvidenceEnvelope: verified-annotation preference over runtime parsing ---
test('verified-annotation preference: canonicalGuidance is derived from the VERIFIED chunk annotation, not from ambiguous runtime text parsing', () => {
  const item = {
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'EARNINGS_CALL_TRANSCRIPT',
    // Deliberately ambiguous/bare "margin" -- runtime normalizeMetric alone
    // would return unresolved for this text (no "operating margin"/"ebitda
    // margin" alias present).
    text: 'Our margins should trend favourably this year.',
    publishedAt: '2025-10-09',
    chunkAnnotation: {
      status: 'VERIFIED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'ORIGINAL',
      valueType: 'range', lowerBound: 26, upperBound: 28, exactValue: null, unit: 'PERCENTAGE', currency: null,
    },
  };
  const reconciled = reconcileEvidenceEnvelope({ items: [item] });
  const canonical = reconciled.items[0].canonicalGuidance;
  assert.ok(canonical, 'expected a resolved canonicalGuidance from the verified annotation, not an unresolved runtime parse');
  assert.equal(canonical.metricKey, 'operating_margin');
  assert.equal(canonical.lowerBound, 26);
  assert.equal(canonical.upperBound, 28);
});

test('existing behavior unchanged for chunks without annotations: an item with no chunkAnnotation falls back to runtime text parsing exactly as before', () => {
  const item = {
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'EARNINGS_CALL_TRANSCRIPT',
    text: 'We are targeting operating margin of 24% to 25% for FY2026.', publishedAt: '2025-10-09',
  };
  const reconciled = reconcileEvidenceEnvelope({ items: [item] });
  const canonical = reconciled.items[0].canonicalGuidance;
  assert.ok(canonical);
  assert.equal(canonical.lowerBound, 24);
  assert.equal(canonical.upperBound, 25);
});

// --- Phase 4D relationship generation, now fed by a VERIFIED annotation ----
test('Phase 4D relationship generation from a verified annotation: an earlier chunk-derived record is SUPERSEDED by a later, explicitly-revised Earnings-Intelligence record for the same scope', () => {
  const earlierChunk = {
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'EARNINGS_CALL_TRANSCRIPT',
    text: 'ambiguous margin text with no clean alias', publishedAt: '2025-07-10',
    chunkAnnotation: {
      status: 'VERIFIED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'ORIGINAL',
      valueType: 'range', lowerBound: 24, upperBound: 25, exactValue: null, unit: 'PERCENTAGE', currency: null,
    },
  };
  const laterRevisedEi = {
    evidenceId: 'E2', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'MANAGEMENT_PROMISE',
    text: 'The company revised its operating margin guidance to 26% to 28% for FY2026.', publishedAt: '2025-10-09',
  };
  const reconciled = reconcileEvidenceEnvelope({ items: [earlierChunk, laterRevisedEi] });
  const supersedes = reconciled.relationships.find((r) => r.type === 'SUPERSEDES');
  assert.ok(supersedes, 'expected a SUPERSEDES relationship between the two records');
  assert.equal(supersedes.toEvidenceId, 'E1');
  assert.equal(supersedes.fromEvidenceId, 'E2');
  assert.equal(reconciled.items.find((i) => i.evidenceId === 'E1').temporalStatus, 'SUPERSEDED');
});

test('unverified annotation cannot produce SUPERSEDES: a REJECTED-status object attached to chunkAnnotation is ignored by normalizeGuidanceEvidence', () => {
  const item = {
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'EARNINGS_CALL_TRANSCRIPT',
    text: 'ambiguous margin text with no clean alias', publishedAt: '2025-07-10',
    // A REJECTED annotation should never be attached in production (only
    // status: VERIFIED is ever looked up by guidanceAnnotationLookup.js),
    // but normalizeGuidanceEvidence defends in depth by checking
    // chunkAnnotation.status itself too.
    chunkAnnotation: {
      status: 'REJECTED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'ORIGINAL',
      valueType: 'range', lowerBound: 24, upperBound: 25, exactValue: null, unit: 'PERCENTAGE', currency: null,
    },
  };
  const reconciled = reconcileEvidenceEnvelope({ items: [item] });
  assert.equal(reconciled.items[0].canonicalGuidance, null);
});

// ---------------------------------------------------------------------------
// Batched, not N+1 (Task 8): a single Mongo round trip for the WHOLE
// candidate pool, regardless of how many chunk ids are passed.
// ---------------------------------------------------------------------------
test('annotation lookup is batched, not N+1: one query covers the entire candidate pool', async () => {
  const chunkIds = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
  await ResearchGuidanceAnnotation.create({
    chunkId: chunkIds[2], chunkHash: 'h1', extractionVersion: '1', symbol: TEST_SYMBOL, documentType: 'EARNINGS_CALL_TRANSCRIPT',
    fiscalYear: 'FY2026', fiscalQuarter: 'Q2', sourceUrl: 'https://example.com/f.pdf', pageStart: 1, pageEnd: 1,
    isCandidateChunk: true, candidateSignals: ['MARGIN'], hasVerifiedAnnotation: true,
    annotations: [{
      status: 'VERIFIED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'ORIGINAL',
      valueType: 'range', lowerBound: 26, upperBound: 28, unit: 'PERCENTAGE', supportingSpan: 'margin of 26% to 28%',
      extractionMethod: 'DETERMINISTIC', confidence: 0.9,
    }],
  });

  const originalFind = ResearchGuidanceAnnotation.find.bind(ResearchGuidanceAnnotation);
  let findCallCount = 0;
  ResearchGuidanceAnnotation.find = (...args) => { findCallCount += 1; return originalFind(...args); };
  try {
    const map = await getVerifiedAnnotationsByChunkIds(chunkIds);
    assert.equal(findCallCount, 1, 'exactly one query must cover the whole batch, never one per chunkId');
    assert.equal(map.size, 1);
    assert.ok(map.has(String(chunkIds[2])));
  } finally {
    ResearchGuidanceAnnotation.find = originalFind;
  }
});

// ---------------------------------------------------------------------------
// No request-time LLM call (structural regression): the entire verified-
// annotation read path -- lookup, envelope construction, reconciliation --
// must never import anything LLM-related. Annotations are produced
// entirely OFFLINE by scripts/enrichGuidanceCorpus.js; nothing on the
// request path may call out to a model.
// ---------------------------------------------------------------------------
test('no request-time LLM call: the annotation read path imports nothing LLM/OpenAI-related', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    path.join(dir, '..', 'services', 'guidanceAnnotationLookup.js'),
    path.join(dir, '..', 'services', 'EvidenceEnvelope.js'),
    path.join(dir, '..', 'services', 'guidanceExtraction.js'),
    path.join(dir, '..', 'services', 'guidanceCandidateDetection.js'),
  ];
  const llmPattern = /\bopenai\b|\banthropic\b|\bfrom\s+['"].*llm/i;
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const importLines = content.split('\n').filter((l) => l.trim().startsWith('import'));
    for (const line of importLines) {
      assert.equal(llmPattern.test(line), false, `${file} must not import anything LLM-related on the request path: "${line.trim()}"`);
    }
  }
});
