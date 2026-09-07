import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closesByDate,
  intersectDates,
  normalizeSeries,
  buildEqualWeightIndex,
  computeRelativeStrengthSeries,
  computeRelativeMomentum,
  classifyQuadrant,
  rankSectors,
} from '../utils/sectorMath.js';
import { createSectorRotationService } from '../services/SectorRotationService.js';

// ---------------------------------------------------------------------------
// Pure math (utils/sectorMath.js)
// ---------------------------------------------------------------------------

test('identical % returns at different price scales produce identical normalized contributions', () => {
  const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
  // Same 10% growth each day, wildly different absolute price scale.
  const cheapStock = closesByDate([
    { timestamp: Date.parse('2026-01-01'), close: 100 },
    { timestamp: Date.parse('2026-01-02'), close: 110 },
    { timestamp: Date.parse('2026-01-03'), close: 121 },
  ]);
  const expensiveStock = closesByDate([
    { timestamp: Date.parse('2026-01-01'), close: 5000 },
    { timestamp: Date.parse('2026-01-02'), close: 5500 },
    { timestamp: Date.parse('2026-01-03'), close: 6050 },
  ]);

  const normalizedCheap = normalizeSeries(dates, cheapStock);
  const normalizedExpensive = normalizeSeries(dates, expensiveStock);

  assert.deepEqual(normalizedCheap, normalizedExpensive);
  assert.deepEqual(normalizedCheap.map((v) => Number(v.toFixed(6))), [100, 110, 121]);

  // An equal-weight index across both must equal that same series — a
  // ₹5,000 stock never outweighs a ₹100 stock once normalized.
  const index = buildEqualWeightIndex([normalizedCheap, normalizedExpensive]);
  assert.deepEqual(index.map((v) => Number(v.toFixed(6))), [100, 110, 121]);
});

test('normalizeSeries returns null (never a fabricated series) when the base close is missing or zero', () => {
  const dates = ['2026-01-01', '2026-01-02'];
  assert.equal(normalizeSeries(dates, closesByDate([])), null);
  const zeroBase = closesByDate([{ timestamp: Date.parse('2026-01-01'), close: 0 }]);
  assert.equal(normalizeSeries(dates, zeroBase), null);
});

test('intersectDates aligns only dates common to every series', () => {
  const a = closesByDate([
    { timestamp: Date.parse('2026-01-01'), close: 1 },
    { timestamp: Date.parse('2026-01-02'), close: 1 },
    { timestamp: Date.parse('2026-01-03'), close: 1 },
  ]);
  const b = closesByDate([
    { timestamp: Date.parse('2026-01-02'), close: 1 },
    { timestamp: Date.parse('2026-01-03'), close: 1 },
    { timestamp: Date.parse('2026-01-04'), close: 1 },
  ]);
  assert.deepEqual(intersectDates([a, b]), ['2026-01-02', '2026-01-03']);
});

test('classifyQuadrant maps all four RS/momentum sign combinations deterministically', () => {
  assert.equal(classifyQuadrant(1.05, 0.01), 'Leading');
  assert.equal(classifyQuadrant(1.05, -0.01), 'Weakening');
  assert.equal(classifyQuadrant(0.95, 0.01), 'Improving');
  assert.equal(classifyQuadrant(0.95, -0.01), 'Lagging');
  // Boundary: RS exactly at parity counts as "leading" (>=), momentum
  // exactly flat counts as "rising" (>=) — deterministic, not ambiguous.
  assert.equal(classifyQuadrant(1, 0), 'Leading');
});

test('computeRelativeMomentum is a deterministic trailing rate of change', () => {
  const rs = [1, 1.01, 1.02, 1.03, 1.04, 1.05];
  assert.equal(computeRelativeMomentum(rs, 5), (1.05 - 1) / 1);
  // Window longer than available history clamps to what's available.
  assert.equal(computeRelativeMomentum(rs, 100), (1.05 - 1) / 1);
});

