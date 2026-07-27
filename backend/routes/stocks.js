/**
 * STOCK_ROUTES.JS
 * =================
 * Express router defining all stock market API endpoints.
 * 
 * RESPONSIBILITY:
 * - Define URL routes
 * - Map routes to controller methods
 * - Add route-specific middleware (if needed)
 * 
 * ARCHITECTURE:
 * Server.js
 *     ↓
 * app.use('/api/stocks', stockRoutes)
 *     ↓
 * This file (routes)
 *     ↓
 * StockController (handlers)
 *     ↓
 * StockService (business logic)
 * 
 * REST ENDPOINT DESIGN:
 * GET = Retrieve data (safe, idempotent)
 * POST = Create or trigger action
 * PUT = Update existing resource
 * DELETE = Remove resource
 * 
 * PATTERN: RESTful API conventions
 * - /api/stocks - Collection
 * - /api/stocks/:symbol - Single resource
 * - /api/stocks/:symbol/details - Sub-resource
 * - /api/stocks/:symbol/refresh - Action
 */

import express from 'express';
import { StockController } from '../controllers/StockController.js';
import { logger } from '../utils/logger.js';

/**
 * createStockRoutes - Factory function to create stock routes
 * 
 * WHY A FACTORY FUNCTION?
 * - Allows injecting StockService as dependency
 * - Makes testing easier (can mock service)
 * - Keeps routes modular and reusable
 * 
 * @param {StockService} stockService - Service instance
 * @returns {express.Router} - Express router with all routes
 * 
 * EXAMPLE:
 * import { createStockRoutes } from './routes/stocks.js';
 * const stockRoutes = createStockRoutes(stockService);
 * app.use('/api', stockRoutes);
 */
