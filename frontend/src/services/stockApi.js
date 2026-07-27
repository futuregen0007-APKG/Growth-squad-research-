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
    console.error('Error fetching stocks, using fallback:', error);
    // Return fallback data from STOCKS array
    return addSeriesToList(STOCKS);
  }
};

// Fetch single stock
export const fetchStockBySymbol = async (symbol) => {
  try {
    const response = await api.get(`/stocks/${symbol}`);
    return addSeries(response.data.data);
  } catch (error) {
    console.error(`Error fetching stock ${symbol}, using fallback:`, error);
    // Return fallback data from FALLBACK_STOCK_DATA
    const fallbackData = FALLBACK_STOCK_DATA[symbol.toUpperCase()];
    if (fallbackData) {
      return addSeries(fallbackData);
    }
    // If no fallback, try to find in STOCKS array
    const stockFromList = STOCKS.find(s => s.ticker === symbol.toUpperCase());
    if (stockFromList) {
      return addSeries(stockFromList);
    }
    throw error;
  }
};

// Fetch multiple stocks
export const fetchMultipleStocks = async (symbols) => {
  try {
    const response = await api.get(`/stocks?symbols=${symbols.join(',')}`);
    return response.data.data || [];
  } catch (error) {
    console.error('Error fetching multiple stocks, using fallback:', error);
    // Return fallback data for each symbol
    return symbols.map(symbol => {
      const fallbackData = FALLBACK_STOCK_DATA[symbol.toUpperCase()];
      if (fallbackData) return addSeries(fallbackData);
      const stockFromList = STOCKS.find(s => s.ticker === symbol.toUpperCase());
      if (stockFromList) return addSeries(stockFromList);
      return null;
    }).filter(Boolean);
  }
};

// Fetch company details
export const fetchCompanyDetails = async (symbol) => {
  try {
    const response = await api.get(`/stocks/${symbol}/details`);
    return response.data.data;
  } catch (error) {
    console.error(`Error fetching company details for ${symbol}, using fallback:`, error);
    // Return basic fallback data
    const stockData = FALLBACK_STOCK_DATA[symbol.toUpperCase()] || STOCKS.find(s => s.ticker === symbol.toUpperCase());
    if (stockData) {
      return {
        name: stockData.name,
        sector: stockData.sector,
        description: `${stockData.name} is a key player in India's ${stockData.sector} sector.`,
        founded: '—',
        hq: 'India',
        employees: '—',
        ceo: '—',
      };
    }
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
    console.error('Error filtering stocks, using fallback:', error);
    // Return filtered STOCKS array
    let filtered = [...STOCKS];
    if (filters.sector) {
      filtered = filtered.filter(s => s.sector === filters.sector);
    }
    if (filters.minPrice) {
      filtered = filtered.filter(s => s.price >= filters.minPrice);
    }
    if (filters.maxPrice) {
      filtered = filtered.filter(s => s.price <= filters.maxPrice);
    }
    return addSeriesToList(filtered);
  }
};

// Get market status
export const fetchMarketStatus = async () => {
  try {
    const response = await api.get('/market/status');
    return response.data.data;
  } catch (error) {
    console.error('Error fetching market status, using fallback:', error);
    return {
      isOpen: true,
      session: "REGULAR",
      region: "NSE / BSE",
      closesAt: "15:30 IST",
      serverTime: new Date().toLocaleTimeString('en-IN', { hour12: false }),
    };
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
    console.error(`Error refreshing stock ${symbol}, using fallback:`, error);
    // Return fallback data
    const fallbackData = FALLBACK_STOCK_DATA[symbol.toUpperCase()];
    if (fallbackData) return addSeries(fallbackData);
    throw error;
  }
};
