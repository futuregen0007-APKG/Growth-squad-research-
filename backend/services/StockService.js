/**
 * STOCK_SERVICE.JS
 * =================
 * Core business logic for stock data retrieval and management.
 * 
 * RESPONSIBILITIES:
 * 1. Coordinates between providers and cache
 * 2. Implements caching strategy (check cache first → fetch if miss)
 * 3. Transforms data into frontend-ready format
 * 4. Handles multi-stock operations
 * 5. Validates input and manages errors
 * 
 * ARCHITECTURE FLOW:
 * Controller → StockService → Cache (hit) OR Provider (miss) → Cache (store) → return
 * 
 * EXAMPLE:
 * const service = new StockService(finnhubProvider);
 * const stock = await service.getStock('HAL'); // Auto-caches for 5 min
 */

import { getCache, setCache, deleteCache } from '../utils/redisClient.js';
import { CACHE_TTL, SUPPORTED_STOCKS, INDEX_SYMBOLS, HISTORY_RANGES, HISTORY_INTERVALS, DEFAULT_INTERVAL_BY_RANGE } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import {
  createNotFoundError,
  createInvalidInputError,
  createProviderError,
  AppError,
} from '../utils/errorHandler.js';
import { calculateDeterministicMetrics } from '../utils/historicalMetrics.js';

// '1W' exists only for the internal SectorRotationService caller — not a
// range a client should be able to request via the public history endpoint.
const PUBLIC_HISTORY_RANGES = HISTORY_RANGES.filter((range) => range !== '1W');

export class StockService {
  /**
   * Constructor - Initialize service with provider
   * 
   * @param {BaseProvider} provider - Market data provider instance
   * 
   * The service doesn't care if it's Finnhub, Twelve Data, or mock provider
   * As long as it implements BaseProvider interface, it works.
   * 
   * EXAMPLE:
   * const finnhubProvider = new FinnhubProvider(apiKey);
   * const service = new StockService(finnhubProvider);
   */
  constructor(provider) {
    if (!provider) {
      throw new Error('Provider is required');
    }
    
    this.provider = provider;
    this.logger = logger;
    this.inFlightRequests = new Map();
  }

  /**
   * getStock - Get single stock with automatic caching
   * 
   * FLOW:
   * 1. Validate symbol
   * 2. Check Redis cache
   *    → If found: Return cached data (fast!)
   *    → If not: Continue to step 3
   * 3. Fetch from provider
   * 4. Store in cache with TTL
   * 5. Return data
   * 
   * @param {string} symbol - Stock ticker (e.g., 'HAL')
   * @returns {object} - Stock data with prices, changes, etc.
   * @throws {AppError} - If symbol invalid or fetch fails
   * 
   * CACHE KEY FORMAT: "stock:{SYMBOL}" (e.g., "stock:HAL")
   * CACHE TTL: 5 minutes (configured in .env)
   * 
   * EXAMPLE:
   * const stock = await service.getStock('HAL');
   * // Returns: { ticker: 'HAL', price: 4521.3, changePct: 2.84, ... }
   */
  async getStock(symbol) {
    try {
      const validatedSymbol = await this._validateSymbol(symbol);
      const cacheKey = `stock:${validatedSymbol}`;

      if (this.inFlightRequests.has(cacheKey)) {
        this.logger.debug(`Stock service deduplicating request for ${validatedSymbol}`);
        return await this.inFlightRequests.get(cacheKey);
      }

      const cachedData = await getCache(cacheKey);
      if (cachedData) {
        this.logger.debug(`Stock service cache HIT for ${validatedSymbol}`);
        return cachedData;
      }

      const requestPromise = (async () => {
        this.logger.debug(`Stock service cache MISS for ${validatedSymbol} - fetching from provider`);
        const stockData = await this.provider.getStock(validatedSymbol);
        const enrichedData = this._enrichStockData(stockData);
        await setCache(cacheKey, enrichedData, CACHE_TTL.STOCK_PRICE);
        return enrichedData;
      })();

      this.inFlightRequests.set(cacheKey, requestPromise);

      try {
        return await requestPromise;
      } finally {
        this.inFlightRequests.delete(cacheKey);
      }
    } catch (error) {
      this.logger.error(`Error in getStock(${symbol}): ${error.message}`);
      throw error;
    }
  }

