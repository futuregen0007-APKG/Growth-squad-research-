import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeToolResults, mergeEvidence } from '../graph/state.js';

/**
 * graphStateReducers.test.js
 * ============================
 * Phase 2 pre-implementation check #4: "Phase 2 will execute tools twice
 * at most, so the second round must not erase first-round evidence or
 * duplicate it." These test the two merge reducers directly, independent
 * of any node or graph wiring, per the instruction to add reducer logic
 * only where necessary and test it directly.
 */

test('mergeToolResults: a round-2 result with a NEW fingerprint is appended, round-1 results are kept', () => {
  const round1 = [{ tool: 'getLiveQuote', fingerprint: 'getLiveQuote:{"symbol":"TCS"}', status: 'SUCCESS', data: { price: 100 } }];
  const round2 = [{ tool: 'getCompanyNews', fingerprint: 'getCompanyNews:{"symbol":"TCS"}', status: 'SUCCESS', data: { articles: [] } }];
  const merged = mergeToolResults(round1, round2);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((r) => r.fingerprint), [round1[0].fingerprint, round2[0].fingerprint]);
});

test('mergeToolResults: a later FAILURE for a fingerprint that already SUCCEEDED must never overwrite the success', () => {
  const round1 = [{ tool: 'getLiveQuote', fingerprint: 'fp-tcs', status: 'SUCCESS', data: { price: 100 } }];
  const round2 = [{ tool: 'getLiveQuote', fingerprint: 'fp-tcs', status: 'ERROR', errorCode: 'UPSTREAM_UNAVAILABLE', data: null }];
  const merged = mergeToolResults(round1, round2);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'SUCCESS');
  assert.equal(merged[0].data.price, 100, 'round-1\'s real data must survive a round-2 failure at the same fingerprint');
});

test('mergeToolResults: a later SUCCESS for the same fingerprint refreshes the entry (fresher real data wins)', () => {
  const round1 = [{ tool: 'getLiveQuote', fingerprint: 'fp-tcs', status: 'SUCCESS', data: { price: 100 } }];
  const round2 = [{ tool: 'getLiveQuote', fingerprint: 'fp-tcs', status: 'SUCCESS', data: { price: 105 } }];
  const merged = mergeToolResults(round1, round2);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].data.price, 105);
});

test('mergeToolResults: different args/symbols always produce different fingerprints and are never collapsed into one entry', () => {
  const round1 = [{ tool: 'getCompanyFinancials', fingerprint: 'getCompanyFinancials:{"symbol":"TCS"}', status: 'SUCCESS' }];
  const round2 = [{ tool: 'getCompanyFinancials', fingerprint: 'getCompanyFinancials:{"symbol":"INFY"}', status: 'SUCCESS' }];
  const merged = mergeToolResults(round1, round2);
  assert.equal(merged.length, 2, 'TCS and INFY financials must both be kept as distinct results');
});

test('mergeToolResults: an empty round-2 update is a no-op, round-1 results pass through unchanged', () => {
  const round1 = [{ tool: 'getLiveQuote', fingerprint: 'fp-tcs', status: 'SUCCESS' }];
  assert.equal(mergeToolResults(round1, []), round1);
});

test('mergeToolResults: preserves round-1 ordering, appending genuinely new entries after it', () => {
  const round1 = [
    { tool: 'getLiveQuote', fingerprint: 'fp-a', status: 'SUCCESS' },
    { tool: 'getCompanyNews', fingerprint: 'fp-b', status: 'EMPTY' },
  ];
  const round2 = [{ tool: 'getCompanyFinancials', fingerprint: 'fp-c', status: 'SUCCESS' }];
  const merged = mergeToolResults(round1, round2);
  assert.deepEqual(merged.map((r) => r.fingerprint), ['fp-a', 'fp-b', 'fp-c']);
});

const evidenceRecord = (overrides = {}) => ({
  evidenceId: `id-${Math.random()}`,
  claimType: 'LIVE_PRICE',
  symbol: 'TCS',
  title: null,
  sourceUrl: null,
  provider: 'angel-one',
  publishedAt: null,
  reportingPeriod: null,
  excerpt: null,
  ...overrides,
});

test('mergeEvidence: a genuinely new fact (different symbol) from round 2 is appended, round-1 evidence is kept', () => {
  const round1 = [evidenceRecord({ symbol: 'TCS' })];
  const round2 = [evidenceRecord({ symbol: 'INFY' })];
  const merged = mergeEvidence(round1, round2);
  assert.equal(merged.length, 2);
});

test('mergeEvidence: re-observing the SAME underlying fact in round 2 (fresh evidenceId, identical content) is deduped, not duplicated', () => {
  const round1 = [evidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'https://example.com/a', publishedAt: '2026-01-01', title: 'TCS wins deal' })];
  // Same content, but a brand-new evidenceId -- exactly what a replan round
  // re-fetching the same article via buildEvidenceRecord would produce.
  const round2 = [evidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'https://example.com/a', publishedAt: '2026-01-01', title: 'TCS wins deal' })];
  assert.notEqual(round1[0].evidenceId, round2[0].evidenceId);
  const merged = mergeEvidence(round1, round2);
  assert.equal(merged.length, 1, 'the same fact re-fetched a second round must not be duplicated just because its evidenceId differs');
});

test('mergeEvidence: two different facts about the same symbol (different claim types) are both kept', () => {
  const round1 = [evidenceRecord({ claimType: 'LIVE_PRICE', symbol: 'TCS' })];
  const round2 = [evidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'https://example.com/x' })];
  const merged = mergeEvidence(round1, round2);
  assert.equal(merged.length, 2);
});

test('mergeEvidence: an empty round-2 update is a no-op, round-1 evidence passes through unchanged', () => {
  const round1 = [evidenceRecord()];
  assert.equal(mergeEvidence(round1, []), round1);
});

// Regression guard: validateEvidence.js deliberately re-returns
// `evidence: evidenceForPrompt(deduped)` -- a TRIMMED transformation
// (fewer fields, truncated excerpt) of the EXACT SAME records already
// sitting in state.evidence, same identity, same order. A naive
// drop-on-match dedup would treat that as "already seen, discard the
// update" and silently defeat validateEvidence's trim step, leaving the
// untrimmed originals (with pageNumber/retrievedAt/evidenceQuality and an
// untruncated excerpt) flowing into the composer prompt instead.
test('mergeEvidence: an identity-matching update REPLACES the existing entry (never just dropped) -- validateEvidence\'s trim step must take effect', () => {
  const full = evidenceRecord({
    evidenceId: 'evid-1', claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'https://example.com/a',
    excerpt: 'x'.repeat(900), pageNumber: 3, evidenceQuality: 'HIGH',
  });
  const trimmed = { evidenceId: full.evidenceId, claimType: full.claimType, symbol: full.symbol, title: full.title, sourceUrl: full.sourceUrl, provider: full.provider, publishedAt: full.publishedAt, reportingPeriod: full.reportingPeriod, excerpt: full.excerpt.slice(0, 500) };
  const merged = mergeEvidence([full], [trimmed]);
  assert.equal(merged.length, 1, 'the trimmed version must replace, not add a second entry');
  assert.equal(merged[0].excerpt.length, 500, 'the trim must actually take effect in the merged state');
  assert.equal(merged[0].pageNumber, undefined, 'fields evidenceForPrompt deliberately drops must not survive via the untrimmed original');
});
