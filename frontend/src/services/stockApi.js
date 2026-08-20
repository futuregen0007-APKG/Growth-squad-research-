import axios from 'axios';
import { STOCKS, FALLBACK_STOCK_DATA } from '@/data/mockData';

const normalizeApiBaseUrl = (value) => {
  if (!value) return 'http://localhost:5001';
  return value.replace(/\/api\/?$/, '').replace(/\/$/, '');
};

const API_BASE = normalizeApiBaseUrl(process.env.REACT_APP_API_BASE_URL || 'http://localhost:5001');

// Create axios instance with timeout
const api = axios.create({
  baseURL: `${API_BASE}/api`,
  timeout: 10000,
});

const generateSeries = (start, length = 30) => {
  const base = Number(start) || 0;
  return Array.from({ length }, (_, idx) => ({
    x: idx,
    v: Number((base + (Math.random() - 0.5) * base * 0.02).toFixed(2)),
  }));
};

const addSeries = (stock) => {
  if (!stock) return stock;
  return {
    ...stock,
    series: stock.series || generateSeries(stock.price || 0),
  };
};

const addSeriesToList = (stocks) => stocks.map(addSeries);

// Fetch all stocks
export const fetchAllStocks = async () => {
  try {
    const response = await api.get('/stocks');
    return addSeriesToList(response.data.data || []);
  } catch (error) {
    console.error('Error fetching stocks:', error);
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

// Get market status
export const fetchMarketStatus = async () => {
  try {
    const response = await api.get('/market/status');
    return response.data.data;
  } catch (error) {
    console.error('Error fetching market status:', error);
    throw error;
  }
};

export const fetchIndexQuotes = async (symbols) => {
  try {
    const response = await api.get('/stocks/indices', {
      params: { symbols: symbols.join(',') },
    });
    return response.data.data.map((index) => addSeries({
      ...index,
      value: index.price,
    }));
  } catch (error) {
    console.error('Error fetching index quotes, using fallback:', error);
    // Return empty array for now
    return [];
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
