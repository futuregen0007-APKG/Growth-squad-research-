/**
 * toolRegistry.js
 * ================
 * Thin, typed adapters around this project's EXISTING services — the only
 * capabilities GS Copilot's model is ever allowed to invoke. No tool here
 * duplicates a provider implementation; each one calls the real service
 * that already backs the corresponding REST endpoint (Angel One for
 * prices, CompanyResearchService/IndianAPI for fundamentals, Earnings
 * Intelligence services for promises, DocumentResearchService for
 * filings, NewsAPIService for news, Watchlist/PortfolioHolding models
 * scoped by userId).
 *
 * Every tool returns the common shape:
 *   { tool, status: SUCCESS|EMPTY|UNAVAILABLE|UNSUPPORTED|ERROR, data,
 *     evidence, resultCount, evidenceCount, errorCode, fetchedAt, warning }
 * and NEVER throws — a failing tool is reported as ERROR/UNAVAILABLE so
 * one bad tool call never discards the others (Promise.allSettled at the
 * executeTools node handles the fan-out).
 *
 * STATUS/REASON DISCIPLINE (see graph/safeReasons.js):
 *   - A real provider infrastructure failure (auth, rate limit, timeout,
 *     upstream down, misconfigured base URL) is UNAVAILABLE, never EMPTY —
 *     collapsing "the provider is broken" into "there's no data" hides the
 *     real cause and was a confirmed bug (CompanyResearchService's
 *     `available: false` conflated both cases; this file now inspects the
 *     actual error code from each section instead of just the boolean).
 *   - A capability the provider genuinely doesn't support is UNSUPPORTED,
 *     never UNAVAILABLE/EMPTY.
 *   - `warning` is always one of the fixed SAFE_REASONS phrases — never a
 *     raw provider error string.
 */

import { StockService } from '../../services/StockService.js';
import { getLiveMarketDataProvider } from '../../providers/ProviderRegistry.js';
import { getCompanyResearchBundle } from '../../services/CompanyResearchService.js';
import { getStockNews } from '../../services/NewsAPIService.js';
import { getCompanyTimeline, getCompanyPromises } from '../../services/ManagementPromiseService.js';
import { collectDocuments } from '../../research/DocumentResearchService.js';
import ManagementPromise from '../../models/ManagementPromise.js';
import Watchlist from '../../models/Watchlist.js';
import PortfolioHolding from '../../models/PortfolioHolding.js';
import { buildEvidenceRecord } from '../evidence.js';
import { buildResearchEvidenceEnvelope } from '../../services/EvidenceEnvelope.js';
import { getVerifiedAnnotationsByChunkIds } from '../../services/guidanceAnnotationLookup.js';
import { retrieveResearchEvidence, RETRIEVAL_MODES, RETRIEVAL_STATUS } from '../../services/ResearchRetrieverService.js';
import { SUPPORTED_STOCKS } from '../../utils/constants.js';
import { DEFAULT_COMPARISON_DIMENSIONS } from '../dimensions.js';
import { fingerprintToolCall } from '../toolFingerprint.js';
import { SAFE_REASONS, classifyErrorCode } from '../safeReasons.js';
import { boundedTimeout } from '../requestBudget.js';
import { getProviderBreaker, isBreakerCountedFailure } from './circuitBreaker.js';
import { getOrCompute, buildCacheKey, CACHE_TTL_MS } from './toolCache.js';
import { logger } from '../../utils/logger.js';

export const TOOL_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS', EMPTY: 'EMPTY', UNAVAILABLE: 'UNAVAILABLE', UNSUPPORTED: 'UNSUPPORTED', ERROR: 'ERROR',
});

const countOf = (data) => {
  if (data == null) return 0;
  if (Array.isArray(data)) return data.length;
  return 1;
};

// `meta` carries the Phase 1 diagnostic extras a tool call may know about —
// cacheStatus ('HIT'|'MISS', omitted when this tool never caches),
// circuitState (the provider breaker's state at call time, omitted when
// this tool has no breaker), cancellationMode ('HARD' when the underlying
// call genuinely accepted the abort signal, 'SOFT' when this tool only
// stopped awaiting it — see toolRegistry.js's module note and the Phase 1
// report's "cancellation limitations"). Never a raw provider payload.
const result = (tool, status, data, evidence = [], warning = null, errorCode = null, meta = {}) => ({
  tool,
  status,
  data,
  evidence,
  resultCount: countOf(data),
  evidenceCount: evidence.length,
  errorCode,
  fetchedAt: new Date().toISOString(),
  warning,
  ...meta,
});

let stockServiceSingleton = null;
const getStockService = () => {
  if (!stockServiceSingleton) {
    stockServiceSingleton = new StockService(getLiveMarketDataProvider());
  }
  return stockServiceSingleton;
};

/**
 * withTimeout - bounds a slow tool call so one hung request never blocks
 * the whole graph. `ms` is already the request-budget-bounded value the
 * caller computed (see boundedCallTimeout below) — this function itself
 * only races promise vs. timer vs. an optional AbortSignal.
 *
 * Cancellation via `signal` is a SOFT cancel for any tool whose underlying
 * call doesn't itself accept the signal (most of the tools in this file —
 * see each call site's own note): the graph stops *awaiting* the call and
 * moves on, but the in-flight HTTP/DB call may still complete in the
 * background. That is a real, documented limitation (Phase 1 report,
 * "cancellation limitations"), never silently claimed as a true abort.
 */
const withTimeout = (promise, ms, label, signal) => {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'TIMEOUT' })), ms);
  });
  const racers = [promise, timeoutPromise];
  if (signal) {
    racers.push(new Promise((_, reject) => {
      if (signal.aborted) { reject(Object.assign(new Error(`${label} cancelled`), { code: 'CANCELLED' })); return; }
      signal.addEventListener('abort', () => reject(Object.assign(new Error(`${label} cancelled`), { code: 'CANCELLED' })), { once: true });
    }));
  }
  return Promise.race(racers).finally(() => clearTimeout(timer));
};

