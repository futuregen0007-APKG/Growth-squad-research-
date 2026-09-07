/**
 * CompanyResearchService.js
 * ==========================
 * Provider-neutral service sitting between controllers and a
 * CompanyResearchProvider (IndianAPI today, Global Datafeeds later).
 *
 * Mirrors StockService's role for market data: callers never see a
 * provider's raw field names or exceptions directly. Each capability is
 * fetched independently (Promise.allSettled) so one section failing never
 * hides the others — the response is a bundle of
 * { available, data, error, asOf } sections, which the frontend renders
 * as independent loading/empty/success/error states per section.
 */

import { getCompanyResearchProvider } from '../providers/ProviderRegistry.js';
import { logger } from '../utils/logger.js';

const SECTION_TTL_MS = 5 * 60 * 1000; // in-process bundle cache; the provider layer already caches the raw upstream call
const bundleCache = new Map();

const errorPayload = (error) => ({
  code: error?.errorCode || 'UPSTREAM_UNAVAILABLE',
  message: error?.message || 'Company research is temporarily unavailable.',
});

/** Runs one provider capability call and normalizes it to a section result. Never throws. */
const runSection = async (provider, method, symbol, extraArgs = []) => {
  if (!provider) {
    return { available: false, data: null, error: { code: 'CONFIGURATION_ERROR', message: 'Company research provider is not configured.' }, asOf: null };
  }
  try {
    const result = await provider[method](symbol, ...extraArgs);
    if (result && result.supported === false) {
      return { available: false, data: null, error: { code: 'UNSUPPORTED_CAPABILITY', message: result.reason || `${method} is not supported.` }, asOf: null };
    }
    return { available: true, data: result?.data ?? null, error: null, asOf: result?.provenance?.fetchedAt || new Date().toISOString(), provider: result?.provider || provider.providerName };
  } catch (error) {
    logger.warn(`[CompanyResearchService] ${method}(${symbol}) failed: ${error.message}`);
    return { available: false, data: null, error: errorPayload(error), asOf: null };
  }
};

/**
 * getCompanyResearchBundle - the single call the frontend's Stock Detail
 * page uses to render the IndianAPI-backed research sections. Every field
 * is independently guarded so a partial IndianAPI outage still returns the
 * sections that succeeded.
 */
export const getCompanyResearchBundle = async (symbol, options = {}) => {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) {
    throw new Error('Symbol is required');
  }

  // `provider` exists solely for test injection (mirrors this codebase's
  // existing StockService(provider) constructor-injection pattern) —
  // production callers never pass it, so the real registry singleton is
  // always used. Distinguish "not passed" from "explicitly passed as
  // null/a fake" via `in`, not truthiness — a test simulating "no provider
  // configured" passes `{ provider: null }` and must not silently fall
  // back to the real singleton.
  const hasProviderOverride = Object.prototype.hasOwnProperty.call(options, 'provider');
  const cacheKey = normalizedSymbol;
  if (!hasProviderOverride) {
    const cached = bundleCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < SECTION_TTL_MS) {
      return cached.bundle;
    }
  }

  const provider = hasProviderOverride ? options.provider : getCompanyResearchProvider();

  const [profile, financials, keyMetrics, shareholding, corporateActions, analystData, news] = await Promise.all([
    runSection(provider, 'getCompanyProfile', normalizedSymbol),
    runSection(provider, 'getFinancials', normalizedSymbol),
    runSection(provider, 'getKeyMetrics', normalizedSymbol),
    runSection(provider, 'getShareholding', normalizedSymbol),
    runSection(provider, 'getCorporateActions', normalizedSymbol),
    runSection(provider, 'getAnalystData', normalizedSymbol),
    runSection(provider, 'getCompanyNews', normalizedSymbol),
  ]);

  const bundle = {
    symbol: normalizedSymbol,
    provider: provider?.providerName || null,
    configured: Boolean(provider?.isConfigured),
    sections: { profile, financials, keyMetrics, shareholding, corporateActions, analystData, news },
    generatedAt: new Date().toISOString(),
  };

  if (!hasProviderOverride) {
    bundleCache.set(cacheKey, { bundle, cachedAt: Date.now() });
  }
  return bundle;
};

/** Clears the in-process bundle cache — used by tests and manual refresh flows. */
export const invalidateCompanyResearchCache = (symbol) => {
  if (symbol) {
    bundleCache.delete(String(symbol).trim().toUpperCase());
  } else {
    bundleCache.clear();
  }
};

export default { getCompanyResearchBundle, invalidateCompanyResearchCache };
