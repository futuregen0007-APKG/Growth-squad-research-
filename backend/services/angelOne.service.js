import { AngelOneProvider } from '../providers/AngelOneProvider.js';

export class AngelOneService {
  constructor(provider = null) {
    this.provider = provider;
  }

  getProvider() {
    if (!this.provider) {
      this.provider = new AngelOneProvider();
    }
    return this.provider;
  }

  async fetchQuote(symbol) {
    const quote = await this.getProvider().getStock(symbol);
    return {
      symbol: quote.ticker,
      companyName: quote.companyName,
      price: quote.price,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previousClose: quote.previousClose,
      volume: quote.volume,
      change: quote.change,
      percentage: quote.changePct,
      timestamp: quote.timestamp,
      exchange: quote.exchange,
      symbolToken: quote.symbolToken,
    };
  }
}