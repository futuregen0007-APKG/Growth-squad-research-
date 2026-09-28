import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  computeAndPersistMetricsForSymbol, getMetricsForSymbol, recomputeMetricsForSymbols,
  MIN_OBSERVATIONS_FOR_VOLATILITY, MIN_OBSERVATIONS_FOR_DRAWDOWN, MIN_OBSERVATIONS_FOR_ONE_YEAR_RETURN,
} from '../services/StockHistoricalMetricsService.js';
import StockPriceHistorySnapshot from '../models/StockPriceHistorySnapshot.js';
import StockHistoricalMetricsSnapshot from '../models/StockHistoricalMetricsSnapshot.js';

/**
 * stockHistoricalMetricsService.test.js
 * ========================================
 * This is the layer that sat silently empty in production: Goals'
 * "Load Eligible Stocks" reads ONLY StockHistoricalMetricsSnapshot (never
 * StockPriceHistorySnapshot directly, never a live candle call), and that
 * snapshot is only ever produced here. These tests pin the exact thresholds
 * (20/60/200 observations) and the corporate-action safety rule so a future
 * change can't silently let an under-sampled or discontinuity-corrupted
 * series report as verified.
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZHISTTEST';
const cleanup = async () => {
  await StockPriceHistorySnapshot.deleteMany({ symbol: TEST_SYMBOL });
  await StockHistoricalMetricsSnapshot.deleteMany({ symbol: TEST_SYMBOL });
};

/** Builds `count` ascending daily rows ending at `lastDate`, close prices following `closes` (cycled/extended flat if shorter than count). */
const buildRows = (count, { lastDate = new Date('2026-09-25T00:00:00.000Z'), closes = null, symbol = TEST_SYMBOL } = {}) => {
  const rows = [];
  const series = closes || Array.from({ length: count }, (_, i) => 100 + i * 0.1); // gentle real-looking uptrend
  for (let i = 0; i < count; i += 1) {
    const tradingDate = new Date(lastDate.getTime() - (count - 1 - i) * 24 * 60 * 60 * 1000);
    const close = series[Math.min(i, series.length - 1)];
    rows.push({
      symbol, exchange: 'NSE', series: 'EQ', isin: 'INE000A00000', tradingDate, open: close, high: close * 1.01, low: close * 0.99, close, previousClose: i > 0 ? series[Math.min(i - 1, series.length - 1)] : close, volume: 100000, turnover: 100000 * close, provider: 'NSE_BHAVCOPY', sourceUrl: 'https://nsearchives.nseindia.com/content/cm/test.csv.zip', fetchedAt: new Date(), dataAsOf: tradingDate,
    });
  }
  return rows;
};

test('zero rows: returns null and writes nothing (never a fabricated empty snapshot)', async (t) => {
  t.after(cleanup);
  await cleanup();
  const result = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  assert.equal(result, null);
  assert.equal(await getMetricsForSymbol(TEST_SYMBOL), null);
});

test('a full year of real history (250+ observations) verifies all three historical metrics', async (t) => {
  t.after(cleanup);
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(252));
  const snapshot = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);

  assert.equal(snapshot.observationCount, 252);
  assert.equal(typeof snapshot.oneYearReturn, 'number');
  assert.equal(typeof snapshot.annualizedVolatility, 'number');
  assert.equal(typeof snapshot.maximumDrawdown, 'number');
  assert.equal(snapshot.corporateActionAdjustmentStatus, 'NOT_REQUIRED');
  assert.deepEqual(snapshot.discontinuitiesDetected, []);
  assert.equal(snapshot.provider, 'NSE_BHAVCOPY');

  const persisted = await getMetricsForSymbol(TEST_SYMBOL);
  assert.equal(persisted.oneYearReturn, snapshot.oneYearReturn);
});

test('below every minimum-observation threshold: all three historical metrics are null and reported missing, never approximated from a short series', async (t) => {
  t.after(cleanup);
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(10)); // below the 20-day volatility floor
  const snapshot = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);

  assert.equal(snapshot.observationCount, 10);
  assert.equal(snapshot.oneYearReturn, null);
  assert.equal(snapshot.annualizedVolatility, null);
  assert.equal(snapshot.maximumDrawdown, null);
  assert.deepEqual(snapshot.missingMetrics.sort(), ['annualizedVolatility', 'maximumDrawdown', 'oneYearReturn', 'threeYearCagr'].sort());
});

