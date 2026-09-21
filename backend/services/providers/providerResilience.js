/**
 * providerResilience.js
 * ========================
 * Phase 6B: makes an unhealthy upstream cheap instead of expensive.
 *
 * WHAT THE AUDIT ACTUALLY FOUND (measured against the real providers, not
 * assumed):
 *
 * 1. IndianAPI returns `429 Rate limit exceeded` in ~286ms with **no
 *    `Retry-After` header and no `x-ratelimit-*` headers at all** — the
 *    response carries a plain-text body and nothing else. So there is no
 *    server-supplied backoff to honour: the client must decide its own, and
 *    must not guess a quota it cannot see. 429 is already excluded from the
 *    provider's retry set, so there was no retry storm.
 *
 * 2. The real latency was never the 429. `getLiveQuote` blocked for the full
 *    10,003ms tool timeout on every call, because Angel One's FIRST call
 *    downloads a 151,599-instrument scrip master (measured: 22.8s cold,
 *    then ~345ms warm). Every early request timed out, the breaker opened,
 *    and live prices stayed unavailable for the rest of the process — a
 *    cold-start problem misread as a dead provider.
 *
 * 3. The circuit breaker could not see IndianAPI rate limiting at all:
 *    `CompanyResearchService.runSection` catches each section's error and
 *    resolves `{available:false}`, so the bundle RESOLVES successfully and
 *    `withBreaker` recorded a success. The breaker never opened, and every
 *    request re-hammered a provider that had already said no.
 *
 * This module supplies the three pieces that fix those, without touching
 * the existing per-provider circuit breaker (which stays exactly as it is
 * for genuine failures):
 *
 *   - RateLimitGate: after a 429, skip the network entirely for a backoff
 *     window instead of paying a round trip to be told no again.
 *   - InFlightRegistry: concurrent identical requests share one promise, so
 *     two symbols in one comparison never issue the same call twice.
 *   - ReadinessRegistry: a provider that is warming up reports "not ready"
 *     immediately, so callers fail over to stored data in milliseconds
 *     instead of waiting out a timeout.
 *
 * Nothing here fabricates, substitutes, or caches a VALUE. It only decides
 * whether a call is worth making right now.
 */
import { logger } from '../../utils/logger.js';
import { emitEvent } from '../telemetry/ragTelemetry.js';

// Backoff schedule used when a provider rate-limits us. Chosen by us, not
// by the server, because this provider sends no Retry-After. Capped so a
// long outage never parks a provider for an unbounded time, and so the next
// legitimate request gets a chance reasonably soon.
export const RATE_LIMIT_BACKOFF_MS = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000]);

/**
 * RateLimitGate - one per provider. While the gate is closed, callers are
 * told to skip immediately; the network is never touched.
 */
export class RateLimitGate {
  constructor(name, { backoff = RATE_LIMIT_BACKOFF_MS, now = () => Date.now() } = {}) {
    this.name = name;
    this.backoff = backoff;
    this.now = now;
    this.blockedUntil = 0;
    this.consecutive = 0;
    this.totalRateLimits = 0;
    this.skippedCalls = 0;
    this.lastRateLimitedAt = null;
  }

  /** True when a call should NOT be attempted right now. */
  isBlocked() {
    return this.now() < this.blockedUntil;
  }

