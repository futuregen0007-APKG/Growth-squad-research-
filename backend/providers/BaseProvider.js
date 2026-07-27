/**
 * BASE_PROVIDER.JS
 * =================
 * Abstract interface (base class) that all market data providers must implement.
 * 
 * WHY THIS ARCHITECTURE:
 * ─────────────────────
 * Instead of tightly coupling code to Finnhub API, we define what methods any
 * market data provider MUST have. This allows:
 * 
 * 1. PROVIDER SWITCHING - Change from Finnhub to Twelve Data by changing 1 line
 * 2. TESTING - Use mock providers without hitting real APIs
 * 3. SCALABILITY - Add new providers without changing service code
 * 4. CONSISTENCY - All providers return same data format
 * 
 * ANALOGY:
 * Think of this like a contract. Any provider must implement these methods.
 * It's like saying "all restaurants must have a menu, kitchen, and checkout".
 * 
 * CONCRETE IMPLEMENTATIONS:
 * - FinnhubProvider
 * - TwelveDataProvider (future)
 * - ZerodhaProvider (future)
 * - UpstoxProvider (future)
 * 
 * PATTERN: "Strategy Pattern" from design patterns
 */

/**
 * BaseProvider - Abstract base class (interface)
 * 
 * All market data providers must extend this class and implement
 * all abstract methods.
 * 
 * Throws error if subclass doesn't implement a method.
 */
export class BaseProvider {
  /**
   * Abstract method: getStock
   * 
   * Every provider must implement this to fetch stock data
   * 
   * @param {string} symbol - Stock ticker (e.g., 'HAL', 'HDFCBANK')
   * @returns {object} - Stock data object with standard fields
   * @throws {Error} - If provider returns error or symbol not found
   * 
   * RETURN FORMAT (standardized across all providers):
   * {
   *   ticker: 'HAL',
   *   name: 'Hindustan Aeronautics',
   *   price: 4521.30,
   *   changePct: 2.84,
   *   change: 120.50,
   *   high: 4580.00,
   *   low: 4450.00,
   *   open: 4450.00,
   *   volume: 5000000,
   *   currency: 'INR',
   *   lastUpdate: 1234567890
   * }
   * 
   * EXAMPLE:
   * const finnhub = new FinnhubProvider();
   * const stockData = await finnhub.getStock('HAL');
   */
  async getStock(symbol) {
    throw new Error(`getStock(${symbol}) not implemented in ${this.constructor.name}`);
  }

  /**
   * Abstract method: getMultipleStocks
   * 
   * Fetch multiple stocks at once (more efficient than individual calls)
   * 
   * @param {array} symbols - Array of stock tickers ['HAL', 'BEL', 'HDFCBANK']
   * @returns {array} - Array of stock data objects
   * @throws {Error} - If any call fails
   * 
   * EXAMPLE:
   * const stocks = await finnhub.getMultipleStocks(['HAL', 'BEL']);
   * // Returns: [{...}, {...}]
   */
  async getMultipleStocks(symbols) {
    throw new Error(
      `getMultipleStocks(${symbols.join(',')}) not implemented in ${this.constructor.name}`
    );
  }

  /**
   * Abstract method: getCompanyDetails
   * 
   * Fetch detailed company information (fundamentals, description, etc.)
   * 
   * @param {string} symbol - Stock ticker
   * @returns {object} - Company details
   * @throws {Error}
   * 
   * RETURN FORMAT:
   * {
   *   ticker: 'HAL',
   *   name: 'Hindustan Aeronautics',
   *   description: 'Manufacturer of aircraft and aerospace products...',
   *   sector: 'Defence',
   *   marketCap: 30200000000,
   *   pe: 32.1,
   *   eps: 140.94,
   *   dividend: 45.50,
   *   website: 'https://hal.co.in',
   *   foundedYear: 1940
   * }
   */
  async getCompanyDetails(symbol) {
    throw new Error(`getCompanyDetails(${symbol}) not implemented in ${this.constructor.name}`);
  }

  /**
   * Abstract method: getHistoricalData
   * 
   * Fetch historical price data (for charts)
   * 
   * @param {string} symbol - Stock ticker
   * @param {string} period - Time period ('1D', '1W', '1M', '3M', '1Y')
   * @returns {array} - Array of OHLCV data points
   * @throws {Error}
   * 
   * RETURN FORMAT (OHLCV = Open, High, Low, Close, Volume):
   * [
   *   { timestamp: 1234567890, open: 4450, high: 4580, low: 4440, close: 4521, volume: 5000000 },
   *   { timestamp: 1234654290, open: 4520, high: 4560, low: 4500, close: 4545, volume: 4500000 },
   *   ...
   * ]
   */
  async getHistoricalData(symbol, period) {
    throw new Error(
      `getHistoricalData(${symbol}, ${period}) not implemented in ${this.constructor.name}`
    );
  }

  /**
   * Abstract method: getMarketStatus
   * 
   * Get current market status (open/closed, session type, etc.)
   * 
   * @returns {object} - Market status
   * @throws {Error}
   * 
   * RETURN FORMAT:
   * {
   *   isOpen: true,
   *   region: 'NSE',
   *   session: 'REGULAR',
   *   closesAt: '15:30 IST',
   *   serverTime: '13:45:30 IST'
   * }
   */
  async getMarketStatus() {
    throw new Error(`getMarketStatus() not implemented in ${this.constructor.name}`);
  }

  /**
   * Helper: formatStockData
   * 
   * Base class provides common formatting logic
   * Subclasses can override if needed
   * 
   * @param {object} rawData - Raw data from API
   * @returns {object} - Formatted stock data
   */
  formatStockData(rawData) {
    throw new Error(`formatStockData() not implemented in ${this.constructor.name}`);
  }

  /**
   * Helper: validateSymbol
   * 
   * Check if symbol is valid (implemented by subclass if needed)
   */
  validateSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') {
      throw new Error('Symbol must be a non-empty string');
    }
    return true;
  }
}
