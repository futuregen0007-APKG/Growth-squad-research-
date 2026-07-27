/**
 * CONSTANTS.JS
 * ============
 * Centralized configuration values and constants for the stock service.
 * 
 * WHY THIS FILE EXISTS:
 * - Single source of truth for configuration values
 * - Easy to adjust settings without searching code
 * - Prevents magic numbers scattered throughout the codebase
 * 
 * CATEGORIES:
 * 1. Cache TTL (Time To Live) - How long data is cached in Redis
 * 2. API Settings - Provider-specific configurations
 * 3. Response Formats - Stock data structure templates
 */

// ============================================================
// CACHE TTL (Time To Live in seconds)
// ============================================================
export const CACHE_TTL = {
  // Stock prices update frequently → short cache
  STOCK_PRICE: parseInt(process.env.CACHE_TTL_STOCK || 300),        // 5 minutes
  
  // Company details are stable → longer cache
  COMPANY_DETAILS: parseInt(process.env.CACHE_TTL_COMPANY || 3600), // 1 hour
  
  // Market status rarely changes during trading hours
  MARKET_STATUS: 60,                                                  // 1 minute
};

// ============================================================
// API ENDPOINTS & CONFIGURATIONS
// ============================================================
export const API_CONFIG = {
  // Finnhub API
  FINNHUB: {
    BASE_URL: 'https://finnhub.io/api/v1',
    TIMEOUT: 10000,  // 10 seconds
  },
  
  // Twelve Data API (for future provider)
  TWELVE_DATA: {
    BASE_URL: 'https://api.twelvedata.com',
    TIMEOUT: 15000,  // 15 seconds
  },

  // Financial Modeling Prep API
  FINANCIAL_MODELING_PREP: {
    BASE_URL: 'https://financialmodelingprep.com/api/v3',
    TIMEOUT: 15000,  // 15 seconds
  },
};

// ============================================================
// STOCK DATA STRUCTURE
// ============================================================
// Template showing what stock object should look like
export const STOCK_DATA_TEMPLATE = {
  ticker: 'HAL',                    // Stock symbol
  name: 'Hindustan Aeronautics',   // Company name
  sector: 'Defence',                // Industry sector
  price: 4521.30,                   // Current price (INR)
  changePct: 2.84,                  // Percentage change
  change: 120.50,                   // Absolute change
  high: 4580.00,                    // Day high
  low: 4450.00,                     // Day low
  open: 4450.00,                    // Opening price
  volume: 5000000,                  // Trading volume
  marketCap: '₹3.02L Cr',           // Market capitalization
  pe: 32.1,                         // Price-to-Earnings ratio
  currency: 'INR',                  // Currency
  lastUpdate: 1234567890,           // Unix timestamp of last update
};

// ============================================================
// ERROR CODES
// ============================================================
export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  CACHE_ERROR: 'CACHE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

// ============================================================
// HTTP STATUS CODES
// ============================================================
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

// ============================================================
// WEBSOCKET CONFIGURATION
// ============================================================
export const WEBSOCKET = {
  PORT: parseInt(process.env.WEBSOCKET_PORT || 5001),
  UPDATE_INTERVAL: parseInt(process.env.PRICE_UPDATE_INTERVAL || 5000),
  
  // Message types for WebSocket communication
  MESSAGE_TYPES: {
    SUBSCRIBE: 'SUBSCRIBE',
    UNSUBSCRIBE: 'UNSUBSCRIBE',
    PRICE_UPDATE: 'PRICE_UPDATE',
    ERROR: 'ERROR',
  },
};

