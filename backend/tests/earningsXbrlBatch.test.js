import test from 'node:test';
import assert from 'node:assert/strict';
import { planBatch, shouldStop, MAX_CONSECUTIVE_INDEX_FAILURES } from '../scripts/earningsXbrlBatch.js';

/**
 * earningsXbrlBatch.test.js
 * ===========================
 * The batch runner decides what to process next from the database alone, so
 * these pin that the choice is right: only PENDING companies, never one
 * already attempted this run, in the requested order, and that the run stops
 * instead of hammering a source that keeps refusing.
 */

const row = (symbol, category = 'PENDING', marketCapCr = null, researchEnabled = true) => (
  { symbol, category, profile: { present: marketCapCr != null || !researchEnabled, researchEnabled, marketCapCr } }
);
const ROWS = [row('DONE', 'COMPLETE'), row('BBB'), row('AAA'), row('PART', 'PARTIAL'), row('CCC'), row('OFF', 'PENDING', 5, false), row('BLOCK', 'BLOCKED')];

test('only pending, research-enabled companies are selected, by market cap then alphabetically', () => {
  assert.deepEqual(planBatch(ROWS, { batchSize: 10 }), ['AAA', 'BBB', 'CCC']);
});

test('a batch is capped at the requested size', () => {
  assert.deepEqual(planBatch(ROWS, { batchSize: 2 }), ['AAA', 'BBB']);
});

test('a company already attempted in this run is not selected again', () => {
  assert.deepEqual(planBatch(ROWS, { batchSize: 10, attempted: new Set(['AAA']) }), ['BBB', 'CCC']);
});

test('priority puts the listed symbols first, in that order, and leaves the rest in the default order', () => {
  assert.deepEqual(planBatch(ROWS, { batchSize: 10, priority: ['CCC', 'BBB'] }), ['CCC', 'BBB', 'AAA']);
  assert.deepEqual(planBatch(ROWS, { batchSize: 10, priority: ['NOT_IN_ROWS', 'CCC'] }), ['CCC', 'AAA', 'BBB']);
});

test('an explicit symbol list is honoured exactly, in its own order, ignoring category', () => {
  assert.deepEqual(planBatch(ROWS, { batchSize: 10, explicit: ['CCC', 'DONE', 'ZZZ', 'AAA'] }), ['CCC', 'DONE', 'AAA']);
});

test('an empty database of pending companies yields an empty batch', () => {
  assert.deepEqual(planBatch([row('DONE', 'COMPLETE'), row('BLOCK', 'BLOCKED')], { batchSize: 10 }), []);
});

test('the run stops after repeated NSE index failures, not before', () => {
  assert.equal(shouldStop({ consecutiveIndexFailures: MAX_CONSECUTIVE_INDEX_FAILURES - 1 }), null);
  assert.match(shouldStop({ consecutiveIndexFailures: MAX_CONSECUTIVE_INDEX_FAILURES }), /unavailable for 3 companies in a row/);
});

test('the run stops when its runtime or batch budget is used up, and a zero budget means unlimited', () => {
  assert.match(shouldStop({ elapsedMs: 61_000, maxRuntimeMs: 60_000 }), /max-runtime-min/);
  assert.equal(shouldStop({ elapsedMs: 9_999_999, maxRuntimeMs: 0 }), null);
  assert.match(shouldStop({ batchesDone: 3, maxBatches: 3 }), /max-batches/);
  assert.equal(shouldStop({ batchesDone: 99, maxBatches: 0 }), null);
});
