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
  try {
    redisClient = createClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB || 0),
      socket: {
        reconnectStrategy: (retries) => {
          // Exponential backoff: 100ms, 200ms, 400ms... up to 5 seconds
          const delay = Math.min(100 * Math.pow(2, retries), 5000);
          return delay;
        },
      },
    });

    // Handle connection events
    redisClient.on('error', (err) => {
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
        setTimeout(() => reject(new Error('Redis connection timed out')), 2000);
      })
    ]);
    logger.info('✓ Redis initialized and connected');

    return redisClient;
  } catch (error) {
    // GRACEFUL FALLBACK: Log warning but don't crash
    logger.warn(`⚠️  Redis not available: ${error.message}`);
    logger.info('   → App will work without caching (slower API responses)');
    logger.info('   → To enable caching: run "redis-server" in another terminal');
    if (redisClient) {
      try {
        await redisClient.disconnect();
      } catch (disconnectError) {
        logger.debug(`Redis disconnect skipped: ${disconnectError.message}`);
      }
    }
    redisClient = null; // Ensure client is null, not undefined
    return null; // Return null to indicate Redis failed
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