/** The timeout a call should actually use this turn: its own natural ceiling, bounded by whatever remains of the request's total deadline (never longer, sometimes shorter). */
const boundedCallTimeout = (naturalTimeoutMs, context) => boundedTimeout(naturalTimeoutMs, context?.deadlineAt);

/**
 * withBreaker - runs `fn` only if the named provider's circuit isn't OPEN,
 * and records the outcome. A cancellation (context.signal already
 * aborted, or the call rejects with code TIMEOUT/CANCELLED because the
 * *request* deadline — not the provider — ran out) is never counted
 * against the breaker (see circuitBreaker.js's isBreakerCountedFailure).
 * Returns { blocked: true } without calling fn at all when the circuit is
 * OPEN — the caller reports that as UNAVAILABLE, never as a fresh attempt.
 */
const withBreaker = async (providerName, fn) => {
  const breaker = getProviderBreaker(providerName);
  if (!breaker.canAttempt()) {
    return { blocked: true, circuitState: breaker.getState() };
  }
  const circuitState = breaker.getState();
  try {
    const value = await fn();
    breaker.recordSuccess();
    return { blocked: false, circuitState, value };
  } catch (error) {
    const cancelled = error?.code === 'CANCELLED';
    breaker.recordOutcome({ cancelled, errorCode: error?.errorCode || (error?.code === 'TIMEOUT' ? 'TIMEOUT' : null) });
    throw error;
  }
};

const normalizeSymbol = (value) => String(value || '').trim().toUpperCase();

/**
 * deriveBundleOutcome - inspects EVERY section of a CompanyResearchService
 * bundle and decides the tool-level status/reason. Any section with real
 * data wins (SUCCESS) regardless of other sections failing. Only when
 * NOTHING came back does the actual failure reason matter — picked by
 * severity so an authentication failure is never masked by a sibling
 * section that merely had no data.
 */
const ERROR_CODE_PRIORITY = [
  'AUTHENTICATION_ERROR', 'PLAN_OR_BASE_URL_ERROR', 'CONFIGURATION_ERROR',
  'RATE_LIMITED', 'TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'INVALID_RESPONSE',
  'NOT_FOUND', 'UNSUPPORTED_CAPABILITY',
];

const deriveBundleOutcome = (sections) => {
  const values = Object.values(sections);
  const anyAvailable = values.some((s) => s.available && s.data);
  if (anyAvailable) return { status: TOOL_STATUS.SUCCESS, reason: null, errorCode: null };

  const codes = values.map((s) => s.error?.code).filter(Boolean);
  for (const code of ERROR_CODE_PRIORITY) {
    if (codes.includes(code)) {
      const classified = classifyErrorCode(code);
      if (classified) return { status: TOOL_STATUS[classified.toolStatus], reason: classified.reason, errorCode: code };
    }
  }
  if (codes.length) return { status: TOOL_STATUS.UNAVAILABLE, reason: SAFE_REASONS.PROVIDER_UNAVAILABLE, errorCode: codes[0] };
  return { status: TOOL_STATUS.EMPTY, reason: SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD, errorCode: null };
};

// ---------------------------------------------------------------------------
// getLiveQuote
// ---------------------------------------------------------------------------
// getLiveQuote is the only tool whose underlying call (StockService ->
// AngelOneProvider, a plain internal method with no options parameter of
// its own) does not accept an AbortSignal — cancellation here is SOFT
// (see withTimeout's doc): the graph stops waiting on it, but the
// in-flight request to Angel One may still complete in the background.
export const getLiveQuote = async ({ symbol }, context = {}) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getLiveQuote', TOOL_STATUS.ERROR, null, [], 'A symbol is required');

  let circuitState = null;
  try {
    const { value: quote, cacheStatus, storedAt } = await getOrCompute(
      buildCacheKey('getLiveQuote', normalized),
      CACHE_TTL_MS.LIVE_QUOTE,
      async () => {
        const outcome = await withBreaker('angel-one', () => withTimeout(
          getStockService().getStock(normalized), boundedCallTimeout(10000, context), 'getLiveQuote', context.signal,
        ));
        circuitState = outcome.circuitState;
        if (outcome.blocked) throw Object.assign(new Error('angel-one circuit is open'), { code: 'CIRCUIT_OPEN' });
        return outcome.value;
      },
    );
    const evidence = [buildEvidenceRecord({
      claimType: 'LIVE_PRICE',
      symbol: normalized,
      title: `${normalized} live quote`,
      provider: 'angel-one',
      publishedAt: quote.timestamp || new Date().toISOString(),
      excerpt: `Price ₹${quote.price}, change ${quote.changePct}% as of ${quote.timestamp}`,
    })].filter(Boolean);
    // fetchedAt reflects when this value was actually obtained from the
    // provider (storedAt, from toolCache.js) -- not "now" -- so a cache HIT
    // never misrepresents its own freshness.
    return result('getLiveQuote', TOOL_STATUS.SUCCESS, quote, evidence, null, null, { cacheStatus, circuitState, cancellationMode: 'SOFT', fetchedAt: new Date(storedAt).toISOString() });
  } catch (error) {
    const meta = { circuitState, cancellationMode: 'SOFT' };
    if (error.code === 'CANCELLED') return result('getLiveQuote', TOOL_STATUS.ERROR, null, [], 'Request was cancelled.', 'CANCELLED', meta);
    logger.warn(`[Tool] getLiveQuote(${normalized}) failed: ${error.message}`);
    return result('getLiveQuote', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, error.errorCode || (error.code === 'CIRCUIT_OPEN' ? 'CIRCUIT_OPEN' : null), meta);
  }
};

// ---------------------------------------------------------------------------
// getCompanyResearch / getCompanyFinancials (share the same bundle fetch —
// CompanyResearchService already caches it in-process for 5 minutes)
// ---------------------------------------------------------------------------

