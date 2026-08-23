import { Server } from 'socket.io';
import { logger } from '../utils/logger.js';

export class StockSocket {
  constructor(httpServer, marketProvider, livePriceService = null, angelWebSocketService = null) {
    if (!marketProvider) {
      throw new Error('Market provider is required');
    }

    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
      },
    });
    this.marketProvider = marketProvider;
    this.livePriceService = livePriceService;
    this.angelWebSocketService = angelWebSocketService;
    this.pollIntervalMs = Math.max(
      1000,
      parseInt(process.env.PRICE_UPDATE_INTERVAL, 10) || 1000,
    );
    this.subscribedSymbols = new Set();
    this.poller = null;
    this.pollInFlight = false;
    this.clientSubscriptions = new Map();

    if (this.livePriceService) {
      this.livePriceService.on('price', (price) => {
        this.io.to(price.symbol).emit('stockUpdate', {
          type: 'PRICE_UPDATE',
          symbol: price.symbol,
          token: price.token,
          exchange: price.exchange,
          price: price.ltp,
          ltp: price.ltp,
          timestamp: price.timestamp,
        });
      });
    }
  }

  start() {
    this.io.on('connection', (socket) => {
      logger.info(`Socket connected: ${socket.id}`);

      socket.on('subscribe', async ({ symbol }) => {
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        if (!normalizedSymbol) {
          socket.emit('stockUpdateError', { message: 'Symbol is required' });
          return;
        }

        socket.join(normalizedSymbol);
        const subscriptions = this.clientSubscriptions.get(socket) || new Set();
        subscriptions.add(normalizedSymbol);
        this.clientSubscriptions.set(socket, subscriptions);
        this.subscribedSymbols.add(normalizedSymbol);
        socket.emit('subscribed', { symbol: normalizedSymbol });
        if (typeof this.marketProvider.getMarketStatus === 'function') {
          socket.emit('marketStatus', await this.marketProvider.getMarketStatus());
        }

        if (this.angelWebSocketService) {
          try {
            await this.angelWebSocketService.subscribe(normalizedSymbol);
            const latest = this.livePriceService.get(normalizedSymbol);
            if (latest) this._emitLivePrice(socket, latest);
          } catch (error) {
            logger.error(`[AngelWS] Failed to subscribe ${normalizedSymbol}: ${error.message}`);
            socket.emit('stockUpdateError', { symbol: normalizedSymbol, message: error.message });
          }
        } else {
          this._ensurePolling();
        }
      });

      socket.on('unsubscribe', ({ symbol }) => {
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        if (!normalizedSymbol) return;
        socket.leave(normalizedSymbol);
        this.clientSubscriptions.get(socket)?.delete(normalizedSymbol);
        this._cleanupPolling(normalizedSymbol);
        if (this.angelWebSocketService && !this._hasSubscribers(normalizedSymbol)) {
          this.angelWebSocketService.unsubscribe(normalizedSymbol);
        }
      });

      socket.on('disconnect', () => {
        logger.info(`Socket disconnected: ${socket.id}`);
        const subscriptions = this.clientSubscriptions.get(socket) || new Set();
        this.clientSubscriptions.delete(socket);
        for (const symbol of subscriptions) {
          this._cleanupPolling(symbol);
          if (this.angelWebSocketService && !this._hasSubscribers(symbol)) {
            this.angelWebSocketService.unsubscribe(symbol);
          }
        }
      });
    });
  }

  _ensurePolling() {
    if (this.angelWebSocketService) return;
    if (this.poller) {
      return;
    }

    this.poller = setInterval(() => this._pollSubscribedStocks(), this.pollIntervalMs);
    this._pollSubscribedStocks();
  }

  _cleanupPolling(symbol) {
    const room = this.io.sockets.adapter.rooms.get(symbol);
    if (room && room.size > 1) {
      return;
    }

    this.subscribedSymbols.delete(symbol);
    if (this.subscribedSymbols.size === 0 && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  _cleanupAllPolling() {
    for (const symbol of this.subscribedSymbols) {
      this._cleanupPolling(symbol);
    }
  }

  async _pollSubscribedStocks() {
    if (this.angelWebSocketService) return;
    const symbols = [...this.subscribedSymbols];
    if (!symbols.length || this.pollInFlight) return;

    this.pollInFlight = true;
    try {
      const quotes = await this.marketProvider.getMultipleStocks(symbols);
      for (const quote of quotes) {
        this.io.to(quote.ticker).emit('stockUpdate', {
          type: 'PRICE_UPDATE',
          symbol: quote.ticker,
          price: quote.price,
          change: quote.change,
          percentage: quote.changePct,
          timestamp: quote.timestamp,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          previousClose: quote.previousClose,
          volume: quote.volume,
          companyName: quote.companyName,
        });
      }
    } catch (error) {
      logger.warn(`Socket polling failed for ${symbols.length} symbols: ${error.message}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  _hasSubscribers(symbol) {
    for (const subscriptions of this.clientSubscriptions.values()) {
      if (subscriptions.has(symbol)) return true;
    }
    return false;
  }

  _emitLivePrice(socket, price) {
    if (socket.connected) {
      socket.emit('stockUpdate', {
        type: 'PRICE_UPDATE',
        symbol: price.symbol,
        token: price.token,
        exchange: price.exchange,
        price: price.ltp,
        ltp: price.ltp,
        timestamp: price.timestamp,
      });
    }
  }

  async stop() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.angelWebSocketService) await this.angelWebSocketService.stop();
    this.io.close();
  }
}
