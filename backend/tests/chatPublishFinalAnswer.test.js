import test from 'node:test';
import assert from 'node:assert/strict';
import { publishFinalAnswer } from '../graph/nodes/publishFinalAnswer.js';

const evidence = [
  { evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'TCS' },
  { evidenceId: 'e2', claimType: 'COMPANY_NEWS', symbol: 'TCS' },
];

test('publishFinalAnswer sets answer/citations from draftAnswer and emits it in bounded chunks', async () => {
  const emitted = [];
  const draftAnswer = 'TCS revenue grew 12% [1] and won a major deal [2].';
  const result = await publishFinalAnswer({ draftAnswer, evidence, onEvent: (e) => emitted.push(e) });

  assert.equal(result.answer, draftAnswer);
  assert.deepEqual(result.citations.map((c) => c.evidenceId), ['e1', 'e2']);

  const tokenEvents = emitted.filter((e) => e.type === 'token');
  assert.ok(tokenEvents.length > 1, 'a non-trivial answer should be split into multiple bounded chunks, not one giant event');
  assert.equal(tokenEvents.map((e) => e.token).join(''), draftAnswer, 'reassembling every chunk must reproduce the exact final text');
});

// Required test 21: final citations are recalculated, never inherited
test('required test 21: citations are recomputed fresh from draftAnswer, ignoring any different citations from an earlier round', async () => {
  const result = await publishFinalAnswer({ draftAnswer: 'Only cite [2] this time.', evidence, onEvent: null });
  assert.deepEqual(result.citations.map((c) => c.evidenceId), ['e2']);
});

test('an out-of-range citation marker in the final text is silently dropped, never fabricated', async () => {
  const result = await publishFinalAnswer({ draftAnswer: 'See [1] and [99].', evidence, onEvent: null });
  assert.deepEqual(result.citations.map((c) => c.evidenceId), ['e1']);
});

test('a null draftAnswer never crashes and produces an empty answer/citations', async () => {
  const result = await publishFinalAnswer({ draftAnswer: null, evidence: [], onEvent: null });
  assert.equal(result.answer, '');
  assert.deepEqual(result.citations, []);
});

test('no onEvent callback (e.g. legacySendMessage, non-streaming) never throws', async () => {
  const result = await publishFinalAnswer({ draftAnswer: 'Plain text.', evidence: [], onEvent: null });
  assert.equal(result.answer, 'Plain text.');
});