/** Formats up to `max` real financial line items into a readable excerpt string. Never fabricates a value. */
const financialsExcerpt = (entry, max = 6) => {
  if (!entry?.lineItems?.length) return null;
  return entry.lineItems.slice(0, max)
    .map((item) => `${item.displayName}: ${item.value} ${entry.unitHint || ''}`.trim())
    .join('; ');
};

/** Formats a keyMetrics category's real metrics into a readable excerpt string. */
const keyMetricExcerpt = (category, max = 8) => {
  if (!category?.metrics?.length) return null;
  return category.metrics.slice(0, max).map((m) => `${m.name}: ${m.value}`).join(', ');
};

// getCompanyResearch and getCompanyFinancials share the same underlying
// IndianAPI bundle fetch (and its provider, so the same 'indian-api'
// circuit breaker instance). CompanyResearchService already caches this
// bundle in-process for 5 minutes — Phase 1 deliberately does NOT add a
// second cache layer on top of that (redundant complexity, no real
// speedup). IndianApiProvider's client has no signal parameter of its
// own, so cancellation here is SOFT, same as getLiveQuote.
const fetchResearchBundle = async (normalized, toolLabel, context) => {
  const outcome = await withBreaker('indian-api', () => withTimeout(
    getCompanyResearchBundle(normalized), boundedCallTimeout(15000, context), toolLabel, context?.signal,
  ));
  if (outcome.blocked) throw Object.assign(new Error('indian-api circuit is open'), { code: 'CIRCUIT_OPEN', circuitState: outcome.circuitState });
  return { bundle: outcome.value, circuitState: outcome.circuitState };
};

export const getCompanyResearch = async ({ symbol }, context = {}) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getCompanyResearch', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  let circuitState = null;
  try {
    const fetched = await fetchResearchBundle(normalized, 'getCompanyResearch', context);
    const { bundle } = fetched;
    circuitState = fetched.circuitState;
    if (!bundle.configured) {
      return result('getCompanyResearch', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, 'CONFIGURATION_ERROR');
    }

    const evidence = [];

    const profile = bundle.sections.profile;
    if (profile.available && profile.data?.profile) {
      evidence.push(buildEvidenceRecord({
        claimType: 'COMPANY_PROFILE', symbol, title: `${normalized} company profile`,
        provider: profile.provider || 'indian-api', publishedAt: profile.asOf,
        excerpt: profile.data.profile.description || null,
      }));
    }

    // One evidence record PER key-metrics category (margins, valuation,
    // growth, ...) with a real, readable excerpt — a single opaque
    // "KEY_METRIC" blob with no excerpt (the prior behavior) gave the
    // composer nothing to cite, which is why margin-trend questions
    // reported "no verifiable evidence" even though the numbers existed.
    const keyMetrics = bundle.sections.keyMetrics;
    if (keyMetrics.available && keyMetrics.data?.categories?.length) {
      for (const category of keyMetrics.data.categories) {
        const excerpt = keyMetricExcerpt(category);
        if (!excerpt) continue;
        evidence.push(buildEvidenceRecord({
          claimType: 'KEY_METRIC', symbol, title: `${normalized} ${category.label}`,
          provider: keyMetrics.provider || 'indian-api', publishedAt: keyMetrics.asOf, excerpt,
        }));
      }
    }

    const shareholding = bundle.sections.shareholding;
    if (shareholding.available && Array.isArray(shareholding.data)) {
      for (const entry of shareholding.data.slice(0, 3)) {
        evidence.push(buildEvidenceRecord({
          claimType: 'SHAREHOLDING', symbol, title: `${normalized} shareholding`,
          provider: shareholding.provider || 'indian-api', publishedAt: entry.date || shareholding.asOf,
          reportingPeriod: entry.period,
          excerpt: entry.raw ? Object.entries(entry.raw).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(', ') : null,
        }));
      }
    }

    const corporateActions = bundle.sections.corporateActions;
    if (corporateActions.available && Array.isArray(corporateActions.data)) {
      for (const entry of corporateActions.data.slice(0, 3)) {
        evidence.push(buildEvidenceRecord({
          claimType: 'CORPORATE_ACTION', symbol, title: entry.title || `${normalized} corporate action`,
          sourceUrl: entry.sourceUrl, provider: corporateActions.provider || 'indian-api',
          publishedAt: entry.date || corporateActions.asOf, reportingPeriod: entry.period,
          excerpt: entry.raw ? Object.entries(entry.raw).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(', ') : entry.title,
        }));
      }
    }

    const analystData = bundle.sections.analystData;
    if (analystData.available && analystData.data) {
      evidence.push(buildEvidenceRecord({
        claimType: 'ANALYST_FORECAST', symbol, title: `${normalized} analyst view`,
        provider: analystData.provider || 'indian-api', publishedAt: analystData.asOf,
        excerpt: analystData.data.note || null,
      }));
    }

    const meta = { circuitState, cancellationMode: 'SOFT' };
    const filteredEvidence = evidence.filter(Boolean);
    if (filteredEvidence.length) {
      return result('getCompanyResearch', TOOL_STATUS.SUCCESS, bundle, filteredEvidence, null, null, meta);
    }
    const outcome = deriveBundleOutcome(bundle.sections);
    return result('getCompanyResearch', outcome.status, outcome.status === TOOL_STATUS.SUCCESS ? bundle : null, [], outcome.reason, outcome.errorCode, meta);
  } catch (error) {
    const meta = { circuitState: error.circuitState ?? circuitState, cancellationMode: 'SOFT' };
    if (error.code === 'CANCELLED') return result('getCompanyResearch', TOOL_STATUS.ERROR, null, [], 'Request was cancelled.', 'CANCELLED', meta);
    logger.warn(`[Tool] getCompanyResearch(${normalized}) failed: ${error.message}`);
    return result('getCompanyResearch', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, error.errorCode || (error.code === 'CIRCUIT_OPEN' ? 'CIRCUIT_OPEN' : null), meta);
  }
};