// ============================================================
// SUPPORTED STOCKS (Indian market symbols)
// ============================================================
// This maps frontend tickers to market data providers
// Useful for validation and rate limiting
export const SUPPORTED_STOCKS = {
  // Defence
  'HAL': { name: 'Hindustan Aeronautics', sector: 'Defence', currency: 'INR' },
  'BEL': { name: 'Bharat Electronics', sector: 'Defence', currency: 'INR' },
  'BDL': { name: 'Bharat Dynamics', sector: 'Defence', currency: 'INR' },
  'MAZDOCK': { name: 'Mazagon Dock Shipbuilders', sector: 'Defence', currency: 'INR' },
  
  // Railways
  'IRCTC': { name: 'IRCTC', sector: 'Railways', currency: 'INR' },
  'RVNL': { name: 'Rail Vikas Nigam', sector: 'Railways', currency: 'INR' },
  'RAILTEL': { name: 'RailTel Corporation', sector: 'Railways', currency: 'INR' },
  'TITAGARH': { name: 'Titagarh Rail Systems', sector: 'Railways', currency: 'INR' },
  
  // Green Energy
  'ADANIGREEN': { name: 'Adani Green Energy', sector: 'Green Energy', currency: 'INR' },
  'TATAPOWER': { name: 'Tata Power', sector: 'Green Energy', currency: 'INR' },
  'SUZLON': { name: 'Suzlon Energy', sector: 'Green Energy', currency: 'INR' },
  'NTPC': { name: 'NTPC Ltd', sector: 'Green Energy', currency: 'INR' },
  
  // Manufacturing
  'LT': { name: 'Larsen & Toubro', sector: 'Manufacturing', currency: 'INR' },
  'SIEMENS': { name: 'Siemens India', sector: 'Manufacturing', currency: 'INR' },
  'ABB': { name: 'ABB India', sector: 'Manufacturing', currency: 'INR' },
  
  // Banking
  'HDFCBANK': { name: 'HDFC Bank', sector: 'Banking', currency: 'INR' },
  'ICICIBANK': { name: 'ICICI Bank', sector: 'Banking', currency: 'INR' },
  'SBIN': { name: 'State Bank of India', sector: 'Banking', currency: 'INR' },
  'KOTAKBANK': { name: 'Kotak Mahindra Bank', sector: 'Banking', currency: 'INR' },
  
  // Infrastructure
  'GMRINFRA': { name: 'GMR Airports Infra', sector: 'Infrastructure', currency: 'INR' },
  'IRB': { name: 'IRB Infrastructure', sector: 'Infrastructure', currency: 'INR' },
  'NCC': { name: 'NCC Limited', sector: 'Infrastructure', currency: 'INR' },
  
  // Healthcare
  'SUNPHARMA': { name: 'Sun Pharmaceuticals', sector: 'Healthcare', currency: 'INR' },
  'DRREDDY': { name: "Dr. Reddy's Laboratories", sector: 'Healthcare', currency: 'INR' },
  'DIVISLAB': { name: "Divi's Laboratories", sector: 'Healthcare', currency: 'INR' },
  'CIPLA': { name: 'Cipla Ltd', sector: 'Healthcare', currency: 'INR' },
};

export const INDEX_SYMBOLS = {
  'NIFTYIT': '^CNXIT',
  'SENSEX': '^BSESN',
  'NIFTY 50': '^NSEI',
};

export const WATCHLISTS = [
  {
    id: 'growth',
    name: 'Growth Picks',
    description: 'High-growth companies with strong momentum in infrastructure, energy and defence.',
    tickers: ['LT', 'ADANIGREEN', 'HAL', 'TATAPOWER'],
  },
  {
    id: 'defence',
    name: 'Defence Leaders',
    description: 'A concentrated basket of defence names capturing order-book momentum.',
    tickers: ['HAL', 'BEL', 'BDL', 'MAZDOCK'],
  },
  {
    id: 'banking',
    name: 'Banking Basket',
    description: 'Banking names reflecting rate-sensitivity and margin trends.',
    tickers: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK'],
  },
];