test('exactly at each threshold boundary: volatility/drawdown/return each turn on independently at their own minimum, not a shared one', async (t) => {
  t.after(cleanup);
  await cleanup();

  // Just below the volatility floor -> nothing computed.
  await StockPriceHistorySnapshot.insertMany(buildRows(MIN_OBSERVATIONS_FOR_VOLATILITY - 1));
  let snapshot = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  assert.equal(snapshot.annualizedVolatility, null);
  assert.equal(snapshot.maximumDrawdown, null);

  // At the volatility floor but below the drawdown floor -> volatility turns on, drawdown still doesn't.
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(MIN_OBSERVATIONS_FOR_VOLATILITY));
  snapshot = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  assert.equal(typeof snapshot.annualizedVolatility, 'number');
  assert.equal(snapshot.maximumDrawdown, null);
  assert.equal(snapshot.oneYearReturn, null);

  // At the drawdown floor but below the one-year-return floor -> drawdown turns on, return still doesn't.
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(MIN_OBSERVATIONS_FOR_DRAWDOWN));
  snapshot = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  assert.equal(typeof snapshot.maximumDrawdown, 'number');
  assert.equal(snapshot.oneYearReturn, null);

  // At the one-year-return floor -> all three are now real numbers.
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(MIN_OBSERVATIONS_FOR_ONE_YEAR_RETURN));
  snapshot = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  assert.equal(typeof snapshot.oneYearReturn, 'number');
});

test('an unresolved corporate-action discontinuity excludes return/drawdown but not volatility, which is computed from the full raw series', async (t) => {
  t.after(cleanup);
  await cleanup();
  // 252 close prices with one permanent 5x step partway through (every later close scaled up) --
  // unmistakably a split/bonus-shaped move (a single discontinuity, not a spike-and-revert).
  const closes = Array.from({ length: 252 }, (_, i) => (100 + i * 0.1) * (i >= 150 ? 5 : 1));
  await StockPriceHistorySnapshot.insertMany(buildRows(252, { closes }));
  const snapshot = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);

  assert.equal(snapshot.corporateActionAdjustmentStatus, 'UNVERIFIED');
  assert.equal(snapshot.discontinuitiesDetected.length, 1);
  assert.equal(snapshot.oneYearReturn, null, 'a return spanning an unresolved discontinuity must never be reported');
  assert.equal(snapshot.maximumDrawdown, null, 'drawdown spanning an unresolved discontinuity must never be reported');
  assert.equal(typeof snapshot.annualizedVolatility, 'number', 'volatility is not defined by two specific endpoints the way return/drawdown are, so it still computes');
});

test('a symbol already fully computed and then re-run with the identical series is idempotent (no duplicate snapshot documents, same values)', async (t) => {
  t.after(cleanup);
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(252));
  const first = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  const second = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  assert.equal(first.oneYearReturn, second.oneYearReturn);
  const count = await StockHistoricalMetricsSnapshot.countDocuments({ symbol: TEST_SYMBOL });
  assert.equal(count, 1);
});

test('a new trading day\'s price row lands, then recomputing reflects it: lastDate/lastClose/observationCount and the return figure all advance -- never frozen at the first computation', async (t) => {
  t.after(cleanup);
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(252));
  const before = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);

  // A new trading day's bhavcopy row lands (correct ordering: this must happen before recomputation, exactly as scripts/productionBootstrap.js's STAGES sequence -- nse-bhavcopy before historical-metrics -- already enforces).
  const priorRows = await StockPriceHistorySnapshot.find({ symbol: TEST_SYMBOL }).sort({ tradingDate: 1 }).lean();
  const lastClose = priorRows[priorRows.length - 1].close;
  const [newRow] = buildRows(1, { lastDate: new Date(before.lastDate.getTime() + 24 * 60 * 60 * 1000), closes: [lastClose * 1.05] });
  await StockPriceHistorySnapshot.create(newRow);

  const after = await computeAndPersistMetricsForSymbol(TEST_SYMBOL);
  assert.equal(after.observationCount, before.observationCount + 1);
  assert.ok(after.lastDate.getTime() > before.lastDate.getTime());
  assert.equal(after.lastClose, lastClose * 1.05);
  assert.notEqual(after.oneYearReturn, before.oneYearReturn, 'the return figure must move when a new closing price lands, never stay frozen at the prior computation');

  const count = await StockHistoricalMetricsSnapshot.countDocuments({ symbol: TEST_SYMBOL });
  assert.equal(count, 1, 'still one snapshot document, updated in place');
});

test('recomputeMetricsForSymbols never throws for one bad symbol and reports computed/skipped counts accurately', async (t) => {
  t.after(cleanup);
  await cleanup();
  await StockPriceHistorySnapshot.insertMany(buildRows(252));
  const results = await recomputeMetricsForSymbols([TEST_SYMBOL, 'ZZ-NO-DATA-AT-ALL']);
  assert.equal(results.computed, 1);
  assert.equal(results.skipped, 1);
  assert.equal(results.failed, 0);
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
