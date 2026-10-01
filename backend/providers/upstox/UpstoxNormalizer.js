/**
 * UpstoxNormalizer - maps Upstox Company Fundamentals API responses onto
 * an explicit, provider-tagged schema. Never fabricates a value: a
 * missing/null/non-numeric field from Upstox stays `null`, never 0 or an
 * interpolated guess. Consolidated/standalone and yearly/quarterly are
 * always kept as explicit top-level tags on the result, never merged into
 * one ambiguous record. Reuses IndianApiNormalizer's pure number/date
 * coercion helpers rather than re-implementing the same "never substitute
 * a missing value" logic a second time.
 */
import { toNumberOrNull, toDateIsoOrNull } from '../indian-api/IndianApiNormalizer.js';

export const UPSTOX_UNIT = 'INR_CRORE';

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * deriveFiscalYearLabel - Upstox period label ("Mar 2026") -> this
 * project's `FY<YYYY>` label, using the SAME April-March fiscal year rule
 * as NseXbrlService.toReportingPeriod (Indian FY ends 31 Mar): a period
 * ending Jan/Feb/Mar belongs to the FY named after that calendar year; a
 * period ending Apr-Dec belongs to the FY named after the FOLLOWING year.
 * Never guesses when the label doesn't parse — returns null.
 */
export const deriveFiscalYearLabel = (periodLabel) => {
  const match = String(periodLabel || '').trim().match(/^([A-Za-z]{3,})\.?\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTH_INDEX[match[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const year = Number(match[2]);
  if (!Number.isFinite(year)) return null;
  const fiscalYear = month >= 3 ? year + 1 : year;
  return `FY${fiscalYear}`;
};

const slugify = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * parseChangePct - Upstox's `change` field is a formatted percentage
 * STRING like "+6.51%" or "-454.14%", not a plain number -- confirmed
 * live against real income-statement and cash-flow responses. Passing
 * that straight through toNumberOrNull silently dropped every real
 * change value to null (Number("+6.51%") is NaN because of the trailing
 * "%", even though the numeric part is perfectly valid). Strips the "%"
 * before delegating to the same never-fabricate numeric coercion used
 * everywhere else.
 */
const parseChangePct = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return toNumberOrNull(String(value).replace(/%/g, '').trim());
};

/**
 * extractPeriodicMetrics - handles BOTH shapes Upstox's statement
 * endpoints use: a nested "category -> history[]" shape (confirmed for
 * income-statement: `{category, history:[{value,period,change}]}`, and
 * defensively applied to cash-flow, which the docs describe the same way)
 * and a flat "one row per period with several named fields" shape
 * (confirmed for balance-sheet: `{period, total_asset, total_liability,
 * ...}`). Every numeric field actually present becomes its own metric
 * labeled by its real Upstox field/category name — nothing is invented,
 * and a field whose value doesn't parse as a number stays null rather
 * than being dropped or zeroed.
 */
const extractPeriodicMetrics = (list, { flatExcludeKeys = ['period'] } = {}) => {
  if (!Array.isArray(list) || !list.length) return [];

  const isNestedCategoryShape = list[0] && typeof list[0] === 'object' && Array.isArray(list[0].history);
  if (isNestedCategoryShape) {
    return list.flatMap((entry) => {
      const label = entry?.category != null ? slugify(entry.category) : null;
      if (!label || !Array.isArray(entry.history)) return [];
      return entry.history.map((h) => ({
        financialYear: deriveFiscalYearLabel(h?.period),
        rawPeriod: h?.period != null ? String(h.period) : null,
        label,
        value: toNumberOrNull(h?.value),
        changePct: parseChangePct(h?.change),
      }));
    });
  }

  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const rawPeriod = entry.period != null ? String(entry.period) : null;
    return Object.entries(entry)
      .filter(([key]) => !flatExcludeKeys.includes(key))
      .map(([key, value]) => ({
        financialYear: deriveFiscalYearLabel(rawPeriod),
        rawPeriod,
        label: key,
        value: toNumberOrNull(value),
        changePct: null, // the flat shape carries no per-field change -- never fabricated
      }));
  });
};

/** Shared builder for balance-sheet/cash-flow/income-statement, which all resolve to the same explicit schema. */
const buildStatement = (raw, {
  symbol = null, isin, fetchedAt, statementType = 'consolidated', period = 'YEARLY', topLevelKeys, flatExcludeKeys,
}) => {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : {};
  let list = [];
  for (const key of topLevelKeys) {
    if (Array.isArray(data[key])) { list = data[key]; break; }
  }
  return {
    symbol,
    isin,
    statementType: String(statementType || 'consolidated').toUpperCase(),
    period: String(period || 'YEARLY').toUpperCase(),
    units: UPSTOX_UNIT,
    provider: 'UPSTOX',
    fetchedAt,
    metrics: extractPeriodicMetrics(list, { flatExcludeKeys }).map(({ financialYear, label, value, changePct }) => ({
      financialYear, label, value, changePct,
    })),
    raw,
  };
};

