/**
 * STOCK_CONTROLLER.JS
 * =====================
 * HTTP request handlers for all stock-related endpoints.
 * 
 * RESPONSIBILITY:
 * - Parse incoming HTTP requests
 * - Validate request parameters
 * - Call appropriate service methods
 * - Format and return HTTP responses
 * - Handle errors and return appropriate status codes
 * 
 * ARCHITECTURE:
 * Client HTTP Request
 *     ↓
 * Express Route (stocks.js)
 *     ↓
 * Controller (THIS FILE) ← Handles request/response
 *     ↓
 * Service (StockService.js) ← Business logic
 *     ↓
 * Provider (FinnhubProvider.js) ← External data
 * 
 * KEY PRINCIPLE:
 * - Controller should NOT contain business logic
 * - All logic belongs in Service
 * - Controller only handles HTTP concerns:
 *   - Reading query/path params
 *   - Validation
 *   - HTTP status codes
 *   - Response formatting
 * 
 * EXAMPLE FLOW:
 * GET /api/stocks/HAL
 *   ↓
 * Controller: Parse 'HAL' from URL
 *   ↓
 * Service: Fetch HAL data with caching
 *   ↓
 * Provider: Call Finnhub API if cache miss
 *   ↓
 * Controller: Return JSON response with 200 status
 */

import { logger } from '../utils/logger.js';
import { HTTP_STATUS, INDEX_SYMBOLS } from '../utils/constants.js';
import { YahooFinanceService } from '../services/yahooFinance.service.js';
import {
  AppError,
  createNotFoundError,
  createInvalidInputError,
} from '../utils/errorHandler.js';

/**
 * StockController - HTTP handlers for stock endpoints
 * 
 * Each method receives:
 * - req: Express request object (params, query, body)
 * - res: Express response object (send, status, json)
 * - next: Express middleware next function (error handling)
 */
export class StockController {
  /**
   * Constructor - Initialize with StockService
   * 
   * WHY INJECT SERVICE?
   * - Dependency Injection pattern
   * - Makes testing easier (can mock service)
   * - Keeps controller focused on HTTP logic
   * 
   * @param {StockService} stockService - Instance of StockService
   */
  constructor(stockService) {
    if (!stockService) {
      throw new Error('StockService is required');
    }
    this.stockService = stockService;
  }

