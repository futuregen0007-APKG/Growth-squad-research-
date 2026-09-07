import { getCache, setCache } from '../utils/redisClient.js';
import { INDEX_SYMBOLS, SUPPORTED_STOCKS } from '../utils/constants.js';
import { AngelOneProvider } from '../providers/AngelOneProvider.js';
import { logger } from '../utils/logger.js';
import {
  METHODOLOGY_VERSION,
  closesByDate,
  intersectDates,
  normalizeSeries,
  buildEqualWeightIndex,
  computeRelativeStrengthSeries,
  computeRelativeMomentum,
  classifyQuadrant,
  rankSectors,
} from '../utils/sectorMath.js';

// Normalized sector relative-strength analytics.
//
// Replaces the previous approach (averaging raw constituent closing prices
// and dividing by the raw Nifty level), which was scale-distorted: a sector
// with one ₹4,000 stock and two ₹200 stocks produced an "average" dominated
// by the expensive stock, and dividing that by Nifty's raw index level (an
// unrelated scale) produced a ratio with no real meaning. See
// utils/sectorMath.js for the normalized replacement (normalize every
// series to 100, THEN average, THEN divide by a similarly-normalized
// benchmark).
//
// Every numeric field returned here is either a real computed value or the
// sector is marked INSUFFICIENT_DATA — never a neutral/fallback number.

const HISTORY_RANGE = '3M'; // ~90 calendar days of daily closes -> real alignment history
const MAX_CONSTITUENTS_PER_SECTOR = 6; // bounds Angel One API load per request
const MIN_CONSTITUENTS = 3; // below this an "equal-weight index" isn't meaningful
const MIN_COVERAGE_PCT = 0.6; // at least 60% of requested constituents must have data
const MIN_ALIGNED_OBSERVATIONS = 10; // at least ~2 trading weeks of common dates
const MOMENTUM_WINDOW = 5; // trailing trading days used for the momentum slope
const CANDLE_CACHE_TTL = 21600; // 6h — matches StockService's HISTORY TTL (immutable once a day closes)
const ROTATION_CACHE_TTL = 300; // 5 min — bounds how often the full computation re-runs
// SmartAPI's historical-data endpoint enforces a real per-second rate limit
// per API key; firing this in parallel across ~190 constituents produced
// silent 429s that looked like "no data" for most sectors. Dispatching
// requests one at a time with a floor delay between them keeps every
// request under that limit — slower on a cold cache (~1 request every
// 350ms), but each ticker's result is then cached for CANDLE_CACHE_TTL so
// this cost is only paid once per cache window, not per user request.
const MIN_REQUEST_INTERVAL_MS = 350;

/** Runs `mapper` over `items` one at a time, spaced by `intervalMs`, allSettled-shaped. */
async function settleRateLimited(items, mapper, intervalMs) {
  const results = new Array(items.length);
  let lastDispatch = 0;
  for (let index = 0; index < items.length; index++) {
    const waitFor = lastDispatch + intervalMs - Date.now();
    if (waitFor > 0) await new Promise((resolve) => setTimeout(resolve, waitFor));
    lastDispatch = Date.now();
    try {
      results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
    } catch (reason) {
      results[index] = { status: 'rejected', reason };
    }
  }
  return results;
}

function sectorsFromSupportedStocks() {
  const bySector = new Map();
  for (const [ticker, meta] of Object.entries(SUPPORTED_STOCKS)) {
    const sector = meta.sector || 'Other';
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(ticker);
  }
  return [...bySector.entries()].map(([name, tickers]) => ({
    sector: name,
    tickers,
    requestedConstituentCount: Math.min(tickers.length, MAX_CONSTITUENTS_PER_SECTOR),
    selected: tickers.slice(0, MAX_CONSTITUENTS_PER_SECTOR),
  }));
}

function insufficientResult(sector, requestedConstituentCount, constituentCount, coveragePct, reason, source) {
  return {
    sector,
    status: 'INSUFFICIENT_DATA',
    reason,
    relativeStrength: null,
    relativeMomentum: null,
    quadrant: null,
    rank: null,
    constituentCount,
    requestedConstituentCount,
    coveragePct: Number(coveragePct.toFixed(4)),
    period: { range: HISTORY_RANGE, interval: 'ONE_DAY' },
    source,
    asOf: new Date().toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
  };
}

