import axios from 'axios';
import { CompanyResearchProvider } from '../contracts/CompanyResearchProvider.js';
import {
  normalizeProfile, normalizeBalanceSheet, normalizeCashFlow, normalizeIncomeStatement,
  normalizeKeyRatios, normalizeShareholding, normalizeCorporateActions,
} from './UpstoxNormalizer.js';
import { mapUpstoxError, UpstoxError, UPSTOX_ERROR_CODES } from './UpstoxErrorMapper.js';
import { getCache, setCache } from '../../utils/redisClient.js';
import { logger } from '../../utils/logger.js';
import { RateLimitGate, isRateLimitError } from '../../services/providers/providerResilience.js';

const DEFAULT_BASE_URL = 'https://api.upstox.com/v2/fundamentals';
const DEFAULT_TIMEOUT_MS = 10000; // bounded per-call timeout -- the search endpoint fans 7 of these out in parallel and must land well inside its ~13-15s target
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 1; // one bounded retry only -- mirrors IndianApiProvider, never a retry storm
// Reported financial statements change at most quarterly, never intraday --
// 6h keeps repeat lookups (and the AI-explain endpoint's cache reconstruction)
// cheap without ever serving stale-by-more-than-a-few-hours figures.
const STATEMENT_CACHE_TTL_SECONDS = 21600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cache key convention: upstox:<resource>:<ISIN>:<type>:<period> (mirrors indianapi:stock:<SYMBOL>). Exported so CompanyFinancialsExplainService can read the exact same keys without ever re-fetching from Upstox. */
export const buildUpstoxCacheKey = (resource, isin, type = 'na', period = 'na') => `upstox:${resource}:${isin}:${type}:${period}`;

/**
 * UpstoxProvider - CompanyResearchProvider implementation backed by the
 * Upstox Company Fundamentals API (https://api.upstox.com/v2/fundamentals).
 * Modeled closely on providers/indian-api/IndianApiProvider.js: same
 * config-read/isConfigured/_assertConfigured shape, same one-bounded-retry
 * axios wrapper, same per-instance RateLimitGate, same getCache/setCache
 * caching via utils/redisClient.js.
 *
 * DELIBERATELY NOT wired into ProviderRegistry.createCompanyResearchProvider:
 * that registry resolves ONE COMPANY_RESEARCH_PROVIDER for
 * CompanyResearchService's single-bundle-per-symbol contract (resolveCompany/
 * getFinancials/getKeyMetrics/...). This feature needs five to seven
 * concurrently-fetched, statement-specific resources (profile, balance
 * sheet, cash flow, income statement, key ratios, shareholding, corporate
 * actions) per ISIN, each with its own type/period tag -- forcing that
 * through the generic one-method-per-capability contract would either lose
 * the statement-type distinction or require a second incompatible meaning
 * for the same method name. UpstoxProvider still extends
 * CompanyResearchProvider (isConfigured/_assertConfigured/unsupported()
 * conventions are reused as-is) but is constructed directly by
 * CompanyFinancialsSearchService, exactly like a bespoke provider used by
 * one feature is expected to be.
 *
 * The token is read from env/constructor only, is never logged, and is
 * never included in a thrown error, log line, or cache payload.
 */
export class UpstoxProvider extends CompanyResearchProvider {
  constructor({
    token = process.env.UPSTOX_ANALYTICS_TOKEN,
    baseUrl = process.env.UPSTOX_BASE_URL || DEFAULT_BASE_URL,
    timeout = Number(process.env.UPSTOX_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  } = {}) {
    super();
    this.token = token || null;
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.client = axios.create({ baseURL: this.baseUrl, timeout });
    this._rateLimitGate = new RateLimitGate('upstox');
  }

  get providerName() { return 'upstox'; }

  get isConfigured() { return Boolean(this.token); }

  _assertConfigured() {
    if (!this.token) {
      throw new UpstoxError(
        UPSTOX_ERROR_CODES.CONFIGURATION_ERROR,
        'UPSTOX_ANALYTICS_TOKEN is not configured — set it in the backend .env to enable Upstox financial statements.',
      );
    }
  }

  /** Never logs header values -- only the resource path and attempt number. */
  async _get(isin, resource, params = {}, { attempt = 0 } = {}) {
    this._assertConfigured();
    const path = `/${isin}/${resource}`;
    try {
      logger.debug(`[Upstox] GET ${resource} for ${isin} (attempt ${attempt + 1})`);
      const response = await this.client.get(path, {
        params,
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
      });
      if (!response.data || typeof response.data !== 'object') {
        throw new UpstoxError(UPSTOX_ERROR_CODES.INVALID_RESPONSE, `Upstox ${resource} returned a non-JSON-object response`);
      }
      return response.data;
    } catch (error) {
      if (error instanceof UpstoxError) throw error;
      const status = error.response?.status;
      const retryable = RETRYABLE_STATUS.has(status) || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT';
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(300 * (attempt + 1));
        return this._get(isin, resource, params, { attempt: attempt + 1 });
      }
      throw mapUpstoxError(error, { operation: resource });
    }
  }

