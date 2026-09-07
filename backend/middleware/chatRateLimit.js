import { AppError } from '../utils/errorHandler.js';

/**
 * chatRateLimit.js
 * =================
 * Minimal in-memory per-user sliding-window rate limiter for GS Copilot.
 * No rate-limiting middleware exists anywhere else in this project (see
 * the Phase 1 audit — no express-rate-limit or similar is installed), so
 * this is a small, self-contained, dependency-free implementation scoped
 * only to chat endpoints. Fine for a single-process deployment; would need
 * a shared store (e.g. Redis) to be correct across multiple instances —
 * noted as a limitation, not silently pretended away.
 */

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 20;

const hits = new Map(); // userId -> array of timestamps

export const chatRateLimit = (req, res, next) => {
  const key = req.userId || req.ip;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const existing = (hits.get(key) || []).filter((ts) => ts > windowStart);
  if (existing.length >= MAX_REQUESTS_PER_WINDOW) {
    return next(new AppError('Too many requests — please slow down.', 429, 'RATE_LIMITED'));
  }

  existing.push(now);
  hits.set(key, existing);
  next();
};

/** Periodically drop stale keys so the map doesn't grow without bound. */
export const startChatRateLimitCleanup = () => setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, timestamps] of hits.entries()) {
    const fresh = timestamps.filter((ts) => ts > cutoff);
    if (fresh.length) hits.set(key, fresh);
    else hits.delete(key);
  }
}, WINDOW_MS).unref();

export default chatRateLimit;
