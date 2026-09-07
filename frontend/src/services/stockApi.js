import axios from 'axios';
import API_BASE from '@/config/api';

const BASE = API_BASE;

// Create axios instance with timeout
const api = axios.create({
  baseURL: `${BASE}/api`,
  timeout: 10000,
});

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

export const searchStocks = async (query) => {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];

  try {
    const response = await api.get('/stocks/search', {
      params: { q: normalizedQuery },
    });
    return addSeriesToList(response.data.data || []);
  } catch (error) {
    console.error(`Error searching stocks for ${normalizedQuery}:`, error);
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
