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
import { AngelOneProvider } from './providers/AngelOneProvider.js';
import { initializeRedis, closeRedis, getRedisClient } from './utils/redisClient.js';
import { livenessHandler, createReadinessHandler } from './utils/healthHandlers.js';
import { formatErrorResponse, getHttpStatus } from './utils/errorHandler.js';
import { logger } from './utils/logger.js';
import { StockSocket } from './socket/stock.socket.js';
import { LivePriceService } from './services/live-price.service.js';
import { AngelWebSocketService } from './services/angel-websocket.service.js';
import authRoutes from './routes/auth.js';
import newsRoute from './routes/news.js';
import { createGoalRoutes } from './routes/goals.js';
import earningsIntelligenceRoute from './routes/earningsIntelligence.js';
import { seedHistoricalIntelligence } from './scripts/seedHistoricalIntelligence.js';
import { createPortfolioRoutes } from './routes/portfolio.js';
import { createWatchlistRoutes } from './routes/watchlist.js';
import { startChatRateLimitCleanup } from './middleware/chatRateLimit.js';

dotenv.config();

// Mongo connection state, tracked independently of mongoose's own
// readyState so /ready can report a specific reason ("connecting" vs
// "never attempted" vs "failed") without an extra DB round-trip -- the
// readiness check below only ever reads this in-memory value, never
// issues its own query.
let mongoConnectAttempted = false;
let mongoLastError = null;

const MONGO_CONNECT_RETRY_DELAYS_MS = [1000, 3000, 8000, 15000, 30000];

/**
 * connectMongoWithRetry - bounded retry (never infinite, never blocking
 * Express startup) for the *initial* connection. Once mongoose is
 * connected once, its own driver handles reconnection on drops -- this
 * loop only covers "never connected yet" (e.g. Atlas cold-starting at the
 * same moment as this Render instance).
 */
const connectMongoWithRetry = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
  mongoConnectAttempted = true;

  for (let attempt = 0; attempt <= MONGO_CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
      logger.info('MongoDB connected successfully');
      mongoLastError = null;
      return;
    } catch (error) {
      mongoLastError = error.message;
      const delay = MONGO_CONNECT_RETRY_DELAYS_MS[attempt];
      if (delay == null) {
        logger.error(`MongoDB connection failed after ${attempt + 1} attempts: ${error.message}. Requests needing the database will queue/fail until it recovers.`);
        return;
      }
      logger.warn(`MongoDB connection attempt ${attempt + 1} failed (${error.message}); retrying in ${delay}ms`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, delay); });
    }
  }
};

const app = express();

const configuredCorsOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (configuredCorsOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== 'production' && !configuredCorsOrigins.length) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

// Liveness: must respond the instant Express is listening, independent of
// Mongo/Redis/any other dependency -- this is what a cold-start wake-up
// probe polls. Never touches the database.
app.get('/health', livenessHandler);
app.get('/api/health', livenessHandler);

// Readiness: reports whether the app's real dependencies are usable yet.
// Every check here reads already-tracked in-memory state (mongoose's own
// connection.readyState, the redis client's isOpen flag) -- no query, no
// ping, no unbounded wait, so this always answers instantly. Redis is
// optional (caching only) and never affects the ready/not-ready verdict;
// Mongo is required by most routes, so it does.
const readinessHandler = createReadinessHandler({
  getMongoReadyState: () => mongoose.connection.readyState,
  mongoAttempted: () => mongoConnectAttempted,
  getMongoLastError: () => mongoLastError,
  getRedisClient,
});
app.get('/ready', readinessHandler);
app.get('/api/ready', readinessHandler);

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
  logger.debug(`Incoming request ${req.method} ${req.url}`);
  next();
});

app.use('/api/chat', chatRoute);
app.use('/api/auth', authRoutes);

let server = null;

