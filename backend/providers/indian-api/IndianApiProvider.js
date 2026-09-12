import axios from 'axios';
import { CompanyResearchProvider } from '../contracts/CompanyResearchProvider.js';
import { normalizeCompanyResearch, normalizeCorporateActionsResponse, normalizeHistoricalStats } from './IndianApiNormalizer.js';
import { mapIndianApiError, IndianApiError, INDIAN_API_ERROR_CODES } from './IndianApiErrorMapper.js';
import { getCache, setCache } from '../../utils/redisClient.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_BASE_URL = 'https://stock.indianapi.in';
const DEFAULT_TIMEOUT_MS = 15000;
const STOCK_CACHE_TTL_SECONDS = 3600; // company/fundamental data is not intraday-volatile
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 1; // one bounded retry only — never a retry storm

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * IndianApiProvider - CompanyResearchProvider implementation backed by
 * IndianAPI (https://indianapi.in). All IndianAPI-specific endpoint paths,
 * parameter names, and header handling live in this file (plus its sibling
 * Normalizer/ErrorMapper) — nothing above the provider layer should ever
 * reference an IndianAPI field name directly.
 *
 * Auth: header `x-api-key: <INDIAN_API_KEY>` — verified against IndianAPI's
 * public documentation/sandbox and corroborating community integrations
 * (Sep 2026). The key is read from env/constructor only, is never logged,
 * and is never included in any thrown error or cache payload.
 */
export class IndianApiProvider extends CompanyResearchProvider {
  constructor({
    apiKey = process.env.INDIAN_API_KEY,
    baseUrl = process.env.INDIAN_API_BASE_URL || DEFAULT_BASE_URL,
    timeout = Number(process.env.INDIAN_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  } = {}) {
    super();
    this.apiKey = apiKey || null;
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.client = axios.create({ baseURL: this.baseUrl, timeout });
    // Per-symbol in-flight request memoization -- see _fetchStockRaw.
    this._inFlightStockFetches = new Map();
  }

  get providerName() {
    return 'indian-api';
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  _assertConfigured() {
    if (!this.apiKey) {
      throw new IndianApiError(
        INDIAN_API_ERROR_CODES.CONFIGURATION_ERROR,
        'INDIAN_API_KEY is not configured — set it in the backend .env to enable company research.',
      );
    }
  }

  /** Never logs header values — only the path and attempt number. */
  async _get(path, params = {}, { operation = path, attempt = 0 } = {}) {
    this._assertConfigured();
    try {
      logger.debug(`[IndianAPI] GET ${path} (attempt ${attempt + 1})`);
      const response = await this.client.get(path, {
        params,
        headers: { 'x-api-key': this.apiKey },
      });
      if (!response.data || typeof response.data !== 'object') {
        throw new IndianApiError(INDIAN_API_ERROR_CODES.INVALID_RESPONSE, `IndianAPI ${operation} returned a non-JSON-object response`);
      }
      return response.data;
    } catch (error) {
      if (error instanceof IndianApiError) throw error;
      const status = error.response?.status;
      const retryable = RETRYABLE_STATUS.has(status) || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT';
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(300 * (attempt + 1));
        return this._get(path, params, { operation, attempt: attempt + 1 });
      }
      throw mapIndianApiError(error, { operation });
    }
  }

  /**
   * Fetches (and caches) the bundled `/stock?name=` response, which
   * IndianAPI documents as returning prices, financials, metrics, risk,
   * shareholding, corporate actions, and news from a single call — reused
   * by every capability method below to avoid redundant credit usage.
   *
   * getCompanyResearchBundle() fires 7 of those capability methods for the
   * same symbol via one Promise.all. On a cold cache, all 7 would otherwise
   * race the `getCache` check below simultaneously (none has written yet)
   * and each independently hit the real upstream endpoint -- confirmed live
   * (7x duplicate `/stock` calls per single bundle request, Sep 2026).
   * `_inFlightStockFetches` memoizes the in-flight promise per cache key so
   * only the first caller actually fetches; every concurrent caller for the
   * same symbol awaits that same promise instead of starting its own.
   */
  async _fetchStockRaw(symbolOrName) {
    const query = String(symbolOrName || '').trim();
    if (!query) {
      throw new IndianApiError(INDIAN_API_ERROR_CODES.INVALID_RESPONSE, 'A company symbol or name is required');
    }
    const cacheKey = `indianapi:stock:${query.toUpperCase()}`;
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const inFlight = this._inFlightStockFetches.get(cacheKey);
    if (inFlight) return inFlight;

    const fetchPromise = (async () => {
      const raw = await this._get('/stock', { name: query }, { operation: 'getCompanyResearch' });
      await setCache(cacheKey, raw, STOCK_CACHE_TTL_SECONDS);
      return raw;
    })();

    this._inFlightStockFetches.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      // Always release the slot once settled (success or failure) so a
      // later, non-concurrent call re-checks the cache / retries fresh
      // rather than being stuck replaying a stale settled promise forever.
      this._inFlightStockFetches.delete(cacheKey);
    }
  }

  async _fetchNormalized(symbolOrName) {
    const raw = await this._fetchStockRaw(symbolOrName);
    const normalized = normalizeCompanyResearch(raw, { endpoint: '/stock' });
    normalized.identity.symbol = String(symbolOrName || '').trim().toUpperCase();
    return normalized;
  }

  async resolveCompany(symbolOrName) {
    try {
      const normalized = await this._fetchNormalized(symbolOrName);
      if (!normalized.identity.companyName) return null;
      return {
        symbol: normalized.identity.symbol,
        companyName: normalized.identity.companyName,
        providerId: normalized.identity.stockId,
      };
    } catch (error) {
      if (error instanceof IndianApiError && error.errorCode === INDIAN_API_ERROR_CODES.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  async getCompanyProfile(symbolOrName) {
    const normalized = await this._fetchNormalized(symbolOrName);
    return { supported: true, provider: this.providerName, data: { identity: normalized.identity, profile: normalized.profile, marketSnapshot: normalized.marketSnapshot }, provenance: normalized.provenance };
  }

  async getFinancials(symbolOrName) {
    const normalized = await this._fetchNormalized(symbolOrName);
    return { supported: true, provider: this.providerName, data: normalized.financials, provenance: normalized.provenance };
  }

  async getKeyMetrics(symbolOrName) {
    const normalized = await this._fetchNormalized(symbolOrName);
    return { supported: true, provider: this.providerName, data: normalized.keyMetrics, provenance: normalized.provenance };
  }

  async getShareholding(symbolOrName) {
    const normalized = await this._fetchNormalized(symbolOrName);
    return { supported: true, provider: this.providerName, data: normalized.shareholding, provenance: normalized.provenance };
  }

  async getCorporateActions(symbolOrName) {
    const normalized = await this._fetchNormalized(symbolOrName);
    if (normalized.corporateActions.length) {
      return { supported: true, provider: this.providerName, data: normalized.corporateActions, provenance: normalized.provenance };
    }
    // Fall back to the dedicated endpoint only when the bundled response had none.
    try {
      const raw = await this._get('/corporate_actions', { stock_name: symbolOrName }, { operation: 'getCorporateActions' });
      return { supported: true, provider: this.providerName, data: normalizeCorporateActionsResponse(raw), provenance: { provider: this.providerName, fetchedAt: new Date().toISOString(), endpoint: '/corporate_actions' } };
    } catch (error) {
      if (error instanceof IndianApiError && error.errorCode === INDIAN_API_ERROR_CODES.NOT_FOUND) {
        return { supported: true, provider: this.providerName, data: [], provenance: normalized.provenance };
      }
      throw error;
    }
  }

  async getAnalystData(symbolOrName) {
    const normalized = await this._fetchNormalized(symbolOrName);
    return { supported: true, provider: this.providerName, data: normalized.analystData, provenance: normalized.provenance };
  }

  async getCompanyNews(symbolOrName) {
    const normalized = await this._fetchNormalized(symbolOrName);
    return { supported: true, provider: this.providerName, data: normalized.news, provenance: normalized.provenance };
  }

  /**
   * getOutcomeEvidence - flat list of dated, typed, provider-tagged
   * candidate evidence for Earnings Intelligence outcome verification.
   * This method only *surfaces* candidates; metric/period/unit matching
   * against a specific promise is the caller's responsibility
   * (services/OutcomeEvidenceService.js), keeping this provider agnostic
   * of promise-verification business rules.
   */
  async getOutcomeEvidence(symbolOrName, options = {}) {
    const normalized = await this._fetchNormalized(symbolOrName);
    const evidence = [];

    for (const entry of normalized.financials) {
      evidence.push({
        symbol: normalized.identity.symbol,
        evidenceType: 'FINANCIAL_ACTUAL',
        period: entry.period,
        evidenceDate: entry.date,
        publishedAt: entry.date,
        sourceUrl: entry.sourceUrl,
        sourceTitle: entry.title || 'IndianAPI company financials',
        provider: this.providerName,
        rawFieldName: 'financials',
        raw: entry.raw,
      });
    }

    for (const entry of normalized.corporateActions) {
      evidence.push({
        symbol: normalized.identity.symbol,
        evidenceType: 'CORPORATE_ACTION',
        period: entry.period,
        evidenceDate: entry.date,
        publishedAt: entry.date,
        sourceUrl: entry.sourceUrl,
        sourceTitle: entry.title || 'IndianAPI corporate action',
        provider: this.providerName,
        rawFieldName: 'corporateActions',
        raw: entry.raw,
      });
    }

    for (const entry of normalized.shareholding) {
      evidence.push({
        symbol: normalized.identity.symbol,
        evidenceType: 'SHAREHOLDING_CHANGE',
        period: entry.period,
        evidenceDate: entry.date,
        publishedAt: entry.date,
        sourceUrl: entry.sourceUrl,
        sourceTitle: entry.title || 'IndianAPI shareholding pattern',
        provider: this.providerName,
        rawFieldName: 'shareholding',
        raw: entry.raw,
      });
    }

    for (const entry of normalized.news) {
      evidence.push({
        symbol: normalized.identity.symbol,
        evidenceType: 'COMPANY_NEWS',
        period: null,
        evidenceDate: entry.date,
        publishedAt: entry.date,
        sourceUrl: entry.sourceUrl,
        sourceTitle: entry.title,
        provider: this.providerName,
        rawFieldName: 'news',
        raw: entry.raw,
      });
    }

    const metricFilter = options.metric ? String(options.metric).toUpperCase() : null;
    const periodFilter = options.targetPeriod ? String(options.targetPeriod).toUpperCase().replace(/\s+/g, ' ').trim() : null;
    const sinceDate = options.sinceDate ? new Date(options.sinceDate) : null;

    return evidence.filter((item) => {
      if (sinceDate && item.evidenceDate && new Date(item.evidenceDate) < sinceDate) return false;
      if (periodFilter && item.period && String(item.period).toUpperCase().replace(/\s+/g, ' ').trim() !== periodFilter) return false;
      // metricFilter is intentionally not applied here — the raw evidence
      // doesn't carry a normalized metric name yet; OutcomeEvidenceService
      // performs the actual metric matching against `raw`.
      return true;
    });
  }
}

export default IndianApiProvider;
