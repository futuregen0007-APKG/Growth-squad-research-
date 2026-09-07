/**
 * IndianApiNormalizer - maps IndianAPI's raw `/stock` (and companion
 * endpoint) responses onto the provider-neutral company-research schema
 * consumed by CompanyResearchService, controllers, and the frontend.
 *
 * VERIFIED (via IndianAPI's public documentation/sandbox and corroborating
 * integrations, Sep 2026) top-level fields on `/stock?name=`:
 *   tickerId, companyName, industry, companyProfile, currentPrice{BSE,NSE},
 *   percentChange, yearHigh, yearLow, financials, keyMetrics, analystView,
 *   shareholding / stockCorporateActionData, recentNews.
 *
 * The exact internal shape of the nested financials/keyMetrics/shareholding/
 * corporateActions/analystData/news objects is NOT fully published. Rather
 * than guess field names and risk silently fabricating structure, this
 * normalizer:
 *   1. Precisely maps the well-documented top-level identity/price fields.
 *   2. For nested sections, detects widely-used common keys (date, period,
 *      fiscalYear, title/headline, url/link) where present, and preserves
 *      everything else verbatim under `raw` on each entry — nothing is
 *      invented, relabelled with false confidence, or dropped.
 *   3. Leaves a field `null`/absent when genuinely not present, and never
 *      substitutes 0 for a missing numeric value.
 */

const NORMALIZED_UNIT_HINT = 'INR_CRORE'; // IndianAPI financial figures are conventionally reported in INR Crore.

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (isFiniteNumber(value)) return value;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === 'NA' || cleaned === 'N/A') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const toDateIsoOrNull = (value) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const isUsableUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return null;
  }
};

/** Pull the first present value among several candidate key names on obj. */
const pick = (obj, ...keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

/**
 * Generic "detect the common fields, preserve the rest" normalizer for a
 * single entry within a loosely-documented nested array (financials,
 * corporate actions, news, etc.). Never fabricates a field it cannot find.
 */
const normalizeGenericEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const { date, period, fiscalYear, title, headline, url, link, sourceUrl, ...rest } = entry;
  return {
    date: toDateIsoOrNull(date || fiscalYear),
    period: period || fiscalYear || null,
    title: title || headline || null,
    sourceUrl: isUsableUrl(url || link || sourceUrl) ? (url || link || sourceUrl) : null,
    raw: rest && Object.keys(rest).length ? rest : entry,
  };
};

const normalizeCompanyProfile = (raw) => {
  const profile = raw?.companyProfile;
  if (!profile || typeof profile !== 'object') return null;
  return {
    description: pick(profile, 'companyDescription', 'description') || null,
    mgIndustry: pick(profile, 'mgIndustry') || null,
    exchangeCodeBse: pick(profile, 'exchangeCodeBse', 'bseCode') || null,
    exchangeCodeNse: pick(profile, 'exchangeCodeNse', 'nseCode') || null,
    officers: Array.isArray(profile.officers) ? profile.officers : null,
    peerCompanyList: Array.isArray(profile.peerCompanyList) ? profile.peerCompanyList : null,
    raw: profile,
  };
};

const normalizeFinancials = (raw) => {
  const financials = pick(raw, 'financials', 'stockFinancialMap');
  if (!Array.isArray(financials)) return [];
  return financials
    .map((entry) => {
      const normalized = normalizeGenericEntry(entry);
      if (!normalized) return null;
      return { ...normalized, unitHint: NORMALIZED_UNIT_HINT };
    })
    .filter(Boolean);
};

const normalizeKeyMetrics = (raw) => {
  const keyMetrics = raw?.keyMetrics;
  if (!keyMetrics || typeof keyMetrics !== 'object') return {};
  return { raw: keyMetrics };
};

