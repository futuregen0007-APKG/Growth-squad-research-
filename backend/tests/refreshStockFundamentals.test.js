import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../scripts/refreshStockFundamentals.js';

// Uses an injected in-memory fake meta store rather than the real Redis
// client -- this environment has no Redis server running, and the resume
// logic under test is pure application logic independent of the backend.
const makeFakeMeta = () => {
  let stored = { lastSuccessfulRefresh: null, providerStatus: 'UNKNOWN', completedSymbols: [], failedSymbols: [] };
  return {
    getMetaFn: async () => stored,
    saveMetaFn: async (next) => { stored = next; },
  };
};

test('a whole rate-limited batch stops the run early and reports stoppedEarly', async () => {
  const { getMetaFn, saveMetaFn } = makeFakeMeta();
  const fetchFn = async () => ({ status: 'RATE_LIMITED', errorCode: 'RATE_LIMITED', error: 'limited' });
  const summary = await run({ symbols: ['A', 'B', 'C', 'D'], batchSize: 2, delayMs: 0, fetchFn, getMetaFn, saveMetaFn });
  assert.equal(summary.stoppedEarly, true);
  assert.equal(summary.completedSymbols.length, 0);
  assert.equal(summary.failedSymbols.length, 2, 'only the first (fully rate-limited) batch should have been attempted');
});

test('one symbol failing never stops the batch -- the rest still get refreshed', async () => {
  const { getMetaFn, saveMetaFn } = makeFakeMeta();
  const fetchFn = async (symbol) => (symbol === 'BAD' ? { status: 'FAILED', errorCode: 'NOT_FOUND', error: 'missing' } : { status: 'OK', record: { pe: 10 } });
  const summary = await run({ symbols: ['GOOD1', 'BAD', 'GOOD2'], batchSize: 3, delayMs: 0, fetchFn, getMetaFn, saveMetaFn });
  assert.equal(summary.completedSymbols.sort().join(','), 'GOOD1,GOOD2');
  assert.equal(summary.failedSymbols.length, 1);
  assert.equal(summary.failedSymbols[0].symbol, 'BAD');
});

test('--resume skips symbols already completed in a prior run, targeting only the rest', async () => {
  const { getMetaFn, saveMetaFn } = makeFakeMeta();
  const attempted = [];
  const fetchFn = async (symbol) => { attempted.push(symbol); return { status: 'OK', record: { pe: 1 } }; };

  const first = await run({ symbols: ['X', 'Y', 'Z'], batchSize: 3, delayMs: 0, fetchFn, getMetaFn, saveMetaFn });
  assert.equal(first.completedSymbols.sort().join(','), 'X,Y,Z');

  attempted.length = 0;
  const second = await run({ symbols: ['X', 'Y', 'Z', 'NEW'], batchSize: 4, delayMs: 0, resume: true, fetchFn, getMetaFn, saveMetaFn });
  assert.deepEqual(attempted, ['NEW'], '--resume must only attempt symbols not already completed');
  assert.equal(second.skippedAlreadyDone, 3);
});
