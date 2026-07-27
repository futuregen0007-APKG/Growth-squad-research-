import YahooFinance from 'yahoo-finance2';
import { createProviderError } from '../utils/errorHandler.js';

export class YahooFinanceService {
  constructor() {
    this.client = new YahooFinance();
    this.providerName = 'Yahoo Finance';
  }

  async fetchQuote(symbol) {
    if (!symbol || typeof symbol !== 'string') {
      throw new Error('Symbol is required');
    }

    const normalizedSymbol = symbol.trim().toUpperCase();

    try {
      const quote = await this.client.quote(normalizedSymbol);
      if (!quote) {
        throw new Error(`No quote data returned for ${normalizedSymbol}`);
      }
      return this.normalizeQuote(quote);
    } catch (error) {
      throw createProviderError(
        this.providerName,
        error?.message || `Failed to fetch ${symbol}`
      );
    }
  }

  normalizeQuote(quote) {
    const price = quote.regularMarketPrice ?? quote.postMarketPrice ?? quote.preMarketPrice ?? 0;
    const open = quote.regularMarketOpen ?? quote.open ?? 0;
    const high = quote.regularMarketDayHigh ?? quote.dayHigh ?? 0;
    const low = quote.regularMarketDayLow ?? quote.dayLow ?? 0;
    const previousClose = quote.regularMarketPreviousClose ?? quote.previousClose ?? 0;
    const volume = quote.regularMarketVolume ?? quote.volume ?? 0;
    const change = quote.regularMarketChange ?? quote.change ?? 0;
    const percentage = quote.regularMarketChangePercent ?? quote.changePercent ?? 0;
    const timestamp = quote.regularMarketTime
      ? new Date(quote.regularMarketTime * 1000).toISOString()
      : new Date().toISOString();

    return {
      symbol: quote.symbol,
      companyName: quote.shortName || quote.longName || quote.symbol,
      price,
      open,
      high,
      low,
      previousClose,
      volume,
      change,
      percentage,
      timestamp,
      ticker: quote.symbol,
      name: quote.shortName || quote.longName || quote.symbol,
      marketCap: quote.marketCap ?? null,
      pe: quote.trailingPE ?? null,
    };
  }
}