export const getCompanyFinancials = async ({ symbol }, context = {}) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getCompanyFinancials', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  let circuitState = null;
  try {
    const fetched = await fetchResearchBundle(normalized, 'getCompanyFinancials', context);
    const { bundle } = fetched;
    circuitState = fetched.circuitState;
    const section = bundle.sections.financials;
    const meta = { circuitState, cancellationMode: 'SOFT' };

    if (!section.available) {
      const classified = classifyErrorCode(section.error?.code);
      return result(
        'getCompanyFinancials', classified ? TOOL_STATUS[classified.toolStatus] : TOOL_STATUS.UNAVAILABLE,
        null, [], classified ? classified.reason : SAFE_REASONS.PROVIDER_UNAVAILABLE, section.error?.code || null, meta,
      );
    }

    const entriesWithData = (section.data || []).filter((entry) => entry.lineItems?.length);
    if (!entriesWithData.length) {
      return result('getCompanyFinancials', TOOL_STATUS.EMPTY, section.data || [], [], SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD, null, meta);
    }

    const evidence = entriesWithData.slice(0, 5).map((entry) => buildEvidenceRecord({
      claimType: 'FINANCIAL_DATA',
      symbol: normalized,
      title: `${normalized} financial statement (${entry.statementType || 'reported'})${entry.period ? ` — FY${entry.period}` : ''}`,
      provider: section.provider || 'indian-api',
      publishedAt: entry.date || section.asOf,
      reportingPeriod: entry.period,
      excerpt: financialsExcerpt(entry),
    })).filter(Boolean);

    return result('getCompanyFinancials', TOOL_STATUS.SUCCESS, entriesWithData, evidence, null, null, meta);
  } catch (error) {
    const meta = { circuitState: error.circuitState ?? circuitState, cancellationMode: 'SOFT' };
    if (error.code === 'CANCELLED') return result('getCompanyFinancials', TOOL_STATUS.ERROR, null, [], 'Request was cancelled.', 'CANCELLED', meta);
    logger.warn(`[Tool] getCompanyFinancials(${normalized}) failed: ${error.message}`);
    return result('getCompanyFinancials', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, error.errorCode || (error.code === 'CIRCUIT_OPEN' ? 'CIRCUIT_OPEN' : null), meta);
  }
};

// ---------------------------------------------------------------------------
// getCompanyNews
// ---------------------------------------------------------------------------
export const getCompanyNews = async ({ symbol }, context = {}) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getCompanyNews', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  let circuitState = null;
  try {
    const { value: articles, cacheStatus, storedAt } = await getOrCompute(
      buildCacheKey('getCompanyNews', normalized),
      CACHE_TTL_MS.COMPANY_NEWS,
      async () => {
        const outcome = await withBreaker('news-api', () => withTimeout(
          getStockNews(normalized, { days: 14 }), boundedCallTimeout(12000, context), 'getCompanyNews', context.signal,
        ));
        circuitState = outcome.circuitState;
        if (outcome.blocked) throw Object.assign(new Error('news-api circuit is open'), { code: 'CIRCUIT_OPEN' });
        return outcome.value;
      },
    );
    const meta = { cacheStatus, circuitState, cancellationMode: 'SOFT', fetchedAt: new Date(storedAt).toISOString() };
    const evidence = articles.slice(0, 5).map((article) => buildEvidenceRecord({
      claimType: 'COMPANY_NEWS',
      symbol: normalized,
      title: article.title,
      sourceUrl: article.url,
      provider: article.source || 'news-api',
      publishedAt: article.publishedAt,
      excerpt: article.description,
    })).filter(Boolean);
    return result('getCompanyNews', articles.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, articles, evidence, articles.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD, null, meta);
  } catch (error) {
    const meta = { circuitState, cancellationMode: 'SOFT' };
    if (error.code === 'CANCELLED') return result('getCompanyNews', TOOL_STATUS.ERROR, null, [], 'Request was cancelled.', 'CANCELLED', meta);
    logger.warn(`[Tool] getCompanyNews(${normalized}) failed: ${error.message}`);
    return result('getCompanyNews', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, error.code === 'CIRCUIT_OPEN' ? 'CIRCUIT_OPEN' : null, meta);
  }
};

// ---------------------------------------------------------------------------
// getEarningsTimeline / getManagementPromiseDetails
// ---------------------------------------------------------------------------
// Mongo-backed (ManagementPromiseService), not an external rate-limited
// provider in the same sense as Angel One/IndianAPI/NewsAPI — Phase 1
// gives this a cache (a real, worthwhile speedup for repeated questions
// about the same company) but deliberately no circuit breaker; see the
// Phase 1 report's "remaining adapters" note.
export const getEarningsTimeline = async ({ symbol }, context = {}) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getEarningsTimeline', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const { value: timeline, cacheStatus, storedAt } = await getOrCompute(
      buildCacheKey('getEarningsTimeline', normalized),
      CACHE_TTL_MS.EARNINGS_TIMELINE,
      () => withTimeout(getCompanyTimeline(normalized), boundedCallTimeout(10000, context), 'getEarningsTimeline', context.signal),
    );
    const meta = { cacheStatus, cancellationMode: 'SOFT', fetchedAt: new Date(storedAt).toISOString() };
    const evidence = timeline.promises.slice(0, 8).map((promise) => buildEvidenceRecord({
      claimType: 'PROMISE_OUTCOME',
      symbol: normalized,
      title: promise.statement,
      sourceUrl: promise.evidence?.sourceUrl || promise.outcome?.sourceUrl || null,
      provider: promise.outcome?.provider || 'document-research',
      publishedAt: promise.evidence?.publicationDate || null,
      reportingPeriod: promise.period,
      excerpt: promise.evidence?.excerpt || null,
      pageNumber: promise.evidence?.page || null,
    })).filter(Boolean);
    return result('getEarningsTimeline', timeline.promises.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, timeline, evidence, timeline.promises.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD, null, meta);
  } catch (error) {
    if (error.code === 'CANCELLED') return result('getEarningsTimeline', TOOL_STATUS.ERROR, null, [], 'Request was cancelled.', 'CANCELLED', { cancellationMode: 'SOFT' });
    logger.warn(`[Tool] getEarningsTimeline(${normalized}) failed: ${error.message}`);
    return result('getEarningsTimeline', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, null, { cancellationMode: 'SOFT' });
  }
};

