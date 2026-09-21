import test from 'node:test';
import assert from 'node:assert/strict';
import { getPriceHistory, TOOL_STATUS } from '../graph/tools/toolRegistry.js';
import StockPriceHistorySnapshot from '../models/StockPriceHistorySnapshot.js';
import { __clearToolCacheForTests } from '../graph/tools/toolCache.js';

/**
 * priceHistoryTool.test.js
 * ===========================
 * UI Phase 1C.3/1D: getPriceHistory reads the durable StockPriceHistorySnapshot
 * collection (never a live provider) and builds exactly ONE MARKET_HISTORY
 * evidence record carrying the whole bounded {date, close}[] series — the
 * "never mix adjusted/unadjusted series" and "represent known gaps
 * honestly" rules live here, in buildPriceHistoryEvidence, not in the
 * block builder (which trusts this tool's series but still independently
 * re-validates every point — see responseBlocks.test.js).
 *
 * UI Phase 1D fix: `days` is a CALENDAR-day window, queried via a real
 * `tradingDate: {$gte: cutoff}` filter, never a `.limit(days)` ROW count —
 * the previous row-limit implementation silently returned roughly 40% more
 * calendar days than requested (5 trading days per 7 calendar days), found
 * via a live check ("last 90 days" returned a 127-day span). The mock
 * below captures the real query filter passed to `.find()` so these tests
 * exercise the actual cutoff-date math, not a row count.
 */

test.beforeEach(() => {
  __clearToolCacheForTests();
});

const row = (dateStr, close, overrides = {}) => ({
  symbol: 'TCS',
  exchange: 'NSE',
  series: 'EQ',
  tradingDate: new Date(`${dateStr}T00:00:00.000Z`),
  open: close,
  high: close,
  low: close,
  close,
  adjustmentStatus: 'NOT_REQUIRED',
  provider: 'NSE_BHAVCOPY',
  sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv',
  dataAsOf: new Date(`${dateStr}T00:00:00.000Z`),
  ...overrides,
});

/**
 * Installs a fake StockPriceHistorySnapshot.find returning `rows` exactly
 * as given (the real query now sorts ascending directly — no reverse step
 * in the tool to exercise), and records the real `.find(query)` argument
 * (so a test can inspect `query.tradingDate.$gte`, the calendar cutoff)
 * plus whatever `.limit(n)` was called with (the fixed safety ceiling,
 * never `days` itself post-fix).
 */
const withMockedFind = async (rows, fn) => {
  const original = StockPriceHistorySnapshot.find;
  const calls = { query: null, limit: null };
  StockPriceHistorySnapshot.find = (query) => {
    calls.query = query;
    return {
      sort: () => ({
        limit: (n) => {
          calls.limit = n;
          return { lean: async () => rows };
        },
      }),
    };
  };
  try {
    await fn(calls);
  } finally {
    StockPriceHistorySnapshot.find = original;
  }
};

test('a missing symbol is rejected with an ERROR result, never a crash', async () => {
  const result = await getPriceHistory({});
  assert.equal(result.status, TOOL_STATUS.ERROR);
  assert.equal(result.data, null);
});

test('a real, all-NOT_REQUIRED series produces exactly one MARKET_HISTORY evidence record carrying the whole ascending series', async () => {
  const rows = [row('2026-01-01', 100), row('2026-01-02', 101), row('2026-01-03', 102)];
  await withMockedFind(rows, async () => {
    const result = await getPriceHistory({ symbol: 'TCS' });
    assert.equal(result.status, TOOL_STATUS.SUCCESS);
    assert.equal(result.evidence.length, 1);
    const [evidence] = result.evidence;
    assert.equal(evidence.claimType, 'MARKET_HISTORY');
    assert.equal(evidence.symbol, 'TCS');
    assert.equal(evidence.chartSeries.length, 3);
    assert.deepEqual(evidence.chartSeries.map((p) => p.date), ['2026-01-01', '2026-01-02', '2026-01-03']);
    assert.deepEqual(evidence.chartSeries.map((p) => p.close), [100, 101, 102]);
    assert.equal(evidence.chartSeries.every((p) => p.gapBefore === false), true, 'a fully contiguous series has no gaps');
    assert.match(evidence.excerpt, /^PRICE_HISTORY: 3 points, INR, NSE_BHAVCOPY, NOT_REQUIRED \(2026-01-01 to 2026-01-03\)$/);
  });
});

