import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';
import { API_CONFIG } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { createProviderError } from '../utils/errorHandler.js';

export class TwelveDataProvider extends BaseProvider {
  constructor(apiKey) {
    super();

    if (!apiKey) {
      throw new Error('Twelve Data API key is required');
    }

    this.apiKey = apiKey;
    this.baseUrl = API_CONFIG.TWELVE_DATA.BASE_URL;
    this.timeout = API_CONFIG.TWELVE_DATA.TIMEOUT;
    this.providerName = 'Twelve Data';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      params: {
        apikey: this.apiKey,
      },
    });
  }

  validateSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
      throw new Error('Symbol must be a non-empty string');
    }
    return true;
  }

  _toProviderSymbol(symbol) {
    const normalized = symbol.trim().toUpperCase();
    if (normalized.includes(':')) {
      return normalized;
    }

    // Default to NSE for Indian stocks
    return `NSE:${normalized}`;
  }

  async getStock(symbol) {
    try {
      this.validateSymbol(symbol);

      const providerSymbol = this._toProviderSymbol(symbol);
      logger.debug(`Twelve Data: Fetching stock quote for ${providerSymbol}`);

      const response = await this.client.get('/quote', {
        params: { symbol: providerSymbol },
      });

      if (!response.data || response.data.status === 'error') {
        throw createProviderError(
          this.providerName,
          response.data?.message || `Symbol '${providerSymbol}' not found or API error`
        );
      }

      const formatted = this.formatStockData(response.data, symbol);
      logger.debug(`Twelve Data: Successfully fetched ${providerSymbol} - Price: ${formatted.price}`);

      return formatted;
    } catch (error) {
      if (error.response?.status === 429) {
        throw createProviderError(this.providerName, 'API rate limit exceeded');
      }
      if (error.message.includes('not implemented')) {
        throw error;
      }
      throw createProviderError(
        this.providerName,
        `Failed to fetch ${symbol}: ${error.message}`
      );
    }
  }

  async getMultipleStocks(symbols) {
    try {
      const promises = symbols.map((symbol) =>
        this.getStock(symbol).catch((error) => {
          logger.warn(`Failed to fetch ${symbol}: ${error.message}`);
          return null;
        })
      );

      const results = await Promise.all(promises);
      return results.filter((stock) => stock !== null);
    } catch (error) {
      throw createProviderError(
        this.providerName,
        `Failed to fetch multiple stocks: ${error.message}`
      );
    }
  }

  async getCompanyDetails(symbol) {
    try {
      this.validateSymbol(symbol);
      const providerSymbol = this._toProviderSymbol(symbol);

      logger.debug(`Twelve Data: Fetching company details for ${providerSymbol}`);
      const response = await this.client.get('/company', {
        params: { symbol: providerSymbol },
      });

      if (!response.data || response.data.status === 'error') {
        throw createProviderError(
          this.providerName,
          response.data?.message || `No company data found for ${providerSymbol}`
        );
      }

      return {
        ticker: symbol.toUpperCase(),
        name: response.data.name || symbol.toUpperCase(),
        description: response.data.description || null,
        sector: response.data.industry || null,
        marketCap: response.data.market_cap || null,
        website: response.data.website || null,
        foundedYear: response.data.founded || null,
      };
    } catch (error) {
      if (error.message.includes('not implemented')) {
        throw error;
      }
      logger.warn(`Twelve Data: Company details fallback for ${symbol}: ${error.message}`);
      return {
        ticker: symbol.toUpperCase(),
        name: symbol.toUpperCase(),
        description: null,
        sector: null,
        marketCap: null,
        website: null,
        foundedYear: null,
      };
    }
  }

  async getHistoricalData(symbol, period = 'D') {
    try {
      this.validateSymbol(symbol);
      const providerSymbol = this._toProviderSymbol(symbol);
      const interval = period === '1W' ? '1week' : period === '1M' ? '1month' : '1day';
      const outputsize = period === '1M' ? 60 : 30;

      logger.debug(`Twelve Data: Fetching historical data for ${providerSymbol} (${interval})`);
      const response = await this.client.get('/time_series', {
        params: {
          symbol: providerSymbol,
          interval,
          outputsize,
          format: 'JSON',
        },
      });

      if (!response.data || response.data.status === 'error' || !Array.isArray(response.data.values)) {
        return [];
      }

      const values = response.data.values
        .map((item) => ({
          timestamp: new Date(item.datetime).getTime(),
          open: parseFloat(item.open) || 0,
          high: parseFloat(item.high) || 0,
          low: parseFloat(item.low) || 0,
          close: parseFloat(item.close) || 0,
          volume: parseInt(item.volume, 10) || 0,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

      return values;
    } catch (error) {
      if (error.message.includes('not implemented')) {
        throw error;
      }
      logger.warn(`Twelve Data: Failed to fetch historical data for ${symbol}: ${error.message}`);
      return [];
    }
  }

  async getMarketStatus() {
    try {
      const now = new Date();
      const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
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
      logger.error(`Twelve Data: Failed to get market status: ${error.message}`);
      return {
        isOpen: false,
        region: 'NSE / BSE',
        session: 'UNKNOWN',
        closesAt: '15:30 IST',
        serverTime: new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' }) + ' IST',
      };
    }
  }

  formatStockData(data, symbol) {
    return {
      ticker: symbol.toUpperCase(),
      name: data.name || symbol.toUpperCase(),
      price: parseFloat(data.close) || 0,
      changePct: parseFloat(data.percent_change) || 0,
      change: parseFloat(data.change) || 0,
      high: parseFloat(data.high) || 0,
      low: parseFloat(data.low) || 0,
      open: parseFloat(data.open) || 0,
      volume: parseInt(data.volume, 10) || 0,
      currency: data.currency || 'INR',
      lastUpdate: data.datetime ? new Date(data.datetime).getTime() : Date.now(),
    };
  }
}
