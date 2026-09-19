import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  classifyQualitativeDirection, normalizeGuidanceEvidence, QUALITATIVE_DIRECTIONS,
} from '../services/guidanceNormalization.js';
import { extractCandidatesFromChunk } from '../services/guidanceExtraction.js';
import { detectRelationships } from '../services/temporalRelationships.js';
import { buildEarningsIntelligenceEnvelopeItems, reconcileEvidenceEnvelope } from '../services/EvidenceEnvelope.js';
import { verifyGroundedClaim, checkQualitativeConsistency } from '../graph/groundedVerification.js';
import {
  linkPublicSafeEIEvidence, buildQualitativeAnnotationFromLinkage, normalizeForExactMatch, LINKAGE_REASONS,
} from '../services/evidenceLinkage.js';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZQUALITATIVE';
const cleanup = async () => {
  await ResearchDocumentChunk.deleteMany({ symbol: TEST_SYMBOL });
  await ResearchGuidanceAnnotation.deleteMany({ symbol: TEST_SYMBOL });
};
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

// ---------------------------------------------------------------------------
// Phase 4F.2 Part 10 #1-4: qualitative canonical schema + deterministic
// direction classification + ambiguous/generic-aspiration rejection.
// ---------------------------------------------------------------------------

test('classifyQualitativeDirection resolves an unambiguous direction for each of the documented vocabulary words', () => {
  assert.equal(classifyQualitativeDirection('we expect margins to expand').qualitativeDirection, 'EXPAND');
  assert.equal(classifyQualitativeDirection('we aim to reduce attrition').qualitativeDirection, 'REDUCE');
  assert.equal(classifyQualitativeDirection('management reiterated its guidance').qualitativeDirection, 'MAINTAIN');
  assert.equal(classifyQualitativeDirection('we are more optimistic about revenue').qualitativeDirection, 'IMPROVE');
  assert.equal(classifyQualitativeDirection('revenue is expected to increase').qualitativeDirection, 'INCREASE');
  assert.equal(classifyQualitativeDirection('costs are expected to decrease').qualitativeDirection, 'DECREASE');
  assert.equal(classifyQualitativeDirection('demand remains stable').qualitativeDirection, 'STABLE');
  for (const direction of QUALITATIVE_DIRECTIONS) assert.ok(typeof direction === 'string');
});

test('classifyQualitativeDirection: a generic aspiration with no directional verb at all is UNRESOLVED, never guessed', () => {
  const result = classifyQualitativeDirection('we aim to be the best in the industry');
  assert.equal(result.qualitativeDirection, null);
  assert.equal(result.confidence, 'unresolved');
  assert.equal(result.reason, 'NO_QUALITATIVE_DIRECTION_FOUND');
});

test('classifyQualitativeDirection: a sentence matching more than one DISTINCT direction pattern is ambiguous, never picked', () => {
  const result = classifyQualitativeDirection('we reiterated our plan to reduce costs while margins improve');
  assert.equal(result.qualitativeDirection, null);
  assert.equal(result.confidence, 'unresolved');
  assert.match(result.reason, /^AMBIGUOUS_DIRECTION:/);
});

// ---------------------------------------------------------------------------
// normalizeGuidanceEvidence: structured (Earnings-Intelligence) + chunk
// annotation qualitative paths — never a fake numeric value.
// ---------------------------------------------------------------------------

test('normalizeGuidanceEvidence: a structured QUALITATIVE record never gets a numeric value, and preserves the trusted excerpt as qualitativeText', () => {
  const record = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentType: 'MANAGEMENT_PROMISE', text: 'irrelevant', publishedAt: '2025-07-10',
  }, { structured: { metric: 'REVENUE_GROWTH', valueType: 'QUALITATIVE', qualitativeText: 'we are more optimistic in the coming quarter' } });
  assert.equal(record.valueType, 'qualitative');
  assert.equal(record.qualitativeDirection, 'IMPROVE');
  assert.equal(record.qualitativeText, 'we are more optimistic in the coming quarter');
  assert.equal(record.exactValue, null);
  assert.equal(record.lowerBound, null);
  assert.equal(record.unit, null);
  assert.equal(record.confidence, 'high');
});

