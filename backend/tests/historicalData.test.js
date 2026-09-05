import test from 'node:test';
import assert from 'node:assert/strict';

import { StockService } from '../services/StockService.js';
import { AppError } from '../utils/errorHandler.js';
import { calculateDeterministicMetrics } from '../utils/historicalMetrics.js';

const candle = (timestamp, close) => ({ timestamp, open: close, high: close, low: close, close, volume: 100 });

test('getHistoricalCandles normalizes candles to ascending order and dedupes', async () => {
  // Provider intentionally returns out-of-order and duplicate timestamps.
  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async () => [
      candle(3000, 30),
      candle(1000, 10),
      candle(1000, 10), // duplicate of the earliest timestamp
      candle(2000, 20),
    ],
  });

  const result = await service.getHistoricalCandles('HAL', { range: '1Y' });

  assert.equal(result.count, 3);
  assert.deepEqual(result.candles.map((c) => c.timestamp), [1000, 2000, 3000]);
  assert.equal(result.symbol, 'HAL');
  assert.equal(result.range, '1Y');
  assert.equal(result.source, 'TestProvider');
  assert.equal(typeof result.asOf, 'string');
  assert.equal(result.isStale, false);
  assert.equal(result.fromCache, false);
});

test('getHistoricalCandles filters out candles with any non-finite OHLC value before they reach the chart', async () => {
  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async () => [
      candle(1000, 10),
      { timestamp: 2000, open: 11, high: 12, low: NaN, close: 11.5, volume: 100 }, // invalid low
      { timestamp: 3000, open: 12, high: 13, low: 11, close: Number('not-a-number'), volume: 100 }, // NaN close
      candle(4000, 13),
    ],
  });

  const result = await service.getHistoricalCandles('HAL', { range: '1Y' });

  assert.equal(result.count, 2);
  assert.deepEqual(result.candles.map((c) => c.timestamp), [1000, 4000]);
});

test('getHistoricalCandles rejects an invalid range with a 400 AppError', async () => {
  const service = new StockService({ providerName: 'TestProvider', getHistoricalData: async () => [] });

  await assert.rejects(
    () => service.getHistoricalCandles('HAL', { range: '10Y' }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
});

test('getHistoricalCandles rejects an invalid interval with a 400 AppError', async () => {
  const service = new StockService({ providerName: 'TestProvider', getHistoricalData: async () => [] });

  await assert.rejects(
    () => service.getHistoricalCandles('HAL', { range: '1Y', interval: 'TWO_DAY' }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
});

test('getHistoricalCandles returns an empty-but-successful result when the provider has no data, never mock candles', async () => {
  const service = new StockService({ providerName: 'TestProvider', getHistoricalData: async () => [] });

  const result = await service.getHistoricalCandles('HAL', { range: '1M' });

  assert.equal(result.count, 0);
  assert.deepEqual(result.candles, []);
});

test('getHistoricalCandles surfaces a provider failure as a thrown AppError rather than empty/fabricated data', async () => {
  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async () => { throw new Error('Request failed with status code 400'); },
  });

  await assert.rejects(
    () => service.getHistoricalCandles('HAL', { range: '1Y' }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /Historical data unavailable/);
      return true;
    }
  );
});

test('getHistoricalCandles cache semantics: fromCache and isStale are distinct, and never both misreport a fresh call', async () => {
  let calls = 0;
  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async () => { calls += 1; return [candle(1000, 10), candle(2000, 11)]; },
  });

  const first = await service.getHistoricalCandles('HAL', { range: '1Y' });
  assert.equal(first.fromCache, false);
  assert.equal(first.isStale, false);

  // NOTE: Redis is unavailable in this test environment (getCache/setCache
  // no-op gracefully — confirmed via `logger.warn('Redis not available')`
  // at server startup), so a second call cannot actually produce a cache
  // hit here. This test therefore only verifies the graceful-degradation
  // path (every call reaches the provider, fromCache stays false) — it
  // does NOT verify fromCache:true/isStale semantics on an actual cache
  // hit, which requires a live Redis and is not claimed as tested here.
  const second = await service.getHistoricalCandles('HAL', { range: '1Y' });
  assert.equal(second.count, 2);
  assert.equal(second.fromCache, false);
  assert.equal(second.isStale, false);
  assert.equal(calls, 2);
});

test('getHistoricalCandles deduplicates concurrent identical in-flight requests into a single provider call', async () => {
  let calls = 0;
  let resolveProvider;
  const providerGate = new Promise((resolve) => { resolveProvider = resolve; });

  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async () => {
      calls += 1;
      await providerGate;
      return [candle(1000, 10), candle(2000, 11)];
    },
  });

  // Fire two identical requests before either has a chance to resolve —
  // simulates a rapid double-click or a symbol/range change that re-fires
  // before the previous request settles.
  const p1 = service.getHistoricalCandles('HAL', { range: '1Y' });
  const p2 = service.getHistoricalCandles('HAL', { range: '1Y' });
  resolveProvider();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(calls, 1, 'the provider must only be called once for concurrent identical requests');
  assert.deepEqual(r1.candles, r2.candles);
});

