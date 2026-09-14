import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareStocks, resolveComparisonPlan, MAX_COMPARISON_OPERATIONS, TOOL_STATUS,
} from '../graph/tools/toolRegistry.js';
import { DEFAULT_COMPARISON_DIMENSIONS } from '../graph/dimensions.js';
import { StockService } from '../services/StockService.js';
import { __resetAllBreakersForTests } from '../graph/tools/circuitBreaker.js';
import { __clearToolCacheForTests } from '../graph/tools/toolCache.js';

test.beforeEach(() => {
  __resetAllBreakersForTests();
  __clearToolCacheForTests();
});

// ---------------------------------------------------------------------------
// resolveComparisonPlan — the pure planning logic, tested directly so these
// don't need to trigger any real per-dimension provider call (see the file
// note on why getCompanyResearch/getCompanyFinancials/getCompanyNews are
// never exercised live in this suite).
// ---------------------------------------------------------------------------

test('the confirmed Phase 0/1 scenario\'s resolved dimensions (FINANCIALS, GUIDANCE, NEWS) are fetched exactly, nothing more', () => {
  const warnings = [];
  const dims = resolveComparisonPlan(['FINANCIALS', 'GUIDANCE', 'NEWS'], 2, warnings);
  assert.deepEqual(new Set(dims), new Set(['FINANCIALS', 'GUIDANCE', 'NEWS']));
  assert.equal(warnings.length, 0);
});

test('no dimensions given falls back to DEFAULT_COMPARISON_DIMENSIONS', () => {
  const dims = resolveComparisonPlan(undefined, 2, []);
  assert.deepEqual(new Set(dims), new Set(DEFAULT_COMPARISON_DIMENSIONS));
});

test('an unsupported/out-of-scope dimension (e.g. PORTFOLIO, which has no per-symbol comparison operation) is silently filtered out, never crashes', () => {
  const dims = resolveComparisonPlan(['PORTFOLIO', 'NEWS'], 2, []);
  assert.deepEqual(dims, ['NEWS']);
});

test('a request with only unsupported dimensions falls back to the default set rather than fetching nothing', () => {
  const dims = resolveComparisonPlan(['PORTFOLIO', 'WATCHLIST'], 2, []);
  assert.deepEqual(new Set(dims), new Set(DEFAULT_COMPARISON_DIMENSIONS));
});

test('duplicate dimensions in the request are deduplicated', () => {
  const dims = resolveComparisonPlan(['NEWS', 'NEWS', 'PRICE'], 2, []);
  assert.deepEqual(new Set(dims), new Set(['NEWS', 'PRICE']));
  assert.equal(dims.length, 2);
});

test('a request that would exceed the operation budget (symbols x dimensions) is truncated by priority, with a warning', () => {
  const warnings = [];
  const allSix = ['PRICE', 'FINANCIALS', 'COMPANY_RESEARCH', 'NEWS', 'GUIDANCE', 'DOCUMENTS'];
  // 4 symbols x 6 dimensions = 24 > MAX_COMPARISON_OPERATIONS (12) -> must
  // truncate to at most floor(12/4)=3 dimensions.
  const dims = resolveComparisonPlan(allSix, 4, warnings);
  assert.ok(dims.length <= Math.floor(MAX_COMPARISON_OPERATIONS / 4));
  assert.ok(warnings.length >= 1, 'truncation must be reported as a warning, never silent');
  // Priority order keeps PRICE/FINANCIALS/COMPANY_RESEARCH first.
  assert.deepEqual(new Set(dims), new Set(['PRICE', 'FINANCIALS', 'COMPANY_RESEARCH']));
});

test('a request within budget is never truncated and produces no warning', () => {
  const warnings = [];
  const dims = resolveComparisonPlan(['PRICE', 'NEWS'], 2, warnings);
  assert.equal(dims.length, 2);
  assert.equal(warnings.length, 0);
});

// ---------------------------------------------------------------------------
// compareStocks integration — PRICE only, with StockService.prototype.getStock
// mocked (no real network) — proves the end-to-end wiring: only the
// requested dimension is present per symbol, correctly typed evidence, and
// the diagnostic meta fields (dimensions/operationCount) reflect reality.
// ---------------------------------------------------------------------------

const withMockedGetStock = async (impl, fn) => {
  const original = StockService.prototype.getStock;
  StockService.prototype.getStock = impl;
  try {
    await fn();
  } finally {
    StockService.prototype.getStock = original;
  }
};

test('compareStocks with dimensions:["PRICE"] fetches ONLY price for each symbol -- never financials/research/news', async () => {
  await withMockedGetStock(async (symbol) => ({ ticker: symbol, price: 100, changePct: 1, timestamp: new Date().toISOString() }), async () => {
    const outcome = await compareStocks({ symbols: ['TCS', 'INFY'], dimensions: ['PRICE'] });
    assert.equal(outcome.status, TOOL_STATUS.SUCCESS);
    assert.deepEqual(outcome.dimensions, ['PRICE']);
    assert.equal(outcome.operationCount, 2);
    outcome.data.forEach((entry) => {
      assert.deepEqual(Object.keys(entry.dimensions), ['PRICE']);
      assert.equal(entry.dimensions.PRICE.status, TOOL_STATUS.SUCCESS);
    });
    // Every evidence record must be correctly typed LIVE_PRICE -- never
    // mislabeled as news/financials just because it came out of compareStocks.
    outcome.evidence.forEach((record) => assert.equal(record.claimType, 'LIVE_PRICE'));
  });
});

test('compareStocks groups results per symbol AND per dimension in a normalized structure', async () => {
  await withMockedGetStock(async (symbol) => ({ ticker: symbol, price: 200, changePct: -1, timestamp: new Date().toISOString() }), async () => {
    const outcome = await compareStocks({ symbols: ['HAL', 'BEL'], dimensions: ['PRICE'] });
    assert.equal(outcome.data.length, 2);
    assert.deepEqual(outcome.data.map((e) => e.symbol), ['HAL', 'BEL']);
    assert.ok(outcome.data.every((e) => typeof e.dimensions === 'object' && !Array.isArray(e.dimensions)));
  });
});

test('compareStocks still requires at least two symbols (unchanged contract)', async () => {
  const outcome = await compareStocks({ symbols: ['TCS'], dimensions: ['PRICE'] });
  assert.equal(outcome.status, TOOL_STATUS.ERROR);
});

test('compareStocks partial success: one symbol failing never discards a different symbol\'s successful data', async () => {
  let call = 0;
  await withMockedGetStock(async (symbol) => {
    call += 1;
    if (symbol === 'BEL') throw Object.assign(new Error('down'), { errorCode: 'UPSTREAM_UNAVAILABLE' });
    return { ticker: symbol, price: 300, changePct: 2, timestamp: new Date().toISOString() };
  }, async () => {
    const outcome = await compareStocks({ symbols: ['HAL', 'BEL'], dimensions: ['PRICE'] });
    assert.equal(outcome.status, TOOL_STATUS.SUCCESS, 'HAL succeeding is enough for overall SUCCESS');
    const hal = outcome.data.find((e) => e.symbol === 'HAL');
    const bel = outcome.data.find((e) => e.symbol === 'BEL');
    assert.equal(hal.dimensions.PRICE.status, TOOL_STATUS.SUCCESS);
    assert.equal(bel.dimensions.PRICE.status, TOOL_STATUS.UNAVAILABLE);
  });
});