test('normalizeGuidanceEvidence: a structured QUALITATIVE record whose excerpt has no resolvable direction stays unresolved, never a fabricated direction', () => {
  const record = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2026', fiscalQuarter: null, documentType: 'MANAGEMENT_PROMISE', text: 'irrelevant', publishedAt: '2025-07-10',
  }, { structured: { metric: 'REVENUE_GROWTH', valueType: 'QUALITATIVE', qualitativeText: 'we aim to be the best in the industry' } });
  assert.equal(record.valueType, null);
  assert.equal(record.qualitativeDirection, null);
  assert.equal(record.confidence, 'unresolved');
});

test('normalizeGuidanceEvidence: a VERIFIED qualitative chunk annotation is used directly, never re-parsed from raw text', () => {
  const record = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'INFY', fiscalYear: 'FY2024', fiscalQuarter: null, documentType: 'EARNINGS_CALL_TRANSCRIPT', text: 'some unrelated chunk text', publishedAt: '2023-04-01',
  }, {
    chunkAnnotation: {
      status: 'VERIFIED', metric: 'attrition', metricKey: 'attrition', guidanceKind: 'ORIGINAL', valueType: 'qualitative', qualitativeDirection: 'REDUCE', supportingSpan: 'We expect attrition to reduce further.',
    },
  });
  assert.equal(record.valueType, 'qualitative');
  assert.equal(record.qualitativeDirection, 'REDUCE');
  assert.equal(record.qualitativeText, 'We expect attrition to reduce further.');
  assert.equal(record.confidence, 'high');
});

test('normalizeGuidanceEvidence: existing EXACT/RANGE numeric behavior is completely unaffected by the qualitative additions', () => {
  const record = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2023', fiscalQuarter: null, documentType: 'ANNUAL_REPORT', text: 'Operating margin guidance of 21%-23% for FY2023.', publishedAt: '2023-01-01',
  });
  assert.equal(record.valueType, 'range');
  assert.equal(record.lowerBound, 21);
  assert.equal(record.upperBound, 23);
  assert.equal(record.qualitativeDirection, null);
  assert.equal(record.qualitativeText, null);
});

// ---------------------------------------------------------------------------
// Phase 4F.2 Part 3: strict qualitative extraction over a REAL chunk shape,
// reusing every existing disqualifying gate unchanged.
// ---------------------------------------------------------------------------

const chunk = (text, overrides = {}) => ({
  symbol: TEST_SYMBOL, documentType: 'EARNINGS_CALL_TRANSCRIPT', fiscalYear: 'FY2026', fiscalQuarter: null, text, ...overrides,
});

test('extraction: a genuine qualitative management guidance sentence is VERIFIED, with the correct metric and direction', () => {
  const { annotations } = extractCandidatesFromChunk(chunk('K Krithivasan: We expect operating margin to improve going forward.'));
  const verified = annotations.filter((a) => a.status === 'VERIFIED');
  assert.equal(verified.length, 1);
  assert.equal(verified[0].valueType, 'qualitative');
  assert.equal(verified[0].metricKey, 'operating_margin');
  assert.equal(verified[0].qualitativeDirection, 'IMPROVE');
});

test('extraction: an analyst question with no number is REJECTED, never treated as qualitative guidance', () => {
  const { annotations } = extractCandidatesFromChunk(chunk('Analyst: Do you expect margins to improve going forward?'));
  const rejected = annotations.filter((a) => a.status === 'REJECTED' && a.rejectionReasons.includes('ANALYST_QUESTION_LANGUAGE'));
  assert.ok(rejected.length >= 1);
  assert.equal(annotations.some((a) => a.status === 'VERIFIED'), false);
});

test('extraction: a courtesy phrase containing "you" is REJECTED even when it also carries genuine guidance language', () => {
  const { annotations } = extractCandidatesFromChunk(chunk('CEO: Nitin, as you know, we expect margins to improve going forward.'));
  const rejected = annotations.filter((a) => a.status === 'REJECTED' && a.rejectionReasons.includes('SECOND_PERSON_ADDRESS'));
  assert.ok(rejected.length >= 1);
  assert.equal(annotations.some((a) => a.status === 'VERIFIED'), false);
});

test('extraction: historical/actual-result language ("attrition declined") is REJECTED, never treated as forward guidance', () => {
  // The chunk-level candidate pre-filter needs SOME signal word to consider
  // this chunk at all (matching how a real transcript page discussing
  // attrition also discusses guidance elsewhere) -- the actual assertion
  // is about the SECOND sentence's own rejection, tested independently of
  // the first.
  const { annotations } = extractCandidatesFromChunk(chunk('CFO: We discussed our margin guidance. Our attrition declined steadily through the year.'));
  const rejected = annotations.filter((a) => a.status === 'REJECTED' && a.rejectionReasons.includes('ACTUAL_RESULT_NOT_GUIDANCE'));
  assert.ok(rejected.length >= 1);
  assert.equal(annotations.some((a) => a.status === 'VERIFIED'), false);
});