// Statuses that mean "not yet evaluated" — a promise still in this state has
// no real outcome to cite, only the original guidance/forecast itself.
const UNEVALUATED_PROMISE_STATUSES = new Set(['PENDING', 'INSUFFICIENT_EVIDENCE']);

/**
 * buildPromiseEvidence - the ONE place a ManagementPromise document is
 * turned into evidence, shared by both branches of getManagementPromiseDetails
 * below. Fixes the confirmed Phase 0/1 regression: the symbol-path branch
 * (the one actually reached by a comparison/GUIDANCE-dimension request —
 * see toolRegistry.js's compareStocks) previously returned `evidence: []`
 * unconditionally, discarding every real promise record it had just
 * fetched. That is fixed here by building real evidence from the SAME
 * fields the promiseId branch already trusted.
 *
 * Builds up to two DISTINCT records per promise, so a forecast is never
 * presented as an achieved outcome and vice versa:
 *   - MANAGEMENT_PROMISE: the original guidance/forecast statement itself,
 *     sourced from evidence.promiseSource (schema-required on every
 *     REAL_RESEARCH record — see models/ManagementPromise.js — so this is
 *     always present for a genuine document, never fabricated here).
 *   - PROMISE_OUTCOME: what actually happened, ONLY when the promise has
 *     genuinely been evaluated (verification.status is not PENDING/
 *     INSUFFICIENT_EVIDENCE) AND a real outcome source exists. A pending
 *     promise never gets a PROMISE_OUTCOME record — there is no outcome
 *     yet, and inventing one would misrepresent a forecast as fulfilled.
 * A record missing its required provenance (sourceUrl/title/excerpt) is
 * simply never built — "records lacking provenance stay non-citable" — and
 * buildEvidenceRecord itself never invents a missing field.
 */
const buildPromiseEvidence = (promise) => {
  const records = [];

  const promiseSource = promise.evidence?.promiseSource;
  // title prefers the actual promise statement (what was promised, in the
  // company's own words) over the source document's title — matching the
  // field mapping this tool already used before this fix, just now gated
  // on the source actually being citable.
  const promiseTitle = promise.promise?.statement || promiseSource?.title;
  if (promiseSource?.sourceUrl && promiseSource?.excerpt && promiseTitle) {
    records.push(buildEvidenceRecord({
      claimType: 'MANAGEMENT_PROMISE',
      symbol: promise.symbol,
      title: promiseTitle,
      sourceUrl: promiseSource.sourceUrl,
      provider: promiseSource.sourceName || 'document-research',
      publishedAt: promiseSource.publicationDate || promiseSource.sourceDate,
      reportingPeriod: promise.promise?.targetPeriod,
      excerpt: promiseSource.excerpt,
      pageNumber: promiseSource.page,
    }));
  }

  const status = promise.verification?.status;
  const isEvaluated = status && !UNEVALUATED_PROMISE_STATUSES.has(status);
  const outcomeSource = promise.evidence?.outcomeSource;
  const outcomeExcerpt = outcomeSource?.excerpt || promise.outcome?.excerpt;
  if (isEvaluated && outcomeSource?.sourceUrl && outcomeExcerpt) {
    records.push(buildEvidenceRecord({
      claimType: 'PROMISE_OUTCOME',
      symbol: promise.symbol,
      title: outcomeSource.title || `${promise.symbol} promise outcome — ${status}`,
      sourceUrl: outcomeSource.sourceUrl,
      provider: outcomeSource.sourceName || promise.outcome?.provider || 'document-research',
      publishedAt: outcomeSource.publicationDate || outcomeSource.sourceDate || promise.outcome?.sourceDate,
      reportingPeriod: promise.outcome?.actualPeriod || promise.promise?.targetPeriod,
      excerpt: outcomeExcerpt,
      pageNumber: null,
    }));
  }

  return records.filter(Boolean);
};

