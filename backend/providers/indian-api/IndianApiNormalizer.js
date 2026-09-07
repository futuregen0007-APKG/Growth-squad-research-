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
 * single entry within a loosely-documented nested array (corporate
 * actions, news, shareholding, etc.). Never fabricates a field it cannot
 * find. Checks BOTH lower-camelCase and IndianAPI's actual PascalCase
 * variants (confirmed empirically against a real /stock response —
 * financial-statement entries use `FiscalYear`/`EndDate`/`StatementDate`,
 * not `fiscalYear`/`date` — see normalizeFinancials below, which uses the
 * dedicated financial-entry normalizer instead of this generic one for
 * exactly that reason).
 */
const normalizeGenericEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const date = pick(entry, 'date', 'Date', 'EndDate', 'StatementDate', 'fiscalYear', 'FiscalYear');
  const period = pick(entry, 'period', 'Period', 'fiscalYear', 'FiscalYear');
  const title = pick(entry, 'title', 'Title', 'headline', 'Headline');
  const sourceUrl = pick(entry, 'url', 'Url', 'URL', 'link', 'Link', 'sourceUrl');
  const { date: _d, Date: _D, EndDate: _ED, StatementDate: _SD, period: _p, Period: _P, fiscalYear: _fy, FiscalYear: _FY, title: _t, Title: _T, headline: _h, Headline: _H, url: _u, Url: _U, URL: _URL, link: _l, Link: _L, sourceUrl: _su, ...rest } = entry;
  return {
    date: toDateIsoOrNull(date),
    period: period != null ? String(period) : null,
    title: title || null,
    sourceUrl: isUsableUrl(sourceUrl) ? sourceUrl : null,
    raw: rest && Object.keys(rest).length ? rest : entry,
  };
};

// Statement-type codes IndianAPI's `stockFinancialMap` uses, confirmed
// empirically: INC (income statement), BAL (balance sheet), CAS (cash
// flow). Each maps to an array of { displayName, key, value, ... } line
// items — the ACTUAL numbers (revenue, margins, PAT, etc.) live here, not
// at the top level of a financials[] entry.
const STATEMENT_TYPE_LABELS = { INC: 'Income Statement', BAL: 'Balance Sheet', CAS: 'Cash Flow' };

/**
 * normalizeFinancialEntry - a financials[] entry has its own confirmed
 * shape (FiscalYear, EndDate, StatementDate, Type, fiscalPeriodNumber,
 * stockFinancialMap: { INC: [...], BAL: [...], CAS: [...] }) — distinct
 * enough from the generic corporate-actions/news/shareholding shape that
 * it gets its own normalizer rather than forcing it through
 * normalizeGenericEntry's guesswork.
 */
const normalizeFinancialEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const fiscalYear = pick(entry, 'FiscalYear', 'fiscalYear');
  const endDate = pick(entry, 'EndDate', 'endDate');
  const statementDate = pick(entry, 'StatementDate', 'statementDate');
  const fiscalPeriodNumber = pick(entry, 'fiscalPeriodNumber', 'FiscalPeriodNumber');
  const statementType = pick(entry, 'Type', 'type');

  // Period label prefers the fiscal year IndianAPI reports directly (e.g.
  // "2026") — callers needing "FY2026"/"Q2 FY2026" phrasing normalize this
  // further; we never invent a quarter/year that wasn't actually present.
  const period = fiscalYear != null ? String(fiscalYear) : null;

  const lineItems = [];
  const financialMap = pick(entry, 'stockFinancialMap', 'StockFinancialMap');
  if (financialMap && typeof financialMap === 'object') {
    for (const [statementCode, items] of Object.entries(financialMap)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const value = toNumberOrNull(item?.value);
        if (value === null || !item?.displayName) continue; // never fabricate a missing line item
        lineItems.push({
          statementType: statementCode,
          statementLabel: STATEMENT_TYPE_LABELS[statementCode] || statementCode,
          displayName: item.displayName,
          key: item.key || null,
          value,
        });
      }
    }
  }

  return {
    date: toDateIsoOrNull(endDate || statementDate),
    period,
    fiscalPeriodNumber: fiscalPeriodNumber != null ? Number(fiscalPeriodNumber) : null,
    statementType: statementType || null,
    title: null,
    sourceUrl: null, // IndianAPI's structured financials carry no per-record citable URL — never fabricate one
    lineItems,
    raw: entry,
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

/**
 * normalizeFinancials - uses normalizeFinancialEntry (empirically matched
 * to IndianAPI's real FiscalYear/EndDate/StatementDate/stockFinancialMap
 * shape), not the generic entry normalizer — the generic one's
 * lower-camelCase field guesses (date/period/fiscalYear) never matched
 * IndianAPI's actual PascalCase keys, so every financial record's period
 * silently came back null. Confirmed against a real /stock response.
 */
const normalizeFinancials = (raw) => {
  const financials = pick(raw, 'financials', 'StockFinancials');
  if (!Array.isArray(financials)) return [];
  return financials
    .map((entry) => {
      const normalized = normalizeFinancialEntry(entry);
      if (!normalized) return null;
      return { ...normalized, unitHint: NORMALIZED_UNIT_HINT };
    })
    .filter(Boolean);
};

// IndianAPI's keyMetrics is a fixed set of named categories (confirmed
// empirically: mgmtEffectiveness, margins, financialstrength, valuation,
// incomeStatement, growth, persharedata, priceandVolume), each itself an
// object of metric-name -> value pairs. Splitting into one normalized
// entry PER CATEGORY (rather than one opaque blob) is what lets
// getCompanyFinancials/getCompanyResearch build an evidence excerpt that
// actually names real numbers instead of an empty/untitled record.
const KEY_METRIC_CATEGORY_LABELS = {
  margins: 'Margins',
  valuation: 'Valuation',
  growth: 'Growth',
  financialstrength: 'Financial Strength',
  mgmtEffectiveness: 'Management Effectiveness',
  incomeStatement: 'Income Statement Ratios',
  persharedata: 'Per-Share Data',
  priceandVolume: 'Price & Volume',
};

const normalizeKeyMetrics = (raw) => {
  const keyMetrics = raw?.keyMetrics;
  if (!keyMetrics || typeof keyMetrics !== 'object') return { categories: [], raw: null };

  const categories = Object.entries(keyMetrics)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([categoryKey, categoryValue]) => {
      const metrics = Object.entries(categoryValue)
        .map(([name, value]) => ({ name, value: toNumberOrNull(value) }))
        .filter((m) => m.value !== null);
      return {
        category: categoryKey,
        label: KEY_METRIC_CATEGORY_LABELS[categoryKey] || categoryKey,
        metrics,
      };
    })
    .filter((c) => c.metrics.length);

  return { categories, raw: keyMetrics };
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