test('extraction: a generic aspiration with no resolvable metric/direction stays UNRESOLVED, never guessed', () => {
  const { annotations } = extractCandidatesFromChunk(chunk('CEO: We aim to be the best in the industry going forward.'));
  assert.equal(annotations.some((a) => a.status === 'VERIFIED'), false);
  assert.equal(annotations.some((a) => a.status === 'UNRESOLVED'), true);
});

test('extraction: qualitative wording with a resolvable metric but no forward-looking/guidance marker stays UNRESOLVED', () => {
  const { annotations } = extractCandidatesFromChunk(chunk('CEO: Our revenue growth is strong and our margins are healthy.'));
  assert.equal(annotations.some((a) => a.status === 'VERIFIED'), false);
});

test('extraction: existing numeric VERIFIED behavior is unaffected by the qualitative branch', () => {
  const { annotations } = extractCandidatesFromChunk(chunk('CEO: We expect operating margin of 21% to 23% for the year.'));
  const verified = annotations.filter((a) => a.status === 'VERIFIED');
  assert.equal(verified.length, 1);
  assert.equal(verified[0].valueType, 'range');
  assert.equal(verified[0].lowerBound, 21);
});

// ---------------------------------------------------------------------------
// Phase 4F.2 Part 4: EI-to-chunk deterministic linkage bridge.
// ---------------------------------------------------------------------------

test('normalizeForExactMatch treats curly and straight apostrophes as the same text (the real TCS-FY2026-002 discrepancy this audit found)', () => {
  assert.equal(normalizeForExactMatch("we don’t give guidance"), normalizeForExactMatch("we don't give guidance"));
});

test('evidenceLinkage: a public-safe record with a genuine matching chunk links successfully and can build a real qualitative annotation', async () => {
  const registryDocumentId = new mongoose.Types.ObjectId();
  await ResearchDocumentChunk.create({
    symbol: TEST_SYMBOL, registryDocumentId, documentType: 'EARNINGS_CALL_TRANSCRIPT', fiscalYear: 'FY2026', fiscalQuarter: 'Q2', documentHash: 'hash-linkage-1', approximateTokenCount: 20,
    sourceUrl: 'https://example.com/test-linkage.pdf', pageStart: 5, pageEnd: 5, chunkIndex: 0, chunkHash: 'hash-1',
    text: 'CEO: We expect international revenue to improve in the coming quarter.', publishedAt: new Date('2025-07-10'),
  });
  const eiRecord = {
    symbol: TEST_SYMBOL,
    evidenceIntegrity: { status: 'VERIFIED_EXCHANGE_COPY' },
    promiseEvidence: { sourceUrl: 'https://example.com/test-linkage.pdf', pageNumber: 5, excerpt: 'We expect international revenue to improve in the coming quarter.' },
  };
  const linkage = await linkPublicSafeEIEvidence(eiRecord, 'promise');
  assert.equal(linkage.linked, true);

  const result = await buildQualitativeAnnotationFromLinkage({
    linkage, metric: 'REVENUE_GROWTH', excerpt: eiRecord.promiseEvidence.excerpt, eiRecordId: 'TEST-1', symbol: TEST_SYMBOL,
  });
  assert.equal(result.annotated, true);
  assert.equal(result.annotation.qualitativeDirection, 'IMPROVE');
  assert.equal(result.annotation.extractionMethod, 'EI_LINKED_DETERMINISTIC');
});

test('evidenceLinkage: refuses immediately for a QUARANTINED record, never even querying for a chunk', async () => {
  const linkage = await linkPublicSafeEIEvidence({
    symbol: TEST_SYMBOL, evidenceIntegrity: { status: 'QUARANTINED' }, promiseEvidence: { sourceUrl: 'https://example.com/x.pdf', pageNumber: 1, excerpt: 'x' },
  }, 'promise');
  assert.equal(linkage.linked, false);
  assert.equal(linkage.reason, LINKAGE_REASONS.UNSAFE_INTEGRITY_STATUS);
});

