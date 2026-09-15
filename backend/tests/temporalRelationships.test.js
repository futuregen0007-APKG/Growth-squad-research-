import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRelationships } from '../services/temporalRelationships.js';

const record = (overrides = {}) => ({
  evidenceId: 'E1', symbol: 'INFY', metricKey: 'operating_margin', targetFiscalYear: 'FY2023', targetQuarter: null,
  guidanceKind: 'original', valueType: 'range', lowerBound: 21, upperBound: 23, exactValue: null, unit: 'PERCENTAGE',
  currency: null, issuedAt: '2023-01-01T00:00:00.000Z', documentType: 'EARNINGS_CALL_TRANSCRIPT', confidence: 'high',
  ...overrides,
});

test('same metric and period across two DIFFERENT document types: a later revision supersedes an older document chunk (the root-cause scenario)', () => {
  const chunk = record({ evidenceId: 'E1', documentType: 'EARNINGS_CALL_TRANSCRIPT', issuedAt: '2023-01-01T00:00:00.000Z' });
  const eiRecord = record({
    evidenceId: 'E2', documentType: 'MANAGEMENT_PROMISE', guidanceKind: 'revised', lowerBound: 21, upperBound: 22, issuedAt: '2023-06-01T00:00:00.000Z',
  });
  const relationships = detectRelationships([chunk, eiRecord]);
  const supersedes = relationships.find((r) => r.type === 'SUPERSEDES');
  assert.ok(supersedes, 'expected a SUPERSEDES relationship across the two different document types');
  assert.equal(supersedes.fromEvidenceId, 'E2');
  assert.equal(supersedes.toEvidenceId, 'E1');
});

test('original guidance followed by an explicit revision: SUPERSEDES', () => {
  const original = record({ evidenceId: 'E1', guidanceKind: 'original', lowerBound: 10, upperBound: 12, issuedAt: '2023-01-01' });
  const revised = record({ evidenceId: 'E2', guidanceKind: 'revised', lowerBound: 8, upperBound: 10, issuedAt: '2023-06-01' });
  const rels = detectRelationships([original, revised]);
  assert.deepEqual(rels.map((r) => r.type), ['SUPERSEDES']);
  assert.equal(rels[0].fromEvidenceId, 'E2');
  assert.equal(rels[0].toEvidenceId, 'E1');
});

test('repeated unchanged guidance (same value restated later, no revision language): REPEATS', () => {
  const first = record({ evidenceId: 'E1', issuedAt: '2023-01-01', documentType: 'EARNINGS_CALL_TRANSCRIPT' });
  const second = record({ evidenceId: 'E2', issuedAt: '2023-06-01', documentType: 'EARNINGS_CALL_TRANSCRIPT' });
  const rels = detectRelationships([first, second]);
  assert.deepEqual(rels.map((r) => r.type), ['REPEATS']);
});

test('identical value corroborated across a DIFFERENT source/document type: SUPPORTS, not REPEATS', () => {
  const chunk = record({ evidenceId: 'E1', documentType: 'EARNINGS_CALL_TRANSCRIPT', issuedAt: '2023-01-01' });
  const eiRecord = record({ evidenceId: 'E2', documentType: 'MANAGEMENT_PROMISE', issuedAt: '2023-01-15' });
  const rels = detectRelationships([chunk, eiRecord]);
  assert.deepEqual(rels.map((r) => r.type), ['SUPPORTS']);
});

test('explicit revision language required: a later publication with a DIFFERENT value but NO revision language never supersedes -- CONFLICTS instead', () => {
  const first = record({ evidenceId: 'E1', guidanceKind: 'original', lowerBound: 10, upperBound: 12, issuedAt: '2023-01-01' });
  const laterNoRevisionLanguage = record({ evidenceId: 'E2', guidanceKind: 'original', lowerBound: 8, upperBound: 10, issuedAt: '2023-06-01' });
  const rels = detectRelationships([first, laterNoRevisionLanguage]);
  assert.deepEqual(rels.map((r) => r.type), ['CONFLICTS']);
});

test('same metric but a DIFFERENT fiscal year: no relationship at all -- never compared', () => {
  const fy2023 = record({ evidenceId: 'E1', targetFiscalYear: 'FY2023' });
  const fy2024 = record({ evidenceId: 'E2', targetFiscalYear: 'FY2024', lowerBound: 8, upperBound: 10 });
  assert.deepEqual(detectRelationships([fy2023, fy2024]), []);
});

test('same fiscal year but a DIFFERENT quarter (quarterly vs annual): no relationship at all -- never equated', () => {
  const annual = record({ evidenceId: 'E1', targetQuarter: null });
  const quarterly = record({ evidenceId: 'E2', targetQuarter: 'Q4', lowerBound: 8, upperBound: 10 });
  assert.deepEqual(detectRelationships([annual, quarterly]), []);
});

test('different companies: no relationship at all', () => {
  const infy = record({ evidenceId: 'E1', symbol: 'INFY' });
  const tcs = record({ evidenceId: 'E2', symbol: 'TCS', lowerBound: 8, upperBound: 10 });
  assert.deepEqual(detectRelationships([infy, tcs]), []);
});

