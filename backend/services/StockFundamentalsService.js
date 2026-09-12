/**
 * StockFundamentalsService.js
 * ============================
 * Fills the gap that made "Load Eligible Stocks" always come back empty:
 * StockService._enrichStockData() only ever merges in the live price
 * provider's own fields (Angel One: price/OHLC/volume), never P/E or ROE --
 * so every stock reaching GoalRecommendationService had zero fundamentals,
 * and (per the tightened eligibility rule in GoalRecommendationService.js)
 * a stock needs >=3 verified metrics spanning BOTH the historical and
 * fundamental categories to ever be rankable. Three historical-only metrics
 * can never be enough on their own, so real fundamentals are required, not
 * optional polish.
 *
 * This service extracts P/E and ROE from IndianAPI's keyMetrics (via the
 * existing IndianApiProvider), which is already fetched for the Earnings
 * Intelligence feature -- the same data source, reused, never invented.
 *
 * IndianAPI's keyMetrics categories are a fixed, empirically-confirmed set
 * (see IndianApiNormalizer.js's own comment): 'valuation' holds P/E-family
 * metrics, 'mgmtEffectiveness' holds ROE-family metrics. Each category is an
 * array of {name, value} line items with real, provider-authored display
 * names (e.g. "Return on average equity - 5 year average") -- there is no
 * single canonical "P/E" or "ROE" key, so this extracts by pattern-matching
 * the metric's own name rather than guessing one fixed key. If no matching
 * line item exists for a symbol, pe/roe are simply omitted (never defaulted
 * or fabricated), exactly like every other metric in this codebase.
 *
 * Caching: results are cached in Redis for 24h per symbol
 * (`fundamentals:<SYMBOL>`), and this module never calls the live API from
 * a request path -- only `scripts/refreshStockFundamentals.js` (or an
 * explicit on-demand admin call) performs live fetches, batched with a
 * delay to respect IndianAPI's rate limit. A cache miss on the read path
 * simply means "no fundamentals available yet," never a live fetch.
 */
import mongoose from 'mongoose';
import { getCache, setCache } from '../utils/redisClient.js';
import { IndianApiProvider } from '../providers/indian-api/IndianApiProvider.js';
import { logger } from '../utils/logger.js';
import StockFundamentalsSnapshot from '../models/StockFundamentalsSnapshot.js';
import { deriveFundamentalsFromHistoricalFacts } from './HistoricalFundamentalsDerivationService.js';

// Mongoose queries buffer (and eventually time out) rather than failing fast
// when there is no active connection -- fine in production (a connection is
// always established at startup) but costly in a unit test that
// deliberately runs without one. Every MongoDB read/write in this file
// checks this first and degrades to a no-op/null, exactly like a real
// connection failure would via the try/catch around it, just without the
// multi-second wait.
const isMongoConnected = () => mongoose.connection.readyState === 1;

const FUNDAMENTALS_CACHE_PREFIX = 'fundamentals:';
const FUNDAMENTALS_TTL_SECONDS = 24 * 60 * 60; // 24h -- precomputed daily, never per-click
const REFRESH_META_KEY = 'fundamentals:meta';
const REFRESH_META_TTL_SECONDS = 7 * 24 * 60 * 60; // outlives one refresh cycle so --resume can find it days later
// A Mongo snapshot younger than this is served as fresh (no isStale flag);
// older is still served (never treated as "no fundamentals") but flagged
// isStale so a caller/UI can be transparent about it, per the lookup
// priority: fresh Mongo snapshot before stale-but-verified Mongo snapshot.
const FRESH_SNAPSHOT_WINDOW_MS = 48 * 60 * 60 * 1000;

