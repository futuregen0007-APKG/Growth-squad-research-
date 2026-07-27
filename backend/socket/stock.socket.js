import { Server } from 'socket.io';
import { logger } from '../utils/logger.js';
import { YahooFinanceService } from '../services/yahooFinance.service.js';

export class StockSocket {
  constructor(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
      },
    });
    this.yahooService = new YahooFinanceService();
    this.pollIntervalMs = parseInt(process.env.PRICE_UPDATE_INTERVAL, 10) || 5000;
    this.pollers = new Map();
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
        socket.emit('subscribed', { symbol: normalizedSymbol });
        this._ensurePolling(normalizedSymbol);
      });

      socket.on('unsubscribe', ({ symbol }) => {
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        if (!normalizedSymbol) return;
        socket.leave(normalizedSymbol);
        this._cleanupPolling(normalizedSymbol);
      });

      socket.on('disconnect', () => {
        logger.info(`Socket disconnected: ${socket.id}`);
        this._cleanupAllPolling();
      });
    });
  }

  _ensurePolling(symbol) {
    if (this.pollers.has(symbol)) {
      return;
    }

    const poller = setInterval(async () => {
      try {
        const quote = await this.yahooService.fetchQuote(symbol);
        this.io.to(symbol).emit('stockUpdate', {
          symbol: quote.symbol,
          price: quote.price,
          change: quote.change,
          percentage: quote.percentage,
          timestamp: quote.timestamp,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          previousClose: quote.previousClose,
          volume: quote.volume,
          companyName: quote.companyName,
        });
      } catch (error) {
        logger.warn(`Socket polling failed for ${symbol}: ${error.message}`);
        this.io.to(symbol).emit('stockUpdateError', {
          symbol,
          message: error.message,
        });
      }
    }, this.pollIntervalMs);

    this.pollers.set(symbol, poller);
  }

  _cleanupPolling(symbol) {
    const room = this.io.sockets.adapter.rooms.get(symbol);
    if (room && room.size > 0) {
      return;
    }

    const poller = this.pollers.get(symbol);
    if (poller) {
      clearInterval(poller);
      this.pollers.delete(symbol);
    }
  }

  _cleanupAllPolling() {
    for (const symbol of this.pollers.keys()) {
      this._cleanupPolling(symbol);
    }
  }
}