export const normalizeBalanceSheet = (raw, ctx) => buildStatement(raw, {
  ...ctx, topLevelKeys: ['history', 'balance_sheet'], flatExcludeKeys: ['period'],
});

export const normalizeCashFlow = (raw, ctx) => buildStatement(raw, {
  ...ctx, topLevelKeys: ['cash_flow', 'history'], flatExcludeKeys: ['period'],
});

export const normalizeIncomeStatement = (raw, ctx) => buildStatement(raw, {
  ...ctx, period: 'YEARLY', topLevelKeys: ['income_statement', 'history'], flatExcludeKeys: ['period'],
});

/**
 * normalizeProfile - `sector_market_cap_inr`/`sector_market_cap_usd` are
 * the SECTOR's market cap per Upstox's own docs, never the company's.
 * Labeled explicitly as such here so nothing downstream (this normalizer,
 * the API response, or the frontend) can relabel it as company market cap.
 * A real company-level market cap already exists in this project from a
 * different source (CompanyResearchProfile.marketCapCr) and is
 * deliberately NOT merged in here — that would blur two different
 * providers' numbers into one field.
 */
export const normalizeProfile = (raw, { symbol = null, isin, fetchedAt }) => {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : {};
  const marketCapBlock = (block) => (block && typeof block === 'object'
    ? { value: toNumberOrNull(block.value), unit: block.unit || null, formatted: block.formatted || null }
    : null);
  return {
    symbol,
    isin,
    provider: 'UPSTOX',
    fetchedAt,
    companyProfile: data.company_profile || null,
    sector: data.sector || null,
    sectorMarketCapInr: marketCapBlock(data.sector_market_cap_inr),
    sectorMarketCapUsd: marketCapBlock(data.sector_market_cap_usd),
    raw,
  };
};

/** company_value/sector_value stay clearly separate fields -- company_value is genuinely company-level (unlike profile's sector market cap), sector_value is the sector comparator. */
export const normalizeKeyRatios = (raw, { symbol = null, isin, fetchedAt }) => {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const ratios = list
    .map((item) => ({
      name: item?.name || null,
      companyValue: toNumberOrNull(item?.company_value),
      sectorValue: toNumberOrNull(item?.sector_value),
    }))
    .filter((ratio) => ratio.name);
  return {
    symbol, isin, provider: 'UPSTOX', fetchedAt, ratios, raw,
  };
};

export const normalizeShareholding = (raw, { symbol = null, isin, fetchedAt }) => {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const categories = list
    .map((entry) => ({
      category: entry?.category || null,
      history: (Array.isArray(entry?.history) ? entry.history : []).map((h) => ({
        period: h?.period != null ? String(h.period) : null,
        // Ownership % is reported per its own period (often quarterly) -- FY
        // derivation is attached as a convenience, but a non-annual period
        // legitimately derives one too under the April-March rule; this
        // does NOT force the reading into an annual bucket.
        financialYear: deriveFiscalYearLabel(h?.period),
        valuePct: toNumberOrNull(h?.value),
      })),
    }))
    .filter((entry) => entry.category);
  return {
    symbol, isin, provider: 'UPSTOX', fetchedAt, categories, raw,
  };
};

export const normalizeCorporateActions = (raw, { symbol = null, isin, fetchedAt }) => {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const actions = list
    .map((entry) => ({
      name: entry?.name || null,
      expiryDate: toDateIsoOrNull(entry?.expiry_date),
      amount: toNumberOrNull(entry?.amount),
      ratio: entry?.ratio != null ? String(entry.ratio) : null,
      eventDetails: Array.isArray(entry?.event_details) ? entry.event_details : [],
    }))
    .filter((action) => action.name);
  return {
    symbol, isin, provider: 'UPSTOX', fetchedAt, actions, raw,
  };
};

export { extractPeriodicMetrics, parseChangePct };

export default {
  UPSTOX_UNIT,
  deriveFiscalYearLabel,
  normalizeBalanceSheet,
  normalizeCashFlow,
  normalizeIncomeStatement,
  normalizeProfile,
  normalizeKeyRatios,
  normalizeShareholding,
  normalizeCorporateActions,
};
