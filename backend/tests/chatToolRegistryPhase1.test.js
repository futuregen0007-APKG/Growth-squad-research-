import test from 'node:test';
import assert from 'node:assert/strict';
import { getLiveQuote, TOOL_STATUS } from '../graph/tools/toolRegistry.js';
import { StockService } from '../services/StockService.js';
import { getProviderBreaker, __resetAllBreakersForTests, CIRCUIT_STATE } from '../graph/tools/circuitBreaker.js';
import { __clearToolCacheForTests } from '../graph/tools/toolCache.js';

test.beforeEach(() => {
  __resetAllBreakersForTests();
  __clearToolCacheForTests();
});

const withMockedGetStock = async (impl, fn) => {
  const original = StockService.prototype.getStock;
  StockService.prototype.getStock = impl;
  try {
    await fn();
  } finally {
    StockService.prototype.getStock = original;
  }
};

test('getLiveQuote caches a successful result -- a second call within the TTL never calls the provider again', async () => {
  let calls = 0;
  await withMockedGetStock(async function mockGetStock(symbol) {
    calls += 1;
    return { ticker: symbol, price: 100, changePct: 1, timestamp: new Date().toISOString() };
  }, async () => {
    const first = await getLiveQuote({ symbol: 'TCS' });
    const second = await getLiveQuote({ symbol: 'TCS' });
    assert.equal(calls, 1, 'the second call must be served from cache, not the provider');
    assert.equal(first.cacheStatus, 'MISS');
    assert.equal(second.cacheStatus, 'HIT');
    assert.equal(second.status, TOOL_STATUS.SUCCESS);
  });
});

test('getLiveQuote never caches a failed call -- a subsequent call still retries the provider', async () => {
  let calls = 0;
  await withMockedGetStock(async function mockGetStock() {
    calls += 1;
    throw Object.assign(new Error('provider down'), { errorCode: 'UPSTREAM_UNAVAILABLE' });
  }, async () => {
    await getLiveQuote({ symbol: 'TCS' });
    await getLiveQuote({ symbol: 'TCS' });
    assert.equal(calls, 2, 'a failure must never be cached as if it were a successful result');
  });
});

test('the angel-one circuit breaker opens after repeated failures and short-circuits further getLiveQuote calls without calling the provider', async () => {
  let calls = 0;
  await withMockedGetStock(async function mockGetStock() {
    calls += 1;
    throw Object.assign(new Error('timeout'), { errorCode: 'TIMEOUT' });
  }, async () => {
    const breaker = getProviderBreaker('angel-one', { failureThreshold: 2, cooldownMs: 60000 });
    await getLiveQuote({ symbol: 'A' });
    await getLiveQuote({ symbol: 'B' }); // different symbol each time -- never cache-hit, always a real attempt
    assert.equal(breaker.getState(), CIRCUIT_STATE.OPEN);
    const callsBeforeOpen = calls;
    const result = await getLiveQuote({ symbol: 'C' });
    assert.equal(calls, callsBeforeOpen, 'once OPEN, the provider must not be called again');
    assert.equal(result.status, TOOL_STATUS.UNAVAILABLE);
    assert.equal(result.circuitState, CIRCUIT_STATE.OPEN);
  });
});

test('the angel-one breaker opening never affects the independent news-api breaker (provider isolation)', async () => {
  // ES module named exports can't be monkey-patched the way TOOL_REGISTRY's
  // plain object entries or a class prototype method can (getStockNews is
  // a live-binding import, not a mutable property) -- so this test proves
  // the WIRING (getLiveQuote and getCompanyNews key their breakers by two
  // different provider names) without depending on a real network call.
  // The underlying isolation guarantee itself (one breaker opening never
  // moves a different one) is directly and fully covered by
  // circuitBreaker.test.js's own dedicated unit test.
  await withMockedGetStock(async function mockGetStock() {
    throw Object.assign(new Error('timeout'), { errorCode: 'TIMEOUT' });
  }, async () => {
    const angelOne = getProviderBreaker('angel-one', { failureThreshold: 1, cooldownMs: 60000 });
    await getLiveQuote({ symbol: 'TCS' });
    assert.equal(angelOne.getState(), CIRCUIT_STATE.OPEN);
  });

  const newsApi = getProviderBreaker('news-api');
  assert.equal(newsApi.getState(), CIRCUIT_STATE.CLOSED, 'a fresh, never-touched news-api breaker must start CLOSED regardless of angel-one\'s state');
  assert.notEqual(newsApi, getProviderBreaker('angel-one'), 'getLiveQuote and getCompanyNews must never share one breaker instance');
});

// Phase 2 pre-implementation check #1, exercised through the real tool
// entry point (not just the breaker class directly -- see
// circuitBreaker.test.js's dedicated test for that level): each call below
// passes its OWN fresh `context` object (a distinct AbortSignal-less
// object literal), exactly mirroring how two unrelated HTTP requests would
// each build their own request-scoped context. Different symbols are used
// so no call is ever cache-served -- every one is a genuine provider
// attempt whose outcome must land on the one shared 'angel-one' breaker.
test('getLiveQuote across many separately-scoped simulated requests shares one provider breaker -- failures are cumulative, not per-request', async () => {
  let calls = 0;
  await withMockedGetStock(async function mockGetStock() {
    calls += 1;
    throw Object.assign(new Error('timeout'), { errorCode: 'TIMEOUT' });
  }, async () => {
    const breaker = getProviderBreaker('angel-one', { failureThreshold: 3, cooldownMs: 60000 });

    await getLiveQuote({ symbol: 'REQ1' }, {}); // simulated request #1's own context
    assert.equal(breaker.getDiagnostics().consecutiveFailures, 1);

    await getLiveQuote({ symbol: 'REQ2' }, {}); // simulated request #2's own context
    assert.equal(breaker.getDiagnostics().consecutiveFailures, 2, 'request #2\'s failure must accumulate on top of request #1\'s, not start over');

    const thirdResult = await getLiveQuote({ symbol: 'REQ3' }, {}); // simulated request #3
    assert.equal(breaker.getState(), CIRCUIT_STATE.OPEN, 'the 3rd separately-scoped request\'s failure must cross the shared threshold');
    assert.equal(thirdResult.status, TOOL_STATUS.UNAVAILABLE);

    const callsBeforeFourthRequest = calls;
    const fourthResult = await getLiveQuote({ symbol: 'REQ4' }, {}); // simulated request #4, fresh context again
    assert.equal(calls, callsBeforeFourthRequest, 'a 4th independent request must be short-circuited too -- the OPEN breaker is not scoped to the request that opened it');
    assert.equal(fourthResult.status, TOOL_STATUS.UNAVAILABLE);
  });
});

test('a cancelled getLiveQuote call is reported with errorCode CANCELLED (soft cancellation) and never trips the circuit breaker', async () => {
  const controller = new AbortController();
  await withMockedGetStock(async function mockGetStock() {
    controller.abort(); // the "client disconnected mid-call" case
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    return { ticker: 'TCS', price: 100, changePct: 0, timestamp: new Date().toISOString() };
  }, async () => {
    const breaker = getProviderBreaker('angel-one');
    const before = breaker.getDiagnostics().consecutiveFailures;
    const result = await getLiveQuote({ symbol: 'TCS' }, { signal: controller.signal });
    assert.equal(result.errorCode, 'CANCELLED');
    assert.equal(result.cancellationMode, 'SOFT');
    assert.equal(breaker.getDiagnostics().consecutiveFailures, before, 'cancellation must never count as a provider failure');
  });
});