test('evidenceLinkage: refuses for every other unsafe integrity status too (UNSUPPORTED, UNREVIEWED_LEGACY, PENDING_REVIEW, missing)', async () => {
  for (const status of ['UNSUPPORTED', 'UNREVIEWED_LEGACY', 'PENDING_REVIEW', undefined]) {
    const linkage = await linkPublicSafeEIEvidence({
      symbol: TEST_SYMBOL, evidenceIntegrity: { status }, promiseEvidence: { sourceUrl: 'https://example.com/x.pdf', pageNumber: 1, excerpt: 'x' },
    }, 'promise');
    assert.equal(linkage.linked, false, `status ${status} must be refused`);
  }
});

test('evidenceLinkage: a genuine provenance mismatch (no chunk with a matching excerpt) is reported honestly, never a manufactured link', async () => {
  await ResearchDocumentChunk.create({
    symbol: TEST_SYMBOL, registryDocumentId: new mongoose.Types.ObjectId(), documentType: 'EARNINGS_CALL_TRANSCRIPT', fiscalYear: 'FY2026', fiscalQuarter: null,
    documentHash: 'hash-linkage-2', approximateTokenCount: 15,
    sourceUrl: 'https://example.com/mismatch.pdf', pageStart: 5, pageEnd: 5, chunkIndex: 0, chunkHash: 'hash-2',
    text: 'This chunk discusses something completely unrelated.', publishedAt: new Date('2025-07-10'),
  });
  const linkage = await linkPublicSafeEIEvidence({
    symbol: TEST_SYMBOL, evidenceIntegrity: { status: 'VERIFIED_PRIMARY' }, promiseEvidence: { sourceUrl: 'https://example.com/mismatch.pdf', pageNumber: 5, excerpt: 'a completely different sentence never in this chunk' },
  }, 'promise');
  assert.equal(linkage.linked, false);
  assert.equal(linkage.reason, LINKAGE_REASONS.EXCERPT_NOT_FOUND_VERBATIM);
});

// ---------------------------------------------------------------------------
// Phase 4F.2 Part 5: temporal relationships.
// ---------------------------------------------------------------------------

const canonical = (overrides = {}) => ({
  evidenceId: 'E1', symbol: TEST_SYMBOL, metricKey: 'revenue_growth', targetFiscalYear: 'FY2026', targetQuarter: 'Q2',
  guidanceKind: 'original', valueType: 'exact', exactValue: 5, unit: 'PERCENTAGE', confidence: 'high', issuedAt: '2025-07-10',
  ...overrides,
});

test('temporalRelationships: a qualitative promise correctly links OUTCOME_FOR to its later NUMERIC actual result (the real TCS-FY2026-002 bug this audit found and fixed)', () => {
  const promise = canonical({
    evidenceId: 'E1', guidanceKind: 'original', valueType: 'qualitative', exactValue: null, unit: null, qualitativeDirection: 'IMPROVE', issuedAt: '2025-07-10',
  });
  const outcome = canonical({
    evidenceId: 'E2', guidanceKind: 'outcome', valueType: 'exact', exactValue: 0.6, unit: 'PERCENTAGE', issuedAt: '2025-10-09',
  });
  const rels = detectRelationships([promise, outcome]);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].type, 'OUTCOME_FOR');
  assert.equal(rels[0].fromEvidenceId, 'E2');
  assert.equal(rels[0].toEvidenceId, 'E1');
  // Part 5: fulfillment is never overstated for a qualitative guidance side.
  assert.equal(rels[0].fulfillmentEvaluable, false);
  assert.equal(rels[0].fulfillmentReason, 'QUALITATIVE_GUIDANCE_NO_DETERMINISTIC_FULFILLMENT_RULE');
});

test('temporalRelationships: numeric guidance + numeric outcome still reports fulfillmentEvaluable true, unaffected by the qualitative change', () => {
  const promise = canonical({ evidenceId: 'E1', guidanceKind: 'original', valueType: 'exact', exactValue: 20, issuedAt: '2025-04-01' });
  const outcome = canonical({ evidenceId: 'E2', guidanceKind: 'outcome', valueType: 'exact', exactValue: 22, issuedAt: '2025-10-09' });
  const rels = detectRelationships([promise, outcome]);
  assert.equal(rels[0].type, 'OUTCOME_FOR');
  assert.equal(rels[0].fulfillmentEvaluable, true);
});