// Only these IndianAPI error codes represent a transient condition worth
// retrying (rate limit, timeout, upstream 5xx). Auth/config/not-found errors
// are never retried -- retrying them just burns quota for a guaranteed
// repeat failure.
const RETRYABLE_ERROR_CODES = new Set(['RATE_LIMITED', 'TIMEOUT', 'UPSTREAM_UNAVAILABLE']);
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Constructed lazily, on first use, rather than at module load -- IndianApiProvider
// reads process.env.INDIAN_API_KEY as a constructor default, and this module is
// imported (and its top-level code executed) before a calling script's own
// dotenv.config() runs, under plain ES module import ordering. Building the
// provider inside getProvider() defers that read until the first real call,
// by which point .env has always been loaded.
let providerInstance = null;
const getProvider = () => {
  if (!providerInstance) providerInstance = new IndianApiProvider();
  return providerInstance;
};

const PE_NAME_PATTERN = /\bp\s*\/?\s*e\b|price[\s-]*to[\s-]*earnings|price\/earnings/i;
const ROE_NAME_PATTERN = /return on (average )?equity/i;

/** Prefers a non-"5 year average" line item when both exist (a more current figure), but accepts the average as a genuine, real fallback rather than nothing. */
const pickBestMatch = (metrics, pattern) => {
  const matches = metrics.filter((m) => pattern.test(m.name));
  if (!matches.length) return null;
  const current = matches.find((m) => !/\d+[\s-]*year[\s-]*average/i.test(m.name));
  return current || matches[0];
};

const extractCategory = (categories, categoryKey) => (categories || []).find((c) => c.category === categoryKey)?.metrics || [];

/** Pure extraction from an already-fetched keyMetrics.categories array -- no I/O, easy to unit test. */
export const extractFundamentalsFromKeyMetrics = (categories) => {
  const valuation = extractCategory(categories, 'valuation');
  const mgmtEffectiveness = extractCategory(categories, 'mgmtEffectiveness');
  const peMatch = pickBestMatch(valuation, PE_NAME_PATTERN);
  const roeMatch = pickBestMatch(mgmtEffectiveness, ROE_NAME_PATTERN);
  return {
    pe: peMatch ? peMatch.value : null,
    peSourceLabel: peMatch ? peMatch.name : null,
    roe: roeMatch ? roeMatch.value : null,
    roeSourceLabel: roeMatch ? roeMatch.name : null,
  };
};

/**
 * upsertSnapshot - the ONLY write path to StockFundamentalsSnapshot. Merges
 * `patch` onto whatever is already stored: a field present (non-null) in
 * `patch` overwrites, a field absent/null in `patch` keeps the EXISTING
 * value (never replaces a valid metric with null/zero just because this
 * particular refresh didn't return it). Never throws -- a snapshot write
 * failure is logged and swallowed so it can never break the read path that
 * calls it.
 */
const upsertSnapshot = async (symbol, patch) => {
  if (!isMongoConnected()) return;
  try {
    const normalized = String(symbol).toUpperCase();
    const existing = await StockFundamentalsSnapshot.findOne({ symbol: normalized }).lean();
    const keep = (existingVal, newVal) => (newVal != null ? newVal : (existingVal ?? null));
    const set = {
      peRatio: keep(existing?.peRatio, patch.peRatio ?? patch.pe),
      roe: keep(existing?.roe, patch.roe),
      revenueGrowth: keep(existing?.revenueGrowth, patch.revenueGrowth),
      profitGrowth: keep(existing?.profitGrowth, patch.profitGrowth),
      operatingMargin: keep(existing?.operatingMargin, patch.operatingMargin),
      debtTrend: patch.debtTrend ?? existing?.debtTrend ?? null,
      source: patch.source || existing?.source,
      sourceUrl: patch.sourceUrl ?? existing?.sourceUrl ?? null,
      provenance: patch.provenance ?? existing?.provenance,
      dataAsOf: patch.dataAsOf ? new Date(patch.dataAsOf) : (existing?.dataAsOf ?? new Date()),
      lastSuccessfulRefresh: new Date(),
      missingMetrics: patch.missingMetrics ?? existing?.missingMetrics ?? [],
      isStale: false,
    };
    await StockFundamentalsSnapshot.findOneAndUpdate({ symbol: normalized }, { $set: set }, { upsert: true });
  } catch (error) {
    logger.warn(`[StockFundamentalsService] Snapshot write failed for ${symbol}: ${error.message}`);
  }
};

