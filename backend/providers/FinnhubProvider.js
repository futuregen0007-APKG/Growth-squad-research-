/**
 * FINNHUB_PROVIDER.JS
 * ====================
 * Concrete implementation of BaseProvider for Finnhub market data API.
 * 
 * ABOUT FINNHUB:
 * - Real-time stock price and company data
 * - Covers global stocks including Indian NSE/BSE
 * - REST API with rate limiting
 * - Free tier available at https://finnhub.io
 * 
 * KEY ENDPOINTS USED:
 * 1. /quote - Real-time stock quotes (price, change, etc.)
 * 2. /company-basic - Company profile and details
 * 3. /candle - Historical OHLC data
 * 
 * DOCUMENTATION: https://finnhub.io/docs/api
 */

import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';
import { API_CONFIG } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { createProviderError } from '../utils/errorHandler.js';

/**
 * FinnhubProvider - Implementation for Finnhub API
 * 
 * Extends BaseProvider and implements all required methods
 * Handles API calls, error handling, and data transformation
 */
export class FinnhubProvider extends BaseProvider {
  /**
   * Constructor - Initialize provider with API key
   * 
   * @param {string} apiKey - Finnhub API key from environment
   */
  constructor(apiKey) {
    super();
    
    if (!apiKey) {
      throw new Error('Finnhub API key is required');
    }
    
    this.apiKey = apiKey;
    this.baseUrl = API_CONFIG.FINNHUB.BASE_URL;
    this.timeout = API_CONFIG.FINNHUB.TIMEOUT;
    this.providerName = 'Finnhub';
    
    // Create axios instance with common config
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      params: {
        token: this.apiKey,  // Finnhub requires 'token' parameter
      },
    });
  }

  /**
   * getStock - Fetch real-time stock quote
   * 
   * Calls Finnhub /quote endpoint which returns:
   * - Current price
   * - Day change and % change
   * - High/Low
   * - Open price
   * - Previous close
   * - Volume
   * 
   * @param {string} symbol - Stock ticker (e.g., 'HAL')
   * @returns {object} - Standardized stock data
   * 
   * EXAMPLE API RESPONSE:
   * {
   *   "c": 4521.3,           // Current price
   *   "d": 120.5,            // Change
   *   "dp": 2.74,            // % change
   *   "h": 4580,             // High
   *   "l": 4450,             // Low
   *   "o": 4400,             // Open
   *   "pc": 4400.8,          // Previous close
   *   "t": 1234567890        // Timestamp
   * }
   * 
   * WE TRANSFORM TO:
   * {
   *   "ticker": "HAL",
   *   "price": 4521.3,
   *   "changePct": 2.74,
   *   "change": 120.5,
   *   ... (other fields)
   * }
   */
  async getStock(symbol) {
    try {
      this.validateSymbol(symbol);
      
      logger.debug(`Finnhub: Fetching stock data for ${symbol}`);
      
      // Call Finnhub /quote endpoint
      const response = await this.client.get('/quote', {
        params: { symbol },  // Add symbol as query parameter
      });

      // Check for API errors
      if (!response.data || response.data.error) {
        throw createProviderError(
          this.providerName,
          `Symbol '${symbol}' not found or API error`
        );
      }

      // Transform Finnhub response to standard format
      const formatted = this.formatStockData(response.data, symbol);
      
      logger.debug(`Finnhub: Successfully fetched ${symbol} - Price: ${formatted.price}`);
      
      return formatted;
    } catch (error) {
      if (error.response?.status === 429) {
        // 429 = Too Many Requests (rate limit)
        throw createProviderError(this.providerName, 'API rate limit exceeded');
      }
      
      if (error.message.includes('not implemented')) {
        throw error; // Re-throw app errors as-is
      }
      
      throw createProviderError(
        this.providerName,
        `Failed to fetch ${symbol}: ${error.message}`
      );
    }
  }

  /**
   * getMultipleStocks - Fetch multiple stocks efficiently
   * 
   * Instead of making N API calls, we batch them
   * Could use Finnhub batch endpoint if available
   * 
   * CURRENT: Calls getStock for each symbol sequentially
   * FUTURE: Could use Promise.all() for parallel requests
   * 
   * @param {array} symbols - ['HAL', 'BEL', 'HDFCBANK']
   * @returns {array} - Array of stock data objects
   */
  async getMultipleStocks(symbols) {
    try {
      logger.debug(`Finnhub: Fetching multiple stocks - ${symbols.join(', ')}`);
      
      // Map to array of getStock promises
      const promises = symbols.map(symbol => 
        this.getStock(symbol).catch(error => {
          // Log error but don't fail entire request
          logger.warn(`Failed to fetch ${symbol}: ${error.message}`);
          return null;
        })
      );
      
      // Wait for all requests
      const results = await Promise.all(promises);
      
      // Filter out null values (failed requests)
      return results.filter(stock => stock !== null);
    } catch (error) {
      throw createProviderError(
        this.providerName,
        `Failed to fetch multiple stocks: ${error.message}`
      );
    }
  }

  /**
   * getCompanyDetails - Fetch company profile and fundamentals
   * 
   * Calls Finnhub /company-basic endpoint which returns:
   * - Company name and description
   * - Sector and industry
   * - Market cap
   * - Website
   * - Founded year
   * 
   * @param {string} symbol - Stock ticker
   * @returns {object} - Company details
   */
  async getCompanyDetails(symbol) {
    try {
      this.validateSymbol(symbol);
      
      logger.debug(`Finnhub: Fetching company details for ${symbol}`);
      
      // Call Finnhub company endpoint
      const response = await this.client.get('/company-basic', {
        params: { symbol },
      });

      if (!response.data) {
        throw createProviderError(
          this.providerName,
          `No company data found for ${symbol}`
        );
      }

      // Transform and return
      return {
        ticker: symbol,
        name: response.data.name,
        description: response.data.description,
        sector: response.data.finnhubIndustry,
        marketCap: response.data.marketCapitalization,
        website: response.data.weburl,
        foundedYear: response.data.ipo,
      };
    } catch (error) {
      if (error.message.includes('not implemented')) {
        throw error;
      }
      
      throw createProviderError(
        this.providerName,
        `Failed to fetch company details for ${symbol}: ${error.message}`
      );
    }
  }

  /**
   * getHistoricalData - Fetch historical OHLC data
   * 
   * Calls Finnhub /candle endpoint which returns:
   * - Open, High, Low, Close prices
   * - Volume
   * - Timestamps
   * 
   * PERIODS:
   * - 1D = Daily
   * - 1W = Weekly
   * - 1M = Monthly
   * 
   * @param {string} symbol - Stock ticker
   * @param {string} period - 'D', 'W', 'M'
   * @returns {array} - Historical data points
   */
  async getHistoricalData(symbol, period = 'D') {
    try {
      this.validateSymbol(symbol);
      
      logger.debug(`Finnhub: Fetching historical data for ${symbol} (${period})`);
      
      // Finnhub candle endpoint parameters
      // 'resolution' maps to: 1 (minute), 5 (5 min), 15, 30, 60 (hourly), D (daily), W (weekly), M (monthly)
      const resolution = period === '1D' ? 'D' : period === '1W' ? 'W' : 'M';
      
      // Calculate date range (e.g., last 1 month)
      const now = Math.floor(Date.now() / 1000); // Current unix timestamp
      const monthAgo = now - 30 * 24 * 60 * 60; // 30 days ago
      
      const response = await this.client.get('/candle', {
        params: {
          symbol,
          resolution,
          from: monthAgo,
          to: now,
        },
      });

      if (!response.data.o || response.data.s === 'no_data') {
        return []; // No data available
      }

      // Transform candle data to standard format
      // Finnhub returns arrays: o[], h[], l[], c[], v[], t[]
      const data = response.data.o.map((open, i) => ({
        timestamp: response.data.t[i],
        open,
        high: response.data.h[i],
        low: response.data.l[i],
        close: response.data.c[i],
        volume: response.data.v[i],
      }));

      return data;
    } catch (error) {
      if (error.message.includes('not implemented')) {
        throw error;
      }
      
      logger.warn(`Failed to fetch historical data for ${symbol}: ${error.message}`);
      return []; // Return empty array on error
    }
  }

  /**
   * getMarketStatus - Get current market status
   * 
   * NOTE: Finnhub doesn't provide specific market status endpoint
   * We could use time-based logic or call another endpoint
   * For now, return basic market info
   * 
   * @returns {object} - Market status
   */
  async getMarketStatus() {
    try {
      logger.debug('Finnhub: Fetching market status');
      
      // Get current time and determine market status
      const now = new Date();
      const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      
      // NSE trading hours: 9:15 AM to 3:30 PM IST
      const hours = istTime.getHours();
      const minutes = istTime.getMinutes();
      const timeInMinutes = hours * 60 + minutes;
      
      const isOpen = timeInMinutes >= 9 * 60 + 15 && timeInMinutes < 15 * 60 + 30;
      
      return {
        isOpen,
        region: 'NSE / BSE',
        session: isOpen ? 'REGULAR' : 'CLOSED',
        closesAt: '15:30 IST',
        serverTime: istTime.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' }) + ' IST',
      };
    } catch (error) {
      logger.error(`Failed to get market status: ${error.message}`);
      
      // Return safe default
      return {
        isOpen: false,
        region: 'NSE / BSE',
        session: 'UNKNOWN',
        closesAt: '15:30 IST',
        serverTime: new Date().toISOString(),
      };
    }
  }

  /**
   * formatStockData - Transform Finnhub response to standard format
   * 
   * FINNHUB RESPONSE:
   * { c: 4521.3, d: 120.5, dp: 2.74, h: 4580, l: 4450, o: 4400, pc: 4400.8, t: 1234567890 }
   * 
   * OUR FORMAT:
   * { ticker, name, price, changePct, change, high, low, open, ... }
   * 
   * KEY MAPPINGS:
   * c (current) → price
   * dp (change percent) → changePct
   * d (change) → change
   * h (high) → high
   * l (low) → low
   * o (open) → open
   * 
   * @param {object} data - Finnhub quote response
   * @param {string} symbol - Stock ticker
   * @returns {object} - Standardized stock data
   */
  formatStockData(data, symbol) {
    return {
      ticker: symbol,
      name: symbol, // Finnhub quote endpoint doesn't include name, can fetch separately
      price: data.c || 0,
      changePct: data.dp || 0,
      change: data.d || 0,
      high: data.h || 0,
      low: data.l || 0,
      open: data.o || 0,
      previousClose: data.pc || 0,
      volume: data.v || 0,
      currency: 'INR',
      lastUpdate: (data.t || Math.floor(Date.now() / 1000)) * 1000, // Convert to milliseconds
    };
  }
}