export function createSectorRotationService(provider = new AngelOneProvider(), { minRequestIntervalMs = MIN_REQUEST_INTERVAL_MS } = {}) {
  // Redis is optional infrastructure (redisClient.js already degrades to a
  // silent no-op when it isn't running) — but for THIS endpoint, a
  // Redis-less environment would otherwise re-pay the full ~190-ticker,
  // rate-limited fetch (~60s+) on every single request, forever. This
  // in-process Map is a same-instance fast-path fallback so repeat requests
  // are fast even without Redis; when Redis IS available it's used too, for
  // cross-instance sharing behind a load balancer. Scoped per service
  // instance (not module-level) so independent instances — e.g. different
  // fake providers in tests — never share stale cached data.
  const memoryCache = new Map(); // key -> { value, expiresAt }

  function memoryCacheGet(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) { memoryCache.delete(key); return null; }
    return entry.value;
  }

  function memoryCacheSet(key, value, ttlSeconds) {
    memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async function cacheGet(key) {
    const cached = memoryCacheGet(key);
    if (cached !== null) return cached;
    return getCache(key);
  }

  async function cacheSet(key, value, ttlSeconds) {
    memoryCacheSet(key, value, ttlSeconds);
    await setCache(key, value, ttlSeconds);
  }

  async function fetchDailyCloses(ticker) {
    const cacheKey = `sector-rotation:candles:v2:${ticker}:${HISTORY_RANGE}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    let candles;
    try {
      candles = await provider.getHistoricalData(ticker, HISTORY_RANGE);
    } catch (error) {
      logger.debug(`SectorRotationService: historical data unavailable for ${ticker}: ${error.message}`);
      candles = [];
    }

    const cleaned = (Array.isArray(candles) ? candles : [])
      .filter((candle) => candle && Number.isFinite(candle.timestamp) && Number.isFinite(candle.close))
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((candle, index, sorted) => index === 0 || candle.timestamp !== sorted[index - 1].timestamp);

    if (cleaned.length) await cacheSet(cacheKey, cleaned, CANDLE_CACHE_TTL);
    return cleaned;
  }

  async function computeSectorAnalytics() {
    const asOf = new Date().toISOString();
    const source = provider.providerName || 'Angel One';
    const benchmarkSymbol = INDEX_SYMBOLS['NIFTY 50'] || Object.values(INDEX_SYMBOLS)[0];
    const benchmarkCandles = await fetchDailyCloses(benchmarkSymbol);
    if (!benchmarkCandles.length) {
      throw new Error(`Sector rotation unavailable: no benchmark (${benchmarkSymbol}) historical data from ${source}.`);
    }
    const benchmarkCloses = closesByDate(benchmarkCandles);

    const sectors = sectorsFromSupportedStocks();
    const uniqueTickers = [...new Set(sectors.flatMap((s) => s.selected))];
    const candlesByTicker = new Map();
    const settled = await settleRateLimited(uniqueTickers, (ticker) => fetchDailyCloses(ticker), minRequestIntervalMs);
    settled.forEach((result, index) => {
      candlesByTicker.set(uniqueTickers[index], result.status === 'fulfilled' ? result.value : []);
    });

    const sufficient = [];
    const insufficient = [];

    for (const { sector, requestedConstituentCount, selected } of sectors) {
      const constituentCloses = selected
        .map((ticker) => closesByDate(candlesByTicker.get(ticker) || []))
        .filter((closes) => closes.size > 0);

      const constituentCount = constituentCloses.length;
      const coveragePct = requestedConstituentCount > 0 ? constituentCount / requestedConstituentCount : 0;

      if (constituentCount < MIN_CONSTITUENTS || coveragePct < MIN_COVERAGE_PCT) {
        insufficient.push(insufficientResult(sector, requestedConstituentCount, constituentCount, coveragePct, 'INSUFFICIENT_CONSTITUENT_COVERAGE', source));
        continue;
      }

      const alignedDates = intersectDates([...constituentCloses, benchmarkCloses]);
      if (alignedDates.length < MIN_ALIGNED_OBSERVATIONS) {
        insufficient.push(insufficientResult(sector, requestedConstituentCount, constituentCount, coveragePct, 'INSUFFICIENT_ALIGNED_OBSERVATIONS', source));
        continue;
      }

      const normalizedConstituents = constituentCloses
        .map((closes) => normalizeSeries(alignedDates, closes))
        .filter(Boolean);
      if (normalizedConstituents.length < MIN_CONSTITUENTS) {
        insufficient.push(insufficientResult(sector, requestedConstituentCount, constituentCount, coveragePct, 'NORMALIZATION_FAILED', source));
        continue;
      }

      const sectorIndex = buildEqualWeightIndex(normalizedConstituents);
      const benchmarkIndex = normalizeSeries(alignedDates, benchmarkCloses);
      const rsSeries = computeRelativeStrengthSeries(sectorIndex, benchmarkIndex);
      const relativeStrength = rsSeries[rsSeries.length - 1];
      const relativeMomentum = computeRelativeMomentum(rsSeries, MOMENTUM_WINDOW);

      sufficient.push({
        sector,
        status: 'OK',
        relativeStrength: Number(relativeStrength.toFixed(6)),
        relativeMomentum: Number(relativeMomentum.toFixed(6)),
        quadrant: classifyQuadrant(relativeStrength, relativeMomentum),
        rank: null, // assigned below, across all sufficient sectors
        constituentCount,
        requestedConstituentCount,
        coveragePct: Number(coveragePct.toFixed(4)),
        period: {
          range: HISTORY_RANGE,
          interval: 'ONE_DAY',
          from: alignedDates[0],
          to: alignedDates[alignedDates.length - 1],
          observations: alignedDates.length,
        },
        source,
        asOf,
        methodologyVersion: METHODOLOGY_VERSION,
      });
    }

    rankSectors(sufficient);
    return [...sufficient, ...insufficient];
  }

  return {
    async getSectorRotation() {
      const cacheKey = 'sector-rotation:normalized:v2';
      const cached = await cacheGet(cacheKey);
      if (cached) return cached;
      const result = await computeSectorAnalytics();
      await cacheSet(cacheKey, result, ROTATION_CACHE_TTL);
      return result;
    },
  };
}

// Lazily constructs the real AngelOneProvider on first use (not at module
// load) so importing this module — e.g. from tests that inject their own
// fake provider via createSectorRotationService() — never requires Angel
// One credentials to be configured.
let defaultServiceInstance = null;
function getDefaultService() {
  if (!defaultServiceInstance) defaultServiceInstance = createSectorRotationService();
  return defaultServiceInstance;
}

export default {
  getSectorRotation: (...args) => getDefaultService().getSectorRotation(...args),
};