export const getManagementPromiseDetails = async ({ promiseId, symbol, metric, period }) => {
  try {
    if (promiseId) {
      const promise = await ManagementPromise.findOne({ _id: promiseId, dataOrigin: 'REAL_RESEARCH' }).lean();
      if (!promise) return result('getManagementPromiseDetails', TOOL_STATUS.EMPTY, null, [], SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
      const evidence = buildPromiseEvidence(promise);
      return result('getManagementPromiseDetails', evidence.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, promise, evidence, evidence.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
    }

    const normalized = normalizeSymbol(symbol);
    if (!normalized) return result('getManagementPromiseDetails', TOOL_STATUS.ERROR, null, [], 'A promiseId or symbol is required');
    const promises = await getCompanyPromises(normalized, { metric, year: period });
    // Dedupe by claim identity is handled centrally by state.js's
    // mergeEvidence reducer across replan rounds — within a single call,
    // each Mongo document is distinct, so a plain flatMap is correct here.
    const evidence = promises.flatMap(buildPromiseEvidence);
    return result(
      'getManagementPromiseDetails', evidence.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY,
      promises, evidence, evidence.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD,
    );
  } catch (error) {
    logger.warn(`[Tool] getManagementPromiseDetails failed: ${error.message}`);
    return result('getManagementPromiseDetails', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE);
  }
};

// ---------------------------------------------------------------------------
// searchResearchDocuments
// ---------------------------------------------------------------------------
// Not wrapped in a circuit breaker this phase (see Phase 1 report's
// "remaining adapters") — collectDocuments fans out across multiple
// underlying sources (BSE filings, durable storage) rather than one
// single external provider boundary the way Angel One/IndianAPI/NewsAPI
// are; it does get the same request-deadline-aware timeout and a cache,
// since a repeated question about the same company shouldn't re-run the
// whole discovery/extraction pipeline within the TTL window.
export const searchResearchDocuments = async ({ symbol }, context = {}) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('searchResearchDocuments', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const { value: collected, cacheStatus, storedAt } = await getOrCompute(
      buildCacheKey('searchResearchDocuments', normalized),
      CACHE_TTL_MS.RESEARCH_DOCUMENTS,
      () => withTimeout(collectDocuments(normalized), boundedCallTimeout(25000, context), 'searchResearchDocuments', context.signal),
    );
    const { documents } = collected;
    const meta = { cacheStatus, cancellationMode: 'SOFT', fetchedAt: new Date(storedAt).toISOString() };
    const evidence = documents.slice(0, 8).map((doc) => buildEvidenceRecord({
      claimType: 'DOCUMENT_EXCERPT',
      symbol: normalized,
      title: doc.title,
      sourceUrl: doc.url || doc.canonicalUrl,
      provider: doc.sourceType || 'document-research',
      publishedAt: doc.sourceDate || doc.publishedAt,
      excerpt: (doc.text || doc.excerpt || '').slice(0, 500),
      pageNumber: doc.page ?? doc.pageNumber ?? null,
    })).filter(Boolean);
    return result(
      'searchResearchDocuments', documents.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY,
      documents.slice(0, 15), evidence, documents.length ? null : SAFE_REASONS.EVIDENCE_SOURCE_UNAVAILABLE, null, meta,
    );
  } catch (error) {
    if (error.code === 'CANCELLED') return result('searchResearchDocuments', TOOL_STATUS.ERROR, null, [], 'Request was cancelled.', 'CANCELLED', { cancellationMode: 'SOFT' });
    logger.warn(`[Tool] searchResearchDocuments(${normalized}) failed: ${error.message}`);
    return result('searchResearchDocuments', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, null, { cancellationMode: 'SOFT' });
  }
};

// ---------------------------------------------------------------------------
// retrieveGroundedEvidence — Phase 4B Part 2: the ONLY grounded-RAG entry
// point, and the only tool this project has that calls
// services/ResearchRetrieverService.js's retrieveResearchEvidence directly
// (searchResearchDocuments above stays on the legacy collectDocuments
// path, untouched, so Phase 1-3 behavior and its tests are never
// disturbed). Deliberately its OWN tool rather than a second mode of
// searchResearchDocuments — the two return fundamentally different
// shapes (a trusted, numbered evidence ENVELOPE here vs. loose
// DOCUMENT_EXCERPT evidence records there).
//
// RAG_RETRIEVAL_MODE (env, default LOCAL_HYBRID_RERANK per the Phase 4B
// kickoff instruction) is read fresh on every call — never cached at
// module load — so a test/deployment can override it without a process
// restart; this is also what keeps retrieval provider-independent: this
// tool has zero knowledge of which underlying mode actually ran beyond
// what retrieveResearchEvidence reports back in retrievalMode.
// ---------------------------------------------------------------------------
const resolveRagRetrievalMode = () => process.env.RAG_RETRIEVAL_MODE || RETRIEVAL_MODES.LOCAL_HYBRID_RERANK;

const RAG_TOP_K = 6;

const toolStatusForRetrieval = (retrievalStatus, hasItems) => {
  if (retrievalStatus === RETRIEVAL_STATUS.UNSUPPORTED) return TOOL_STATUS.UNSUPPORTED;
  if (retrievalStatus === RETRIEVAL_STATUS.UNAVAILABLE) return TOOL_STATUS.UNAVAILABLE;
  if (retrievalStatus === RETRIEVAL_STATUS.SUCCESS && hasItems) return TOOL_STATUS.SUCCESS;
  return TOOL_STATUS.EMPTY;
};

export const retrieveGroundedEvidence = async ({
  symbol, fiscalYear, fiscalQuarter, query,
} = {}, context = {}) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('retrieveGroundedEvidence', TOOL_STATUS.ERROR, null, [], 'A symbol is required');

  const mode = resolveRagRetrievalMode();
  const effectiveQuery = String(query || `${symbol} ${fiscalQuarter || ''} ${fiscalYear || ''} guidance results`).trim();

  try {
    const outcome = await retrieveResearchEvidence({
      query: effectiveQuery,
      symbols: [normalized],
      fiscalYears: fiscalYear ? [fiscalYear] : [],
      topK: RAG_TOP_K,
      mode,
      deadlineAt: context.deadlineAt,
      signal: context.signal,
    });

    // Phase 4E.1 Part 7: batch-load VERIFIED offline annotations for the
    // COMPLETE bounded candidate pool (outcome.results — already capped at
    // RAG_TOP_K by the retriever) BEFORE the envelope is built, so the
    // envelope's own pre-budget SUPERSEDES prioritization pass can see them
    // too, not just the final post-budget reconciliation. This is the only
    // database access in this whole flow — EvidenceEnvelope.js itself stays
    // a pure, synchronous, DB-free module; it only ever consumes the plain
    // Map built here.
    const chunkAnnotationsByChunkId = await getVerifiedAnnotationsByChunkIds(
      (outcome.results || []).map((r) => r.chunkId),
    );

    const envelope = buildResearchEvidenceEnvelope(outcome.results, {
      retrievalMode: outcome.retrievalMode || mode,
      companyNames: { [normalized]: SUPPORTED_STOCKS[normalized]?.name || null },
      chunkAnnotationsByChunkId,
    });

    const status = toolStatusForRetrieval(outcome.status, envelope.items.length > 0);
    const warning = status === TOOL_STATUS.SUCCESS ? null
      : status === TOOL_STATUS.UNSUPPORTED ? SAFE_REASONS.CAPABILITY_NOT_SUPPORTED
        : SAFE_REASONS.EVIDENCE_SOURCE_UNAVAILABLE;

    return result(
      'retrieveGroundedEvidence', status, envelope.items, [], warning, null,
      { researchEvidence: envelope.items, retrievalMode: envelope.retrievalMode },
    );
  } catch (error) {
    if (error.code === 'CANCELLED') return result('retrieveGroundedEvidence', TOOL_STATUS.ERROR, null, [], 'Request was cancelled.', 'CANCELLED', { retrievalMode: mode });
    logger.warn(`[Tool] retrieveGroundedEvidence(${normalized}) failed: ${error.message}`);
    return result('retrieveGroundedEvidence', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, null, { retrievalMode: mode });
  }
};

