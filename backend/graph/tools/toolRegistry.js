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
import { SAFE_REASONS, classifyErrorCode } from '../safeReasons.js';
import { logger } from '../../utils/logger.js';

export const TOOL_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS', EMPTY: 'EMPTY', UNAVAILABLE: 'UNAVAILABLE', UNSUPPORTED: 'UNSUPPORTED', ERROR: 'ERROR',
});

const countOf = (data) => {
  if (data == null) return 0;
  if (Array.isArray(data)) return data.length;
  return 1;
};

const result = (tool, status, data, evidence = [], warning = null, errorCode = null) => ({
  tool,
  status,
  data,
  evidence,
  resultCount: countOf(data),
  evidenceCount: evidence.length,
  errorCode,
  fetchedAt: new Date().toISOString(),
  warning,
});

let stockServiceSingleton = null;
const getStockService = () => {
  if (!stockServiceSingleton) {
    stockServiceSingleton = new StockService(getLiveMarketDataProvider());
  }
  return stockServiceSingleton;
};

/** Bounds a slow tool call so one hung request never blocks the whole graph. */
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

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
export const getLiveQuote = async ({ symbol }) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getLiveQuote', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const quote = await withTimeout(getStockService().getStock(normalized), 10000, 'getLiveQuote');
    const evidence = [buildEvidenceRecord({
      claimType: 'LIVE_PRICE',
      symbol: normalized,
      title: `${normalized} live quote`,
      provider: 'angel-one',
      publishedAt: quote.timestamp || new Date().toISOString(),
      excerpt: `Price ₹${quote.price}, change ${quote.changePct}% as of ${quote.timestamp}`,
    })].filter(Boolean);
    return result('getLiveQuote', TOOL_STATUS.SUCCESS, quote, evidence);
  } catch (error) {
    logger.warn(`[Tool] getLiveQuote(${normalized}) failed: ${error.message}`);
    return result('getLiveQuote', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, error.errorCode || null);
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

export const getCompanyResearch = async ({ symbol }) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getCompanyResearch', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const bundle = await withTimeout(getCompanyResearchBundle(normalized), 15000, 'getCompanyResearch');
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

    const filteredEvidence = evidence.filter(Boolean);
    if (filteredEvidence.length) {
      return result('getCompanyResearch', TOOL_STATUS.SUCCESS, bundle, filteredEvidence);
    }
    const outcome = deriveBundleOutcome(bundle.sections);
    return result('getCompanyResearch', outcome.status, outcome.status === TOOL_STATUS.SUCCESS ? bundle : null, [], outcome.reason, outcome.errorCode);
  } catch (error) {
    logger.warn(`[Tool] getCompanyResearch(${normalized}) failed: ${error.message}`);
    return result('getCompanyResearch', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, error.errorCode || null);
  }
};

export const getCompanyFinancials = async ({ symbol }) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getCompanyFinancials', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const bundle = await withTimeout(getCompanyResearchBundle(normalized), 15000, 'getCompanyFinancials');
    const section = bundle.sections.financials;

    if (!section.available) {
      const classified = classifyErrorCode(section.error?.code);
      return result(
        'getCompanyFinancials', classified ? TOOL_STATUS[classified.toolStatus] : TOOL_STATUS.UNAVAILABLE,
        null, [], classified ? classified.reason : SAFE_REASONS.PROVIDER_UNAVAILABLE, section.error?.code || null,
      );
    }

    const entriesWithData = (section.data || []).filter((entry) => entry.lineItems?.length);
    if (!entriesWithData.length) {
      return result('getCompanyFinancials', TOOL_STATUS.EMPTY, section.data || [], [], SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD, null);
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

    return result('getCompanyFinancials', TOOL_STATUS.SUCCESS, entriesWithData, evidence);
  } catch (error) {
    logger.warn(`[Tool] getCompanyFinancials(${normalized}) failed: ${error.message}`);
    return result('getCompanyFinancials', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE, error.errorCode || null);
  }
};

// ---------------------------------------------------------------------------
// getCompanyNews
// ---------------------------------------------------------------------------
export const getCompanyNews = async ({ symbol }) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getCompanyNews', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const articles = await withTimeout(getStockNews(normalized, { days: 14 }), 12000, 'getCompanyNews');
    const evidence = articles.slice(0, 5).map((article) => buildEvidenceRecord({
      claimType: 'COMPANY_NEWS',
      symbol: normalized,
      title: article.title,
      sourceUrl: article.url,
      provider: article.source || 'news-api',
      publishedAt: article.publishedAt,
      excerpt: article.description,
    })).filter(Boolean);
    return result('getCompanyNews', articles.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, articles, evidence, articles.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
  } catch (error) {
    logger.warn(`[Tool] getCompanyNews(${normalized}) failed: ${error.message}`);
    return result('getCompanyNews', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE);
  }
};