  /**
   * _fetchCached - the one path every resource method below goes through:
   * cache hit returns the ORIGINAL fetchedAt (never "now"), a cold cache
   * checks the rate-limit gate first (skip the network entirely while
   * blocked, same as IndianApiProvider), then fetches, records
   * success/rate-limit on the gate, and caches the RAW response (not the
   * normalized one) so a normalizer bugfix never requires a cache flush.
   */
  async _fetchCached(isin, resource, params, { type = 'na', period = 'na' } = {}) {
    const cacheKey = buildUpstoxCacheKey(resource, isin, type, period);
    const cached = await getCache(cacheKey);
    if (cached && cached.raw) {
      return { raw: cached.raw, fetchedAt: cached.fetchedAt, fromCache: true };
    }

    const gate = this._rateLimitGate;
    if (gate.isBlocked()) {
      gate.countSkip();
      throw new UpstoxError(
        UPSTOX_ERROR_CODES.RATE_LIMITED,
        `Upstox is rate-limited; skipping upstream call for another ${gate.retryAfterMs()}ms`,
      );
    }

    try {
      const raw = await this._get(isin, resource, params);
      gate.recordSuccess();
      const fetchedAt = new Date().toISOString();
      await setCache(cacheKey, { raw, fetchedAt }, STATEMENT_CACHE_TTL_SECONDS);
      return { raw, fetchedAt, fromCache: false };
    } catch (error) {
      if (isRateLimitError(error)) gate.recordRateLimited();
      throw error;
    }
  }

  async getProfile(isin, { symbol = null } = {}) {
    const { raw, fetchedAt, fromCache } = await this._fetchCached(isin, 'profile', {}, {});
    return { fromCache, data: normalizeProfile(raw, { symbol, isin, fetchedAt }) };
  }

  async getBalanceSheet(isin, { symbol = null, type = 'consolidated' } = {}) {
    const { raw, fetchedAt, fromCache } = await this._fetchCached(isin, 'balance-sheet', { type }, { type, period: 'YEARLY' });
    return { fromCache, data: normalizeBalanceSheet(raw, { symbol, isin, fetchedAt, statementType: type, period: 'YEARLY' }) };
  }

  async getCashFlow(isin, { symbol = null, type = 'consolidated' } = {}) {
    const { raw, fetchedAt, fromCache } = await this._fetchCached(isin, 'cash-flow', { type }, { type, period: 'YEARLY' });
    return { fromCache, data: normalizeCashFlow(raw, { symbol, isin, fetchedAt, statementType: type, period: 'YEARLY' }) };
  }

  /**
   * getIncomeStatement - requests `fs: true` (full_statement) ALONGSIDE the
   * usual summary categories. Confirmed live (see UpstoxNormalizer's
   * deriveVerifiedDefinition) that Upstox's summary `revenue`/
   * `operating_profit`/`net_profit` category names do not match their true
   * accounting meaning (e.g. `revenue` is actually Total Income for real
   * companies with other income). `full_statement` carries individually
   * labeled line items ("Revenue", "Total Revenue", "Profit Before Tax",
   * "Profit After Tax", ...) that the normalizer cross-references per
   * period to derive a verified definition -- never guessed, never
   * hardcoded. Cache key is unaffected (same resource/type/period); the
   * richer response is simply cached under the same key as before.
   */
  async getIncomeStatement(isin, { symbol = null, type = 'consolidated' } = {}) {
    const { raw, fetchedAt, fromCache } = await this._fetchCached(
      isin, 'income-statement', { type, time_period: 'yearly', fs: true }, { type, period: 'YEARLY' },
    );
    return { fromCache, data: normalizeIncomeStatement(raw, { symbol, isin, fetchedAt, statementType: type, period: 'YEARLY' }) };
  }

  async getKeyRatios(isin, { symbol = null } = {}) {
    const { raw, fetchedAt, fromCache } = await this._fetchCached(isin, 'key-ratios', {}, {});
    return { fromCache, data: normalizeKeyRatios(raw, { symbol, isin, fetchedAt }) };
  }

  async getShareHoldings(isin, { symbol = null } = {}) {
    const { raw, fetchedAt, fromCache } = await this._fetchCached(isin, 'share-holdings', {}, {});
    return { fromCache, data: normalizeShareholding(raw, { symbol, isin, fetchedAt }) };
  }

  async getCorporateActions(isin, { symbol = null } = {}) {
    const { raw, fetchedAt, fromCache } = await this._fetchCached(isin, 'corporate-actions', {}, {});
    return { fromCache, data: normalizeCorporateActions(raw, { symbol, isin, fetchedAt }) };
  }

  /**
   * getCachedStatementsOnly - reads whatever core statements are already
   * in Redis for this ISIN WITHOUT ever calling Upstox. Backs the AI-explain
   * endpoint's "never re-fetch" rule when the frontend didn't send back the
   * sections it already had. A section not currently cached comes back
   * `null` (honest gap), never a fresh fetch.
   */
  async getCachedStatementsOnly(isin, { symbol = null } = {}) {
    const specs = [
      ['profile', 'profile', 'na', 'na', normalizeProfile, {}],
      ['balanceSheet', 'balance-sheet', 'consolidated', 'YEARLY', normalizeBalanceSheet, { statementType: 'consolidated', period: 'YEARLY' }],
      ['cashFlow', 'cash-flow', 'consolidated', 'YEARLY', normalizeCashFlow, { statementType: 'consolidated', period: 'YEARLY' }],
      ['incomeStatement', 'income-statement', 'consolidated', 'YEARLY', normalizeIncomeStatement, { statementType: 'consolidated', period: 'YEARLY' }],
      ['keyRatios', 'key-ratios', 'na', 'na', normalizeKeyRatios, {}],
    ];
    const out = {};
    for (const [sectionKey, resource, type, period, normalizer, extra] of specs) {
      const cached = await getCache(buildUpstoxCacheKey(resource, isin, type, period));
      out[sectionKey] = cached?.raw
        ? normalizer(cached.raw, { symbol, isin, fetchedAt: cached.fetchedAt, ...extra })
        : null;
    }
    return out;
  }
}

export default UpstoxProvider;