  /**
   * getMultipleStocks - Get multiple stocks efficiently
   * 
   * OPTIMIZATION:
   * - Checks cache for each stock first
   * - Only fetches missing stocks from provider (batch request if supported)
   * - Caches each result individually
   * 
   * @param {array} symbols - ['HAL', 'BEL', 'HDFCBANK']
   * @returns {array} - Array of stock data
   * @throws {AppError}
   * 
   * EXAMPLE:
   * const stocks = await service.getMultipleStocks(['HAL', 'BEL', 'HDFCBANK']);
   * // Returns: [{...}, {...}, {...}]
   */
  async getMultipleStocks(symbols) {
    try {
      if (!Array.isArray(symbols) || symbols.length === 0) {
        throw createInvalidInputError('Symbols must be a non-empty array');
      }

      const validatedSymbols = [...new Set((await Promise.all(symbols.map(s => this._validateSymbol(s)))))]
        .filter(Boolean);

      const cacheEntries = await Promise.all(
        validatedSymbols.map(async (symbol) => {
          const cacheKey = `stock:${symbol}`;
          const cached = await getCache(cacheKey);
          return { symbol, cached };
        })
      );

      const cachedMap = new Map();
      const missingSymbols = [];

      for (const entry of cacheEntries) {
        if (entry.cached) {
          cachedMap.set(entry.symbol, entry.cached);
        } else {
          missingSymbols.push(entry.symbol);
        }
      }

      logger.info(`Market provider: ${validatedSymbols.length} stocks requested`);
      logger.info(`Market provider: ${cachedMap.size} stocks served from cache`);

      if (missingSymbols.length > 0) {
        logger.info(`Market provider: fetching ${missingSymbols.length} stocks`);
        try {
          const fetchedStocks = await this.provider.getMultipleStocks(missingSymbols);

          for (const stock of (fetchedStocks || [])) {
            const normalizedTicker = String(stock?.ticker || '').toUpperCase();
            if (!normalizedTicker) continue;
            const enriched = this._enrichStockData(stock);
            await setCache(`stock:${normalizedTicker}`, enriched, CACHE_TTL.STOCK_PRICE);
            cachedMap.set(normalizedTicker, enriched);
          }
        } catch (providerError) {
          logger.warn(`Market provider fetch encountered an issue: ${providerError.message}`);
        }

        // Do not manufacture prices when a provider is unavailable. Missing
        // symbols are omitted so callers can render an explicit unavailable state.
      }

      const orderedResults = validatedSymbols.map((symbol) => cachedMap.get(symbol));
      const successfulStocks = orderedResults.filter(Boolean);

      logger.info(`Market provider: ${successfulStocks.length} stocks returned`);
      return successfulStocks;
    } catch (error) {
      this.logger.error(`Error in getMultipleStocks: ${error.message}`);
      throw error;
    }
  }

  /**
   * getAllStocks - Get all supported stocks
   * 
   * Fetches all stocks in SUPPORTED_STOCKS list
   * Uses getMultipleStocks internally for efficiency
   * 
   * @returns {array} - All supported stocks with live data
   * @throws {AppError}
   * 
   * EXAMPLE:
   * const allStocks = await service.getAllStocks();
   * // Returns array of 28 stocks (all sectors)
   */
  async getAllStocks() {
    try {
      const symbols = Object.keys(SUPPORTED_STOCKS);
      return await this.getMultipleStocks(symbols);
    } catch (error) {
      this.logger.error(`Error in getAllStocks: ${error.message}`);
      throw error;
    }
  }