/**
 * startServer - synchronous from here down (no `await`) until app.listen()
 * fires. Route registration and provider construction do no I/O, so they
 * are safe to run before the port is bound. Mongo/Redis/seed data are all
 * moved to a background task kicked off *after* listen -- a slow or
 * failing dependency must never delay accepting the first HTTP connection
 * (that delay was previously exactly what a Render wake-up looked like:
 * connectMongo + seedHistoricalIntelligence + initializeRedis were all
 * awaited before app.listen, so the liveness endpoint itself only became
 * reachable once all three had finished).
 */
const startServer = () => {
  const PORT = process.env.PORT || 5001;
  const marketProvider = (process.env.MARKET_DATA_PROVIDER || 'angel-one').toLowerCase();

  let provider;
  if (marketProvider === 'angel-one' || marketProvider === 'angelone' || marketProvider === 'angel') {
    provider = new AngelOneProvider();
    logger.info('Using Angel One provider for NSE/BSE market data');
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
    if (marketProvider.includes('finnhub')) {
      const finnhubApiKey = process.env.FINNHUB_API_KEY;
      if (!finnhubApiKey) {
        logger.error('Missing FINNHUB_API_KEY. Set FINNHUB_API_KEY in .env before starting the server.');
        process.exit(1);
      }
      provider = new FinnhubProvider(finnhubApiKey);
      logger.info('Using Finnhub provider for market data');
    } else {
      provider = new AngelOneProvider();
      logger.info('Defaulting to Angel One provider for NSE/BSE market data');
    }
  }

  const stockService = new StockService(provider);
  const stockRoutes = createStockRoutes(stockService);
  app.use('/api/stocks', stockRoutes);
  app.use('/api/research', researchRoute);
  app.use('/api/news', newsRoute);
  app.use('/api/goals', createGoalRoutes(stockService));
  app.use('/api/portfolio', createPortfolioRoutes(stockService));
  app.use('/api/watchlist', createWatchlistRoutes(stockService));
  app.use('/api/earnings-intelligence', earningsIntelligenceRoute);
  app.use('/earnings-intelligence', earningsIntelligenceRoute);
  logger.info('Mounting route: /api/sector-rotation');
  app.use('/api/sector-rotation', sectorRotationRoute);
  logger.info('Mounted route: /api/sector-rotation');

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found', endpoint: req.originalUrl });
  });

  app.use((err, req, res, next) => {
    const payload = formatErrorResponse(err);
    const statusCode = getHttpStatus(err);
    logger.error(`HTTP ${statusCode} - ${err.message}`);
    res.status(statusCode).json(payload);
  });

  server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Backend API listening on 0.0.0.0:${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
  });

  const livePriceService = provider instanceof AngelOneProvider ? new LivePriceService() : null;
  const angelWebSocketService = livePriceService
    ? new AngelWebSocketService(provider, livePriceService)
    : null;
  const socketCorsOrigins = configuredCorsOrigins.length ? configuredCorsOrigins : (process.env.FRONTEND_URL || 'http://localhost:3000');
  const stockSocket = new StockSocket(server, provider, livePriceService, angelWebSocketService, { corsOrigins: socketCorsOrigins });
  stockSocket.start();

  startChatRateLimitCleanup();

  // Background startup: never awaited by anything on the request path.
  // Heavy/optional work (Mongo connect with retry, Redis cache warm-up,
  // demo historical-intelligence seeding) all happens here, after the
  // server is already accepting connections.
  (async () => {
    await connectMongoWithRetry();
    if (mongoose.connection.readyState === 1) {
      await seedHistoricalIntelligence().catch((err) => logger.warn(`Seed error: ${err.message}`));
    } else {
      logger.warn('Skipping demo historical-intelligence seed: MongoDB is not connected.');
    }
  })();

  initializeRedis().catch((err) => logger.warn(`Redis initialization error: ${err.message}`));

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      await closeRedis();
      await stockSocket.stop();
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

try {
  startServer();
} catch (error) {
  logger.error(`Failed to start server: ${error.message}`);
  process.exit(1);
}
