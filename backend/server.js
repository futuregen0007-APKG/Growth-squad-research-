import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import mongoose from 'mongoose';

import chatRoute from './routes/chat.js';
import researchRoute from './routes/research.js';
import sectorRotationRoute from './routes/sectorRotation.js';
import { createStockRoutes } from './routes/stocks.js';
import { StockService } from './services/StockService.js';
import { FinnhubProvider } from './providers/FinnhubProvider.js';
import { TwelveDataProvider } from './providers/TwelveDataProvider.js';
import { FinancialModelingPrepProvider } from './providers/FinancialModelingPrepProvider.js';
import { YahooFinanceProvider } from './providers/YahooFinanceProvider.js';
import { initializeRedis, closeRedis } from './utils/redisClient.js';
import { formatErrorResponse, getHttpStatus } from './utils/errorHandler.js';
import { logger } from './utils/logger.js';
import { StockSocket } from './socket/stock.socket.js';
import authRoutes from './routes/auth.js';

dotenv.config();

const connectMongo = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000
    });
    logger.info('MongoDB connected successfully');
  } catch (error) {
    logger.error(`MongoDB connection failed: ${error.message}`);
    logger.error('Please ensure MongoDB is running and MONGODB_URI is set in .env');
    throw new Error('MongoDB connection required. Application cannot start without database.');
  }
};

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'ok', uptime: process.uptime() });
});

// Debug: list registered routes
app.get('/__routes', (req, res) => {
  try {
    const routes = [];
    app._router.stack.forEach((layer) => {
      if (layer.route && layer.route.path) {
        routes.push(Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`).join(', '));
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        layer.handle.stack.forEach((l) => {
          if (l.route && l.route.path) {
            routes.push(Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${layer.regexp ? layer.regexp : ''}${l.route.path}`).join(', '));
          }
        });
      }
    });
    res.json({ routes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res, next) => {
  console.log('Incoming request', req.method, req.url);
  next();
});

app.use('/api/chat', chatRoute);
app.use('/api/auth', (req, res, next) => {
  console.log('Auth middleware hit', req.method, req.url);
  next();
}, authRoutes);

let server = null;

const startServer = async () => {
  const port = parseInt(process.env.PORT, 10) || 5001;
  const marketProvider = (process.env.MARKET_DATA_PROVIDER || 'yahoo-finance').toLowerCase();

  await connectMongo();
  await initializeRedis();

  let provider;
  if (marketProvider === 'yahoo' || marketProvider === 'yahoo-finance' || marketProvider === 'yahoo-finance2' || marketProvider === 'yahoofinance') {
    provider = new YahooFinanceProvider();
    logger.info('Using Yahoo Finance provider for market data');
  } else if (marketProvider === 'financialmodelingprep' || marketProvider === 'financial-modeling-prep') {
    const fmpApiKey = process.env.FINANCIAL_MODELING_PREP_API_KEY;
    if (!fmpApiKey) {
      logger.error('Missing FINANCIAL_MODELING_PREP_API_KEY. Set FINANCIAL_MODELING_PREP_API_KEY in .env before starting the server.');
      process.exit(1);
    }
    provider = new FinancialModelingPrepProvider(fmpApiKey);
    logger.info('Using Financial Modeling Prep provider for market data');
  } else if (marketProvider === 'twelve-data' || marketProvider === 'twelvedata') {
    const twelveApiKey = process.env.TWELVE_DATA_API_KEY;
    if (!twelveApiKey) {
      logger.error('Missing TWELVE_DATA_API_KEY. Set TWELVE_DATA_API_KEY in .env before starting the server.');
      process.exit(1);
    }
    provider = new TwelveDataProvider(twelveApiKey);
    logger.info('Using Twelve Data provider for market data');
  } else {
    // If explicitly configured for Finnhub, use it; otherwise default to Yahoo Finance
    if (marketProvider.includes('finnhub')) {
      const finnhubApiKey = process.env.FINNHUB_API_KEY;
      if (!finnhubApiKey) {
        logger.error('Missing FINNHUB_API_KEY. Set FINNHUB_API_KEY in .env before starting the server.');
        process.exit(1);
      }
      provider = new FinnhubProvider(finnhubApiKey);
      logger.info('Using Finnhub provider for market data');
    } else {
      provider = new YahooFinanceProvider();
      logger.info('Defaulting to Yahoo Finance provider for market data');
    }
  }

  const stockService = new StockService(provider);
  const stockRoutes = createStockRoutes(stockService);
  app.use('/api/stocks', stockRoutes);
  app.use('/api/research', researchRoute);
  logger.info('Mounting route: /api/sector-rotation');
  app.use('/api/sector-rotation', sectorRotationRoute);
  logger.info('Mounted route: /api/sector-rotation');

  app.use((err, req, res, next) => {
    const payload = formatErrorResponse(err);
    const statusCode = getHttpStatus(err);
    logger.error(`HTTP ${statusCode} - ${err.message}`);
    res.status(statusCode).json(payload);
  });

  server = app.listen(port, () => {
    logger.info(`Server running on http://localhost:${port}`);
  });

  const stockSocket = new StockSocket(server);
  stockSocket.start();

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      await closeRedis();
      if (server) {
        server.close(() => {
          logger.info('HTTP server closed');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    } catch (shutdownError) {
      logger.error(`Shutdown error: ${shutdownError.message}`);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Promise rejection: ${reason}`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}`);
    shutdown('uncaughtException');
  });
};

startServer().catch((error) => {
  logger.error(`Failed to start server: ${error.message}`);
  process.exit(1);
});