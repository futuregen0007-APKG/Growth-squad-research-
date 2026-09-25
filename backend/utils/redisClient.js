/**
 * REDIS_CLIENT.JS
 * ================
 * Redis connection management and helper methods for caching.
 * 
 * WHY THIS FILE EXISTS:
 * - Centralizes Redis connection and configuration
 * - Provides helper methods for cache operations
 * - Handles reconnection and error scenarios
 * - Can be imported and used throughout the app
 * 
 * REDIS AS CACHE:
 * - Fast in-memory storage for frequently accessed data
 * - Reduces API calls to market data providers
 * - Significantly improves response time
 * 
 * KEY CONCEPTS:
 * 1. SET - Store data with expiration (TTL)
 * 2. GET - Retrieve cached data
 * 3. DEL - Remove cached data
 * 4. EXPIRE - Set expiration time
 */

import { createClient } from 'redis';
import { logger } from './logger.js';
import { createCacheError } from './errorHandler.js';

let redisClient = null;

// How many times a DROPPED connection is retried before giving up for good.
const MAX_RECONNECT_ATTEMPTS = 10;

// Used for both the socket's own connect timeout and the startup wait below.
const CONNECT_TIMEOUT_MS = 2000;

/**
 * redisReconnectStrategy - bounded backoff: 200ms, 400ms, 600ms ... capped at
 * 3s, and after MAX_RECONNECT_ATTEMPTS the client gives up for good and every
 * caller falls back to running without a cache.
 */
export const redisReconnectStrategy = (retries) => {
  if (retries >= MAX_RECONNECT_ATTEMPTS) return new Error('Redis reconnect attempts exhausted');
  return Math.min((retries + 1) * 200, 3000);
};

/**
 * buildRedisClientOptions - pure (no I/O) construction of the node-redis v4
 * `createClient` options. Precedence:
 *
 *   1. REDIS_URL (redis:// or rediss://) -- what hosted Redis/Key Value
 *      services hand out. The URL supplies host, port, TLS (rediss://),
 *      username, password and database; the socket options below
 *      (timeout, bounded reconnect) are kept alongside it.
 *   2. REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB.
 *   3. localhost:6379, no password, database 0 (a local Docker Redis).
 *
 * node-redis v4 only honors host/port under `socket` and the database under
 * `database`. The previous top-level `host`/`port`/`db` were silently
 * ignored, so every deployment connected to localhost:6379 whatever was
 * configured.
 *
 * An invalid REDIS_URL throws an error that never echoes the value, since
 * it may contain credentials.
 */
export const buildRedisClientOptions = (env = process.env) => {
  const socket = { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: redisReconnectStrategy };

  const url = String(env.REDIS_URL || '').trim();
  if (url) {
    let protocol = null;
    try { protocol = new URL(url).protocol; } catch { /* reported below without the value */ }
    if (protocol !== 'redis:' && protocol !== 'rediss:') {
      throw new Error('REDIS_URL is not a valid redis:// or rediss:// URL');
    }
    return { url, socket };
  }

  const options = { socket: { ...socket, host: env.REDIS_HOST || 'localhost', port: Number(env.REDIS_PORT) || 6379 } };
  if (env.REDIS_PASSWORD) options.password = env.REDIS_PASSWORD;
  const database = Number.parseInt(env.REDIS_DB, 10);
  if (database > 0) options.database = database;
  return options;
};

/** describeRedisTarget - "redis://host:port" or "rediss://host:port" for logs. Never includes credentials. */
export const describeRedisTarget = (options) => {
  if (options.url) {
    const { protocol, hostname, port } = new URL(options.url);
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  }
  return `redis://${options.socket.host}:${options.socket.port}`;
};

// Simple wrapper exports for convenience (backwards compatible)
const redisWrapper = {
  get: async (k) => {
    try {
      if (!redisClient) return null;
      const v = await redisClient.get(k);
      return v;
    } catch (e) {
      return null;
    }
  },
  setEx: async (k, ttl, v) => {
    try {
      if (!redisClient) return;
      await redisClient.setEx(k, ttl, typeof v === 'string' ? v : JSON.stringify(v));
    } catch (e) {
      // ignore
    }
  },
};

/**
 * initializeRedis - Connect to Redis server (graceful fallback)
 * 
 * Called once at application startup
 * Sets up error handlers and connection monitoring
 * 
 * GRACEFUL: If Redis fails to connect, app continues without caching
 * This ensures the app works even if Redis isn't available
 */
