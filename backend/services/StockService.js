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
import { CACHE_TTL, SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import {
  createNotFoundError,
  createInvalidInputError,
  AppError,
} from '../utils/errorHandler.js';

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
      // Step 1: Validate input
      const validatedSymbol = await this._validateSymbol(symbol);
      
      // Step 2: Try cache first
      const cacheKey = `stock:${validatedSymbol}`;
      const cachedData = await getCache(cacheKey);
      
      if (cachedData) {
        this.logger.debug(`Stock service cache HIT for ${validatedSymbol}`);
        return cachedData;
      }

      // Step 3: Cache miss - fetch from provider
      this.logger.debug(`Stock service cache MISS for ${validatedSymbol} - fetching from provider`);
      const stockData = await this.provider.getStock(validatedSymbol);

      // Step 4: Enrich and transform data
      const enrichedData = this._enrichStockData(stockData);

      // Step 5: Store in cache
      await setCache(cacheKey, enrichedData, CACHE_TTL.STOCK_PRICE);

      return enrichedData;
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

      const validatedSymbols = await Promise.all(symbols.map(s => this._validateSymbol(s)));
      const results = [];
      const concurrency = 4;

      for (let index = 0; index < validatedSymbols.length; index += concurrency) {
        const batch = validatedSymbols.slice(index, index + concurrency);
        const batchResults = await Promise.all(
          batch.map((symbol) =>
            this.getStock(symbol).catch((error) => {
              this.logger.warn(`Failed to fetch ${symbol}: ${error.message}`);
              return null;
            })
          )
        );

        results.push(...batchResults.filter(Boolean));
      }

      if (results.length === 0) {
        throw createInvalidInputError('Failed to fetch any stocks');
      }

      return results;
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

    const upperSymbol = symbol.toUpperCase();

    // If symbol exists in supported list, return immediately
    if (SUPPORTED_STOCKS[upperSymbol]) {
      return upperSymbol;
    }

    // Attempt provider-based search by name if provider supports it
    if (this.provider && typeof this.provider.search === 'function') {
      // Try treating the input as a company name and resolve to a ticker
      // Example: 'dhoot technology' -> 'DHOOT' (provider-specific)
      // Note: provider.search should return { ticker, name } or null
      // Use a best-effort approach before failing with NotFound
      return this.provider.search(symbol).then((res) => {
        if (res && res.ticker) {
          return res.ticker.toUpperCase();
        }
        throw createNotFoundError('Stock', symbol);
      });
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