test('an UNVERIFIED-only series (a detected discontinuity, never safely explained) is EMPTY, not silently included', async () => {
  const rows = [row('2026-01-01', 100, { adjustmentStatus: 'UNVERIFIED' }), row('2026-01-02', 999, { adjustmentStatus: 'UNVERIFIED' })];
  await withMockedFind(rows, async () => {
    const result = await getPriceHistory({ symbol: 'TCS' });
    assert.equal(result.status, TOOL_STATUS.EMPTY);
    assert.equal(result.evidence.length, 0);
  });
});

test('a mismatched-basis row in the middle is EXCLUDED (never blended in), and the point right after it is flagged gapBefore', async () => {
  const rows = [
    row('2026-01-01', 100),
    row('2026-01-02', 101),
    row('2026-01-03', 999, { adjustmentStatus: 'UNVERIFIED' }), // excluded -- never mixed with the NOT_REQUIRED rows around it
    row('2026-01-04', 103),
    row('2026-01-05', 104),
  ];
  await withMockedFind(rows, async () => {
    const result = await getPriceHistory({ symbol: 'TCS' });
    assert.equal(result.status, TOOL_STATUS.SUCCESS);
    const series = result.evidence[0].chartSeries;
    assert.deepEqual(series.map((p) => p.date), ['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05']);
    assert.equal(series.every((p) => p.close !== 999), true, 'the UNVERIFIED row never appears, at any price');
    // 2026-01-04 immediately follows the excluded 2026-01-03 row -- a real gap.
    assert.deepEqual(series.map((p) => p.gapBefore), [false, false, true, false]);
  });
});

test('fewer than two usable rows after basis filtering is EMPTY, not a one-point chart', async () => {
  const rows = [row('2026-01-01', 100), row('2026-01-02', 999, { adjustmentStatus: 'UNVERIFIED' })];
  await withMockedFind(rows, async () => {
    const result = await getPriceHistory({ symbol: 'TCS' });
    assert.equal(result.status, TOOL_STATUS.EMPTY);
    assert.equal(result.evidence.length, 0);
  });
});

test('zero rows for the symbol is EMPTY with the standard "no data for period" reason', async () => {
  await withMockedFind([], async () => {
    const result = await getPriceHistory({ symbol: 'NOSUCHCO' });
    assert.equal(result.status, TOOL_STATUS.EMPTY);
    assert.ok(result.warning);
  });
});

test('a non-finite or non-positive close is excluded from the series, never propagated as a chart point', async () => {
  const rows = [
    row('2026-01-01', 100),
    row('2026-01-02', NaN),
    row('2026-01-03', 102),
  ];
  await withMockedFind(rows, async () => {
    const result = await getPriceHistory({ symbol: 'TCS' });
    const series = result.evidence[0].chartSeries;
    assert.deepEqual(series.map((p) => p.date), ['2026-01-01', '2026-01-03']);
  });
});

// ---------------------------------------------------------------------------
// Calendar-day window vs. trading-observation count (UI Phase 1D fix).
// ---------------------------------------------------------------------------

test('an explicit `days` arg becomes a real CALENDAR-day cutoff filter, never a row-count limit', async () => {
  await withMockedFind([row('2026-01-01', 100), row('2026-01-02', 101)], async (calls) => {
    const before = Date.now();
    await getPriceHistory({ symbol: 'TCS', days: 30 });
    const cutoff = calls.query.tradingDate.$gte;
    assert.ok(cutoff instanceof Date, 'the query filters by a real Date cutoff');
    const expectedCutoffMs = before - 30 * 24 * 60 * 60 * 1000;
    // Allow a small slack for the test's own execution time between
    // capturing `before` and the tool computing Date.now() internally.
    assert.ok(Math.abs(cutoff.getTime() - expectedCutoffMs) < 5000, `cutoff should be ~30 days before now, got ${cutoff.toISOString()}`);
  });
});