test('different units: flagged UNRESOLVED, never equated', () => {
  const percent = record({ evidenceId: 'E1', unit: 'PERCENTAGE', valueType: 'range' });
  const crore = record({
    evidenceId: 'E2', unit: 'INR_CRORE', valueType: 'exact', lowerBound: null, upperBound: null, exactValue: 500,
  });
  const rels = detectRelationships([percent, crore]);
  assert.deepEqual(rels.map((r) => r.type), ['UNRESOLVED']);
  assert.equal(rels[0].reason, 'UNIT_MISMATCH');
});

test('different metric variants (operating margin vs ebitda margin) are never grouped -- no relationship at all', () => {
  const operating = record({ evidenceId: 'E1', metricKey: 'operating_margin' });
  const ebitda = record({ evidenceId: 'E2', metricKey: 'ebitda_margin', lowerBound: 8, upperBound: 10 });
  assert.deepEqual(detectRelationships([operating, ebitda]), []);
});

test('ambiguous metric normalization (metricKey null): never grouped, never related', () => {
  const unresolved = record({ evidenceId: 'E1', metricKey: null, confidence: 'unresolved' });
  const resolved = record({ evidenceId: 'E2' });
  assert.deepEqual(detectRelationships([unresolved, resolved]), []);
});

test('multiple sequential revisions: each later revision supersedes its immediate predecessor', () => {
  const v1 = record({ evidenceId: 'E1', guidanceKind: 'original', lowerBound: 10, upperBound: 12, issuedAt: '2023-01-01' });
  const v2 = record({ evidenceId: 'E2', guidanceKind: 'revised', lowerBound: 9, upperBound: 11, issuedAt: '2023-04-01' });
  const v3 = record({ evidenceId: 'E3', guidanceKind: 'revised', lowerBound: 8, upperBound: 10, issuedAt: '2023-08-01' });
  const rels = detectRelationships([v1, v2, v3]);
  const supersedes = rels.filter((r) => r.type === 'SUPERSEDES');
  assert.equal(supersedes.length, 3); // v2 supersedes v1, v3 supersedes v1, v3 supersedes v2 (pairwise)
  assert.ok(supersedes.some((r) => r.fromEvidenceId === 'E2' && r.toEvidenceId === 'E1'));
  assert.ok(supersedes.some((r) => r.fromEvidenceId === 'E3' && r.toEvidenceId === 'E2'));
});

test('duplicate evidence (identical value, identical evidenceId list) produces a deterministic, non-crashing result', () => {
  const a = record({ evidenceId: 'E1' });
  const b = record({ evidenceId: 'E2' });
  const rels1 = detectRelationships([a, b]);
  const rels2 = detectRelationships([b, a]);
  assert.deepEqual(rels1, rels2);
});

test('missing issuedAt on one side with differing values: no reliable ordering -- CONFLICTS, never guessed as SUPERSEDES', () => {
  const withDate = record({ evidenceId: 'E1', issuedAt: '2023-01-01' });
  const noDate = record({
    evidenceId: 'E2', issuedAt: null, guidanceKind: 'revised', lowerBound: 8, upperBound: 10,
  });
  const rels = detectRelationships([withDate, noDate]);
  assert.deepEqual(rels.map((r) => r.type), ['CONFLICTS']);
});

test('conflicting same-date sources (different values, identical issuedAt): CONFLICTS', () => {
  const a = record({ evidenceId: 'E1', issuedAt: '2023-06-01T00:00:00.000Z' });
  const b = record({
    evidenceId: 'E2', issuedAt: '2023-06-01T00:00:00.000Z', lowerBound: 8, upperBound: 10,
  });
  const rels = detectRelationships([a, b]);
  assert.deepEqual(rels.map((r) => r.type), ['CONFLICTS']);
  assert.equal(rels[0].reason, 'DIFFERING_VALUES_SAME_DATE');
});

test('an outcome record links OUTCOME_FOR to the guidance record in the same scope, regardless of value equality', () => {
  const guidance = record({ evidenceId: 'E1', guidanceKind: 'original' });
  const outcome = record({
    evidenceId: 'E2', guidanceKind: 'outcome', documentType: 'PROMISE_OUTCOME', valueType: 'exact', lowerBound: null, upperBound: null, exactValue: 22,
  });
  const rels = detectRelationships([guidance, outcome]);
  assert.deepEqual(rels.map((r) => r.type), ['OUTCOME_FOR']);
  assert.equal(rels[0].fromEvidenceId, 'E2');
  assert.equal(rels[0].toEvidenceId, 'E1');
});

test('every relationship is marked deterministic:true', () => {
  const original = record({ evidenceId: 'E1', guidanceKind: 'original', lowerBound: 10, upperBound: 12, issuedAt: '2023-01-01' });
  const revised = record({ evidenceId: 'E2', guidanceKind: 'revised', lowerBound: 8, upperBound: 10, issuedAt: '2023-06-01' });
  const rels = detectRelationships([original, revised]);
  assert.ok(rels.every((r) => r.deterministic === true));
});