  /**
   * getStock - Handler for GET /api/stocks/:symbol
   * 
   * FLOW:
   * 1. Extract 'symbol' from URL path params
   *    Example: /api/stocks/HAL → symbol = 'HAL'
   * 
   * 2. Call service to fetch stock data
   *    - Service checks cache first
   *    - If cache miss, fetches from provider
   *    - Returns standardized stock object
   * 
   * 3. Return JSON response with 200 status
   * 
   * ERROR HANDLING:
   * - NotFoundError (404) - Symbol doesn't exist
   * - InvalidInputError (400) - Symbol format invalid
   * - ProviderError (503) - API unavailable
   * - Catch-all (500) - Unexpected error
   * 
   * RESPONSE FORMAT:
   * {
   *   "success": true,
   *   "data": {
   *     "ticker": "HAL",
   *     "name": "Hindustan Aeronautics",
   *     "price": 4521.30,
   *     "changePct": 2.84,
   *     ...
   *   }
   * }
   * 
   * @param {object} req - Express request { params: { symbol } }
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   * 
   * EXAMPLES:
   * GET /api/stocks/HAL
   * GET /api/stocks/HDFCBANK
   * GET /api/stocks/invalid → Returns 404
   */
  async getStock(req, res, next) {
    try {
      // Extract symbol from URL path
      // Example: /api/stocks/HAL → req.params.symbol = 'HAL'
      const { symbol } = req.params;

      logger.debug(`[Controller] getStock requested for: ${symbol}`);

      // Call service - returns stock data or throws error
      const stock = await this.stockService.getStock(symbol);

      // Return successful response
      // 200 = OK status code
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: stock,
        message: `Stock data for ${symbol}`,
      });
    } catch (error) {
      // Pass error to Express error handler (in server.js)
      next(error);
    }
  }

  /**
   * getMultipleStocks - Handler for GET /api/stocks?symbols=HAL,BEL,HDFCBANK
   * 
   * FLOW:
   * 1. Extract 'symbols' from query string
   *    Example: /api/stocks?symbols=HAL,BEL → symbols = 'HAL,BEL'
   * 
   * 2. Parse comma-separated string to array
   *    'HAL,BEL' → ['HAL', 'BEL']
   * 
   * 3. Call service with array of symbols
   *    - Returns array of stock objects
   * 
   * 4. Return JSON array response
   * 
   * RESPONSE FORMAT:
   * {
   *   "success": true,
   *   "data": [
   *     { "ticker": "HAL", "price": 4521.30, ... },
   *     { "ticker": "BEL", "price": 3280.50, ... }
   *   ],
   *   "count": 2
   * }
   * 
   * @param {object} req - Express request { query: { symbols } }
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   * 
   * EXAMPLES:
   * GET /api/stocks?symbols=HAL,BEL
   * GET /api/stocks?symbols=HDFCBANK,SBIN,ICICIBANK
   * GET /api/stocks?symbols= → Returns 400 (bad request)
   */
  async getMultipleStocks(req, res, next) {
    try {
      // Extract 'symbols' query parameter
      // Example: GET /api/stocks?symbols=HAL,BEL
      const { symbols } = req.query;

      logger.debug(`[Controller] getMultipleStocks requested for: ${symbols}`);

      // Validate that symbols parameter exists
      if (!symbols) {
        throw createInvalidInputError('symbols query parameter is required');
      }

      // Parse comma-separated string to array
      // 'HAL,BEL,HDFCBANK' → ['HAL', 'BEL', 'HDFCBANK']
      // Also trim whitespace: 'HAL, BEL' → ['HAL', 'BEL']
      const symbolArray = symbols
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      if (symbolArray.length === 0) {
        throw createInvalidInputError('At least one symbol must be provided');
      }

      // Call service
      const stocks = await this.stockService.getMultipleStocks(symbolArray);

      // Return array response with count
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: stocks,
        count: stocks.length,
        message: `Data for ${stocks.length} stocks`,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * getAllStocks - Handler for GET /api/stocks
   * 
   * Returns ALL supported stocks with live data.
   * 
   * FLOW:
   * 1. Call service.getAllStocks()
   *    - Fetches all stocks from SUPPORTED_STOCKS list
   *    - Uses getMultipleStocks internally
   * 
   * 2. Return array of all stocks
   * 
   * RESPONSE FORMAT:
   * {
   *   "success": true,
   *   "data": [
   *     { "ticker": "HAL", "price": ..., ... },
   *     { "ticker": "BEL", "price": ..., ... },
   *     ... (26 total stocks)
   *   ],
   *   "count": 26
   * }
   * 
   * PERFORMANCE NOTE:
   * - Likely to hit cache for most stocks
   * - Only fetches fresh data for uncached stocks
   * - Takes ~100-500ms depending on cache hit rate
   * 
   * @param {object} req - Express request
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   * 
   * EXAMPLE:
   * GET /api/stocks
   */
  async getAllStocks(req, res, next) {
    try {
      logger.debug('[Controller] getAllStocks requested');

      // Call service
      const stocks = await this.stockService.getAllStocks();

      // Return success response
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: stocks,
        count: stocks.length,
        message: `All ${stocks.length} supported stocks`,
      });
    } catch (error) {
      next(error);
    }
  }

  async getIndexQuotes(req, res, next) {
    try {
      const { symbols } = req.query;

      if (!symbols || typeof symbols !== 'string') {
        throw createInvalidInputError('symbols query parameter is required');
      }

      const requestedSymbols = symbols
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (requestedSymbols.length === 0) {
        throw createInvalidInputError('At least one index symbol is required');
      }

      const yahooService = new YahooFinanceService();

      const quotes = await Promise.all(
        requestedSymbols.map(async (symbol) => {
          const normalizedSymbol = symbol.toUpperCase();
          const providerSymbol = INDEX_SYMBOLS[normalizedSymbol];

          if (!providerSymbol) {
            throw createInvalidInputError(`Unsupported index symbol: ${symbol}`);
          }

          const quote = await yahooService.fetchQuote(providerSymbol);
          return {
            symbol: normalizedSymbol,
            providerSymbol,
            price: quote.price,
            change: quote.change,
            changePct: quote.percentage,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            volume: quote.volume,
            previousClose: quote.previousClose,
            timestamp: quote.timestamp,
          };
        })
      );

      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: quotes,
        count: quotes.length,
        message: `Index data for ${quotes.map((q) => q.symbol).join(', ')}`,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * getFilteredStocks - Handler for GET /api/stocks/search
   * 
   * GET /api/stocks/search?sector=Defence&sortBy=changePct
   * 
   * QUERY PARAMETERS:
   * - sector: Filter by industry (Defence, Railways, Banking, etc.)
   * - minPrice: Minimum stock price
   * - maxPrice: Maximum stock price
   * - sortBy: Sort by 'price', 'changePct', 'volume'
   * 
   * FLOW:
   * 1. Extract filters from query params
   * 2. Convert string parameters to appropriate types
   *    - minPrice/maxPrice: String → Number
   * 3. Pass filters to service
   * 4. Return filtered stocks
   * 
   * RESPONSE FORMAT:
   * {
   *   "success": true,
   *   "data": [ ... filtered stocks ... ],
   *   "count": 8,
   *   "filters": {
   *     "sector": "Defence",
   *     "sortBy": "changePct"
   *   }
   * }
   * 
   * EXAMPLES:
   * GET /api/stocks/search?sector=Defence
   * GET /api/stocks/search?sector=Banking&sortBy=changePct
   * GET /api/stocks/search?minPrice=1000&maxPrice=5000&sortBy=price
   * 
   * @param {object} req - Express request with query params
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   */
  async getFilteredStocks(req, res, next) {
    try {
      logger.debug(`[Controller] getFilteredStocks requested with filters:`, req.query);

      // Extract query parameters
      const { sector, minPrice, maxPrice, sortBy } = req.query;

      // Build filters object
      // Only include parameters that were actually provided
      const filters = {};

      if (sector) {
        filters.sector = sector;
      }

      if (minPrice) {
        // Convert string to number
        const price = parseFloat(minPrice);
        if (isNaN(price)) {
          throw createInvalidInputError('minPrice must be a valid number');
        }
        filters.minPrice = price;
      }

      if (maxPrice) {
        // Convert string to number
        const price = parseFloat(maxPrice);
        if (isNaN(price)) {
          throw createInvalidInputError('maxPrice must be a valid number');
        }
        filters.maxPrice = price;
      }

      if (sortBy) {
        filters.sortBy = sortBy;
      }

      // Call service with filters
      const stocks = await this.stockService.getStocksByFilter(filters);

      // Return response with applied filters
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: stocks,
        count: stocks.length,
        filters: filters,
        message: `Found ${stocks.length} stocks matching filters`,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * getCompanyDetails - Handler for GET /api/stocks/:symbol/details
   * 
   * Fetch detailed company information including:
   * - Company profile
   * - Sector/Industry
   * - Market cap
   * - Website
   * - Founded year
   * - Description
   * 
   * FLOW:
   * 1. Extract symbol from URL
   * 2. Call service to get company details
   *    - Uses longer cache TTL (1 hour vs 5 min for prices)
   * 3. Return company data
   * 
   * RESPONSE FORMAT:
   * {
   *   "success": true,
   *   "data": {
   *     "ticker": "HAL",
   *     "name": "Hindustan Aeronautics Ltd.",
   *     "description": "Manufacturer of aircraft...",
   *     "sector": "Defence",
   *     "marketCap": 30200000000,
   *     "website": "https://hal.co.in",
   *     "foundedYear": 1940
   *   }
   * }
   * 
   * @param {object} req - Express request { params: { symbol } }
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   * 
   * EXAMPLE:
   * GET /api/stocks/HAL/details
   * GET /api/stocks/HDFCBANK/details
   */
  async getCompanyDetails(req, res, next) {
    try {
      // Extract symbol from URL path
      const { symbol } = req.params;

      logger.debug(`[Controller] getCompanyDetails requested for: ${symbol}`);

      // Call service
      const details = await this.stockService.getCompanyDetails(symbol);

      // Return response
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: details,
        message: `Company details for ${symbol}`,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * refreshStockPrice - Handler for POST /api/stocks/:symbol/refresh
   * 
   * Manually trigger a price refresh (bypass cache).
   * Useful when user wants latest data immediately.
   * 
   * FLOW:
   * 1. Extract symbol
   * 2. Invalidate cache for this symbol
   *    - Removes from Redis
   * 3. Fetch fresh data from provider
   *    - Next getStock call will fetch from API
   * 4. Return fresh stock data
   * 
   * RESPONSE FORMAT:
   * {
   *   "success": true,
   *   "data": { ... fresh stock data ... },
   *   "message": "Stock data refreshed"
   * }
   * 
   * HTTP STATUS:
   * - 200 = Success
   * - 400 = Invalid symbol
   * - 404 = Symbol not found
   * - 503 = Provider error
   * 
   * @param {object} req - Express request
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   * 
   * EXAMPLE:
   * POST /api/stocks/HAL/refresh
   */
  async refreshStockPrice(req, res, next) {
    try {
      const { symbol } = req.params;

      logger.debug(`[Controller] refreshStockPrice requested for: ${symbol}`);

      // Invalidate cache (removes from Redis)
      await this.stockService.invalidateCache(symbol);

      // Fetch fresh data
      const stock = await this.stockService.getStock(symbol);

      // Return response
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: stock,
        message: `Stock data refreshed for ${symbol}`,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * getWatchlist - Handler for GET /api/watchlist/:listId
   * 
   * Fetch a specific watchlist with live stock data.
   * 
   * FLOW:
   * 1. Get watchlist definition from WATCHLISTS constant
   * 2. Get live prices for all stocks in watchlist
   * 3. Return watchlist with current data
   * 
   * RESPONSE FORMAT:
   * {
   *   "success": true,
   *   "data": {
   *     "id": "growth",
   *     "name": "Growth Picks",
   *     "description": "High-growth companies",
   *     "stocks": [
   *       { "ticker": "HAL", "price": ..., ... },
   *       { "ticker": "ADANIGREEN", "price": ..., ... }
   *     ]
   *   }
   * }
   * 
   * NOTE:
   * Frontend has predefined watchlists like 'growth', 'dividend', etc.
   * This endpoint returns those watchlists with live data instead of hardcoded values.
   * 
   * @param {object} req - Express request { params: { listId } }
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   * 
   * EXAMPLE:
   * GET /api/watchlist/growth
   * GET /api/watchlist/dividend
   */
  async getWatchlist(req, res, next) {
    try {
      const { listId } = req.params;

      logger.debug(`[Controller] getWatchlist requested for: ${listId}`);

      // NOTE: This would need WATCHLISTS constant
      // For now, return placeholder response
      // TODO: Implement when WATCHLISTS constant is added

      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Watchlist endpoint (implementation pending)',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * getMarketStatus - Handler for GET /api/market/status
   * 
   * Get current market status (open/closed, session, time).
   * 
   * RESPONSE:
   * {
   *   "success": true,
   *   "data": {
   *     "isOpen": true,
   *     "region": "NSE / BSE",
   *     "session": "REGULAR",
   *     "closesAt": "15:30 IST",
   *     "serverTime": "14:30:45 IST"
   *   }
   * }
   * 
   * @param {object} req - Express request
   * @param {object} res - Express response
   * @param {function} next - Express middleware
   */
  async getMarketStatus(req, res, next) {
    try {
      logger.debug('[Controller] getMarketStatus requested');

      // Call provider to get market status
      const status = await this.stockService.provider.getMarketStatus();

      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: status,
      });
    } catch (error) {
      next(error);
    }
  }
}
