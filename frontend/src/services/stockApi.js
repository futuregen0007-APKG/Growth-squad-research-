import axios from 'axios';
import API_BASE from '@/config/api';
import { reportBackendUnavailable, isAvailabilityImpactingAxiosError } from '@/services/backendHealth';

const BASE = API_BASE;

// 20-30s is a sensible bound for an ordinary GET once the backend is
// actually awake -- long enough to survive a slow query, short enough that
// a genuinely broken backend still fails predictably. This is NOT how cold
// starts are handled (that's `services/backendHealth.js`, awaited once
// before these requests are ever fired) -- solving cold starts by simply
// inflating this number would make every *normal* request wait just as
// long when something is actually wrong.
const REQUEST_TIMEOUT_MS = 25000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 2500];

// Create axios instance with timeout
const api = axios.create({
  baseURL: `${BASE}/api`,
  timeout: REQUEST_TIMEOUT_MS,
});

const isRetryableStatus = (status) => status == null || status >= 500;

// Retries only safe, idempotent requests (GET) a bounded number of times
// with a short fixed backoff. Never retries a request that already has a
// response with a 4xx status (auth/validation errors are not transient),
// and never retries a canceled request (a caller-initiated abort, e.g.
// unmount or a superseded search keystroke, means "stop", not "try again").
//
// Once a request is genuinely given up on (either it wasn't retryable at
// all, or retries are exhausted), it's classified: a network failure,
// timeout, or 502/503/504 means the backend itself is unreachable, and
// reportBackendUnavailable() flips the shared readiness store back to
// "waking" so the whole app falls back to the same wake-up screen it shows
// on first load (see services/backendHealth.js) -- a 4xx/500/canceled
// request never does this, since those say nothing about whether the
// backend is up. This only fires on the FINAL give-up, not on a transient
// attempt that a retry might still recover from, so a single self-healing
// blip never flashes the wake-up screen.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config || {};
    const method = String(config.method || 'get').toLowerCase();
    const canceled = axios.isCancel(error) || error.code === 'ERR_CANCELED' || error.name === 'CanceledError';
    const status = error.response?.status;

    if (canceled || method !== 'get' || !isRetryableStatus(status)) {
      if (isAvailabilityImpactingAxiosError(error)) reportBackendUnavailable();
      return Promise.reject(error);
    }

    const attempt = config.__retryAttempt || 0;
    if (attempt >= MAX_RETRIES) {
      if (isAvailabilityImpactingAxiosError(error)) reportBackendUnavailable();
      return Promise.reject(error);
    }

    config.__retryAttempt = attempt + 1;
    const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    return api(config);
  },
);

const addSeries = (stock) => {
  if (!stock) return stock;
  return {
    ...stock,
    series: Array.isArray(stock.series) ? stock.series : [],
  };
};

const addSeriesToList = (stocks) => stocks.map(addSeries);

// A caller-initiated AbortController cancellation (component unmount, a
// dependency changing before the previous request settled — including
// React StrictMode's dev-only double-effect-invoke) is expected, not a
// failure; logging it as an error is just console noise.
const isCanceled = (error) => axios.isCancel(error) || error.code === 'ERR_CANCELED' || error.name === 'CanceledError';

// Fetch all stocks
export const fetchAllStocks = async (options = {}) => {
  try {
    const response = await api.get('/stocks', options);
    return addSeriesToList(response.data.data || []);
  } catch (error) {
    if (!isCanceled(error)) console.error('Error fetching stocks:', error);
    throw error;
  }
};

// Fetch single stock
export const fetchStockBySymbol = async (symbol) => {
  try {
    const response = await api.get(`/stocks/${symbol}`);
    return addSeries(response.data.data);
  } catch (error) {
    console.error(`Error fetching stock ${symbol}:`, error);
    throw error;
  }
};

// Fetch multiple stocks
export const fetchMultipleStocks = async (symbols) => {
  try {
    const response = await api.get(`/stocks?symbols=${symbols.join(',')}`);
    return response.data.data || [];
  } catch (error) {
    console.error('Error fetching multiple stocks:', error);
    throw error;
  }
};

// Fetch company details
export const fetchCompanyDetails = async (symbol) => {
  try {
    const response = await api.get(`/stocks/${symbol}/details`);
    return response.data.data;
  } catch (error) {
    console.error(`Error fetching company details for ${symbol}:`, error);
    throw error;
  }
};

// Fetch real historical OHLCV candles for the price chart.
// Returns the full metadata envelope from the backend
// ({ symbol, range, interval, source, asOf, isStale, count, candles }) —
// never mock/fallback candles; a provider/network failure throws so the
// caller can render an explicit error state instead of a fake chart.
export const fetchHistoricalData = async (symbol, range = '1Y', interval, options = {}) => {
  try {
    const response = await api.get(`/stocks/${encodeURIComponent(symbol)}/history`, {
      params: { range, ...(interval ? { interval } : {}) },
      ...options,
    });
    return response.data.data;
  } catch (error) {
    if (!isCanceled(error)) console.error(`Error fetching historical data for ${symbol}:`, error);
    throw error;
  }
};

// Real sector relative-strength analytics, computed server-side from live
// Angel One daily candles: each constituent is normalized to 100 at a
// common start date, averaged into an equal-weight sector index, then
// divided by a similarly-normalized Nifty 50 index. `relativeStrength` is
// that ratio (NOT a %-change/heatmap value — never label it "% gain") and
// `relativeMomentum` is its trailing rate of change. Sectors without enough
// constituent coverage or aligned trading days come back with
// status: 'INSUFFICIENT_DATA' and null numeric fields — never a
// neutral/fallback number. Render exactly what the backend returns.
export const fetchSectorRotation = async (options = {}) => {
  const response = await api.get('/sector-rotation', options);
  return response.data.data || [];
};

// Filter stocks by criteria
export const filterStocks = async (filters) => {
  try {
    const params = new URLSearchParams(filters).toString();
    const response = await api.get(`/stocks/search?${params}`);
    return response.data.data || [];
  } catch (error) {
    console.error('Error filtering stocks:', error);
    throw error;
  }
};

export const searchStocks = async (query, options = {}) => {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];

  try {
    const response = await api.get('/stocks/search', {
      params: { q: normalizedQuery },
      ...options,
    });
    return addSeriesToList(response.data.data || []);
  } catch (error) {
    if (!isCanceled(error)) console.error(`Error searching stocks for ${normalizedQuery}:`, error);
    throw error;
  }
};

// Get market status
export const fetchMarketStatus = async () => {
  try {
    const response = await api.get('/stocks/market/status');
    return response.data.data;
  } catch (error) {
    console.error('Error fetching market status:', error);
    throw error;
  }
};

export const fetchIndexQuotes = async (symbols, options = {}) => {
  try {
    const response = await api.get('/stocks/indices', {
      params: { symbols: symbols.join(',') },
      ...options,
    });
    return response.data.data.map((index) => addSeries({
      ...index,
      value: index.price,
    }));
  } catch (error) {
    if (!isCanceled(error)) console.error('Error fetching index quotes:', error);
    throw error;
  }
};

// Refresh stock price (bypass cache)
export const refreshStockPrice = async (symbol) => {
  try {
    const response = await api.post(`/stocks/${symbol}/refresh`);
    return response.data.data;
  } catch (error) {
    console.error(`Error refreshing stock ${symbol}:`, error);
    throw error;
  }
};