test('rankSectors ranks by relative strength descending, deterministically', () => {
  const results = [
    { sector: 'A', relativeStrength: 0.98 },
    { sector: 'B', relativeStrength: 1.10 },
    { sector: 'C', relativeStrength: 1.02 },
  ];
  rankSectors(results);
  assert.deepEqual(results.map((r) => r.sector), ['A', 'B', 'C']); // order unchanged
  assert.deepEqual(results.map((r) => r.rank), [3, 1, 2]); // ranks assigned by RS
});

// ---------------------------------------------------------------------------
// SectorRotationService orchestration (fake provider — no network)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-01-01T09:15:00.000Z');
const OBSERVATIONS = 20;

function syntheticCandles(basePrice, growthPerDay = 0.01, days = OBSERVATIONS) {
  const candles = [];
  let price = basePrice;
  for (let i = 0; i < days; i++) {
    candles.push({ timestamp: START + i * DAY_MS, open: price, high: price, low: price, close: price, volume: 1000 });
    price *= 1 + growthPerDay;
  }
  return candles;
}

// Insurance has exactly 4 real constituents in SUPPORTED_STOCKS (HDFCLIFE,
// SBILIFE, ICICIPRULI, ICICIGI) — small enough to control precisely.
// Banking has 15+, of which only the first 6 are ever requested
// (MAX_CONSTITUENTS_PER_SECTOR), letting us fail all but one deliberately.
function makeFakeProvider({ failTickers = [] } = {}) {
  const failSet = new Set(failTickers);
  return {
    providerName: 'FakeTestProvider',
    async getHistoricalData(ticker) {
      if (ticker === 'NIFTY 50') return syntheticCandles(20000, 0.002);
      if (failSet.has(ticker)) return [];
      return syntheticCandles(100, 0.003);
    },
  };
}

test('a missing constituent does not drop a sufficiently covered sector', async () => {
  const service = createSectorRotationService(makeFakeProvider({ failTickers: ['ICICIGI'] }), { minRequestIntervalMs: 0 });
  const results = await service.getSectorRotation();
  const insurance = results.find((r) => r.sector === 'Insurance');
  assert.ok(insurance, 'Insurance sector should be present in the result');
  assert.equal(insurance.status, 'OK');
  assert.equal(insurance.requestedConstituentCount, 4);
  assert.equal(insurance.constituentCount, 3);
  assert.equal(insurance.coveragePct, 0.75);
  assert.equal(typeof insurance.relativeStrength, 'number');
});

test('insufficient constituent coverage is flagged as INSUFFICIENT_DATA, never a fallback value', async () => {
  // Banking requests its first 6 constituents; fail all but one.
  const bankingFailures = ['AXISBANK', 'INDUSINDBK', 'BANKBARODA', 'PNB', 'CANBK'];
  const service = createSectorRotationService(makeFakeProvider({ failTickers: bankingFailures }), { minRequestIntervalMs: 0 });
  const results = await service.getSectorRotation();
  const banking = results.find((r) => r.sector === 'Banking');
  assert.ok(banking);
  assert.equal(banking.status, 'INSUFFICIENT_DATA');
  assert.equal(banking.reason, 'INSUFFICIENT_CONSTITUENT_COVERAGE');
  assert.equal(banking.relativeStrength, null);
  assert.equal(banking.relativeMomentum, null);
  assert.equal(banking.quadrant, null);
  assert.equal(banking.rank, null);
});

test('sector rotation output is deterministic across repeated calls with the same inputs', async () => {
  const provider = makeFakeProvider();
  const service = createSectorRotationService(provider, { minRequestIntervalMs: 0 });
  const stripVolatileFields = (results) => results.map(({ asOf, ...rest }) => rest);

  const first = stripVolatileFields(await service.getSectorRotation());
  const second = stripVolatileFields(await service.getSectorRotation());
  assert.deepEqual(first, second);
});

test('every sector in the output has aligned observations spanning the requested history when sufficient', async () => {
  const service = createSectorRotationService(makeFakeProvider(), { minRequestIntervalMs: 0 });
  const results = await service.getSectorRotation();
  const sufficient = results.filter((r) => r.status === 'OK');
  assert.ok(sufficient.length > 0);
  for (const r of sufficient) {
    assert.ok(r.period.observations >= 10, `${r.sector} should have >=10 aligned observations`);
    assert.equal(r.methodologyVersion, 'sector-relative-strength-v1');
  }
});
