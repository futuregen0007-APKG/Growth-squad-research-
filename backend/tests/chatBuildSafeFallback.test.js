import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeFallback } from '../graph/nodes/buildSafeFallback.js';

const baseState = (overrides = {}) => ({
  evidenceCoverage: [], missingEvidence: [], evidence: [], validationStatus: 'REPAIR_REQUIRED', onEvent: null,
  ...overrides,
});

test('required test 1 (fallback half): total abstention when nothing is covered at all', async () => {
  const result = await buildSafeFallback(baseState({
    missingEvidence: [{ symbol: 'HAL', dimension: 'PRICE', status: 'UNAVAILABLE' }, { symbol: 'BEL', dimension: 'PRICE', status: 'UNAVAILABLE' }],
  }));
  assert.match(result.answer, /don't have verified data/i);
  assert.deepEqual(result.citations, []);
  assert.equal(result.validationStatus, 'ABSTAINED');
  assert.ok(!/founded|1940|1954/i.test(result.answer), 'must never contain fabricated facts');
});

test('buildSafeFallback cites REAL evidence for a COVERED row, never inventing one', async () => {
  const result = await buildSafeFallback(baseState({
    evidenceCoverage: [{ symbol: 'TCS', dimension: 'FINANCIALS', status: 'COVERED' }],
    evidence: [{ evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'TCS', excerpt: 'Revenue grew 12%' }],
  }));
  assert.match(result.answer, /Revenue grew 12%/);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].evidenceId, 'e1');
});

test('a mix of covered and missing rows produces both a fact line and an honest gap statement', async () => {
  const result = await buildSafeFallback(baseState({
    evidenceCoverage: [{ symbol: 'TCS', dimension: 'FINANCIALS', status: 'COVERED' }],
    evidence: [{ evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'TCS', excerpt: 'Revenue grew 12%' }],
    missingEvidence: [{ symbol: 'TCS', dimension: 'NEWS', status: 'UNAVAILABLE' }],
  }));
  assert.match(result.answer, /Revenue grew 12%/);
  assert.match(result.answer, /news/i);
});

test('validationStatus FAILED_SAFE (pipeline failure) is preserved, never downgraded to ABSTAINED', async () => {
  const result = await buildSafeFallback(baseState({ validationStatus: 'FAILED_SAFE' }));
  assert.equal(result.validationStatus, 'FAILED_SAFE');
});

test('validationStatus REPAIR_REQUIRED (repair exhausted, content-quality reason) is recorded as ABSTAINED', async () => {
  const result = await buildSafeFallback(baseState({ validationStatus: 'REPAIR_REQUIRED' }));
  assert.equal(result.validationStatus, 'ABSTAINED');
});

test('a COVERED row with no actual matching evidence (defensive) is simply omitted, never a fabricated fact line', async () => {
  const result = await buildSafeFallback(baseState({
    evidenceCoverage: [{ symbol: 'TCS', dimension: 'FINANCIALS', status: 'COVERED' }],
    evidence: [], // no matching evidence despite the COVERED status -- should not happen, but defensive
  }));
  assert.ok(!/Revenue/i.test(result.answer));
  assert.match(result.answer, /couldn't produce a fully verified answer/i);
});

test('emits the fallback text in bounded chunks, exactly like publishFinalAnswer', async () => {
  const emitted = [];
  const result = await buildSafeFallback(baseState({
    missingEvidence: [{ symbol: 'HAL', dimension: 'PRICE', status: 'UNAVAILABLE' }],
    onEvent: (e) => emitted.push(e),
  }));
  const tokenEvents = emitted.filter((e) => e.type === 'token');
  assert.equal(tokenEvents.map((e) => e.token).join(''), result.answer);
});
