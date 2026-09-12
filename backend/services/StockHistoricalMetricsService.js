/**
 * StockHistoricalMetricsService.js
 * ===================================
 * Computes verified historical-price statistics from the durable
 * StockPriceHistorySnapshot rows (NSE bhavcopy) and persists them to
 * StockHistoricalMetricsSnapshot -- so a "Load Eligible Stocks" click or a
 * /stock/:symbol page load reads one small pre-computed document instead of
 * recalculating over ~250 daily rows every time (Part Z).
 *
 * Corporate-action safety (Part C): a single-day close-to-close move beyond
 * DISCONTINUITY_THRESHOLD is flagged. This project has no ingested
 * corporate-action feed to confirm/adjust it against yet, so every detected
 * discontinuity is conservatively treated as UNVERIFIED -- the return/CAGR/
 * drawdown metrics that would cross that date are excluded (null) rather
 * than risk reporting a split/bonus-distorted "return". Volatility and
 * liquidity, which are not defined by two specific endpoints the way return/
 * drawdown are, are still computed from the full series.
 *
 * Minimum observation requirements (documented, not implicit): 20 trading
 * days for volatility, 60 for drawdown, 200 for a genuine one-year return --
 * the same thresholds already used by GoalRecommendationService's
 * historical-metric availability gate, now centralized here as the single
 * source of truth.
 */
import StockPriceHistorySnapshot from '../models/StockPriceHistorySnapshot.js';
import StockHistoricalMetricsSnapshot from '../models/StockHistoricalMetricsSnapshot.js';
import { logger } from '../utils/logger.js';

export const MIN_OBSERVATIONS_FOR_VOLATILITY = 20;
export const MIN_OBSERVATIONS_FOR_DRAWDOWN = 60;
export const MIN_OBSERVATIONS_FOR_ONE_YEAR_RETURN = 200;
export const DISCONTINUITY_THRESHOLD_PCT = 20; // abs single-day close-to-close move

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Detects single-day discontinuities in a date-ascending row series -- a real split/bonus/demerger will show up as an abrupt jump the raw close series can't explain on its own. */
const detectDiscontinuities = (rows) => {
  const discontinuities = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prior = rows[i - 1];
    const current = rows[i];
    if (!(prior.close > 0)) continue;
    const changePercent = ((current.close - prior.close) / prior.close) * 100;
    if (Math.abs(changePercent) >= DISCONTINUITY_THRESHOLD_PCT) {
      discontinuities.push({
        date: current.tradingDate, priorClose: prior.close, close: current.close, changePercent: Number(changePercent.toFixed(2)),
      });
    }
  }
  return discontinuities;
};

const classifyLiquidity = (averageDailyTurnover) => {
  if (averageDailyTurnover == null) return null;
  if (averageDailyTurnover >= 100000000) return 'HIGH'; // >= 10 crore/day
  if (averageDailyTurnover >= 10000000) return 'MODERATE'; // >= 1 crore/day
  return 'LOW';
};

/**
 * computeAndPersistMetricsForSymbol - reads every StockPriceHistorySnapshot
 * row for `symbol` once, computes the full metrics set, and upserts
 * StockHistoricalMetricsSnapshot. Returns null (and writes nothing) if there
 * are zero rows -- "no data" is never persisted as a fabricated empty
 * snapshot.
 */
