/**
 * toolCache.js
 * ==============
 * Bounded, in-process TTL cache for GS Copilot's tool layer ONLY — an
 * "optional acceleration layer" (per Phase 1 spec), never a source of
 * truth. Redis stays optional and untouched; this is deliberately simpler
 * than a Redis-backed cache because chat tool results are small,
 * short-lived, and already have a durable source of truth elsewhere
 * (CompanyResearchService's own bundle cache, the underlying Mongo
 * snapshots, etc.) — this cache only avoids re-fetching the SAME
 * (tool, normalized args) pair from a live provider within its TTL window.
 *
 * Explicitly NEVER used for: getWatchlist, getPortfolio, or any other
 * authenticated/user-scoped data (see toolRegistry.js — those tools never
 * call into this module at all, not even with a short TTL) — caching
 * portfolio/watchlist data, even briefly and even per-user, is out of
 * scope for this phase; those tools always hit their real source.
 *
 * Per-data-type TTLs (shorter for anything price-like, longer for
 * slower-changing research artifacts):
 */
export const CACHE_TTL_MS = Object.freeze({
  LIVE_QUOTE: 15000, // 15s -- a live price must stay close to real-time
  COMPANY_NEWS: 10 * 60 * 1000, // 10 min
  EARNINGS_TIMELINE: 30 * 60 * 1000, // 30 min -- promise/outcome data changes slowly
  RESEARCH_DOCUMENTS: 30 * 60 * 1000, // 30 min
  // UI Phase 1C.3: durable NSE-bhavcopy daily closes update at most once
  // per trading day -- same slow-changing rationale as EARNINGS_TIMELINE.
  PRICE_HISTORY: 30 * 60 * 1000, // 30 min
  // Deliberately NOT listed: company research/financials. CompanyResearchService
  // already caches its bundle in-process for 5 minutes (see
  // services/CompanyResearchService.js) -- adding a second cache layer here
  // for the same data would just be redundant complexity, not a real speedup.
});

const store = new Map(); // key -> { value, expiresAt, storedAt }

/**
 * getOrCompute - returns a cached value if present and unexpired
 * (cacheStatus: 'HIT'), otherwise calls `computeFn`, caches a *successful*
 * result, and returns it (cacheStatus: 'MISS'). A computeFn rejection is
 * never cached — an error must never be replayed as if it were real,
 * successful data. `now` is injectable for deterministic fake-clock tests.
 */
export const getOrCompute = async (key, ttlMs, computeFn, { now = () => Date.now() } = {}) => {
  const existing = store.get(key);
  if (existing && existing.expiresAt > now()) {
    return { value: existing.value, cacheStatus: 'HIT', storedAt: existing.storedAt };
  }
  const value = await computeFn();
  store.set(key, { value, expiresAt: now() + ttlMs, storedAt: now() });
  return { value, cacheStatus: 'MISS', storedAt: now() };
};

/** Builds a cache key from a tool name + normalized args + an optional data-version tag (e.g. a snapshot's own dataAsOf) so a stale key can never silently outlive the data it was built from. */
export const buildCacheKey = (toolName, normalizedArgsString, dataVersion = null) => `${toolName}:${normalizedArgsString}${dataVersion ? `:v=${dataVersion}` : ''}`;

/** Test-only: clears every cached entry. Never used by app code. */
export const __clearToolCacheForTests = () => store.clear();

export default { CACHE_TTL_MS, getOrCompute, buildCacheKey, __clearToolCacheForTests };