test('temporalRelationships: two qualitative records with the SAME direction from different sources: SUPPORTS', () => {
  const a = canonical({ evidenceId: 'E1', valueType: 'qualitative', exactValue: null, unit: null, qualitativeDirection: 'IMPROVE', documentType: 'EARNINGS_CALL_TRANSCRIPT', issuedAt: '2025-07-10' });
  const b = canonical({ evidenceId: 'E2', valueType: 'qualitative', exactValue: null, unit: null, qualitativeDirection: 'IMPROVE', documentType: 'MANAGEMENT_PROMISE', issuedAt: '2025-07-11' });
  const rels = detectRelationships([a, b]);
  assert.equal(rels[0].type, 'SUPPORTS');
});

test('temporalRelationships: two qualitative records with genuinely DIFFERENT directions and no revision language: CONFLICTS, never guessed', () => {
  const a = canonical({ evidenceId: 'E1', valueType: 'qualitative', exactValue: null, unit: null, qualitativeDirection: 'IMPROVE', issuedAt: '2025-07-10' });
  const b = canonical({ evidenceId: 'E2', valueType: 'qualitative', exactValue: null, unit: null, qualitativeDirection: 'DECREASE', issuedAt: '2025-10-09' });
  const rels = detectRelationships([a, b]);
  assert.equal(rels[0].type, 'CONFLICTS');
});

test('temporalRelationships: a qualitative record is never compared against a numeric one for equality/supersession -- UNRESOLVED with VALUE_TYPE_MISMATCH', () => {
  const qualitative = canonical({ evidenceId: 'E1', valueType: 'qualitative', exactValue: null, unit: null, qualitativeDirection: 'IMPROVE', guidanceKind: 'original', issuedAt: '2025-07-10' });
  const numeric = canonical({ evidenceId: 'E2', valueType: 'exact', exactValue: 5, unit: 'PERCENTAGE', guidanceKind: 'original', issuedAt: '2025-10-09' });
  const rels = detectRelationships([qualitative, numeric]);
  assert.equal(rels[0].type, 'UNRESOLVED');
  assert.equal(rels[0].reason, 'VALUE_TYPE_MISMATCH');
});

// ---------------------------------------------------------------------------
// Phase 4F.2 Part 6: grounded verification.
// ---------------------------------------------------------------------------

const qualitativeEnvelopeItem = (overrides = {}) => ({
  evidenceId: 'E1', symbol: TEST_SYMBOL, text: 'we are more optimistic about international revenue in the coming quarter',
  canonicalGuidance: { valueType: 'qualitative', qualitativeDirection: 'IMPROVE', metricKey: 'revenue_growth' },
  temporalStatus: 'CURRENT',
  ...overrides,
});

test('groundedVerification: a claim that safely paraphrases a qualitative statement in the SAME direction is not flagged', () => {
  const verdict = checkQualitativeConsistency({ text: 'Management expected international revenue to improve.' }, [qualitativeEnvelopeItem()]);
  assert.equal(verdict, null);
});

test('groundedVerification: a claim asserting the OPPOSITE direction of the cited qualitative evidence is rejected', () => {
  const verdict = checkQualitativeConsistency({ text: 'Management expected international revenue to decrease.' }, [qualitativeEnvelopeItem()]);
  assert.equal(verdict.verdict, 'QUALITATIVE_DIRECTION_MISMATCH');
});

test('groundedVerification: firm-commitment language ("guaranteed 10% growth") citing only qualitative evidence is rejected as overreach', () => {
  const verdict = checkQualitativeConsistency({ text: 'Management guaranteed 10% international revenue growth.' }, [qualitativeEnvelopeItem()]);
  assert.equal(verdict.verdict, 'QUALITATIVE_OVERREACH');
});

test('groundedVerification: a fulfillment claim citing an outcome whose fulfillment is not deterministically evaluable is rejected', () => {
  const outcomeItem = { evidenceId: 'E2', symbol: TEST_SYMBOL, text: 'international revenue grew 0.6% QoQ', fulfillmentEvaluable: false };
  const verdict = checkQualitativeConsistency({ text: 'Management fully delivered on its guidance.' }, [outcomeItem]);
  assert.equal(verdict.verdict, 'UNSUPPORTED_FULFILLMENT_CLAIM');
});

test('groundedVerification: reporting the outcome plainly (no fulfillment language) is not blocked by fulfillmentEvaluable:false', () => {
  const outcomeItem = { evidenceId: 'E2', symbol: TEST_SYMBOL, text: 'international revenue grew 0.6% QoQ', fulfillmentEvaluable: false };
  const verdict = checkQualitativeConsistency({ text: 'International revenue grew 0.6% quarter-on-quarter.' }, [outcomeItem]);
  assert.equal(verdict, null);
});

