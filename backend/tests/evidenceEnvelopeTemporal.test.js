import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchEvidenceEnvelope, mergeEarningsIntelligenceEvidence, reconcileEvidenceEnvelope } from '../services/EvidenceEnvelope.js';

/**
 * evidenceEnvelopeTemporal.test.js
 * ====================================
 * Phase 4D: end-to-end EvidenceEnvelope annotation, using genuinely mixed
 * document-chunk + Earnings-Intelligence evidence -- the exact root-cause
 * scenario (INFY FY2023 operating-margin guidance 21%-23% in a document
 * chunk, later revised to 21%-22% in an Earnings Intelligence record).
 */

const docResult = (overrides = {}) => ({
  chunkId: 'doc-1', symbol: 'INFY', registryDocumentId: 'reg-1', documentType: 'EARNINGS_CALL_TRANSCRIPT',
  title: 'INFY Q1 FY2023 Earnings Call', fiscalYear: 'FY2023', fiscalQuarter: null,
  publishedAt: '2022-07-01T00:00:00.000Z', sourceUrl: 'https://example.com/infy-q1.pdf', pageStart: 4, pageEnd: 4,
  text: 'We are guiding operating margin of 21%-23% for FY2023.', sourceAuthority: 'EARNINGS_CALL_TRANSCRIPT', score: 5,
  ...overrides,
});

test('reconcileEvidenceEnvelope marks the OLDER document chunk SUPERSEDED by a LATER Earnings-Intelligence record for the SAME canonical guidance scope, across DIFFERENT document types', () => {
  const docEnvelope = buildResearchEvidenceEnvelope([docResult()], { retrievalMode: 'LOCAL_HYBRID_RERANK', companyNames: { INFY: 'Infosys' } });
  const timeline = {
    promises: [{
      id: 'p1', statement: 'Revised operating margin guidance', period: 'FY2023', status: 'PENDING',
      metric: 'operating margin', targetValue: 21.5, targetUnit: 'PERCENTAGE',
      evidence: {
        sourceUrl: 'https://example.com/infy-revised.pdf', excerpt: 'Management revised FY2023 operating margin guidance to 21%-22%.', publicationDate: '2023-01-01T00:00:00.000Z', sourceName: 'Q2 Earnings Call',
      },
      outcome: { sourceUrl: null, excerpt: null },
    }],
  };
  const merged = mergeEarningsIntelligenceEvidence(docEnvelope, timeline, { symbol: 'INFY', companyName: 'Infosys' });
  const reconciled = reconcileEvidenceEnvelope(merged);

  const docItem = reconciled.items.find((i) => i.chunkId === 'doc-1');
  const eiItem = reconciled.items.find((i) => i.retrievalMode === 'EARNINGS_INTELLIGENCE_MERGE');

  assert.equal(docItem.temporalStatus, 'SUPERSEDED');
  assert.equal(docItem.supersededByEvidenceId, eiItem.evidenceId);
  assert.equal(eiItem.temporalStatus, 'CURRENT');
  assert.ok(eiItem.supersedesEvidenceIds.includes(docItem.evidenceId));
  assert.ok(reconciled.relationships.some((r) => r.type === 'SUPERSEDES' && r.fromEvidenceId === eiItem.evidenceId && r.toEvidenceId === docItem.evidenceId));
});

test('reconcileEvidenceEnvelope leaves ordinary, non-guidance evidence completely unaffected (no canonicalGuidance, temporalStatus defaults to CURRENT)', () => {
  const docEnvelope = buildResearchEvidenceEnvelope([docResult({
    chunkId: 'doc-news', text: 'TCS announced a new partnership with a global bank this quarter.',
  })]);
  const reconciled = reconcileEvidenceEnvelope(docEnvelope);
  assert.equal(reconciled.items[0].canonicalGuidance, null);
});

test('an isolated, unchallenged guidance disclosure (no siblings) is CURRENT, never marked superseded or conflicting', () => {
  const docEnvelope = buildResearchEvidenceEnvelope([docResult()]);
  const reconciled = reconcileEvidenceEnvelope(docEnvelope);
  assert.equal(reconciled.items[0].temporalStatus, 'CURRENT');
  assert.equal(reconciled.items[0].supersededByEvidenceId, null);
});

test('a PROMISE_OUTCOME item is always temporalStatus HISTORICAL, never CURRENT', () => {
  const timeline = {
    promises: [{
      id: 'p1', statement: 'Operating margin guidance', period: 'FY2023', status: 'FULFILLED',
      metric: 'operating margin', targetValue: 22, targetUnit: 'PERCENTAGE',
      evidence: { sourceUrl: 'https://example.com/g.pdf', excerpt: 'Guided 21%-23% operating margin.', publicationDate: '2022-07-01' },
      outcome: {
        actualValue: 22.4, actualUnit: 'PERCENTAGE', actualPeriod: 'FY2023', sourceUrl: 'https://example.com/o.pdf', sourceDate: '2023-05-01', excerpt: 'Delivered 22.4% operating margin for FY2023.',
      },
    }],
  };
  const merged = mergeEarningsIntelligenceEvidence({ items: [] }, timeline, { symbol: 'INFY', companyName: 'Infosys' });
  const reconciled = reconcileEvidenceEnvelope(merged);
  const outcomeItem = reconciled.items.find((i) => i.documentType === 'PROMISE_OUTCOME');
  assert.equal(outcomeItem.temporalStatus, 'HISTORICAL');
  const guidanceItem = reconciled.items.find((i) => i.documentType === 'MANAGEMENT_PROMISE');
  assert.ok(reconciled.relationships.some((r) => r.type === 'OUTCOME_FOR' && r.fromEvidenceId === outcomeItem.evidenceId && r.toEvidenceId === guidanceItem.evidenceId));
});

test('pre-budget prioritization: when the document-chunk pool exceeds the item cap, a CURRENT (superseding) chunk is never excluded in favor of keeping its SUPERSEDED sibling', () => {
  // 7 candidate chunks (cap is 6): the 5 highest-scored are unrelated
  // filler, the 6th-highest-scored is the OLDER (would-be-superseded)
  // guidance chunk, and the LOWEST-scored is the NEWER, explicitly
  // revised chunk for the exact same scope -- under plain score ordering
  // alone the revised chunk would be cut; the reconciliation pass must
  // still keep it over its own superseded predecessor.
  const filler = Array.from({ length: 5 }, (_, i) => docResult({
    chunkId: `filler-${i}`, score: 10 - i, text: `Unrelated filler content number ${i}.`, fiscalYear: null,
  }));
  const older = docResult({
    chunkId: 'older-guidance', score: 4, fiscalYear: 'FY2023', text: 'We are guiding operating margin of 21%-23% for FY2023.', publishedAt: '2022-07-01T00:00:00.000Z',
  });
  const newerRevised = docResult({
    chunkId: 'newer-revised', score: 0.1, fiscalYear: 'FY2023', text: 'Management revised FY2023 operating margin guidance to 21%-22%.', publishedAt: '2023-01-01T00:00:00.000Z',
  });

  const envelope = buildResearchEvidenceEnvelope([...filler, older, newerRevised]);
  assert.ok(envelope.items.length <= 6);
  assert.ok(envelope.items.some((i) => i.chunkId === 'newer-revised'), 'the current/revised chunk must survive budgeting even though it scored lowest');
  assert.ok(!envelope.items.some((i) => i.chunkId === 'older-guidance'), 'its now-superseded predecessor is the one that should be dropped instead');
});