/**
 * Live fetch + cache write for one symbol, with bounded exponential-backoff
 * retry ONLY for transient errors (rate limit / timeout / upstream 5xx).
 * Never throws -- returns { status: 'OK'|'RATE_LIMITED'|'FAILED', record?, errorCode?, error? }
 * so a batch job can distinguish "quota exhausted, stop early" from
 * "this one symbol genuinely has no data" and continue past the latter.
 * On failure, the previous stale cache entry (if any) is left untouched --
 * a temporarily-unavailable provider must never erase yesterday's real data.
 * A successful fetch is ALSO durably persisted to MongoDB
 * (StockFundamentalsSnapshot) -- Redis is a performance cache in front of
 * that durable store, never the only copy (rule: a Redis miss/eviction must
 * never mean "no fundamentals").
 */
export const fetchAndCacheFundamentals = async (symbol, {
  getKeyMetricsFn, skipDelay = false, setCacheFn = setCache, persistSnapshotFn = upsertSnapshot,
} = {}) => {
  const normalized = String(symbol || '').toUpperCase();
  const cacheKey = `${FUNDAMENTALS_CACHE_PREFIX}${normalized}`;
  const fetcher = getKeyMetricsFn || ((sym) => getProvider().getKeyMetrics(sym));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const result = await fetcher(normalized);
      const extracted = extractFundamentalsFromKeyMetrics(result?.data?.categories);
      const record = { ...extracted, symbol: normalized, fetchedAt: new Date().toISOString() };
      await setCacheFn(cacheKey, record, FUNDAMENTALS_TTL_SECONDS);
      if (extracted.pe != null || extracted.roe != null) {
        await persistSnapshotFn(normalized, {
          peRatio: extracted.pe, roe: extracted.roe, source: 'INDIAN_API', sourceUrl: 'indian-api', dataAsOf: new Date(),
        });
      }
      return { status: 'OK', record };
    } catch (error) {
      const errorCode = error?.errorCode || null;
      const retryable = RETRYABLE_ERROR_CODES.has(errorCode);
      if (!retryable || attempt === MAX_RETRIES) {
        logger.warn(`[StockFundamentalsService] Failed to fetch fundamentals for ${normalized} (${errorCode || 'UNKNOWN'})${attempt > 0 ? ` after ${attempt + 1} attempts` : ''}: ${error.message}`);
        return { status: errorCode === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'FAILED', errorCode, error: error.message };
      }
      const backoffMs = BASE_BACKOFF_MS * (2 ** attempt);
      logger.warn(`[StockFundamentalsService] ${normalized}: ${errorCode} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${backoffMs}ms`);
      if (!skipDelay) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(backoffMs);
      }
    }
  }
  return { status: 'FAILED', errorCode: 'UNKNOWN', error: 'exhausted retries' };
};

/** Read-only, cache-only lookup -- the only function ever called from a request path (Load Eligible Stocks must never block on a live IndianAPI fetch). Serves stale cached data indefinitely if the provider is temporarily unavailable; a cache miss simply means "no fundamentals available yet." Kept for callers that only want the raw Redis-cached IndianAPI record; new callers should use getFundamentals below. */
export const getCachedFundamentals = async (symbol, { getCacheFn = getCache } = {}) => {
  const normalized = String(symbol || '').toUpperCase();
  const cached = await getCacheFn(`${FUNDAMENTALS_CACHE_PREFIX}${normalized}`);
  return cached || null;
};

