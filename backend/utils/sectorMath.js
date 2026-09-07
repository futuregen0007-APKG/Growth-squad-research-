/**
 * SECTORMATH.JS
 * =============
 * Pure, deterministic math for sector relative-strength analytics.
 *
 * No network calls, no randomness, no fallback/neutral values — every
 * function here either returns a real computed result or a clear
 * null/insufficient signal so SectorRotationService never has to guess.
 *
 * METHOD (equal-weight relative strength):
 * 1. Each constituent's daily closes are normalized to a base of 100 at the
 *    first date common to every series in the comparison (so a ₹50 stock and
 *    a ₹5,000 stock contribute identically once normalized — see
 *    buildEqualWeightIndex).
 * 2. The sector index is the equal-weight average of those normalized
 *    constituent series.
 * 3. The benchmark (Nifty 50) is normalized to 100 over the same dates.
 * 4. Relative strength = sector index / benchmark index (a ratio, ~1 at the
 *    base date — never a "% gain").
 * 5. Relative momentum = trailing rate of change of that ratio.
 */

export const METHODOLOGY_VERSION = 'sector-relative-strength-v1';

/** Converts a candle timestamp (ms) to a trading-date key (YYYY-MM-DD, UTC). */
export function toDateKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Builds a Map<dateKey, close> from a candle array. Candles with a
 * non-finite close are skipped rather than coerced to 0 — a skipped
 * observation is honest; a fabricated zero is not.
 */
export function closesByDate(candles) {
  const map = new Map();
  for (const candle of candles || []) {
    if (!candle || !Number.isFinite(candle.close) || !Number.isFinite(candle.timestamp)) continue;
    map.set(toDateKey(candle.timestamp), candle.close);
  }
  return map;
}

/** Sorted ascending list of dates present in every supplied Map. */
export function intersectDates(dateMaps) {
  if (!dateMaps.length) return [];
  let common = new Set(dateMaps[0].keys());
  for (let i = 1; i < dateMaps.length; i++) {
    const keys = dateMaps[i];
    common = new Set([...common].filter((date) => keys.has(date)));
  }
  return [...common].sort();
}

/**
 * Normalizes a close-price series to `base` (100) at `dates[0]`.
 * Returns null (never a fabricated series) if the base observation is
 * missing or zero.
 */
export function normalizeSeries(dates, closes, base = 100) {
  const baseClose = closes.get(dates[0]);
  if (!Number.isFinite(baseClose) || baseClose === 0) return null;
  return dates.map((date) => (closes.get(date) / baseClose) * base);
}

/**
 * Equal-weight index across already-normalized constituent series (each
 * starting at 100). Because every input series shares the same base and
 * scale, this never lets a high-priced stock dominate a low-priced one —
 * the defect this module replaces (averaging raw prices) is structurally
 * impossible here.
 */
export function buildEqualWeightIndex(normalizedSeriesList) {
  if (!normalizedSeriesList.length) return null;
  const length = normalizedSeriesList[0].length;
  const sums = new Array(length).fill(0);
  for (const series of normalizedSeriesList) {
    for (let i = 0; i < length; i++) sums[i] += series[i];
  }
  return sums.map((sum) => sum / normalizedSeriesList.length);
}

/** Relative-strength ratio series: sector index / benchmark index. */
export function computeRelativeStrengthSeries(sectorIndex, benchmarkIndex) {
  return sectorIndex.map((value, i) => value / benchmarkIndex[i]);
}

/**
 * Deterministic trailing rate-of-change of the RS series — the slope
 * proxy used as "relative momentum". Window is clamped to the series
 * length so short (but still sufficient) histories still produce a value.
 */
export function computeRelativeMomentum(rsSeries, window) {
  const n = rsSeries.length;
  const effectiveWindow = Math.min(window, n - 1);
  if (effectiveWindow <= 0) return 0;
  const past = rsSeries[n - 1 - effectiveWindow];
  const latest = rsSeries[n - 1];
  if (!Number.isFinite(past) || past === 0) return 0;
  return (latest - past) / past;
}

/**
 * Standard RRG-style quadrant naming:
 * RS >= 1 (leading the benchmark) & momentum >= 0 -> Leading
 * RS >= 1 & momentum < 0                          -> Weakening
 * RS < 1 (lagging the benchmark) & momentum >= 0  -> Improving
 * RS < 1 & momentum < 0                           -> Lagging
 */
export function classifyQuadrant(relativeStrength, relativeMomentum) {
  const isLeadingBenchmark = relativeStrength >= 1;
  const isRising = relativeMomentum >= 0;
  if (isLeadingBenchmark && isRising) return 'Leading';
  if (isLeadingBenchmark && !isRising) return 'Weakening';
  if (!isLeadingBenchmark && isRising) return 'Improving';
  return 'Lagging';
}

/**
 * Ranks sectors with sufficient data by relative strength (descending),
 * mutating and returning each entry with a `rank` field. Sectors not
 * passed in here (insufficient data) are never ranked — callers should
 * leave their `rank` as null.
 */
export function rankSectors(sufficientResults) {
  const sorted = [...sufficientResults].sort((a, b) => b.relativeStrength - a.relativeStrength);
  sorted.forEach((result, index) => { result.rank = index + 1; });
  return sorted;
}
