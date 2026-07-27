/**
 * WEBSOCKET_TICKER.JS
 * ====================
 * WebSocket server for real-time stock price updates.
 * 
 * FUNCTIONALITY:
 * - Clients subscribe to specific stock symbols
 * - Server pushes price updates at regular intervals
 * - No polling needed - client receives updates automatically
 * 
 * ARCHITECTURE:
 * 
 * WebSocket Client (Frontend)
 *     ↓ (Open connection)
 * WebSocket Server (THIS FILE)
 *     ↓
 * Stock Service (Fetch prices)
 *     ↓
 * Redis Cache / Provider
 *     ↓ (Push updates back to client)
 * WebSocket Client (Real-time UI update)
 * 
 * WHY WEBSOCKET INSTEAD OF REST POLLING?
 * - REST: Frontend asks "Is there new data?" every N seconds (wasteful)
 * - WebSocket: Server pushes data when available (efficient)
 * - Lower latency, less bandwidth, better UX
 * 
 * MESSAGE FORMAT:
 * {
 *   "type": "PRICE_UPDATE",
 *   "data": {
 *     "ticker": "HAL",
 *     "price": 4521.30,
 *     "changePct": 2.84,
 *     "timestamp": 1721898645000
 *   }
 * }
 * 
 * CLIENT MESSAGES:
 * {
 *   "type": "SUBSCRIBE",
 *   "symbols": ["HAL", "BEL", "HDFCBANK"]
 * }
 * 
 * {
 *   "type": "UNSUBSCRIBE",
 *   "symbols": ["HAL"]
 * }
 */

import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';
import { WEBSOCKET, SUPPORTED_STOCKS } from '../utils/constants.js';

/**
 * WebSocketTicker - WebSocket server for live prices
 * 
 * Manages connections, subscriptions, and price broadcasts
 */
export class WebSocketTicker {
  /**
   * Constructor
   * 
   * @param {StockService} stockService - Service to fetch prices
   * @param {number} port - WebSocket server port
   * @param {number} updateInterval - Price update interval (ms)
   */
  constructor(stockService, port = 5001, updateInterval = 5000) {
    this.stockService = stockService;
    this.port = port;
    this.updateInterval = updateInterval;

    // Map of clients and their subscriptions
    // Structure: Map<WebSocket, Set<symbols>>
    // Example: 
    //   client1 → {HAL, BEL, HDFCBANK}
    //   client2 → {NTPC, TATAPOWER}
    this.clientSubscriptions = new Map();

    // Map of all active WebSocket connections
    // Used to broadcast updates to all clients
    this.clients = new Set();

    // Interval ID for clearing when server stops
    this.updateIntervalId = null;

    // WebSocket server instance
    this.wss = null;
  }

  /**
   * start - Initialize WebSocket server
   * 
   * FLOW:
   * 1. Create WebSocket server on specified port
   * 2. Setup connection handlers
   * 3. Start price update loop
   * 
   * @returns {Promise<void>}
   */
  async start() {
    try {
      // Create WebSocket server
      // This listens for client connections
      this.wss = new WebSocketServer({ port: this.port });

      logger.info(`✓ WebSocket server listening on port ${this.port}`);

      // Handle new client connections
      this.wss.on('connection', (ws) => {
        this._handleClientConnect(ws);
      });

      // Start price update loop
      // Sends updates to all subscribed clients every N seconds
      this.updateIntervalId = setInterval(() => {
        this._broadcastPriceUpdates();
      }, this.updateInterval);

      logger.info(`✓ Price update loop started (interval: ${this.updateInterval}ms)`);
    } catch (error) {
      logger.error(`Failed to start WebSocket server: ${error.message}`);
      throw error;
    }
  }

  /**
   * stop - Gracefully shutdown WebSocket server
   * 
   * Closes all connections and clears intervals
   */
  async stop() {
    try {
      // Clear update interval
      if (this.updateIntervalId) {
        clearInterval(this.updateIntervalId);
      }

      // Close all client connections
      for (const ws of this.clients) {
        ws.close();
      }

      // Close server
      if (this.wss) {
        this.wss.close();
      }

      logger.info('✓ WebSocket server stopped');
    } catch (error) {
      logger.error(`Error stopping WebSocket server: ${error.message}`);
    }
  }

