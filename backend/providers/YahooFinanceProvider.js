import YahooFinance from 'yahoo-finance2';
import { BaseProvider } from './BaseProvider.js';
import { logger } from '../utils/logger.js';
import { createProviderError } from '../utils/errorHandler.js';

export class YahooFinanceProvider extends BaseProvider {
  constructor() {
    super();
    this.client = new YahooFinance();
    this.providerName = 'Yahoo Finance';
    this.maxBatchSize = 5;
    this.maxRetries = 3;
    this.retryBaseDelay = 1000;
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

  async _quoteWithRetry(symbols) {
    const query = Array.isArray(symbols) ? symbols : [symbols];
    const retryableSymbols = query.map((symbol) => this.normalizeSymbol(symbol));

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const quoteResponse = await this.client.quote(retryableSymbols);
        const entries = Array.isArray(quoteResponse) ? quoteResponse : Object.values(quoteResponse || {});
        logger.info(`Yahoo Finance: request successful for ${retryableSymbols.length} symbols`);
        return entries;
      } catch (error) {
        const message = error?.message || '';
        const isRateLimited = message.includes('429') || message.includes('Too Many Requests') || error?.status === 429 || /status 429/i.test(message);

        if (isRateLimited && attempt < this.maxRetries) {
          const delayMs = this.retryBaseDelay * (2 ** attempt);
          logger.warn(`Yahoo Finance: 429 received, retrying in ${delayMs / 1000} second(s)`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        if (isRateLimited) {
          logger.warn(`Yahoo Finance: 429 received after max retries for ${retryableSymbols.length} symbols`);
          return [];
        }

        throw new Error(message || 'Yahoo Finance quote request failed');
      }
    }

    return [];
  }

  async getCurrentQuote(symbol) {
    const providerSymbol = this.normalizeSymbol(symbol);
    logger.debug(`Yahoo Finance: Fetching quote for ${providerSymbol}`);
    const quotes = await this._quoteWithRetry([providerSymbol]);
    return quotes[0] || null;
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
    const uniqueSymbols = [...new Set((symbols || []).map((symbol) => String(symbol || '').trim()).filter(Boolean))];

    if (!uniqueSymbols.length) {
      return [];
    }

    const normalizedSymbols = uniqueSymbols.map((symbol) => this.normalizeSymbol(symbol));
    const results = [];
    const failedSymbols = [];

    for (let index = 0; index < normalizedSymbols.length; index += this.maxBatchSize) {
      const batch = normalizedSymbols.slice(index, index + this.maxBatchSize);
      logger.info(`Yahoo Finance: requesting ${batch.length} symbols in one batch`);

      try {
        const quoteResults = await this._quoteWithRetry(batch);
        if (!quoteResults.length) {
          failedSymbols.push(...batch.map((symbol) => symbol.replace(/\.NS$/, '')));
          continue;
        }

        for (const quote of quoteResults) {
          if (!quote || !quote.symbol) {
            continue;
          }

          const normalizedTicker = String(quote.symbol || '').replace(/\.NS$/i, '').toUpperCase();
          const originalSymbol = uniqueSymbols.find((symbol) => this.normalizeSymbol(symbol) === quote.symbol || this.normalizeSymbol(symbol) === String(quote.symbol || '').toUpperCase()) || normalizedTicker;
          const formatted = this.formatStockData(quote, originalSymbol || normalizedTicker);
          results.push(formatted);
        }
      } catch (error) {
        logger.warn(`Yahoo Finance: 2 symbols failed - ${error.message}`);
        failedSymbols.push(...batch.map((symbol) => symbol.replace(/\.NS$/, '')));
      }
    }

    logger.info(`Yahoo Finance: ${results.length} symbols returned`);
    if (failedSymbols.length) {
      logger.warn(`Yahoo Finance: ${failedSymbols.length} symbols failed`);
    }

    return results;
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