export function createStockRoutes(stockService) {
  // Create Express router
  // This router will handle all /api/stocks/* paths
  const router = express.Router();

  // Initialize controller with service
  // Controller now has access to business logic
  const controller = new StockController(stockService);

  /**
   * REQUEST LOGGING MIDDLEWARE
   * ===========================
   * Log all incoming requests to stock endpoints
   * 
   * FORMAT: [TIMESTAMP] METHOD /path - Query: {...}
   * EXAMPLE: [14:30:45] GET /api/stocks/HAL - Query: {}
   */
  router.use((req, res, next) => {
    logger.debug(
      `[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl}`
    );
    next();
  });

  /**
   * ============================================================
   * PRIMARY ENDPOINTS
   * ============================================================
   */

  /**
   * GET /api/stocks
   * ================
   * Get ALL supported stocks with live data.
   * 
   * RESPONSE:
   * {
   *   "success": true,
   *   "data": [
   *     { "ticker": "HAL", "price": ..., ... },
   *     { "ticker": "BEL", "price": ..., ... },
   *     ... (26 total)
   *   ],
   *   "count": 26
   * }
   * 
   * QUERY PARAMETERS: None
   * 
   * ERRORS:
   * - 500: Provider error or internal failure
   * 
   * PERFORMANCE:
   * - Fast if all cached (100ms)
   * - Slow if cache empty (1-2 seconds with API calls)
   * 
   * USE CASE:
   * - Load market overview dashboard
   * - Initialize stock list on frontend
   */
  /**
   * GET /api/stocks/search
   * =======================
   * Get filtered/sorted stocks.
   * 
   * QUERY PARAMETERS:
   * - sector: 'Defence' | 'Banking' | 'Railways' | etc.
   * - minPrice: Minimum stock price (number)
   * - maxPrice: Maximum stock price (number)
   * - sortBy: 'price' | 'changePct' | 'volume'
   * 
   * EXAMPLES:
   * GET /api/stocks/search?sector=Defence
   * GET /api/stocks/search?sector=Banking&sortBy=changePct
   * GET /api/stocks/search?minPrice=1000&maxPrice=5000
   * 
   * RESPONSE:
   * {
   *   "success": true,
   *   "data": [ ... filtered stocks ... ],
   *   "count": 8,
   *   "filters": { "sector": "Defence" }
   * }
   * 
   * USE CASE:
   * - Show stocks from specific sector
   * - Filter by price range
   * - Sort by performance
   */
  router.get('/search', (req, res, next) => {
    return controller.getFilteredStocks(req, res, next);
  });

  router.get('/indices', (req, res, next) => {
    return controller.getIndexQuotes(req, res, next);
  });

  /**
   * GET /api/stocks/:symbol
   * =========================
   * Get single stock by ticker symbol.
   * 
   * PATH PARAMETERS:
   * - symbol: Stock ticker (e.g., 'HAL', 'HDFCBANK')
   * 
   * EXAMPLES:
   * GET /api/stocks/HAL
   * GET /api/stocks/HDFCBANK
   * GET /api/stocks/invalid → 404 Not Found
   * 
   * RESPONSE:
   * {
   *   "success": true,
   *   "data": {
   *     "ticker": "HAL",
   *     "name": "Hindustan Aeronautics",
   *     "price": 4521.30,
   *     "changePct": 2.84,
   *     ...
   *   },
   *   "message": "Stock data for HAL"
   * }
   * 
   * HTTP STATUS:
   * - 200: Success
   * - 404: Symbol not found
   * - 400: Invalid symbol format
   * - 503: Provider unavailable
   * - 500: Server error
   * 
   * CACHE:
   * - Checks Redis first (5 min TTL)
   * - Fetches from Finnhub if cache miss
   * 
   * USE CASE:
   * - Fetch single stock when user clicks on stock in list
   * - Stock detail page loads this data
   */
  router.get('/:symbol', (req, res, next) => {
    return controller.getStock(req, res, next);
  });

  /**
   * GET /api/stocks?symbols=HAL,BEL,HDFCBANK
   * ==========================================
   * Get multiple stocks efficiently (alternative to individual calls).
   * 
   * QUERY PARAMETERS:
   * - symbols: Comma-separated list (e.g., 'HAL,BEL,HDFCBANK')
   * 
   * EXAMPLES:
   * GET /api/stocks?symbols=HAL
   * GET /api/stocks?symbols=HAL,BEL,HDFCBANK
   * GET /api/stocks?symbols=NTPC,TATAPOWER,ADANIGREEN
   * 
   * RESPONSE:
   * {
   *   "success": true,
   *   "data": [
   *     { "ticker": "HAL", "price": ..., ... },
   *     { "ticker": "BEL", "price": ..., ... }
   *   ],
   *   "count": 2,
   *   "message": "Data for 2 stocks"
   * }
   * 
   * OPTIMIZATION:
   * - Better than 3 individual GET requests
   * - Checks cache for each stock
   * - Only fetches uncached stocks from API
   * 
   * NOTE:
   * This route is AFTER /search and /:symbol
   * So it only matches when query param is present
   * 
   * USE CASE:
   * - Load watchlist with specific stocks
   * - Frontend dashboard showing selected stocks
   */
  router.get('/', (req, res, next) => {
    // Check if 'symbols' query parameter exists
    if (req.query.symbols) {
      return controller.getMultipleStocks(req, res, next);
    }
    // Otherwise fall through to getAllStocks
    return controller.getAllStocks(req, res, next);
  });

  /**
   * ============================================================
   * SUB-RESOURCE ENDPOINTS
   * ============================================================
   * These provide additional data for a specific stock
   */

  /**
   * GET /api/stocks/:symbol/details
   * ================================
   * Get detailed company information.
   * 
   * INCLUDES:
   * - Company profile
   * - Sector/Industry
   * - Market cap
   * - Website
   * - Founded year
   * - Business description
   * 
   * EXAMPLES:
   * GET /api/stocks/HAL/details
   * GET /api/stocks/HDFCBANK/details
   * 
   * RESPONSE:
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
   * CACHE:
   * - Longer TTL (1 hour) than prices (5 minutes)
   * - Company details don't change frequently
   * 
   * USE CASE:
   * - Stock detail page
   * - Company profile section
   */
  router.get('/:symbol/details', (req, res, next) => {
    return controller.getCompanyDetails(req, res, next);
  });

  /**
   * POST /api/stocks/:symbol/refresh
   * =================================
   * Manually refresh stock price (bypass cache).
   * 
   * WHY POST?
   * - It's an action/command (refresh), not just data retrieval
   * - POST = "do something" vs GET = "retrieve something"
   * - Also prevents caching by proxy servers
   * 
   * EXAMPLES:
   * POST /api/stocks/HAL/refresh
   * 
   * RESPONSE:
   * {
   *   "success": true,
   *   "data": { ... fresh stock data ... },
   *   "message": "Stock data refreshed for HAL"
   * }
   * 
   * FLOW:
   * 1. Invalidate Redis cache for this symbol
   * 2. Fetch fresh data from provider
   * 3. Cache new data
   * 4. Return fresh prices
   * 
   * USE CASE:
   * - User clicks "Refresh" button on stock page
   * - Need immediate latest prices (skip 5-min cache)
   */
  router.post('/:symbol/refresh', (req, res, next) => {
    return controller.refreshStockPrice(req, res, next);
  });

  /**
   * ============================================================
   * MARKET-WIDE ENDPOINTS
   * ============================================================
   * These provide market-level information
   */

  /**
   * GET /api/market/status
   * =======================
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
   * USE CASE:
   * - Display market status indicator
   * - Disable trading when market is closed
   * - Show "Market closes at 3:30 PM" message
   */
  router.get('/market/status', (req, res, next) => {
    return controller.getMarketStatus(req, res, next);
  });

  /**
   * ============================================================
   * ERROR HANDLING
   * ============================================================
   * Catch undefined routes and return 404
   */
  router.use((req, res) => {
    logger.warn(`[Routes] No route found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
      success: false,
      error: 'Endpoint not found',
      path: req.originalUrl,
    });
  });

  return router;
}

/**
 * ROUTE SUMMARY
 * =============
 * 
 * GET  /api/stocks                      - All stocks
 * GET  /api/stocks?symbols=HAL,BEL      - Multiple stocks
 * GET  /api/stocks/search?sector=Defence - Filtered stocks
 * GET  /api/stocks/:symbol               - Single stock
 * GET  /api/stocks/:symbol/details       - Company details
 * POST /api/stocks/:symbol/refresh       - Force refresh price
 * GET  /api/market/status                - Market status
 * 
 * These cover the core functionality needed for:
 * - Dashboard (all stocks overview)
 * - Stock detail page (single stock + company info)
 * - Watchlist page (filtered stocks)
 * - Sector page (filtered by sector)
 * - Real-time updates (refresh endpoint)
 */
