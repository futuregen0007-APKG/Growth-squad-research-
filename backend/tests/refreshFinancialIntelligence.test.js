import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, refreshOneSymbol, refreshAllFinancialIntelligence } from '../scripts/refreshFinancialIntelligence.js';

test('chunk splits an array into groups of the given size, including a partial final group', () => {
  assert.deepEqual(chunk(['A', 'B', 'C', 'D', 'E'], 2), [['A', 'B'], ['C', 'D'], ['E']]);
  assert.deepEqual(chunk(['A', 'B', 'C'], 5), [['A', 'B', 'C']]);
  assert.deepEqual(chunk([], 3), []);
});

test('refreshAllFinancialIntelligence never fetches more than batchSize symbols concurrently', async () => {
  const symbols = ['A', 'B', 'C', 'D', 'E', 'F'];
  let inFlight = 0;
  let maxConcurrent = 0;
  const calls = [];

  const fetchBundle = async (symbol) => {
    calls.push(symbol);
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return { configured: true, symbol };
  };

  const results = await refreshAllFinancialIntelligence({ symbols, batchSize: 2, batchDelayMs: 5, fetchBundle });

  assert.equal(calls.length, 6);
  assert.ok(maxConcurrent <= 2, `expected at most 2 concurrent calls, saw ${maxConcurrent}`);
  assert.deepEqual(results.map((r) => r.symbol), symbols);
  assert.ok(results.every((r) => r.status === 'OK'));
});

test('refreshAllFinancialIntelligence waits batchDelayMs between batches (never fires all batches back-to-back)', async () => {
  const symbols = ['A', 'B', 'C', 'D'];
  const timestamps = [];
  const fetchBundle = async (symbol) => {
    timestamps.push(Date.now());
    return { configured: true, symbol };
  };

  await refreshAllFinancialIntelligence({ symbols, batchSize: 2, batchDelayMs: 50, fetchBundle });

  // batch 1: timestamps[0..1], batch 2: timestamps[2..3] -- the gap between the
  // last call of batch 1 and the first call of batch 2 must be >= the delay.
  const gap = timestamps[2] - timestamps[1];
  assert.ok(gap >= 45, `expected a >=50ms gap between batches, saw ${gap}ms`); // small tolerance for timer jitter
});

test('refreshOneSymbol retries exactly once on failure, then succeeds if the retry works', async () => {
  let attempts = 0;
  const fetchBundle = async (symbol) => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient upstream error');
    return { configured: true, symbol };
  };

  const result = await refreshOneSymbol('TCS', { fetchBundle });
  assert.equal(result.status, 'OK');
  assert.equal(attempts, 2);
});

test('refreshOneSymbol reports FAILED (never throws) after exhausting its one retry', async () => {
  let attempts = 0;
  const fetchBundle = async () => {
    attempts += 1;
    throw new Error('permanently down');
  };

  const result = await refreshOneSymbol('TCS', { fetchBundle });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'permanently down');
  assert.equal(attempts, 2); // initial attempt + exactly 1 retry, never a retry storm
});

test('one symbol failing never stops the batch -- the rest still get refreshed', async () => {
  const symbols = ['GOOD1', 'BAD', 'GOOD2'];
  const fetchBundle = async (symbol) => {
    if (symbol === 'BAD') throw new Error('down');
    return { configured: true, symbol };
  };

  const results = await refreshAllFinancialIntelligence({ symbols, batchSize: 3, batchDelayMs: 0, fetchBundle });
  const byStatus = Object.fromEntries(results.map((r) => [r.symbol, r.status]));
  assert.equal(byStatus.GOOD1, 'OK');
  assert.equal(byStatus.GOOD2, 'OK');
  assert.equal(byStatus.BAD, 'FAILED');
});

test('refreshAllFinancialIntelligence defaults to every SUPPORTED_STOCKS symbol when none are specified', async () => {
  const seen = new Set();
  const fetchBundle = async (symbol) => {
    seen.add(symbol);
    return { configured: true };
  };
  // Small batch size and zero delay keep this fast even across all 215 symbols.
  const results = await refreshAllFinancialIntelligence({ batchSize: 20, batchDelayMs: 0, fetchBundle });
  assert.ok(results.length > 200); // matches the real SUPPORTED_STOCKS scale without hardcoding the exact count
  assert.equal(seen.size, results.length);
});
