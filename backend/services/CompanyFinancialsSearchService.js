/**
 * CompanyFinancialsSearchService - orchestrates the on-demand company
 * financial statement search: resolve query -> ISIN
 * (CompanyFinancialsResolver), then fetch every Upstox section in PARALLEL
 * via Promise.allSettled (never sequential), then assemble a response
 * where each section independently reports
 * {available, data, status, error, asOf, fromCache} -- one slow/failed
 * section never blanks the others. Mirrors
 * StockDetailAggregationService.js's sectionStatus() convention.
 *
 * NEVER persists Upstox data to MongoDB -- the only durable store touched
 * here is the resolver's read-only CompanyResearchProfile lookup. The
 * short-lived cache is Redis only (see UpstoxProvider's
 * STATEMENT_CACHE_TTL_SECONDS), and every section response threads through
 * the provider's own fetchedAt/fromCache so the frontend can never mislabel
 * cached data as a fresh live fetch.
 */
import { resolveCompanyForFinancials } from './CompanyFinancialsResolver.js';
import { UpstoxProvider } from '../providers/upstox/UpstoxProvider.js';
import { logger } from '../utils/logger.js';

const SECTION_KEYS = ['profile', 'balanceSheet', 'cashFlow', 'incomeStatement', 'keyRatios', 'shareholding', 'corporateActions'];

let sharedProvider = null;
/** Test-injectable singleton accessor -- production always shares one instance (one RateLimitGate, one axios client), tests construct their own via the exported class directly. */
export const getUpstoxProvider = () => {
  if (!sharedProvider) sharedProvider = new UpstoxProvider();
  return sharedProvider;
};

/** Test-only: forces the next getUpstoxProvider() call to construct a fresh instance. */
export const _resetProviderForTests = () => { sharedProvider = null; };

const sectionStatus = (hasData, hasError) => {
  if (hasData) return 'AVAILABLE';
  if (hasError) return 'PROVIDER_ERROR';
  return 'UNAVAILABLE';
};

const configurationUnavailableSection = () => ({
  available: false,
  data: null,
  status: 'UNAVAILABLE',
  error: { code: 'CONFIGURATION_ERROR', message: 'UPSTOX_ANALYTICS_TOKEN is not configured on the server yet.' },
  asOf: null,
  fromCache: false,
});

const toSection = (settled) => {
  if (settled.status === 'rejected') {
    const error = settled.reason;
    return {
      available: false,
      data: null,
      status: sectionStatus(false, true),
      error: { code: error?.errorCode || 'UPSTREAM_UNAVAILABLE', message: error?.message || 'Upstox request failed' },
      asOf: null,
      fromCache: false,
    };
  }
  const value = settled.value;
  const hasData = Boolean(value?.data);
  return {
    available: hasData,
    data: value?.data || null,
    status: sectionStatus(hasData, false),
    error: null,
    asOf: value?.data?.fetchedAt || null,
    fromCache: Boolean(value?.fromCache),
  };
};

/**
 * searchCompanyFinancials - the one call GET /api/company-financials/search
 * needs. Always resolves (never throws) so the route can return 200 with an
 * honest partial/unavailable state rather than a 500.
 */
export const searchCompanyFinancials = async (query) => {
  const resolution = await resolveCompanyForFinancials(query);

  if (resolution.status === 'AMBIGUOUS') {
    return {
      success: true, ambiguous: true, query: resolution.query, candidates: resolution.candidates,
    };
  }
  if (resolution.status === 'NOT_FOUND') {
    return {
      success: true, ambiguous: false, notFound: true, query: String(query || '').trim(),
    };
  }
  if (resolution.status === 'ISIN_UNAVAILABLE') {
    return {
      success: true,
      ambiguous: false,
      isinUnavailable: true,
      symbol: resolution.symbol,
      companyName: resolution.companyName,
    };
  }

  const { symbol, companyName, isin } = resolution;
  const provider = getUpstoxProvider();

  if (!provider.isConfigured) {
    const sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, configurationUnavailableSection()]));
    return {
      success: true,
      ambiguous: false,
      data: {
        symbol, companyName, isin, provider: 'UPSTOX', generatedAt: new Date().toISOString(),
        sections,
        missingSections: SECTION_KEYS,
        dataCoveragePct: 0,
        configurationError: true,
      },
    };
  }

  const [profile, balanceSheet, cashFlow, incomeStatement, keyRatios, shareholding, corporateActions] = await Promise.allSettled([
    provider.getProfile(isin, { symbol }),
    provider.getBalanceSheet(isin, { symbol }),
    provider.getCashFlow(isin, { symbol }),
    provider.getIncomeStatement(isin, { symbol }),
    provider.getKeyRatios(isin, { symbol }),
    provider.getShareHoldings(isin, { symbol }),
    provider.getCorporateActions(isin, { symbol }),
  ]);

  for (const [label, settled] of [['profile', profile], ['balanceSheet', balanceSheet], ['cashFlow', cashFlow], ['incomeStatement', incomeStatement], ['keyRatios', keyRatios], ['shareholding', shareholding], ['corporateActions', corporateActions]]) {
    if (settled.status === 'rejected') {
      logger.warn(`[CompanyFinancialsSearchService] ${label} failed for ${symbol}: ${settled.reason?.message}`);
    }
  }

  const sections = {
    profile: toSection(profile),
    balanceSheet: toSection(balanceSheet),
    cashFlow: toSection(cashFlow),
    incomeStatement: toSection(incomeStatement),
    keyRatios: toSection(keyRatios),
    shareholding: toSection(shareholding),
    corporateActions: toSection(corporateActions),
  };

  const missingSections = SECTION_KEYS.filter((key) => !sections[key].available);
  const dataCoveragePct = Math.round(((SECTION_KEYS.length - missingSections.length) / SECTION_KEYS.length) * 100);

  return {
    success: true,
    ambiguous: false,
    data: {
      symbol, companyName, isin, provider: 'UPSTOX', generatedAt: new Date().toISOString(), sections, missingSections, dataCoveragePct,
    },
  };
};

export default { searchCompanyFinancials, getUpstoxProvider, _resetProviderForTests };
