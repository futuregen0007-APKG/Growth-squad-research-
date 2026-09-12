/**
 * MfApiHistoricalNavProvider.js
 * ===============================
 * Real daily NAV history per scheme, from https://api.mfapi.in -- a public
 * service that republishes AMFI's own official historical NAV disclosures
 * (verified live: full daily history back to scheme inception, e.g. TCS's
 * banking-and-PSU debt scheme returned data to 2013). AMFI itself only
 * exposes historical NAV via a date-range form download, not a clean
 * per-scheme API, so this is used as the practical way to compute real
 * 1Y/3Y/5Y returns, 3Y volatility and max drawdown -- the same math already
 * used for stocks in GoalRecommendationService.calculateHistoricalMetrics,
 * applied to real NAV series instead of real price candles. Never
 * fabricates a return/risk figure when history is insufficient.
 */
import axios from 'axios';
import { logger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// A trailing return/statistic is only trusted once enough real daily NAV
// observations exist within its window -- mirrors the stock-side minimums
// (MIN_OBSERVATIONS_FOR_* in GoalRecommendationService.js) rather than
// inventing a separate standard for funds.
export const MIN_OBSERVATIONS_FOR_1Y = 200;
export const MIN_OBSERVATIONS_FOR_3Y = 500;
export const MIN_OBSERVATIONS_FOR_5Y = 800;
export const MIN_OBSERVATIONS_FOR_VOLATILITY_3Y = 500;

export const fetchSchemeHistory = async (schemeCode) => {
  const response = await axios.get(`https://api.mfapi.in/mf/${encodeURIComponent(schemeCode)}`, { timeout: 20000 });
  const payload = response.data;
  if (!payload || payload.status !== 'SUCCESS' || !Array.isArray(payload.data)) {
    throw new Error(`Unexpected mfapi.in response for scheme ${schemeCode}`);
  }
  // mfapi.in returns newest-first; normalize to a clean ascending series of {date, nav}.
  const series = payload.data
    .map((entry) => ({ date: parseMfApiDate(entry.date), nav: Number(entry.nav) }))
    .filter((entry) => entry.date && Number.isFinite(entry.nav) && entry.nav > 0)
    .sort((a, b) => a.date - b.date);
  return series;
};

const parseMfApiDate = (value) => {
  // mfapi.in date format: "DD-MM-YYYY"
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Computes real, deterministic returns/risk statistics from a real NAV
 * series. Each statistic independently requires its own minimum sample size
 * within its trailing window (not a full literal calendar span) before being
 * asserted -- matching the same convention already used for stocks
 * (GoalRecommendationService.calculateHistoricalMetrics computes a "1-year
 * return" as first-vs-last over whatever window the provider actually
 * returned, gated purely by observation count, never by requiring an exact
 * 365-days-ago data point to exist). A fund with only ~10 months of history
 * still gets a real, CAGR-annualized 1Y-window return (annualized using the
 * ACTUAL elapsed time, not padded to a full year) as long as it clears the
 * observation-count floor; a fund with too few observations in a window
 * gets null for that statistic, never an extrapolated guess.
 */
export const computeReturnsAndRisk = (series) => {
  if (!Array.isArray(series) || series.length < 2) {
    return { returns1Y: null, returns3Y: null, returns5Y: null, volatility3Y: null, maxDrawdown: null, observations: 0, dataAsOf: null };
  }

  const latest = series[series.length - 1];
  const observations = series.length;

  const trailingWindow = (years) => {
    const cutoffTime = latest.date.getTime() - years * 365 * DAY_MS;
    return series.filter((e) => e.date.getTime() >= cutoffTime);
  };

  const cagrOver = (years, minObservations) => {
    const window = trailingWindow(years);
    if (window.length < minObservations) return null;
    const start = window[0];
    const yearsActual = (latest.date.getTime() - start.date.getTime()) / (365 * DAY_MS);
    if (yearsActual <= 0) return null;
    const cagr = (Math.pow(latest.nav / start.nav, 1 / yearsActual) - 1) * 100;
    return Number(cagr.toFixed(2));
  };

  const returns1Y = cagrOver(1, MIN_OBSERVATIONS_FOR_1Y);
  const returns3Y = cagrOver(3, MIN_OBSERVATIONS_FOR_3Y);
  const returns5Y = cagrOver(5, MIN_OBSERVATIONS_FOR_5Y);

  let volatility3Y = null;
  let maxDrawdown = null;
  const window = trailingWindow(3);
  if (window.length >= MIN_OBSERVATIONS_FOR_VOLATILITY_3Y) {
    const dailyReturns = window.slice(1).map((entry, index) => (entry.nav / window[index].nav) - 1).filter(Number.isFinite);
    const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / Math.max(dailyReturns.length, 1);
    const variance = dailyReturns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(dailyReturns.length - 1, 1);
    volatility3Y = Number((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(2));

    let peak = window[0].nav;
    let drawdown = 0;
    for (const entry of window) {
      peak = Math.max(peak, entry.nav);
      drawdown = Math.min(drawdown, (entry.nav / peak) - 1);
    }
    maxDrawdown = Number((drawdown * 100).toFixed(2));
  }

  return { returns1Y, returns3Y, returns5Y, volatility3Y, maxDrawdown, observations, dataAsOf: latest.date };
};

export const fetchReturnsAndRisk = async (schemeCode) => {
  try {
    const series = await fetchSchemeHistory(schemeCode);
    return computeReturnsAndRisk(series);
  } catch (error) {
    logger.warn(`[MfApiHistoricalNavProvider] Failed to fetch history for scheme ${schemeCode}: ${error.message}`);
    return null;
  }
};

export default { fetchSchemeHistory, computeReturnsAndRisk, fetchReturnsAndRisk };