export const initializeRedis = async () => {
  let lastSocketError = null;
  let startupTimer = null;
  try {
    // Phase 5B: bounded reconnect (redisReconnectStrategy) replaced
    // `reconnectStrategy: false`, under which a dropped connection never came
    // back until the next deploy. The initial connect keeps its own short
    // timeout below, and a Redis that was never reachable still ends with a
    // null client and no retry loop.
    const options = buildRedisClientOptions(process.env);
    logger.info(`Redis: connecting to ${describeRedisTarget(options)}`);
    redisClient = createClient(options);

    // Handle connection events
    redisClient.on('error', (err) => {
      lastSocketError = err.message;
      logger.warn(`Redis error: ${err.message}`);
    });

    redisClient.on('connect', () => {
      logger.info('✓ Redis connected successfully - caching enabled');
    });

    redisClient.on('reconnecting', () => {
      logger.debug('Redis reconnecting...');
    });

    // Actually establish connection (with timeout)
    await Promise.race([
      redisClient.connect(),
      new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Redis connection timed out')), CONNECT_TIMEOUT_MS);
      })
    ]);
    logger.info('✓ Redis initialized and connected');

    return redisClient;
  } catch (error) {
    // GRACEFUL FALLBACK: Log warning but don't crash
    const cause = lastSocketError && lastSocketError !== error.message ? ` (last socket error: ${lastSocketError})` : '';
    logger.warn(`⚠️  Redis not available: ${error.message}${cause}`);
    logger.info('   → App will work without caching (slower API responses)');
    logger.info('   → To enable caching: set REDIS_URL (or REDIS_HOST/REDIS_PORT), or run redis locally');
    if (redisClient) {
      try {
        await redisClient.disconnect();
      } catch (disconnectError) {
        logger.debug(`Redis disconnect skipped: ${disconnectError.message}`);
      }
    }
    redisClient = null; // Ensure client is null, not undefined
    return null; // Return null to indicate Redis failed
  } finally {
    clearTimeout(startupTimer);
  }
};

/**
 * getRedisClient - Returns active Redis client instance (or null if unavailable)
 * 
 * GRACEFUL: Returns null if Redis isn't available instead of throwing
 * This allows the app to continue working without caching
 */
export const getRedisClient = () => {
  return redisClient; // Can be null if Redis unavailable
};

/**
 * setCache - Store data in Redis with expiration (graceful)
 * 
 * @param {string} key - Cache key (usually "stock:HAL" format)
 * @param {object} data - Data to cache (will be JSON stringified)
 * @param {number} ttl - Time to live in seconds
 * 
 * EXAMPLE:
 * await setCache('stock:HAL', { price: 4521, change: 2.84 }, 300);
 * 
 * GRACEFUL: If Redis unavailable, silently skip caching
 */
export const setCache = async (key, data, ttl) => {
  try {
    const client = getRedisClient();
    if (!client) {
      // Redis not available - skip caching silently
      return;
    }
    const jsonData = JSON.stringify(data);
    await client.setEx(key, ttl, jsonData);
    logger.debug(`Cache SET: ${key} (TTL: ${ttl}s)`);
  } catch (error) {
    // Don't throw - cache errors shouldn't crash the app
    logger.debug(`Cache SET skipped for ${key}: ${error.message}`);
  }
};

/**
 * getCache - Retrieve data from Redis (graceful)
 * 
 * @param {string} key - Cache key to retrieve
 * @returns {object|null} - Cached data or null if not found/expired/unavailable
 * 
 * EXAMPLE:
 * const cachedData = await getCache('stock:HAL');
 * 
 * GRACEFUL: If Redis unavailable, returns null (forces fresh fetch)
 */
export const getCache = async (key) => {
  try {
    const client = getRedisClient();
    if (!client) {
      // Redis not available - return null to force fresh fetch
      return null;
    }
    const data = await client.get(key);
    if (data) {
      logger.debug(`Cache HIT: ${key}`);
      return JSON.parse(data);
    }
    logger.debug(`Cache MISS: ${key}`);
    return null;
  } catch (error) {
    logger.debug(`Cache GET skipped for ${key}: ${error.message}`);
    return null; // Return null on error - force fresh fetch
  }
};

/**
 * deleteCache - Remove data from Redis
 * 
 * @param {string} key - Cache key to delete
 * 
 * USE CASES:
 * - After updating stock price
 * - When data becomes stale
 * - Manual cache invalidation
 */
export const deleteCache = async (key) => {
  try {
    const client = getRedisClient();
    await client.del(key);
    logger.debug(`Cache DELETE: ${key}`);
  } catch (error) {
    logger.error(`Cache DELETE failed for ${key}: ${error.message}`);
  }
};

/**
 * flushCache - Clear all cached data (useful for development/testing)
 * 
 * WARNING: Clears entire Redis database!
 */
export const flushCache = async () => {
  try {
    const client = getRedisClient();
    await client.flushDb();
    logger.warn('Cache flushed - all data cleared');
  } catch (error) {
    logger.error(`Cache flush failed: ${error.message}`);
  }
};

/**
 * closeRedis - Gracefully close Redis connection
 * 
 * Called during application shutdown
 */
export const closeRedis = async () => {
  try {
    if (redisClient) {
      await redisClient.quit();
      redisClient = null;
      logger.info('Redis connection closed');
    }
  } catch (error) {
    logger.error(`Error closing Redis: ${error.message}`);
  }
};

export default redisWrapper;
