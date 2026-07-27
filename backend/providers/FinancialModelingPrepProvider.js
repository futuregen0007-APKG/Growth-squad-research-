import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';
import { API_CONFIG } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { createProviderError } from '../utils/errorHandler.js';

export class FinancialModelingPrepProvider extends BaseProvider {
  constructor(apiKey) {
    super();

    if (!apiKey) {
      throw new Error('Financial Modeling Prep API key is required');
    }

    this.apiKey = apiKey;
    this.baseUrl = API_CONFIG.FINANCIAL_MODELING_PREP.BASE_URL;
    this.timeout = API_CONFIG.FINANCIAL_MODELING_PREP.TIMEOUT;
    this.providerName = 'FinancialModelingPrep';

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

    if (normalized.includes('.') || normalized.includes(':')) {
      return normalized;
    }

    return `${normalized}.NS`;
  }

  async getStock(symbol) {
    try {
      this.validateSymbol(symbol);

      const providerSymbol = this._toProviderSymbol(symbol);

      logger.debug(`FinancialModelingPrep: Fetching stock quote for ${providerSymbol}`);
      const response = await this.client.get(`/quote/${providerSymbol}`);

      const quote = Array.isArray(response.data) ? response.data[0] : null;
      if (!quote) {
        throw createProviderError(
          this.providerName,
          `Symbol '${providerSymbol}' not found or API returned no quote`
        );
      }

      return this.formatStockData(quote, symbol);
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

      logger.debug(`FinancialModelingPrep: Fetching company details for ${providerSymbol}`);
      const response = await this.client.get(`/profile/${providerSymbol}`);
      const profile = Array.isArray(response.data) ? response.data[0] : null;

      if (!profile) {
        throw createProviderError(
          this.providerName,
          `No company profile found for ${providerSymbol}`
        );
      }

      return {
        ticker: symbol.toUpperCase(),
        name: profile.companyName || profile.name || symbol.toUpperCase(),
        description: profile.description || null,
        sector: profile.sector || null,
        marketCap: profile.mktCap || profile.marketCap || null,
        website: profile.website || null,
        foundedYear: profile.ipoDate ? new Date(profile.ipoDate).getFullYear() : null,
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

  async getHistoricalData(symbol, period = 'D') {
    try {
      this.validateSymbol(symbol);
      const providerSymbol = this._toProviderSymbol(symbol);
      const timeseries = period === '1M' ? 30 : 7;

      logger.debug(`FinancialModelingPrep: Fetching historical data for ${providerSymbol}`);
      const response = await this.client.get(`/historical-price-full/${providerSymbol}`, {
        params: { timeseries },
      });

      const historical = response.data?.historical || [];
      return historical.map((item) => ({
        timestamp: new Date(item.date).getTime(),
        open: parseFloat(item.open) || 0,
        high: parseFloat(item.high) || 0,
        low: parseFloat(item.low) || 0,
        close: parseFloat(item.close) || 0,
        volume: parseInt(item.volume, 10) || 0,
      })).reverse();
    } catch (error) {
      logger.warn(`FinancialModelingPrep: Failed to fetch historical data for ${symbol}: ${error.message}`);
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
      logger.error(`FinancialModelingPrep: Failed to get market status: ${error.message}`);
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
      price: parseFloat(data.price) || 0,
      changePct: parseFloat(String(data.changesPercentage || data.changePercent || '0').replace('%', '')) || 0,
      change: parseFloat(data.change) || 0,
      high: parseFloat(data.dayHigh) || 0,
      low: parseFloat(data.dayLow) || 0,
      open: parseFloat(data.open) || 0,
      volume: parseInt(data.volume, 10) || 0,
      currency: data.currency || 'INR',
      lastUpdate: data.timestamp ? data.timestamp * 1000 : Date.now(),
    };
  }
}