  /** Milliseconds until the gate reopens (0 when open). */
  retryAfterMs() {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Records a 429 and extends the backoff window. */
  recordRateLimited() {
    const index = Math.min(this.consecutive, this.backoff.length - 1);
    const waitMs = this.backoff[index];
    this.consecutive += 1;
    this.totalRateLimits += 1;
    this.lastRateLimitedAt = new Date(this.now()).toISOString();
    this.blockedUntil = this.now() + waitMs;
    logger.warn(`[provider-resilience] ${this.name} rate-limited; skipping calls for ${waitMs}ms (consecutive ${this.consecutive})`);
    emitEvent('dependency.failure', {
      tool: this.name, toolStatus: 'RATE_LIMITED', durationMs: waitMs,
    });
    return waitMs;
  }

  /** A call that got through and succeeded — the provider is serving us again. */
  recordSuccess() {
    if (this.consecutive > 0) {
      logger.info(`[provider-resilience] ${this.name} recovered after ${this.consecutive} rate-limited window(s)`);
    }
    this.consecutive = 0;
    this.blockedUntil = 0;
  }

  /** Counts a call this gate prevented, for telemetry. */
  countSkip() {
    this.skippedCalls += 1;
  }

  getStatus() {
    return {
      provider: this.name,
      blocked: this.isBlocked(),
      retryAfterMs: this.retryAfterMs(),
      consecutiveRateLimits: this.consecutive,
      totalRateLimits: this.totalRateLimits,
      callsSkipped: this.skippedCalls,
      lastRateLimitedAt: this.lastRateLimitedAt,
    };
  }

  __resetForTests() {
    this.blockedUntil = 0; this.consecutive = 0; this.totalRateLimits = 0;
    this.skippedCalls = 0; this.lastRateLimitedAt = null;
  }
}

/**
 * InFlightRegistry - de-duplicates concurrent identical work.
 *
 * A single comparison fans out to several tools per symbol, and two
 * comparisons can overlap. Without this, the same symbol's fetch is issued
 * repeatedly while the first is still in flight — wasted quota against a
 * provider that is already rate-limiting us.
 */
export class InFlightRegistry {
  constructor() {
    this.pending = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** Runs `fn` for `key`, or joins the call already running for it. */
  async run(key, fn) {
    const existing = this.pending.get(key);
    if (existing) {
      this.hits += 1;
      return existing;
    }
    this.misses += 1;
    // The promise is registered BEFORE awaiting, so a caller arriving on the
    // same tick joins it rather than starting a second call.
    const promise = (async () => fn())().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  getStatus() {
    return { inFlight: this.pending.size, deduplicated: this.hits, issued: this.misses };
  }

  __resetForTests() { this.pending.clear(); this.hits = 0; this.misses = 0; }
}

/**
 * ReadinessRegistry - tracks providers that need warming before they can
 * serve, so a cold provider is a fast "not ready" rather than a timeout.
 *
 * Angel One is the case this exists for: its first call downloads a
 * 151,599-row scrip master (22.8s measured). Waiting for that on a user's
 * request burns the whole tool budget; reporting "warming" lets the turn
 * fall back to stored market history in milliseconds and still answer.
 */
export class ReadinessRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.state = new Map(); // name -> { status, since, error }
  }

  markWarming(name) { this.state.set(name, { status: 'WARMING', since: this.now(), error: null }); }
  markReady(name) { this.state.set(name, { status: 'READY', since: this.now(), error: null }); }
  markFailed(name, error) {
    this.state.set(name, { status: 'FAILED', since: this.now(), error: error?.message ? String(error.message).slice(0, 120) : 'warmup failed' });
  }

  /** UNKNOWN means nothing has claimed this provider needs warming — callers proceed normally. */
  statusOf(name) { return this.state.get(name)?.status || 'UNKNOWN'; }

  /** True only when we positively know the provider cannot serve yet. */
  isWarming(name) { return this.statusOf(name) === 'WARMING'; }

  getStatus() {
    return Object.fromEntries([...this.state.entries()].map(([name, entry]) => [name, {
      status: entry.status,
      sinceMs: this.now() - entry.since,
      error: entry.error,
    }]));
  }

  __resetForTests() { this.state.clear(); }
}

// --- process-wide instances -------------------------------------------------

export const rateLimitGates = new Map();
export const getRateLimitGate = (name) => {
  if (!rateLimitGates.has(name)) rateLimitGates.set(name, new RateLimitGate(name));
  return rateLimitGates.get(name);
};

export const inFlight = new InFlightRegistry();
export const readiness = new ReadinessRegistry();

/**
 * isRateLimitError - recognises this provider's 429 shape. The body is
 * plain text ("Rate limit exceeded") and the mapped error code is
 * RATE_LIMITED, so both are accepted.
 */
export const isRateLimitError = (error) => {
  if (!error) return false;
  if (error.errorCode === 'RATE_LIMITED' || error.code === 'RATE_LIMITED') return true;
  const status = error.response?.status ?? error.status ?? error.httpStatus;
  if (status === 429) return true;
  return /rate limit/i.test(String(error.message || ''));
};

/**
 * withRateLimitGate - wraps a provider call. Skips instantly while the gate
 * is closed; records 429s and successes so the window adapts.
 *
 * Returns `{ skipped: true, retryAfterMs }` rather than throwing when
 * blocked, so the caller can fail over to stored data deliberately.
 */
export const withRateLimitGate = async (providerName, fn) => {
  const gate = getRateLimitGate(providerName);
  if (gate.isBlocked()) {
    gate.countSkip();
    return { skipped: true, retryAfterMs: gate.retryAfterMs(), value: undefined };
  }
  try {
    const value = await fn();
    gate.recordSuccess();
    return { skipped: false, value };
  } catch (error) {
    if (isRateLimitError(error)) gate.recordRateLimited();
    throw error;
  }
};

/** Everything the ops endpoint reports about provider health. */
export const getProviderResilienceStatus = () => ({
  rateLimitGates: Object.fromEntries([...rateLimitGates.entries()].map(([name, gate]) => [name, gate.getStatus()])),
  inFlight: inFlight.getStatus(),
  readiness: readiness.getStatus(),
});

export default {
  RateLimitGate, InFlightRegistry, ReadinessRegistry,
  getRateLimitGate, inFlight, readiness,
  withRateLimitGate, isRateLimitError, getProviderResilienceStatus,
  RATE_LIMIT_BACKOFF_MS,
};