// ============================================================
// FALLBACK HARDCODED STOCK DATA (used when APIs fail)
// ============================================================
export const FALLBACK_STOCK_DATA = {
  'HAL': { ticker: 'HAL', name: 'Hindustan Aeronautics', sector: 'Defence', price: 4521.30, changePct: 2.84, change: 120.50, high: 4580.00, low: 4450.00, open: 4450.00, volume: 5000000, marketCap: '₹3.02L Cr', pe: 32.1, currency: 'INR' },
  'BEL': { ticker: 'BEL', name: 'Bharat Electronics', sector: 'Defence', price: 289.45, changePct: 1.23, change: 3.55, high: 292.00, low: 285.00, open: 286.00, volume: 2500000, marketCap: '₹1.02L Cr', pe: 28.5, currency: 'INR' },
  'BDL': { ticker: 'BDL', name: 'Bharat Dynamics', sector: 'Defence', price: 1850.75, changePct: -0.45, change: -8.35, high: 1870.00, low: 1840.00, open: 1855.00, volume: 800000, marketCap: '₹45K Cr', pe: 35.2, currency: 'INR' },
  'MAZDOCK': { ticker: 'MAZDOCK', name: 'Mazagon Dock', sector: 'Defence', price: 4125.60, changePct: 3.21, change: 128.40, high: 4180.00, low: 4000.00, open: 4010.00, volume: 1200000, marketCap: '₹68K Cr', pe: 42.1, currency: 'INR' },
  'IRCTC': { ticker: 'IRCTC', name: 'IRCTC', sector: 'Railways', price: 925.30, changePct: 1.89, change: 17.20, high: 935.00, low: 910.00, open: 915.00, volume: 3500000, marketCap: '₹1.45L Cr', pe: 38.5, currency: 'INR' },
  'RVNL': { ticker: 'RVNL', name: 'Rail Vikas Nigam', sector: 'Railways', price: 235.40, changePct: 2.15, change: 4.95, high: 240.00, low: 230.00, open: 232.00, volume: 4500000, marketCap: '₹52K Cr', pe: 25.8, currency: 'INR' },
  'RAILTEL': { ticker: 'RAILTEL', name: 'RailTel Corporation', sector: 'Railways', price: 425.80, changePct: -1.32, change: -5.70, high: 435.00, low: 420.00, open: 430.00, volume: 1800000, marketCap: '₹18K Cr', pe: 22.4, currency: 'INR' },
  'TITAGARH': { ticker: 'TITAGARH', name: 'Titagarh Rail Systems', sector: 'Railways', price: 890.25, changePct: 4.56, change: 38.80, high: 910.00, low: 855.00, open: 860.00, volume: 900000, marketCap: '₹12K Cr', pe: 30.2, currency: 'INR' },
  'ADANIGREEN': { ticker: 'ADANIGREEN', name: 'Adani Green Energy', sector: 'Green Energy', price: 2850.40, changePct: 2.78, change: 77.50, high: 2900.00, low: 2780.00, open: 2800.00, volume: 2800000, marketCap: '₹4.85L Cr', pe: 45.3, currency: 'INR' },
  'TATAPOWER': { ticker: 'TATAPOWER', name: 'Tata Power', sector: 'Green Energy', price: 412.35, changePct: 1.45, change: 5.90, high: 418.00, low: 405.00, open: 408.00, volume: 5200000, marketCap: '₹1.32L Cr', pe: 18.7, currency: 'INR' },
  'SUZLON': { ticker: 'SUZLON', name: 'Suzlon Energy', sector: 'Green Energy', price: 45.60, changePct: 5.23, change: 2.25, high: 47.00, low: 43.00, open: 44.00, volume: 15000000, marketCap: '₹15K Cr', pe: -12.5, currency: 'INR' },
  'NTPC': { ticker: 'NTPC', name: 'NTPC Ltd', sector: 'Green Energy', price: 345.80, changePct: 0.89, change: 3.05, high: 350.00, low: 342.00, open: 344.00, volume: 8500000, marketCap: '₹3.45L Cr', pe: 14.2, currency: 'INR' },
  'LT': { ticker: 'LT', name: 'Larsen & Toubro', sector: 'Manufacturing', price: 3520.45, changePct: 1.67, change: 58.20, high: 3580.00, low: 3470.00, open: 3480.00, volume: 3200000, marketCap: '₹5.12L Cr', pe: 28.9, currency: 'INR' },
  'SIEMENS': { ticker: 'SIEMENS', name: 'Siemens India', sector: 'Manufacturing', price: 4850.70, changePct: 2.34, change: 111.50, high: 4920.00, low: 4750.00, open: 4770.00, volume: 850000, marketCap: '₹1.85L Cr', pe: 35.6, currency: 'INR' },
  'ABB': { ticker: 'ABB', name: 'ABB India', sector: 'Manufacturing', price: 6890.25, changePct: 3.12, change: 209.40, high: 7000.00, low: 6700.00, open: 6720.00, volume: 450000, marketCap: '₹2.05L Cr', pe: 42.8, currency: 'INR' },
  'HDFCBANK': { ticker: 'HDFCBANK', name: 'HDFC Bank', sector: 'Banking', price: 1685.40, changePct: 0.78, change: 13.10, high: 1700.00, low: 1670.00, open: 1675.00, volume: 8500000, marketCap: '₹9.45L Cr', pe: 19.5, currency: 'INR' },
  'ICICIBANK': { ticker: 'ICICIBANK', name: 'ICICI Bank', sector: 'Banking', price: 1085.60, changePct: 1.23, change: 13.25, high: 1095.00, low: 1075.00, open: 1080.00, volume: 12000000, marketCap: '₹6.25L Cr', pe: 17.8, currency: 'INR' },
  'SBIN': { ticker: 'SBIN', name: 'State Bank of India', sector: 'Banking', price: 785.30, changePct: -0.45, change: -3.55, high: 795.00, low: 780.00, open: 790.00, volume: 15000000, marketCap: '₹7.02L Cr', pe: 11.2, currency: 'INR' },
  'KOTAKBANK': { ticker: 'KOTAKBANK', name: 'Kotak Mahindra Bank', sector: 'Banking', price: 1825.80, changePct: 0.92, change: 16.70, high: 1840.00, low: 1810.00, open: 1820.00, volume: 4200000, marketCap: '₹4.58L Cr', pe: 22.4, currency: 'INR' },
  'GMRINFRA': { ticker: 'GMRINFRA', name: 'GMR Airports Infra', sector: 'Infrastructure', price: 72.45, changePct: 3.56, change: 2.50, high: 74.00, low: 70.00, open: 71.00, volume: 8500000, marketCap: '₹48K Cr', pe: 28.5, currency: 'INR' },
  'IRB': { ticker: 'IRB', name: 'IRB Infrastructure', sector: 'Infrastructure', price: 185.30, changePct: 2.18, change: 3.95, high: 188.00, low: 182.00, open: 184.00, volume: 3200000, marketCap: '₹18K Cr', pe: 24.7, currency: 'INR' },
  'NCC': { ticker: 'NCC', name: 'NCC Limited', sector: 'Infrastructure', price: 142.80, changePct: 1.89, change: 2.65, high: 145.00, low: 140.00, open: 141.00, volume: 5800000, marketCap: '₹22K Cr', pe: 18.9, currency: 'INR' },
  'SUNPHARMA': { ticker: 'SUNPHARMA', name: 'Sun Pharmaceuticals', sector: 'Healthcare', price: 1685.40, changePct: 1.45, change: 24.10, high: 1700.00, low: 1665.00, open: 1670.00, volume: 4500000, marketCap: '₹4.12L Cr', pe: 28.5, currency: 'INR' },
  'DRREDDY': { ticker: 'DRREDDY', name: "Dr. Reddy's Laboratories", sector: 'Healthcare', price: 5850.75, changePct: -0.89, change: -52.30, high: 5920.00, low: 5820.00, open: 5880.00, volume: 850000, marketCap: '₹3.85L Cr', pe: 22.4, currency: 'INR' },
  'DIVISLAB': { ticker: 'DIVISLAB', name: "Divi's Laboratories", sector: 'Healthcare', price: 5420.30, changePct: 2.12, change: 113.20, high: 5480.00, low: 5350.00, open: 5380.00, volume: 680000, marketCap: '₹3.25L Cr', pe: 35.8, currency: 'INR' },
  'CIPLA': { ticker: 'CIPLA', name: 'Cipla Ltd', sector: 'Healthcare', price: 1425.60, changePct: 1.34, change: 18.90, high: 1440.00, low: 1410.00, open: 1415.00, volume: 2800000, marketCap: '₹1.15L Cr', pe: 24.5, currency: 'INR' },
};