// --- Deterministic metric sample-size thresholds ---

test('calculateDeterministicMetrics returns null with a reason for every metric when fewer than 2 candles exist', () => {
  const result = calculateDeterministicMetrics([]);
  assert.equal(result.observations, 0);
  assert.equal(result.oneYearReturn.value, null);
  assert.equal(result.oneYearReturn.available, false);
  assert.match(result.oneYearReturn.missingReason, /Fewer than 2/);
  assert.equal(result.volatility.value, null);
  assert.equal(result.maxDrawdown.value, null);
});

test('calculateDeterministicMetrics: volatility becomes available at 20 observations, return and drawdown remain unavailable', () => {
  const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100 + Math.sin(i) * 5));
  const result = calculateDeterministicMetrics(candles);

  assert.equal(result.observations, 20);
  assert.equal(result.volatility.available, true);
  assert.equal(typeof result.volatility.value, 'number');
  assert.equal(result.maxDrawdown.available, false);
  assert.match(result.maxDrawdown.missingReason, /Needs >=60/);
  assert.equal(result.oneYearReturn.available, false);
  assert.match(result.oneYearReturn.missingReason, /Needs >=200/);
});

test('calculateDeterministicMetrics: max drawdown becomes available at 60 observations, one-year return still is not', () => {
  const candles = Array.from({ length: 60 }, (_, i) => candle(i, 100 + Math.sin(i / 3) * 10));
  const result = calculateDeterministicMetrics(candles);

  assert.equal(result.observations, 60);
  assert.equal(result.volatility.available, true);
  assert.equal(result.maxDrawdown.available, true);
  assert.equal(typeof result.maxDrawdown.value, 'number');
  assert.ok(result.maxDrawdown.value <= 0, 'drawdown must be zero or negative');
  assert.equal(result.oneYearReturn.available, false);
});

test('calculateDeterministicMetrics: all three metrics become available at 200 observations and are computed deterministically', () => {
  const candles = Array.from({ length: 200 }, (_, i) => candle(i, 100 + Math.sin(i / 10) * 8 + i * 0.1));
  const first = calculateDeterministicMetrics(candles);
  const second = calculateDeterministicMetrics(candles);

  assert.equal(first.observations, 200);
  assert.equal(first.oneYearReturn.available, true);
  assert.equal(first.volatility.available, true);
  assert.equal(first.maxDrawdown.available, true);
  // Deterministic: identical input must produce the identical output, no AI/randomness involved.
  assert.deepEqual(first, second);

  const expectedReturn = Number((((candles[199].close / candles[0].close) - 1) * 100).toFixed(2));
  assert.equal(first.oneYearReturn.value, expectedReturn);
});

// --- metrics wiring into getHistoricalCandles ---

test('getHistoricalCandles includes verified metrics for a daily-interval range', async () => {
  const dailyCandles = Array.from({ length: 250 }, (_, i) => candle(i * 86400000, 100 + Math.sin(i / 10) * 8 + i * 0.1));
  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async () => dailyCandles,
  });

  const result = await service.getHistoricalCandles('HAL', { range: '1Y' });

  assert.equal(result.interval, 'ONE_DAY');
  assert.ok(result.metrics);
  assert.equal(result.metrics.observations, 250);
  assert.equal(result.metrics.oneYearReturn.available, true);
  assert.equal(result.metrics.volatility.available, true);
  assert.equal(result.metrics.maxDrawdown.available, true);
  assert.deepEqual(result.metrics, calculateDeterministicMetrics(dailyCandles));
});

test('getHistoricalCandles reports metrics as unavailable with an explicit reason for an intraday range, never computing them', async () => {
  const intradayCandles = Array.from({ length: 300 }, (_, i) => candle(i * 300000, 100 + Math.sin(i / 5) * 2));
  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async () => intradayCandles,
  });

  const result = await service.getHistoricalCandles('HAL', { range: '5D' });

  assert.equal(result.interval, 'FIVE_MINUTE');
  assert.ok(result.metrics, 'metrics key must be present even when unavailable, not omitted inconsistently');
  assert.equal(result.metrics.oneYearReturn.value, null);
  assert.equal(result.metrics.oneYearReturn.available, false);
  assert.match(result.metrics.oneYearReturn.missingReason, /daily candles/i);
  assert.equal(result.metrics.volatility.available, false);
  assert.match(result.metrics.volatility.missingReason, /FIVE_MINUTE/);
  assert.equal(result.metrics.maxDrawdown.available, false);
  assert.match(result.metrics.maxDrawdown.missingReason, /FIVE_MINUTE/);
});
