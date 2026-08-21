import { Server } from 'socket.io';
import { logger } from '../utils/logger.js';

export class StockSocket {
  constructor(httpServer, marketProvider) {
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
    this.pollIntervalMs = Math.max(
      1000,
      parseInt(process.env.PRICE_UPDATE_INTERVAL, 10) || 1000,
    );
    this.subscribedSymbols = new Set();
    this.poller = null;
    this.pollInFlight = false;
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
        this.subscribedSymbols.add(normalizedSymbol);
        socket.emit('subscribed', { symbol: normalizedSymbol });
        this._ensurePolling();
      });

      socket.on('unsubscribe', ({ symbol }) => {
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        if (!normalizedSymbol) return;
        socket.leave(normalizedSymbol);
        this._cleanupPolling(normalizedSymbol);
      });

      socket.on('disconnect', () => {
        logger.info(`Socket disconnected: ${socket.id}`);
        for (const symbol of [...this.subscribedSymbols]) {
          this._cleanupPolling(symbol);
        }
      });
    });
  }

  _ensurePolling() {
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
    const symbols = [...this.subscribedSymbols];
    if (!symbols.length || this.pollInFlight) return;

    this.pollInFlight = true;
    try {
      const quotes = await this.marketProvider.getMultipleStocks(symbols);
      for (const quote of quotes) {
        this.io.to(quote.ticker).emit('stockUpdate', {
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
}