// ---------------------------------------------------------------------------
// getEarningsTimeline / getManagementPromiseDetails
// ---------------------------------------------------------------------------
export const getEarningsTimeline = async ({ symbol }) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('getEarningsTimeline', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const timeline = await withTimeout(getCompanyTimeline(normalized), 10000, 'getEarningsTimeline');
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
    return result('getEarningsTimeline', timeline.promises.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, timeline, evidence, timeline.promises.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
  } catch (error) {
    logger.warn(`[Tool] getEarningsTimeline(${normalized}) failed: ${error.message}`);
    return result('getEarningsTimeline', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE);
  }
};

export const getManagementPromiseDetails = async ({ promiseId, symbol, metric, period }) => {
  try {
    if (promiseId) {
      const promise = await ManagementPromise.findOne({ _id: promiseId, dataOrigin: 'REAL_RESEARCH' }).lean();
      if (!promise) return result('getManagementPromiseDetails', TOOL_STATUS.EMPTY, null, [], SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
      const evidence = [buildEvidenceRecord({
        claimType: 'MANAGEMENT_PROMISE',
        symbol: promise.symbol,
        title: promise.promise?.statement,
        sourceUrl: promise.evidence?.promiseSource?.sourceUrl,
        provider: 'document-research',
        publishedAt: promise.evidence?.promiseSource?.publicationDate,
        reportingPeriod: promise.promise?.targetPeriod,
        excerpt: promise.evidence?.promiseSource?.excerpt,
        pageNumber: promise.evidence?.promiseSource?.page,
      })].filter(Boolean);
      return result('getManagementPromiseDetails', TOOL_STATUS.SUCCESS, promise, evidence);
    }

    const normalized = normalizeSymbol(symbol);
    if (!normalized) return result('getManagementPromiseDetails', TOOL_STATUS.ERROR, null, [], 'A promiseId or symbol is required');
    const promises = await getCompanyPromises(normalized, { metric, year: period });
    return result('getManagementPromiseDetails', promises.length ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY, promises, [], promises.length ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
  } catch (error) {
    logger.warn(`[Tool] getManagementPromiseDetails failed: ${error.message}`);
    return result('getManagementPromiseDetails', TOOL_STATUS.ERROR, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE);
  }
};

// ---------------------------------------------------------------------------
// searchResearchDocuments
// ---------------------------------------------------------------------------
export const searchResearchDocuments = async ({ symbol }) => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return result('searchResearchDocuments', TOOL_STATUS.ERROR, null, [], 'A symbol is required');
  try {
    const { documents } = await withTimeout(collectDocuments(normalized), 25000, 'searchResearchDocuments');
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
      documents.slice(0, 15), evidence, documents.length ? null : SAFE_REASONS.EVIDENCE_SOURCE_UNAVAILABLE,
    );
  } catch (error) {
    logger.warn(`[Tool] searchResearchDocuments(${normalized}) failed: ${error.message}`);
    return result('searchResearchDocuments', TOOL_STATUS.UNAVAILABLE, null, [], SAFE_REASONS.PROVIDER_UNAVAILABLE);
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
// compareStocks — deterministic combination of already-fetched data; no LLM
// call happens inside a tool. The comparison explanation is composed later
// by composeAnswer from this structured data plus its evidence.
//
// Fetches quote + research + FINANCIALS for every symbol (previously
// omitted getCompanyFinancials entirely — confirmed as the reason
// margin/financial-metric comparisons like "HDFCBANK vs ICICIBANK margin
// trends" had no usable evidence: getCompanyResearch's evidence never
// included the financials section).
// ---------------------------------------------------------------------------
export const compareStocks = async ({ symbols }) => {
  const list = (Array.isArray(symbols) ? symbols : [symbols]).map(normalizeSymbol).filter(Boolean).slice(0, 4);
  if (list.length < 2) return result('compareStocks', TOOL_STATUS.ERROR, null, [], 'At least two symbols are required to compare.');

  const perSymbol = await Promise.all(list.map(async (symbol) => {
    const [quoteResult, researchResult, financialsResult] = await Promise.all([
      getLiveQuote({ symbol }), getCompanyResearch({ symbol }), getCompanyFinancials({ symbol }),
    ]);
    return {
      symbol, quote: quoteResult, research: researchResult, financials: financialsResult,
    };
  }));

  const evidence = perSymbol.flatMap((entry) => [
    ...(entry.quote.evidence || []), ...(entry.research.evidence || []), ...(entry.financials.evidence || []),
  ]);
  const anySuccess = perSymbol.some((entry) => [entry.quote.status, entry.research.status, entry.financials.status].includes(TOOL_STATUS.SUCCESS));
  return result(
    'compareStocks', anySuccess ? TOOL_STATUS.SUCCESS : TOOL_STATUS.EMPTY,
    perSymbol, evidence, anySuccess ? null : SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD,
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
};

export const AUTH_REQUIRED_TOOLS = Object.freeze(['getWatchlist', 'getPortfolio']);

export default TOOL_REGISTRY;