// ---------------------------------------------------------------------------
// getWatchlist / getPortfolio — require userId (enforced by the caller;
// see graph/nodes/planTools.js, which strips these tools from the plan for
// unauthenticated requests before this code ever runs).
// ---------------------------------------------------------------------------
export const getWatchlist = async ({}, { userId } = {}) => {
  if (!userId) return result('getWatchlist', TOOL_STATUS.ERROR, null, [], 'Authentication is required for watchlist data.');
  try {
    const lists = await Watchlist.find({ userId }).sort({ createdAt: 1 }).lean();
    const stockService = getStockService();
    const data = await Promise.all(lists.map(async (list) => {
      const stocks = await Promise.all(list.symbols.map(async (symbol) => {
        try { return await stockService.getStock(symbol); } catch { return null; }
      }));
      return { id: list._id, name: list.name, symbols: list.symbols, stocks: stocks.filter(Boolean) };
    }));
    return result('getWatchlist', data.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, data, [], data.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
  } catch (error) {
    logger.warn(`[Tool] getWatchlist failed for user ${userId}: ${error.message}`);
    return result('getWatchlist', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE);
  }
};

export const getPortfolio = async ({}, { userId } = {}) => {
  if (!userId) return result('getPortfolio', TOOL_STATUS.ERROR, null, [], 'Authentication is required for portfolio data.');
  try {
    const holdings = await PortfolioHolding.find({ userId }).sort({ createdAt: 1 }).lean();
    const stockService = getStockService();
    const enriched = await Promise.all(holdings.map(async (holding) => {
      let stock = null;
      try { stock = await stockService.getStock(holding.symbol); } catch { stock = null; }
      const currentPrice = Number.isFinite(Number(stock?.price)) ? Number(stock.price) : null;
      const investedAmount = holding.quantity * holding.averageBuyPrice;
      const currentValue = currentPrice === null ? null : holding.quantity * currentPrice;
      return {
        symbol: holding.symbol,
        quantity: holding.quantity,
        averageBuyPrice: holding.averageBuyPrice,
        sector: stock?.sector || 'N/A',
        currentPrice,
        investedAmount,
        currentValue,
        pnl: currentValue === null ? null : currentValue - investedAmount,
      };
    }));
    return result('getPortfolio', enriched.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, enriched, [], enriched.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
  } catch (error) {
    logger.warn(`[Tool] getPortfolio failed for user ${userId}: ${error.message}`);
    return result('getPortfolio', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE);
  }
};

// ---------------------------------------------------------------------------
// compareStocks — Phase 2 canonical, DIMENSION-AWARE comparison. Fixes the
// confirmed regression where compareStocks always fetched quote+research+
// financials for every symbol and NEVER fetched news or guidance, no
// matter what the user actually asked for ("using financial growth,
// management guidance and recent news" got neither guidance nor news).
//
// {symbols, dimensions} — dimensions is graph/dimensions.js's closed enum
// (resolved deterministically by extractEntities before planTools ever
// builds this call; see planTools.js). Only the REQUESTED dimensions are
// fetched, per symbol, and each dimension is delegated to the SAME
// existing per-dimension tool function used elsewhere in this file
// (getLiveQuote/getCompanyFinancials/getCompanyResearch/getCompanyNews/
// getEarningsTimeline/searchResearchDocuments) — never a second, parallel
// implementation. That is what structurally prevents mislabeling one
// dimension's evidence as another's: every evidence record already carries
// the correct claimType from its OWN tool (LIVE_PRICE, FINANCIAL_DATA,
// COMPANY_NEWS, PROMISE_OUTCOME/MANAGEMENT_PROMISE, DOCUMENT_EXCERPT, ...),
// compareStocks never re-labels or re-packages it.
//
// No LLM call happens inside a tool — the comparison explanation is
// composed later by composeAnswer from this structured data plus evidence.
// ---------------------------------------------------------------------------
const MAX_COMPARISON_SYMBOLS = 4;

// A single planned step (`compareStocks`) still counts as ONE call against
// MAX_TOOL_CALLS_PER_REQUEST (planTools.js) — this is a SEPARATE, internal
// budget bounding how many underlying PROVIDER operations that one step may
// fan out to (symbols x dimensions), so a 4-symbol, 6-dimension request
// can't silently trigger 24 real provider calls in one turn.
export const MAX_COMPARISON_OPERATIONS = 12;

// Priority order used only to decide which dimensions survive when the
// requested set would exceed MAX_COMPARISON_OPERATIONS — price/financials/
// company research are DEFAULT_COMPARISON_DIMENSIONS (dimensions.js) and
// are kept first; a request that explicitly asked for more than the budget
// allows loses its LEAST-prioritized dimensions, never a random subset.
const COMPARISON_DIMENSION_PRIORITY = ['PRICE', 'FINANCIALS', 'COMPANY_RESEARCH', 'GUIDANCE', 'NEWS', 'DOCUMENTS'];

// Each entry delegates to the EXACT existing tool function for that
// dimension — see the module note above on why this is what keeps
// evidence correctly typed per dimension. GUIDANCE maps to
// getEarningsTimeline (the same management-promise/outcome tracking
// EARNINGS_INTELLIGENCE already uses), not getManagementPromiseDetails,
// which is reachable on its own for a targeted promiseId/metric lookup.
// `toolName` (the exact TOOL_REGISTRY/APPROVED_TOOLS string) lets this
// step's underlying operations be fingerprinted the SAME way a top-level
// planned step would be (graph/toolFingerprint.js) — see
// operationFingerprints below, which is what lets Phase 2's bounded
// replan (nodes/replanMissingEvidence.js) recognize "this exact
// symbol+dimension was already tried, even though it happened INSIDE a
// compareStocks call rather than as its own planned step" and avoid
// silently repeating it.
const COMPARISON_DIMENSION_OPERATIONS = Object.freeze({
  PRICE: { tool: getLiveQuote, toolName: 'getLiveQuote', label: 'price' },
  FINANCIALS: { tool: getCompanyFinancials, toolName: 'getCompanyFinancials', label: 'financials' },
  COMPANY_RESEARCH: { tool: getCompanyResearch, toolName: 'getCompanyResearch', label: 'company research' },
  NEWS: { tool: getCompanyNews, toolName: 'getCompanyNews', label: 'news' },
  GUIDANCE: { tool: getEarningsTimeline, toolName: 'getEarningsTimeline', label: 'guidance' },
  DOCUMENTS: { tool: searchResearchDocuments, toolName: 'searchResearchDocuments', label: 'documents' },
});

/**
 * Resolves the dimensions compareStocks will actually fetch: only
 * supported ones, defaulted when none given, truncated (by priority,
 * never silently dropped without a warning) to fit the operation budget
 * for however many symbols were requested. Exported (unlike this file's
 * other internal helpers) so tests can verify the planning logic directly
 * without triggering the real per-dimension provider calls compareStocks
 * itself would make.
 */
export const resolveComparisonPlan = (requestedDimensions, symbolCount, warnings) => {
  const supported = (Array.isArray(requestedDimensions) ? requestedDimensions : [])
    .filter((d) => COMPARISON_DIMENSION_OPERATIONS[d]);
  let dimensions = [...new Set(supported.length ? supported : DEFAULT_COMPARISON_DIMENSIONS)];

  const maxDimensions = Math.max(1, Math.floor(MAX_COMPARISON_OPERATIONS / Math.max(1, symbolCount)));
  if (dimensions.length > maxDimensions) {
    const kept = COMPARISON_DIMENSION_PRIORITY.filter((d) => dimensions.includes(d)).slice(0, maxDimensions);
    const keptSet = new Set(kept.length ? kept : dimensions.slice(0, maxDimensions));
    dimensions = dimensions.filter((d) => keptSet.has(d));
    warnings.push('Limited the comparison to fewer data types to stay within this turn\'s budget.');
  }
  return dimensions;
};

export const compareStocks = async ({ symbols, dimensions } = {}, context = {}) => {
  const list = (Array.isArray(symbols) ? symbols : [symbols]).map(normalizeSymbol).filter(Boolean).slice(0, MAX_COMPARISON_SYMBOLS);
  if (list.length < 2) return result('compareStocks', TOOL_STATUS.ERROR, null, [], 'At least two symbols are required to compare.');

  const warnings = [];
  const resolvedDimensions = resolveComparisonPlan(dimensions, list.length, warnings);

  const perSymbol = await Promise.all(list.map(async (symbol) => {
    const outcomes = await Promise.all(resolvedDimensions.map((dimension) => COMPARISON_DIMENSION_OPERATIONS[dimension].tool({ symbol }, context)));
    const byDimension = {};
    resolvedDimensions.forEach((dimension, i) => { byDimension[dimension] = outcomes[i]; });
    return { symbol, dimensions: byDimension };
  }));

  const allResults = perSymbol.flatMap((entry) => Object.values(entry.dimensions));
  const evidence = allResults.flatMap((r) => r.evidence || []);
  const anySuccess = allResults.some((r) => r.status === TOOL_STATUS.SUCCESS);
  const operationCount = list.length * resolvedDimensions.length;
  const operationFingerprints = list.flatMap((symbol) => resolvedDimensions.map(
    (dimension) => fingerprintToolCall({ tool: COMPARISON_DIMENSION_OPERATIONS[dimension].toolName, args: { symbol } }),
  ));
  // A missing-data reason takes priority over the (informational-only)
  // truncation notice — see executeTools.js, which only ever surfaces this
  // single `warning` string to the user, never a second field.
  const warning = !anySuccess ? SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD : (warnings[0] || null);

  return result(
    'compareStocks', anySuccess ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY,
    perSymbol, evidence, warning, null,
    { dimensions: resolvedDimensions, operationCount, operationFingerprints },
  );
};

// Deliberately NOT frozen: tests mutate individual entries to inject fakes
// (the same technique used elsewhere in this codebase's tests — see
// tests/chatExecuteTools.test.js). This carries no production security
// implication: the real allowlist boundary is APPROVED_TOOLS (graph/
// schemas.js), enforced against the model's structured tool-plan output in
// planTools.js — server-side code here is never attacker-reachable.
export const TOOL_REGISTRY = {
  getLiveQuote,
  getCompanyResearch,
  getCompanyFinancials,
  getCompanyNews,
  getEarningsTimeline,
  getManagementPromiseDetails,
  searchResearchDocuments,
  getWatchlist,
  getPortfolio,
  compareStocks,
  retrieveGroundedEvidence,
};

export const AUTH_REQUIRED_TOOLS = Object.freeze(['getWatchlist', 'getPortfolio']);

export default TOOL_REGISTRY;