/**
 * getFundamentals - the durable, priority-ordered lookup every request path
 * should use instead of getCachedFundamentals. Never calls the live
 * IndianAPI itself (that stays confined to scripts/refreshStockFundamentals.js,
 * out-of-request-path, respecting the rate limit) -- a symbol with nothing
 * in any of tiers 2-4 simply returns null, meaning "genuinely no verified
 * fundamentals yet", never a fabricated value. Order:
 *   2. Redis (fast path over the same IndianAPI data tier 1's caller may
 *      already have on the stock object itself -- that check is the
 *      caller's job, e.g. DynamicUniverseService's `stock.pe ?? ...`)
 *   3. Fresh MongoDB StockFundamentalsSnapshot (isStale: false)
 *   4. Stale-but-verified MongoDB snapshot (isStale: true) -- still real,
 *      still cited, just older than FRESH_SNAPSHOT_WINDOW_MS
 *   5. Derived from REAL_RESEARCH CompanyHistoricalFact (revenueGrowth,
 *      profitGrowth, operatingMargin, debtTrend only -- never pe/roe)
 */
export const getFundamentals = async (symbol, {
  getCacheFn = getCache, deriveFn = deriveFundamentalsFromHistoricalFacts, persistSnapshotFn = upsertSnapshot,
} = {}) => {
  const normalized = String(symbol || '').toUpperCase();

  const cached = await getCacheFn(`${FUNDAMENTALS_CACHE_PREFIX}${normalized}`);
  if (cached && (cached.pe != null || cached.roe != null)) {
    return {
      pe: cached.pe ?? null, roe: cached.roe ?? null, revenueGrowth: null, profitGrowth: null, operatingMargin: null, debtTrend: null,
      source: 'INDIAN_API', sourceUrl: 'indian-api', dataAsOf: cached.fetchedAt || new Date().toISOString(), isStale: false, missingMetrics: [],
    };
  }

  const snapshot = isMongoConnected() ? await StockFundamentalsSnapshot.findOne({ symbol: normalized }).lean().catch(() => null) : null;
  if (snapshot && (snapshot.peRatio != null || snapshot.roe != null || snapshot.revenueGrowth != null || snapshot.profitGrowth != null || snapshot.operatingMargin != null || snapshot.debtTrend?.direction != null)) {
    const isStale = Date.now() - new Date(snapshot.lastSuccessfulRefresh).getTime() > FRESH_SNAPSHOT_WINDOW_MS;
    return {
      pe: snapshot.peRatio, roe: snapshot.roe, revenueGrowth: snapshot.revenueGrowth, profitGrowth: snapshot.profitGrowth,
      operatingMargin: snapshot.operatingMargin, debtTrend: snapshot.debtTrend?.direction ? snapshot.debtTrend : null,
      source: snapshot.source, sourceUrl: snapshot.sourceUrl, provenance: snapshot.provenance,
      dataAsOf: snapshot.dataAsOf, isStale, missingMetrics: snapshot.missingMetrics || [],
    };
  }

  const derived = await deriveFn(normalized).catch((error) => {
    logger.warn(`[StockFundamentalsService] Historical-facts derivation failed for ${normalized}: ${error.message}`);
    return null;
  });
  if (derived) {
    await persistSnapshotFn(normalized, { ...derived, source: 'REAL_RESEARCH_DERIVED' });
    return {
      pe: null, roe: null, ...derived, source: 'REAL_RESEARCH_DERIVED', sourceUrl: derived.provenance?.sourceUrls?.[0] || null, isStale: false,
    };
  }

  return null;
};

/** Refresh-run progress/status, read by callers (e.g. an admin endpoint) and written incrementally by refreshStockFundamentals.js so a run can resume after a quota outage instead of restarting the whole universe. */
export const getRefreshMeta = async () => (await getCache(REFRESH_META_KEY)) || {
  lastSuccessfulRefresh: null, providerStatus: 'UNKNOWN', completedSymbols: [], failedSymbols: [],
};

export const saveRefreshMeta = async (meta) => setCache(REFRESH_META_KEY, meta, REFRESH_META_TTL_SECONDS);

export default {
  extractFundamentalsFromKeyMetrics, fetchAndCacheFundamentals, getCachedFundamentals, getFundamentals, getRefreshMeta, saveRefreshMeta,
};
