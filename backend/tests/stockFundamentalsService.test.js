import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFundamentalsFromKeyMetrics, fetchAndCacheFundamentals, getCachedFundamentals } from '../services/StockFundamentalsService.js';

class FakeApiError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

test('extractFundamentalsFromKeyMetrics finds real P/E and ROE by name pattern, never a fixed key', () => {
  const categories = [
    { category: 'valuation', metrics: [{ name: 'Price to Earnings Ratio', value: 27.4 }] },
    { category: 'mgmtEffectiveness', metrics: [{ name: 'Return on average equity - 5 year average', value: 48.55 }] },
  ];
  const result = extractFundamentalsFromKeyMetrics(categories);
  assert.equal(result.pe, 27.4);
  assert.equal(result.roe, 48.55);
});

test('extractFundamentalsFromKeyMetrics prefers a current-period metric over a 5-year-average variant when both exist', () => {
  const categories = [
    { category: 'mgmtEffectiveness', metrics: [
      { name: 'Return on average equity - 5 year average', value: 40 },
      { name: 'Return on average equity', value: 22 },
    ] },
  ];
  const result = extractFundamentalsFromKeyMetrics(categories);
  assert.equal(result.roe, 22);
});

test('extractFundamentalsFromKeyMetrics returns null (never a default) when no matching metric exists', () => {
  const result = extractFundamentalsFromKeyMetrics([{ category: 'margins', metrics: [{ name: 'Operating margin', value: 20 }] }]);
  assert.equal(result.pe, null);
  assert.equal(result.roe, null);
});

test('fetchAndCacheFundamentals retries a RATE_LIMITED error and succeeds on a later attempt', async () => {
  let calls = 0;
  const getKeyMetricsFn = async () => {
    calls += 1;
    if (calls < 3) throw new FakeApiError('RATE_LIMITED', 'Rate limit exceeded');
    return { data: { categories: [{ category: 'valuation', metrics: [{ name: 'P/E', value: 18 }] }] } };
  };
  const result = await fetchAndCacheFundamentals('TESTSYM_RETRY', { getKeyMetricsFn, skipDelay: true });
  assert.equal(result.status, 'OK');
  assert.equal(result.record.pe, 18);
  assert.equal(calls, 3);
});

test('fetchAndCacheFundamentals never retries a non-retryable error (e.g. AUTHENTICATION_ERROR)', async () => {
  let calls = 0;
  const getKeyMetricsFn = async () => { calls += 1; throw new FakeApiError('AUTHENTICATION_ERROR', 'bad key'); };
  const result = await fetchAndCacheFundamentals('TESTSYM_AUTH', { getKeyMetricsFn, skipDelay: true });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'AUTHENTICATION_ERROR');
  assert.equal(calls, 1, 'a non-retryable error must fail on the first attempt, never retried');
});

test('fetchAndCacheFundamentals reports RATE_LIMITED status (distinct from FAILED) once retries are exhausted', async () => {
  const getKeyMetricsFn = async () => { throw new FakeApiError('RATE_LIMITED', 'still limited'); };
  const result = await fetchAndCacheFundamentals('TESTSYM_EXHAUSTED', { getKeyMetricsFn, skipDelay: true });
  assert.equal(result.status, 'RATE_LIMITED');
});

test('a failed fetch never overwrites a previously cached real result (stale-serving, never erased)', async () => {
  // Uses an injected in-memory fake cache rather than the real Redis client
  // -- this environment has no Redis server running, and the invariant
  // under test (setCache is never called on failure) is pure application
  // logic, independent of which cache backend is behind getCache/setCache.
  const store = new Map();
  const setCacheFn = async (key, value) => { store.set(key, value); };
  const getCacheFn = async (key) => store.get(key) ?? null;

  const okFn = async () => ({ data: { categories: [{ category: 'valuation', metrics: [{ name: 'P/E', value: 25 }] }] } });
  await fetchAndCacheFundamentals('TESTSYM_STALE', { getKeyMetricsFn: okFn, skipDelay: true, setCacheFn });
  const beforeFailure = await getCachedFundamentals('TESTSYM_STALE', { getCacheFn });
  assert.equal(beforeFailure.pe, 25);

  const failFn = async () => { throw new FakeApiError('UPSTREAM_UNAVAILABLE', 'down'); };
  await fetchAndCacheFundamentals('TESTSYM_STALE', { getKeyMetricsFn: failFn, skipDelay: true, setCacheFn });
  const afterFailure = await getCachedFundamentals('TESTSYM_STALE', { getCacheFn });
  assert.equal(afterFailure.pe, 25, 'the earlier real cached value must survive a later transient failure');
});
