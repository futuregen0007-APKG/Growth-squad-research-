import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceRecord, evidenceForPrompt, CLAIM_TYPES } from '../graph/evidence.js';
import { extractCitations } from '../graph/nodes/composeAnswer.js';

test('buildEvidenceRecord returns null for an unknown/missing claimType instead of a partial fake record', () => {
  assert.equal(buildEvidenceRecord({ symbol: 'TCS' }), null);
  assert.equal(buildEvidenceRecord({ claimType: 'NOT_A_REAL_TYPE', symbol: 'TCS' }), null);
});

test('buildEvidenceRecord drops an unusable sourceUrl rather than keeping a fake link', () => {
  const record = buildEvidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'javascript:alert(1)' });
  assert.equal(record.sourceUrl, null);
});

test('buildEvidenceRecord preserves a real https sourceUrl and stamps retrievedAt', () => {
  const record = buildEvidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'https://example.com/a' });
  assert.equal(record.sourceUrl, 'https://example.com/a');
  assert.ok(record.retrievedAt);
  assert.ok(CLAIM_TYPES.includes(record.claimType));
});

test('evidenceForPrompt truncates a long excerpt and never leaks raw provider fields', () => {
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', excerpt: 'x'.repeat(1000) });
  const [prompt] = evidenceForPrompt([record]);
  assert.equal(prompt.excerpt.length, 500);
  assert.equal(prompt.raw, undefined);
});

test('extractCitations maps only [N] markers that are within range, sorted and deduplicated', () => {
  const evidence = [{ evidenceId: 'a' }, { evidenceId: 'b' }, { evidenceId: 'c' }];
  const answer = 'Revenue grew [2]. Margin held steady [2][1]. Unrelated [99].';
  const citations = extractCitations(answer, evidence);
  assert.deepEqual(citations.map((c) => c.evidenceId), ['a', 'b']);
});

test('extractCitations returns an empty array when the answer cites nothing', () => {
  assert.deepEqual(extractCitations('No citations here.', [{ evidenceId: 'a' }]), []);
});

test('extractCitations never fabricates a citation for an out-of-range marker', () => {
  const citations = extractCitations('See [5].', [{ evidenceId: 'a' }]);
  assert.deepEqual(citations, []);
});