  /**
   * getStocksByFilter - Get stocks filtered by criteria
   * 
   * FILTERS:
   * - sector: Filter by industry
   * - minPrice: Minimum price
   * - maxPrice: Maximum price
   * - sortBy: Sort by 'price', 'changePct', 'volume'
   * 
   * @param {object} filters - Filter criteria
   * @returns {array} - Filtered and sorted stocks
   * 
   * EXAMPLE:
   * const defenceStocks = await service.getStocksByFilter({
   *   sector: 'Defence',
   *   sortBy: 'changePct'
   * });
   */
  async getStocksByFilter(filters = {}) {
    try {
      // Get all stocks first
      let stocks = await this.getAllStocks();

      // Apply filters
      if (filters.sector) {
        stocks = stocks.filter(s => 
          SUPPORTED_STOCKS[s.ticker]?.sector === filters.sector
        );
      }

      if (filters.minPrice) {
        stocks = stocks.filter(s => s.price >= filters.minPrice);
      }

      if (filters.maxPrice) {
        stocks = stocks.filter(s => s.price <= filters.maxPrice);
      }

      // Sort results
      if (filters.sortBy) {
        stocks = this._sortStocks(stocks, filters.sortBy);
      }

      return stocks;
    } catch (error) {
      this.logger.error(`Error in getStocksByFilter: ${error.message}`);
      throw error;
    }
  }

  async searchStocks(query) {
    const searchTerm = String(query || '').trim().toLowerCase();
    if (!searchTerm) {
      throw createInvalidInputError('Search query is required');
    }

    const matchedSet = new Set();

    // 1. Search known supported stocks by ticker, name, or sector
    for (const [ticker, metadata] of Object.entries(SUPPORTED_STOCKS)) {
      const isMatch = [ticker, metadata?.name, metadata?.sector]
        .some((val) => String(val || '').toLowerCase().includes(searchTerm));
      if (isMatch) {
        matchedSet.add(ticker);
      }
    }

    // 2. Support any live ticker on NSE/BSE (e.g. JIOFIN, TATATECH, MAPMYINDIA, SWIGGY)
    const cleanTicker = searchTerm.toUpperCase().replace(/[^A-Z0-9&-]/g, '');
    if (cleanTicker && /^[A-Z0-9&-]{2,15}$/.test(cleanTicker)) {
      matchedSet.add(cleanTicker);
    }

    const matchingSymbols = Array.from(matchedSet).slice(0, 25);

    if (!matchingSymbols.length) {
      return [];
    }

    return this.getMultipleStocks(matchingSymbols);
  }

  /**
   * getCompanyDetails - Get detailed company information
   * 
   * Fetches and caches company profile data
   * Uses longer TTL than price data (1 hour)
   * 
   * @param {string} symbol - Stock ticker
   * @returns {object} - Company details
   * @throws {AppError}
   * 
   * CACHE KEY: "company:{SYMBOL}"
   * CACHE TTL: 1 hour (less volatile than prices)
   */
  async getCompanyDetails(symbol) {
    try {
      const validatedSymbol = await this._validateSymbol(symbol);

      // Try cache
      const cacheKey = `company:${validatedSymbol}`;
      const cachedData = await getCache(cacheKey);
      
      if (cachedData) {
        return cachedData;
      }

      // Fetch from provider
      const details = await this.provider.getCompanyDetails(validatedSymbol);

      // Cache with longer TTL
      await setCache(cacheKey, details, CACHE_TTL.COMPANY_DETAILS);

      return details;
    } catch (error) {
      this.logger.error(`Error in getCompanyDetails: ${error.message}`);
      throw error;
    }
  }

