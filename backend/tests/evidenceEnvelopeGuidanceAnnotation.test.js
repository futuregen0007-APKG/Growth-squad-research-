import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';
import { attachVerifiedChunkAnnotations, reconcileEvidenceEnvelope } from '../services/EvidenceEnvelope.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZENVELOPEANNOT';
const cleanup = async () => { await ResearchGuidanceAnnotation.deleteMany({ symbol: TEST_SYMBOL }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

// --- attachVerifiedChunkAnnotations (DB-backed, additive step) -------------
test('attachVerifiedChunkAnnotations: an item whose chunkId has a VERIFIED annotation gets chunkAnnotation attached', async () => {
  const chunkId = new mongoose.Types.ObjectId();
  await ResearchGuidanceAnnotation.create({
    chunkId, chunkHash: 'h1', extractionVersion: '1', symbol: TEST_SYMBOL, documentType: 'EARNINGS_CALL_TRANSCRIPT',
    fiscalYear: 'FY2026', fiscalQuarter: 'Q2', sourceUrl: 'https://example.com/f.pdf', pageStart: 1, pageEnd: 1,
    isCandidateChunk: true, candidateSignals: ['MARGIN'], hasVerifiedAnnotation: true,
    annotations: [{
      status: 'VERIFIED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'ORIGINAL',
      valueType: 'range', lowerBound: 26, upperBound: 28, unit: 'PERCENTAGE', supportingSpan: 'margin of 26% to 28%',
      extractionMethod: 'DETERMINISTIC', confidence: 0.9,
    }],
  });

  const envelope = { items: [{ evidenceId: 'E1', chunkId: String(chunkId), text: 'unrelated text with no clean guidance figure' }] };
  const result = await attachVerifiedChunkAnnotations(envelope);
  assert.ok(result.items[0].chunkAnnotation);
  assert.equal(result.items[0].chunkAnnotation.metricKey, 'operating_margin');
});

test('attachVerifiedChunkAnnotations: an item with no VERIFIED annotation is returned completely unchanged (no chunkAnnotation key at all)', async () => {
  const envelope = { items: [{ evidenceId: 'E1', chunkId: String(new mongoose.Types.ObjectId()), text: 'some text' }] };
  const result = await attachVerifiedChunkAnnotations(envelope);
  assert.equal('chunkAnnotation' in result.items[0], false);
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
    // A REJECTED annotation should never be attached by
    // attachVerifiedChunkAnnotations in production (it only ever queries
    // status: VERIFIED), but normalizeGuidanceEvidence defends in depth by
    // checking chunkAnnotation.status itself too.
    chunkAnnotation: {
      status: 'REJECTED', metric: 'operating margin', metricKey: 'operating_margin', guidanceKind: 'ORIGINAL',
      valueType: 'range', lowerBound: 24, upperBound: 25, exactValue: null, unit: 'PERCENTAGE', currency: null,
    },
  };
  const reconciled = reconcileEvidenceEnvelope({ items: [item] });
  assert.equal(reconciled.items[0].canonicalGuidance, null);
});
