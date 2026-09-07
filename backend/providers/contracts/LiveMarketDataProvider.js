/**
 * LiveMarketDataProvider - documented contract for live/tradeable market
 * data (quotes, index quotes, market session status, historical candles).
 *
 * This is NOT a new base class that AngelOneProvider must extend today —
 * AngelOneProvider already implements this role via BaseProvider
 * (getStock/getMultipleStocks/getHistoricalData/getMarketStatus) and is
 * left untouched per the "don't replace working Angel One" requirement.
 * This file exists so the *role* is named and documented the same way
 * CompanyResearchProvider is, and so a future GlobalDatafeedsProvider has
 * a single contract to implement for the market-data half of the registry.
 *
 * ProviderRegistry maps MARKET_DATA_PROVIDER to any object satisfying this
 * shape: getStock(symbol), getMultipleStocks(symbols), getHistoricalData
 * (symbol, period, interval?), getMarketStatus(). AngelOneProvider already
 * satisfies it as-is; no changes to that file are required.
 */
export class LiveMarketDataProvider {
  get providerName() {
    throw new Error(`${this.constructor.name} must implement providerName`);
  }

  async getStock(symbol) {
    throw new Error(`getStock(${symbol}) not implemented in ${this.constructor.name}`);
  }

  async getMultipleStocks(symbols) {
    throw new Error(`getMultipleStocks not implemented in ${this.constructor.name}`);
  }

  async getHistoricalData(symbol, period, interval) {
    throw new Error(`getHistoricalData(${symbol}) not implemented in ${this.constructor.name}`);
  }

  async getMarketStatus() {
    throw new Error(`getMarketStatus() not implemented in ${this.constructor.name}`);
  }
}

export default LiveMarketDataProvider;