  /**
   * _handleClientConnect - Handle new WebSocket client connection
   * 
   * FLOW:
   * 1. Add client to tracking set
   * 2. Setup message handler
   * 3. Setup close handler
   * 4. Send welcome message
   * 
   * @param {WebSocket} ws - New client connection
   * @private
   */
  _handleClientConnect(ws) {
    try {
      // Track this client
      this.clients.add(ws);
      this.clientSubscriptions.set(ws, new Set());

      logger.debug(`New WebSocket connection (total: ${this.clients.size})`);

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: 'WELCOME',
          message: 'Connected to Stock Ticker',
          availableSymbols: Object.keys(SUPPORTED_STOCKS),
        })
      );

      // Handle incoming messages from client
      ws.on('message', (message) => {
        this._handleClientMessage(ws, message);
      });

      // Handle client disconnect
      ws.on('close', () => {
        this._handleClientDisconnect(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        logger.error(`WebSocket error: ${error.message}`);
      });
    } catch (error) {
      logger.error(`Error handling client connect: ${error.message}`);
      ws.close();
    }
  }

  /**
   * _handleClientMessage - Process messages from client
   * 
   * MESSAGE TYPES:
   * - SUBSCRIBE: Subscribe to stock prices
   * - UNSUBSCRIBE: Unsubscribe from stocks
   * - PING: Heartbeat (client checks connection alive)
   * 
   * MESSAGE FORMAT:
   * {
   *   "type": "SUBSCRIBE",
   *   "symbols": ["HAL", "BEL", "HDFCBANK"]
   * }
   * 
   * @param {WebSocket} ws - Client connection
   * @param {string} message - Raw message from client
   * @private
   */
  _handleClientMessage(ws, message) {
    try {
      // Parse JSON message
      const parsed = JSON.parse(message);
      const { type, symbols } = parsed;

      logger.debug(`[WS] Received ${type} message`);

      switch (type) {
        case 'SUBSCRIBE':
          // Client wants to subscribe to stock prices
          if (Array.isArray(symbols)) {
            const currentSubs = this.clientSubscriptions.get(ws) || new Set();
            symbols.forEach(symbol => currentSubs.add(symbol.toUpperCase()));
            this.clientSubscriptions.set(ws, currentSubs);

            logger.debug(`Client subscribed to: ${Array.from(currentSubs).join(', ')}`);

            // Send confirmation
            ws.send(
              JSON.stringify({
                type: 'SUBSCRIBED',
                symbols: Array.from(currentSubs),
              })
            );
          }
          break;

        case 'UNSUBSCRIBE':
          // Client wants to stop receiving updates for specific stocks
          if (Array.isArray(symbols)) {
            const currentSubs = this.clientSubscriptions.get(ws);
            symbols.forEach(symbol => currentSubs.delete(symbol.toUpperCase()));

            logger.debug(`Client unsubscribed from: ${symbols.join(', ')}`);

            ws.send(
              JSON.stringify({
                type: 'UNSUBSCRIBED',
                symbols: Array.from(currentSubs),
              })
            );
          }
          break;

        case 'PING':
          // Client is checking connection is alive
          ws.send(JSON.stringify({ type: 'PONG' }));
          break;

        default:
          logger.warn(`Unknown message type: ${type}`);
      }
    } catch (error) {
      logger.error(`Error processing client message: ${error.message}`);

      // Send error to client
      try {
        ws.send(
          JSON.stringify({
            type: 'ERROR',
            message: error.message,
          })
        );
      } catch (e) {
        // Client connection may be closed
      }
    }
  }

  /**
   * _handleClientDisconnect - Handle WebSocket client disconnect
   * 
   * CLEANUP:
   * 1. Remove client from tracking set
   * 2. Remove subscriptions
   * 
   * @param {WebSocket} ws - Disconnected client
   * @private
   */
  _handleClientDisconnect(ws) {
    try {
      this.clients.delete(ws);
      this.clientSubscriptions.delete(ws);

      logger.debug(`Client disconnected (remaining: ${this.clients.size})`);
    } catch (error) {
      logger.error(`Error handling disconnect: ${error.message}`);
    }
  }

  /**
   * _broadcastPriceUpdates - Fetch and broadcast latest prices
   * 
   * FLOW:
   * 1. Collect all unique subscribed symbols from all clients
   * 2. Fetch prices for those symbols
   * 3. For each client, send only their subscribed stocks
   * 
   * OPTIMIZATION:
   * - Fetches prices once for all clients (not per client)
   * - Uses cache to avoid repeated API calls
   * - Only sends data client requested
   * 
   * @private
   */
  async _broadcastPriceUpdates() {
    try {
      if (this.clients.size === 0) {
        // No connected clients, skip update
        return;
      }

      // Collect all unique symbols subscribed by any client
      const allSymbols = new Set();
      for (const symbols of this.clientSubscriptions.values()) {
        symbols.forEach(symbol => allSymbols.add(symbol));
      }

      if (allSymbols.size === 0) {
        // No one subscribed to anything
        return;
      }

      // Fetch prices for all subscribed symbols
      const symbolArray = Array.from(allSymbols);
      let prices = {};

      try {
        // Fetch stocks from service (uses cache)
        const stocks = await this.stockService.getMultipleStocks(symbolArray);
        
        // Create map for quick lookup: ticker → price data
        stocks.forEach(stock => {
          prices[stock.ticker] = stock;
        });
      } catch (error) {
        // Log error but don't crash
        logger.error(`Failed to fetch prices for broadcast: ${error.message}`);
        return;
      }

      // Send updates to each client (only their subscribed stocks)
      for (const [ws, symbols] of this.clientSubscriptions.entries()) {
        try {
          // Build update message with only subscribed stocks
          const updates = Array.from(symbols)
            .filter(symbol => prices[symbol])
            .map(symbol => ({
              type: 'PRICE_UPDATE',
              data: {
                ...prices[symbol],
                timestamp: Date.now(),
              },
            }));

          // Send each update
          updates.forEach(update => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(update));
            }
          });
        } catch (error) {
          logger.error(`Error sending update to client: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`Error in broadcast loop: ${error.message}`);
    }
  }

  /**
   * getStats - Get WebSocket server statistics
   * 
   * @returns {object} - Server stats
   */
  getStats() {
    return {
      connectedClients: this.clients.size,
      totalSubscriptions: Array.from(this.clientSubscriptions.values())
        .reduce((sum, subs) => sum + subs.size, 0),
      updateInterval: this.updateInterval,
      port: this.port,
    };
  }
}

/**
 * USAGE EXAMPLE (in server.js)
 * =============================
 * 
 * import { WebSocketTicker } from './websocket/ticker.js';
 * 
 * // Create ticker
 * const ticker = new WebSocketTicker(
 *   stockService,
 *   5001,  // port
 *   5000   // update interval (5 seconds)
 * );
 * 
 * // Start on server init
 * await ticker.start();
 * 
 * // Stop on graceful shutdown
 * process.on('SIGTERM', async () => {
 *   await ticker.stop();
 *   process.exit(0);
 * });
 * 
 * CLIENT USAGE (Frontend JavaScript)
 * ====================================
 * 
 * // Open connection
 * const ws = new WebSocket('ws://localhost:5001');
 * 
 * // On connect
 * ws.onopen = () => {
 *   // Subscribe to stocks
 *   ws.send(JSON.stringify({
 *     type: 'SUBSCRIBE',
 *     symbols: ['HAL', 'BEL', 'HDFCBANK']
 *   }));
 * };
 * 
 * // Receive updates
 * ws.onmessage = (event) => {
 *   const msg = JSON.parse(event.data);
 *   
 *   if (msg.type === 'PRICE_UPDATE') {
 *     // Update UI with new price
 *     updateStockPrice(msg.data.ticker, msg.data.price);
 *   }
 * };
 * 
 * // Handle errors
 * ws.onerror = (error) => {
 *   console.error('WebSocket error:', error);
 * };
 * 
 * // Close connection
 * ws.close();
 */
