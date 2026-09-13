import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCompute, buildCacheKey, CACHE_TTL_MS, __clearToolCacheForTests } from '../graph/tools/toolCache.js';

test.beforeEach(() => __clearToolCacheForTests());

test('the first call for a key is a MISS and computes the value', async () => {
  let calls = 0;
  const result = await getOrCompute('key-1', 10000, async () => { calls += 1; return 'value-1'; });
  assert.equal(result.value, 'value-1');
  assert.equal(result.cacheStatus, 'MISS');
  assert.equal(calls, 1);
});

test('a second call for the same key within the TTL is a HIT and never recomputes (fake clock)', async () => {
  let calls = 0;
  let now = 1000;
  const clock = { now: () => now };
  const compute = async () => { calls += 1; return `computed-${calls}`; };

  const first = await getOrCompute('key-2', 5000, compute, clock);
  assert.equal(first.cacheStatus, 'MISS');

  now += 1000; // still within the 5000ms TTL
  const second = await getOrCompute('key-2', 5000, compute, clock);
  assert.equal(second.cacheStatus, 'HIT');
  assert.equal(second.value, first.value);
  assert.equal(calls, 1, 'compute must not run again on a cache hit');
});

test('a call after the TTL expires is a MISS again and recomputes (fake clock)', async () => {
  let calls = 0;
  let now = 1000;
  const clock = { now: () => now };
  const compute = async () => { calls += 1; return `computed-${calls}`; };

  await getOrCompute('key-3', 5000, compute, clock);
  now += 5001; // just past the TTL
  const afterExpiry = await getOrCompute('key-3', 5000, compute, clock);
  assert.equal(afterExpiry.cacheStatus, 'MISS');
  assert.equal(calls, 2);
});

test('a rejected computeFn is never cached as if it were a successful result', async () => {
  let calls = 0;
  const failThenSucceed = async () => {
    calls += 1;
    if (calls === 1) throw new Error('provider down');
    return 'real-value';
  };

  await assert.rejects(() => getOrCompute('key-4', 10000, failThenSucceed));
  const second = await getOrCompute('key-4', 10000, failThenSucceed);
  assert.equal(second.value, 'real-value');
  assert.equal(second.cacheStatus, 'MISS', 'the failed attempt must not have poisoned the cache with a fake hit');
  assert.equal(calls, 2);
});

test('buildCacheKey includes the tool name, normalized args, and an optional data-version tag', () => {
  const withoutVersion = buildCacheKey('getLiveQuote', 'TCS');
  const withVersion = buildCacheKey('getLiveQuote', 'TCS', '2026-09-13');
  assert.notEqual(withoutVersion, withVersion);
  assert.match(withVersion, /v=2026-09-13/);
});

test('CACHE_TTL_MS gives live quotes a much shorter TTL than research documents/earnings timelines', () => {
  assert.ok(CACHE_TTL_MS.LIVE_QUOTE < CACHE_TTL_MS.COMPANY_NEWS);
  assert.ok(CACHE_TTL_MS.LIVE_QUOTE < CACHE_TTL_MS.EARNINGS_TIMELINE);
  assert.ok(CACHE_TTL_MS.LIVE_QUOTE < CACHE_TTL_MS.RESEARCH_DOCUMENTS);
});