  async getHistoricalData(symbol, period = '1Y') {
    const validatedSymbol = await this._validateSymbol(symbol);
    const cacheKey = `history:${validatedSymbol}:${period}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return cachedData;

    const history = await this.provider.getHistoricalData(validatedSymbol, period);
    if (Array.isArray(history) && history.length) {
      await setCache(cacheKey, history, CACHE_TTL.HISTORY);
    }
    return Array.isArray(history) ? history : [];
  }

  /**
   * getHistoricalCandles - Public, schema-normalized historical candles for
   * GET /api/stocks/:symbol/history.
   *
   * Unlike getHistoricalData (a bare array, kept for existing internal
   * callers), this returns the full metadata envelope the frontend chart
   * needs: source/asOf/fromCache/isStale/count/metrics alongside ascending,
   * deduplicated candles with only finite OHLC values. A provider failure
   * (network/auth/rate-limit/HTTP error) is rethrown as a 503 AppError; a
   * genuinely empty provider response is returned as-is (count: 0,
   * candles: []) rather than an error — the two are distinct and must never
   * be confused with each other or with fabricated data.
   *
   * CACHE SEMANTICS: `fromCache` is true whenever this response was served
   * from Redis rather than freshly fetched — it says nothing about
   * freshness. `isStale` is reserved for a deliberate serve-expired-data
   * fallback (e.g. serving a last-known-good response when the provider is
   * down); no such fallback exists here, so isStale is always false. A
   * fresh cache hit (within TTL) is `fromCache: true, isStale: false` —
   * cached is not the same as stale.
   *
   * Concurrent identical requests (same symbol/range/interval) are
   * deduplicated via an in-flight map so a rapid double-click or a
   * symbol/range change that re-fires before the previous request settles
   * never issues two real provider calls for the same data.
   *
   * @param {string} symbol
   * @param {{range?: string, interval?: string}} options
   * @throws {AppError} 400 for an invalid range/interval, 503 for a provider failure
   */
  async getHistoricalCandles(symbol, { range = '1Y', interval } = {}) {
    const validatedSymbol = await this._validateSymbol(symbol);

    const normalizedRange = String(range || '1Y').toUpperCase();
    if (!PUBLIC_HISTORY_RANGES.includes(normalizedRange)) {
      throw createInvalidInputError(
        `Invalid range '${range}'. Allowed: ${PUBLIC_HISTORY_RANGES.join(', ')}`
      );
    }

    let normalizedInterval = null;
    if (interval !== undefined && interval !== null && interval !== '') {
      normalizedInterval = String(interval).toUpperCase();
      if (!HISTORY_INTERVALS.includes(normalizedInterval)) {
        throw createInvalidInputError(
          `Invalid interval '${interval}'. Allowed: ${HISTORY_INTERVALS.join(', ')}`
        );
      }
    }

    const resolvedInterval = normalizedInterval || DEFAULT_INTERVAL_BY_RANGE[normalizedRange] || 'ONE_DAY';
    const cacheKey = `history:v2:${validatedSymbol}:${normalizedRange}:${resolvedInterval}`;
    const inFlightKey = `historyCandles:${cacheKey}`;

    if (this.inFlightRequests.has(inFlightKey)) {
      this.logger.debug(`Stock service deduplicating history request for ${validatedSymbol}`);
      return this.inFlightRequests.get(inFlightKey);
    }

    const requestPromise = (async () => {
      const cached = await getCache(cacheKey);
      if (cached) {
        return { ...cached, fromCache: true, isStale: false };
      }

      let rawCandles;
      try {
        rawCandles = await this.provider.getHistoricalData(validatedSymbol, normalizedRange, normalizedInterval || undefined);
      } catch (error) {
        this.logger.error(`Error in getHistoricalCandles(${symbol}): ${error.message}`);
        if (error instanceof AppError) throw error;
        throw createProviderError('Angel One', `Historical data unavailable for ${validatedSymbol}: ${error.message}`);
      }

      const candles = (Array.isArray(rawCandles) ? rawCandles : [])
        .filter((candle) => candle
          && Number.isFinite(candle.timestamp)
          && Number.isFinite(candle.open)
          && Number.isFinite(candle.high)
          && Number.isFinite(candle.low)
          && Number.isFinite(candle.close))
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((candle, index, sorted) => index === 0 || candle.timestamp !== sorted[index - 1].timestamp);

      // Return/volatility/drawdown assume one observation per trading day
      // for annualization — never computed from intraday candles. Reported
      // consistently (always present, marked unavailable with a reason)
      // rather than sometimes omitted, so callers can rely on the shape.
      const metrics = resolvedInterval === 'ONE_DAY'
        ? calculateDeterministicMetrics(candles)
        : (() => {
          const reason = `Metrics require daily candles; this response uses ${resolvedInterval} candles`;
          return {
            observations: candles.length,
            oneYearReturn: { value: null, available: false, missingReason: reason },
            volatility: { value: null, available: false, missingReason: reason },
            maxDrawdown: { value: null, available: false, missingReason: reason },
          };
        })();

      const payload = {
        symbol: validatedSymbol,
        range: normalizedRange,
        interval: resolvedInterval,
        source: this.provider?.providerName || 'unknown',
        asOf: new Date().toISOString(),
        count: candles.length,
        candles,
        metrics,
      };

      if (candles.length) {
        await setCache(cacheKey, payload, CACHE_TTL.HISTORY);
      }

      return { ...payload, fromCache: false, isStale: false };
    })();

    this.inFlightRequests.set(inFlightKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      this.inFlightRequests.delete(inFlightKey);
    }
  }

  /**
   * invalidateCache - Clear cache for specific stock
   * 
   * Called when data needs to be refreshed
   * (e.g., after data update, manual refresh)
   * 
   * @param {string} symbol - Stock ticker
   */
  async invalidateCache(symbol) {
    try {
      const validatedSymbol = await this._validateSymbol(symbol);
      
      // Delete both price and company cache
      await deleteCache(`stock:${validatedSymbol}`);
      await deleteCache(`company:${validatedSymbol}`);
      
      this.logger.debug(`Cache invalidated for ${validatedSymbol}`);
    } catch (error) {
      this.logger.error(`Error invalidating cache: ${error.message}`);
      // Don't throw - cache errors shouldn't break the app
    }
  }

  /**
   * ===== PRIVATE HELPER METHODS =====
   * These support the public API
   */

  /**
   * _validateSymbol - Ensure symbol is valid
   * 
   * @param {string} symbol - Stock ticker to validate
   * @returns {string} - Validated (uppercase) symbol
   * @throws {AppError} - If invalid
   * 
   * WHY UPPERCASE:
   * - Market data providers expect uppercase symbols
   * - Normalizes input from frontend
   */
  _validateSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') {
      throw createInvalidInputError('Symbol must be a non-empty string');
    }

    const upperSymbol = symbol.trim().toUpperCase();

    if (SUPPORTED_STOCKS[upperSymbol] || INDEX_SYMBOLS[upperSymbol]) {
      return upperSymbol;
    }

    // Allow standard exchange ticker syntax
    if (/^[A-Z0-9&-]{2,15}$/.test(upperSymbol)) {
      return upperSymbol;
    }

    throw createNotFoundError('Stock', symbol);
  }

  /**
   * _enrichStockData - Add metadata and transform data
   * 
   * Takes raw provider data and enhances it with:
   * - Stock name from SUPPORTED_STOCKS
   * - Sector information
   * - Additional calculations
   * 
   * @param {object} stockData - Raw stock data from provider
   * @returns {object} - Enriched stock data
   */
  _enrichStockData(stockData) {
    const metadata = SUPPORTED_STOCKS[stockData.ticker];
    
    return {
      ...stockData,
      name: metadata?.name || stockData.name,
      sector: metadata?.sector || 'Unknown',
      
      // Format price display
      priceFormatted: `₹${stockData.price.toFixed(2)}`,
      changeFormatted: `${stockData.changePct > 0 ? '+' : ''}${stockData.changePct.toFixed(2)}%`,
      
      // Status
      isPositive: stockData.changePct > 0,
      isNegative: stockData.changePct < 0,
    };
  }

  /**
   * _sortStocks - Sort stock array by criteria
   * 
   * @param {array} stocks - Stock array to sort
   * @param {string} sortBy - Sort key ('price', 'changePct', 'volume')
   * @returns {array} - Sorted stocks (descending)
   */
  _sortStocks(stocks, sortBy) {
    const validKeys = ['price', 'changePct', 'volume', 'change'];
    
    if (!validKeys.includes(sortBy)) {
      return stocks;
    }

    // Sort descending by default
    return stocks.sort((a, b) => b[sortBy] - a[sortBy]);
  }
}