test('an oversized `days` arg is clamped to MAX_PRICE_HISTORY_QUERY_DAYS calendar days, never passed through unbounded', async () => {
  await withMockedFind([row('2026-01-01', 100), row('2026-01-02', 101)], async (calls) => {
    const before = Date.now();
    await getPriceHistory({ symbol: 'TCS', days: 999999 });
    const cutoff = calls.query.tradingDate.$gte;
    const expectedCutoffMs = before - 400 * 24 * 60 * 60 * 1000; // MAX_PRICE_HISTORY_QUERY_DAYS
    assert.ok(Math.abs(cutoff.getTime() - expectedCutoffMs) < 5000, `cutoff should be clamped to ~400 days, got ${cutoff.toISOString()}`);
  });
});

test('with no `days` arg, the default ~180-calendar-day window is used', async () => {
  await withMockedFind([row('2026-01-01', 100), row('2026-01-02', 101)], async (calls) => {
    const before = Date.now();
    await getPriceHistory({ symbol: 'TCS' });
    const cutoff = calls.query.tradingDate.$gte;
    const expectedCutoffMs = before - 180 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(cutoff.getTime() - expectedCutoffMs) < 5000, `cutoff should be ~180 days before now, got ${cutoff.toISOString()}`);
  });
});

test('the query filters by symbol AND the calendar cutoff together -- never one without the other', async () => {
  await withMockedFind([row('2026-01-01', 100), row('2026-01-02', 101)], async (calls) => {
    await getPriceHistory({ symbol: 'tcs', days: 30 });
    assert.equal(calls.query.symbol, 'TCS');
    assert.ok(calls.query.tradingDate.$gte instanceof Date);
  });
});

test('a naturally sparse trading calendar (weekends/holidays) returns fewer POINTS than the requested day count -- this is normal, not a data gap', async () => {
  // Only 3 real trading-day rows exist inside a requested 30-calendar-day
  // window (the other ~21 calendar days are weekends/holidays with no
  // row at all) -- the tool must not treat this as insufficient data.
  const rows = [row('2026-01-05', 100), row('2026-01-06', 101), row('2026-01-07', 102)];
  await withMockedFind(rows, async () => {
    const result = await getPriceHistory({ symbol: 'TCS', days: 30 });
    assert.equal(result.status, TOOL_STATUS.SUCCESS);
    assert.equal(result.evidence[0].chartSeries.length, 3);
  });
});

test('a successful call is cached -- a second call within the TTL never re-queries Mongo', async () => {
  let queries = 0;
  const original = StockPriceHistorySnapshot.find;
  StockPriceHistorySnapshot.find = () => {
    queries += 1;
    return { sort: () => ({ limit: () => ({ lean: async () => [row('2026-01-01', 100), row('2026-01-02', 101)] }) }) };
  };
  try {
    const first = await getPriceHistory({ symbol: 'TCS' });
    const second = await getPriceHistory({ symbol: 'TCS' });
    assert.equal(queries, 1, 'the second call must be served from cache');
    assert.equal(first.cacheStatus, 'MISS');
    assert.equal(second.cacheStatus, 'HIT');
  } finally {
    StockPriceHistorySnapshot.find = original;
  }
});

test('a thrown query error is reported as UNAVAILABLE, never a crash', async () => {
  const original = StockPriceHistorySnapshot.find;
  StockPriceHistorySnapshot.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => { throw new Error('connection lost'); } }) }) });
  try {
    const result = await getPriceHistory({ symbol: 'TCS' });
    assert.equal(result.status, TOOL_STATUS.UNAVAILABLE);
  } finally {
    StockPriceHistorySnapshot.find = original;
  }
});