const normalizeShareholding = (raw) => {
  const shareholding = pick(raw, 'shareholding', 'shareHoldingPattern', 'shareholdingPattern');
  if (Array.isArray(shareholding)) {
    return shareholding.map((entry) => normalizeGenericEntry(entry)).filter(Boolean);
  }
  if (shareholding && typeof shareholding === 'object') {
    return [{ date: null, period: null, title: null, sourceUrl: null, raw: shareholding }];
  }
  return [];
};

const normalizeCorporateActions = (raw) => {
  const actions = pick(raw, 'stockCorporateActionData', 'corporateActions', 'corporate_actions');
  const list = Array.isArray(actions) ? actions : Array.isArray(actions?.data) ? actions.data : [];
  return list.map((entry) => normalizeGenericEntry(entry)).filter(Boolean);
};

const normalizeAnalystData = (raw) => {
  const analystView = pick(raw, 'analystView', 'recosBar', 'stockTargetPrice');
  if (!analystView) return null;
  return {
    // Explicitly informational — never fed into promise-outcome verification.
    note: 'Analyst opinion/target from IndianAPI. This is a third-party forecast, not a reported company outcome.',
    raw: analystView,
  };
};

const normalizeNews = (raw) => {
  const news = pick(raw, 'recentNews', 'news');
  if (!Array.isArray(news)) return [];
  return news
    .map((entry) => {
      const normalized = normalizeGenericEntry(entry);
      if (!normalized) return null;
      // A news item without a real title or a real dated source URL is not
      // useful evidence and must not be presented as if it were.
      if (!normalized.title || !normalized.sourceUrl) return null;
      return normalized;
    })
    .filter(Boolean);
};

/**
 * normalizeCompanyResearch - top-level entry point. `raw` is the parsed
 * JSON body of a `/stock?name=...` response. `endpoint` is recorded for
 * provenance only.
 */
export const normalizeCompanyResearch = (raw, { endpoint = '/stock' } = {}) => {
  const currentPrice = raw?.currentPrice || {};

  return {
    identity: {
      symbol: null, // filled in by the caller, who knows the requested symbol
      companyName: raw?.companyName || null,
      stockId: raw?.tickerId || null,
      industry: raw?.industry || null,
      sector: pick(raw?.companyProfile, 'mgSector', 'sector') || null,
      nseCode: pick(raw?.companyProfile, 'exchangeCodeNse') || null,
      bseCode: pick(raw?.companyProfile, 'exchangeCodeBse') || null,
    },
    marketSnapshot: {
      nsePrice: toNumberOrNull(pick(currentPrice, 'NSE', 'nse')),
      bsePrice: toNumberOrNull(pick(currentPrice, 'BSE', 'bse')),
      percentChange: toNumberOrNull(raw?.percentChange),
      yearHigh: toNumberOrNull(raw?.yearHigh),
      yearLow: toNumberOrNull(raw?.yearLow),
      asOf: new Date().toISOString(),
    },
    profile: normalizeCompanyProfile(raw),
    financials: normalizeFinancials(raw),
    keyMetrics: normalizeKeyMetrics(raw),
    technicalData: raw?.stockTechnicalData && typeof raw.stockTechnicalData === 'object' ? { raw: raw.stockTechnicalData } : {},
    analystData: normalizeAnalystData(raw),
    shareholding: normalizeShareholding(raw),
    corporateActions: normalizeCorporateActions(raw),
    news: normalizeNews(raw),
    provenance: {
      provider: 'indian-api',
      fetchedAt: new Date().toISOString(),
      endpoint,
    },
  };
};

export const normalizeCorporateActionsResponse = (raw) => {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  return list.map((entry) => normalizeGenericEntry(entry)).filter(Boolean);
};

export const normalizeHistoricalStats = (raw) => {
  if (!raw || typeof raw !== 'object') return [];
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [raw];
  return entries.map((entry) => normalizeGenericEntry(entry)).filter(Boolean);
};

export { toNumberOrNull, toDateIsoOrNull, isUsableUrl, normalizeGenericEntry };

export default normalizeCompanyResearch;
