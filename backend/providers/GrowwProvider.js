import axios from 'axios';
import { BaseProvider } from './BaseProvider.js';
import { API_CONFIG, SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { createProviderError } from '../utils/errorHandler.js';

export class GrowwProvider extends BaseProvider {
  constructor(apiKey, apiSecret) {
    super();

    if (!apiKey || !apiSecret) {
      throw new Error('Groww API key and secret are required');
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = API_CONFIG.GROWW.BASE_URL;
    this.timeout = API_CONFIG.GROWW.TIMEOUT;
    this.providerName = 'Groww';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'X-API-VERSION': '1.0',
        'Accept': 'application/json',
      },
    });
  }

  async getStock(symbol) {
    try {
      this.validateSymbol(symbol);
      const providerSymbol = String(symbol).trim().toUpperCase();

      logger.debug(`Groww: Fetching quote for ${providerSymbol}`);

      const resp = await this.client.get('/v1/live-data/quote', {
        params: {
          exchange: 'NSE',
          segment: 'CASH',
          trading_symbol: providerSymbol,
        },
      });

      if (!resp.data) {
        throw createProviderError(this.providerName, `No quote data for ${providerSymbol}`);
      }

      const data = resp.data?.payload || resp.data;

      const formatted = {
        ticker: providerSymbol,
        name: data.name || data.companyName || SUPPORTED_STOCKS[providerSymbol]?.name || providerSymbol,
        price: Number(data.last_price ?? data.lastPrice ?? data.price ?? 0),
        change: Number(data.day_change ?? data.change ?? 0),
        changePct: Number(data.day_change_perc ?? data.changePercent ?? data.changePct ?? 0),
        high: Number(data.ohlc?.high ?? data.high ?? 0),
        low: Number(data.ohlc?.low ?? data.low ?? 0),
        open: Number(data.ohlc?.open ?? data.open ?? 0),
        previousClose: Number(data.ohlc?.close ?? data.previousClose ?? 0),
        volume: Number(data.volume ?? 0),
        currency: data.currency || 'INR',
        lastUpdate: data.last_trade_time ? Number(data.last_trade_time) : Date.now(),
      };

      return formatted;
    } catch (error) {
      if (error.response?.status === 429) {
        throw createProviderError(this.providerName, 'API rate limit exceeded');
      }
      if (error.response?.status === 403) {
        throw createProviderError(
          this.providerName,
          `Access Forbidden (403). Please verify that your IP is whitelisted on Groww, and the key is active.`
        );
      }
      throw createProviderError(this.providerName, `Failed to fetch ${symbol}: ${error.message}`);
    }
  }

  async search(query) {
    try {
      if (!query || typeof query !== 'string') return null;

      logger.debug(`Groww: Searching locally for '${query}'`);

      const cleanQuery = query.trim().toLowerCase();

      // Look up in SUPPORTED_STOCKS first
      for (const [ticker, info] of Object.entries(SUPPORTED_STOCKS)) {
        if (ticker.toLowerCase() === cleanQuery || info.name.toLowerCase().includes(cleanQuery)) {
          return { ticker, name: info.name };
        }
      }

      // Fallback to query
      return { ticker: query.toUpperCase(), name: query.toUpperCase() };
    } catch (error) {
      logger.warn(`Groww search failed for '${query}': ${error.message}`);
      return null;
    }
  }
}