test('groundedVerification: a numeric-only claim citing numeric-only evidence is completely unaffected by the qualitative checks', () => {
  const numericItem = { evidenceId: 'E1', symbol: TEST_SYMBOL, text: 'operating margin guidance of 21%-23%', canonicalGuidance: { valueType: 'range', lowerBound: 21, upperBound: 23 } };
  const verdict = checkQualitativeConsistency({ text: 'Operating margin guidance is 21%-23%.' }, [numericItem]);
  assert.equal(verdict, null);
});

test('verifyGroundedClaim: end-to-end rejects an overreaching fulfillment claim through the full claim-verification pipeline', () => {
  const evidenceById = new Map([['E1', qualitativeEnvelopeItem()], ['E2', { evidenceId: 'E2', symbol: TEST_SYMBOL, text: 'grew 0.6% QoQ', fulfillmentEvaluable: false }]]);
  const { verdict } = verifyGroundedClaim(
    { evidenceIds: ['E1', 'E2'], text: 'Management fully delivered on its guidance.' },
    { evidenceById, scope: {}, allEnvelopeItems: [...evidenceById.values()] },
  );
  assert.equal(verdict, 'UNSUPPORTED_FULFILLMENT_CLAIM');
});

// ---------------------------------------------------------------------------
// Phase 4F.2: EvidenceEnvelope's qualitative structuredGuidance construction
// and its strict operator===null signal (never a merely-missing field).
// ---------------------------------------------------------------------------

test('buildEarningsIntelligenceEnvelopeItems: operator === null (strictly) builds a qualitative structuredGuidance, never a fabricated number', () => {
  const timeline = {
    promises: [{
      id: 'X-1', statement: 'stmt', period: 'Q2 FY2026', status: 'PENDING', metric: 'REVENUE_GROWTH', targetValue: 0, targetUnit: 'OTHER', operator: null,
      evidence: { sourceUrl: 'https://example.com/a.pdf', excerpt: 'we are more optimistic about revenue', publicationDate: '2025-01-01' },
      outcome: {},
    }],
  };
  const items = buildEarningsIntelligenceEnvelopeItems(timeline, { symbol: TEST_SYMBOL });
  assert.deepEqual(items[0].structuredGuidance, { metric: 'REVENUE_GROWTH', valueType: 'QUALITATIVE', qualitativeText: 'we are more optimistic about revenue' });
});

test('buildEarningsIntelligenceEnvelopeItems: a merely-missing operator field (legacy/test fixture shape) is NOT treated as qualitative -- falls to the pre-existing null structuredGuidance', () => {
  const timeline = {
    promises: [{
      id: 'X-2', statement: 'stmt', period: 'FY2026', status: 'PENDING', metric: 'operating margin', targetValue: 21.5, targetUnit: 'PERCENTAGE',
      evidence: { sourceUrl: 'https://example.com/b.pdf', excerpt: 'Operating margin guidance of 21%-22%.', publicationDate: '2025-01-01' },
      outcome: {},
    }],
  };
  const items = buildEarningsIntelligenceEnvelopeItems(timeline, { symbol: TEST_SYMBOL });
  assert.equal(items[0].structuredGuidance, null);
});

test('reconcileEvidenceEnvelope: canonicalGuidance carries qualitativeDirection/qualitativeText for a qualitative item, and omits them entirely for a numeric one', () => {
  const envelope = {
    items: [
      { evidenceId: 'E1', symbol: TEST_SYMBOL, fiscalYear: 'FY2026', text: 'we are more optimistic about revenue', structuredGuidance: { metric: 'REVENUE_GROWTH', valueType: 'QUALITATIVE', qualitativeText: 'we are more optimistic about revenue' } },
      { evidenceId: 'E2', symbol: TEST_SYMBOL, fiscalYear: 'FY2023', text: 'Operating margin guidance of 21%-23%.' },
    ],
  };
  const reconciled = reconcileEvidenceEnvelope(envelope);
  const qualitativeItem = reconciled.items.find((i) => i.evidenceId === 'E1');
  const numericItem = reconciled.items.find((i) => i.evidenceId === 'E2');
  assert.equal(qualitativeItem.canonicalGuidance.qualitativeDirection, 'IMPROVE');
  assert.equal(qualitativeItem.canonicalGuidance.qualitativeText, 'we are more optimistic about revenue');
  assert.equal('qualitativeDirection' in numericItem.canonicalGuidance, false);
});
