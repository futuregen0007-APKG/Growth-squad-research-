import YahooFinance from 'yahoo-finance2';
import { BaseProvider } from './BaseProvider.js';
import { logger } from '../utils/logger.js';
import { createProviderError } from '../utils/errorHandler.js';

export class YahooFinanceProvider extends BaseProvider {
  constructor() {
    super();
    this.client = new YahooFinance();
    this.providerName = 'Yahoo Finance';
  }

  normalizeSymbol(symbol) {
    const value = String(symbol || '').trim();
    if (!value) {
      throw new Error('Symbol is required');
    }

    const upper = value.toUpperCase();

    if (upper === 'USDINR' || upper === 'USD/INR' || upper === 'USDINR=X') {
      return 'USDINR=X';
    }

    if (upper.includes('^') || upper.includes('=') || upper.includes(':') || upper.includes('.')) {
      return upper;
    }

    return `${upper}.NS`;
  }

  getCurrentQuote(symbol) {
    const providerSymbol = this.normalizeSymbol(symbol);
    logger.debug(`Yahoo Finance: Fetching quote for ${providerSymbol}`);
    return this.client.quote(providerSymbol);
  }

  async getStock(symbol) {
    try {
      this.validateSymbol(symbol);
      const providerSymbol = this.normalizeSymbol(symbol);
      const quote = await this.getCurrentQuote(providerSymbol);

      if (!quote) {
        throw createProviderError(this.providerName, `No quote data returned for ${symbol}`);
      }

      const formatted = this.formatStockData(quote, symbol);
      logger.debug(`Yahoo Finance: Successfully fetched ${providerSymbol} - Price: ${formatted.price}`);
      return formatted;
    } catch (error) {
      if (error.message?.includes('not implemented')) {
        throw error;
      }
      throw createProviderError(
        this.providerName,
        `Failed to fetch ${symbol}: ${error.message || 'Unknown error'}`
      );
    }
  }

  async getMultipleStocks(symbols) {
    const results = await Promise.all(
      symbols.map((symbol) =>
        this.getStock(symbol).catch((error) => {
          logger.warn(`Yahoo Finance: Failed to fetch ${symbol}: ${error.message}`);
          return null;
        })
      )
    );

    return results.filter(Boolean);
  }

  async getCompanyDetails(symbol) {
    try {
      this.validateSymbol(symbol);
      const quote = await this.getCurrentQuote(symbol);

      return {
        ticker: symbol.toUpperCase(),
        name: quote?.shortName || quote?.longName || symbol.toUpperCase(),
        description: null,
        sector: null,
        marketCap: quote?.marketCap || null,
        website: null,
        foundedYear: null,
      };
    } catch (error) {
      logger.warn(`Yahoo Finance: Company details unavailable for ${symbol}: ${error.message}`);
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

  async getHistoricalData(symbol, period = '1D') {
    try {
      this.validateSymbol(symbol);
      const normalizedSymbol = this.normalizeSymbol(symbol);
      const rangeMap = {
        '1D': '1d',
        '1W': '5d',
        '1M': '1mo',
        '3M': '3mo',
        '1Y': '1y',
        '5Y': '5y',
      };

      const range = rangeMap[period] || '1mo';
      const chart = await this.client.chart(normalizedSymbol, {
        range,
        interval: period === '1D' ? '1m' : '1d',
      });

      const quotes = Array.isArray(chart?.quotes) ? chart.quotes : [];
      return quotes
        .filter((item) => item && item.close != null)
        .map((item) => ({
          timestamp: item.date ? new Date(item.date).getTime() : Date.now(),
          open: Number(item.open) || 0,
          high: Number(item.high) || 0,
          low: Number(item.low) || 0,
          close: Number(item.close) || 0,
          volume: Number(item.volume) || 0,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
      logger.warn(`Yahoo Finance: Historical data unavailable for ${symbol}: ${error.message}`);
      return [];
    }
  }

  async getMarketStatus() {
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
  }

  formatStockData(data, symbol) {
    const price = Number(data.regularMarketPrice ?? data.price ?? 0);
    const change = Number(data.regularMarketChange ?? data.change ?? 0);
    const changePct = Number(data.regularMarketChangePercent ?? data.changePercent ?? 0);
    const previousClose = Number(data.regularMarketPreviousClose ?? data.previousClose ?? 0);
    const open = Number(data.regularMarketOpen ?? data.open ?? 0);
    const high = Number(data.regularMarketDayHigh ?? data.dayHigh ?? 0);
    const low = Number(data.regularMarketDayLow ?? data.dayLow ?? 0);
    const volume = Number(data.regularMarketVolume ?? data.volume ?? 0);
    const timestamp = data.regularMarketTime ? new Date(data.regularMarketTime * 1000).toISOString() : new Date().toISOString();

    return {
      ticker: symbol.toUpperCase(),
      name: data.shortName || data.longName || symbol.toUpperCase(),
      price,
      change,
      changePct,
      high,
      low,
      open,
      previousClose,
      volume,
      currency: data.currency || 'INR',
      lastUpdate: data.regularMarketTime ? data.regularMarketTime * 1000 : Date.now(),
      companyName: data.shortName || data.longName || symbol.toUpperCase(),
      timestamp,
      marketCap: data.marketCap ?? null,
      pe: data.trailingPE ?? null,
    };
  }
}