export const computeAndPersistMetricsForSymbol = async (symbol) => {
  const normalized = String(symbol).toUpperCase();
  const rows = await StockPriceHistorySnapshot.find({ symbol: normalized }).sort({ tradingDate: 1 }).lean();
  if (!rows.length) return null;

  const observationCount = rows.length;
  const firstDate = rows[0].tradingDate;
  const lastDate = rows[rows.length - 1].tradingDate;
  const lastClose = rows[rows.length - 1].close;

  const discontinuities = detectDiscontinuities(rows);
  const hasUnresolvedDiscontinuity = discontinuities.length > 0;
  const corporateActionAdjustmentStatus = hasUnresolvedDiscontinuity ? 'UNVERIFIED' : 'NOT_REQUIRED';

  // 52-week window: every row we have is already within the last year in
  // practice (this project's backfill window), but scope explicitly by date
  // anyway so a symbol with >1Y of history in the future isn't misreported.
  const oneYearAgo = new Date(lastDate.getTime() - ONE_YEAR_MS);
  const windowRows = rows.filter((r) => r.tradingDate >= oneYearAgo);
  const fiftyTwoWeekHigh = windowRows.length ? Math.max(...windowRows.map((r) => r.high)) : null;
  const fiftyTwoWeekLow = windowRows.length ? Math.min(...windowRows.map((r) => r.low)) : null;

  const missingMetrics = [];

  let oneYearReturn = null;
  if (observationCount >= MIN_OBSERVATIONS_FOR_ONE_YEAR_RETURN && windowRows.length && !hasUnresolvedDiscontinuity) {
    const startClose = windowRows[0].close;
    if (startClose > 0) oneYearReturn = Number((((lastClose / startClose) - 1) * 100).toFixed(2));
  }
  if (oneYearReturn == null) missingMetrics.push('oneYearReturn');

  // Three-year CAGR requires ~3 years of daily rows this project has not
  // backfilled yet (one year to date) -- left null and reported missing
  // rather than computed from a shorter window under a 3-year label.
  const threeYearCagr = null;
  missingMetrics.push('threeYearCagr');

  let annualizedVolatility = null;
  if (observationCount >= MIN_OBSERVATIONS_FOR_VOLATILITY) {
    const closes = rows.map((r) => r.close).filter((c) => c > 0);
    const returns = closes.slice(1).map((c, i) => (c / closes[i]) - 1);
    const mean = returns.reduce((sum, r) => sum + r, 0) / Math.max(returns.length, 1);
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
    annualizedVolatility = Number((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(2));
  } else {
    missingMetrics.push('annualizedVolatility');
  }

  let maximumDrawdown = null;
  if (observationCount >= MIN_OBSERVATIONS_FOR_DRAWDOWN && !hasUnresolvedDiscontinuity) {
    let peak = rows[0].close;
    let maxDd = 0;
    for (const row of rows) {
      peak = Math.max(peak, row.close);
      maxDd = Math.min(maxDd, (row.close / peak) - 1);
    }
    maximumDrawdown = Number((maxDd * 100).toFixed(2));
  } else {
    missingMetrics.push('maximumDrawdown');
  }

  const volumes = rows.map((r) => r.volume).filter((v) => Number.isFinite(v));
  const turnovers = rows.map((r) => r.turnover).filter((t) => Number.isFinite(t));
  const averageDailyVolume = volumes.length ? Math.round(volumes.reduce((s, v) => s + v, 0) / volumes.length) : null;
  const averageDailyTurnover = turnovers.length ? Math.round(turnovers.reduce((s, t) => s + t, 0) / turnovers.length) : null;
  if (averageDailyTurnover == null) missingMetrics.push('averageDailyTurnover');

  const snapshot = {
    symbol: normalized,
    observationCount,
    firstDate,
    lastDate,
    lastClose,
    fiftyTwoWeekHigh,
    fiftyTwoWeekLow,
    oneYearReturn,
    threeYearCagr,
    annualizedVolatility,
    maximumDrawdown,
    averageDailyVolume,
    averageDailyTurnover,
    liquidityClassification: classifyLiquidity(averageDailyTurnover),
    corporateActionAdjustmentStatus,
    discontinuitiesDetected: discontinuities,
    missingMetrics,
    provider: 'NSE_BHAVCOPY',
    dataAsOf: lastDate,
    computedAt: new Date(),
  };

  await StockHistoricalMetricsSnapshot.findOneAndUpdate({ symbol: normalized }, { $set: snapshot }, { upsert: true });
  return snapshot;
};

/** Fast, request-path-safe read of the already-computed snapshot. Never recomputes -- returns null if nothing has been computed yet for this symbol. */
export const getMetricsForSymbol = async (symbol) => {
  const doc = await StockHistoricalMetricsSnapshot.findOne({ symbol: String(symbol).toUpperCase() }).lean();
  return doc || null;
};

/** Batch recompute -- used by the backfill script and by a scheduled refresh; never throws for one bad symbol. */
export const recomputeMetricsForSymbols = async (symbols, { onProgress = () => {} } = {}) => {
  const results = { computed: 0, skipped: 0, failed: 0 };
  for (const symbol of symbols) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const snapshot = await computeAndPersistMetricsForSymbol(symbol);
      if (snapshot) { results.computed += 1; onProgress(`${symbol}: computed (${snapshot.observationCount} obs)`); } else { results.skipped += 1; }
    } catch (error) {
      results.failed += 1;
      logger.warn(`[StockHistoricalMetricsService] Failed to compute metrics for ${symbol}: ${error.message}`);
    }
  }
  return results;
};

export default {
  computeAndPersistMetricsForSymbol, getMetricsForSymbol, recomputeMetricsForSymbols, MIN_OBSERVATIONS_FOR_VOLATILITY, MIN_OBSERVATIONS_FOR_DRAWDOWN, MIN_OBSERVATIONS_FOR_ONE_YEAR_RETURN,
};
