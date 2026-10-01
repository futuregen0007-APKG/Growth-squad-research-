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
 * VERIFIED_LABELS - human-readable display text for each verified
 * definition enum. "Profit after tax (consolidated)" deliberately does NOT
 * claim a profit-attributable-to-owners split -- Upstox's API has no
 * minority-interest line anywhere (confirmed live against TCS/INFY
 * full_statement), so this project never fabricates one.
 */
const VERIFIED_LABELS = {
  REVENUE_FROM_OPERATIONS: 'Revenue from operations',
  TOTAL_INCOME: 'Total income',
  PROFIT_BEFORE_TAX: 'Profit before tax',
  PROFIT_AFTER_TAX: 'Profit after tax (consolidated)',
};

/** valuesMatch - 2dp-tolerant equality for cross-referencing summary vs full_statement figures (both already pass through toNumberOrNull, so this only guards against float drift, never a real mismatch). */
const valuesMatch = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) < 0.005;

/**
 * buildFullStatementLookup - income-statement's `fs=true` response adds a
 * `full_statement` array using the SAME nested shape as `income_statement`
 * (confirmed live for TCS/INFY) but keyed by `particular` instead of
 * `category` ("Revenue", "Other Income", "Total Revenue", "Profit Before
 * Tax", "Profit After Tax", ...). Returns slugify(particular) -> Map(rawPeriod -> value).
 * Absent/empty full_statement (fs wasn't honored, or no data for this
 * company) returns an empty Map -- callers must treat that as
 * "unverifiable", never guess.
 */
const buildFullStatementLookup = (fullStatementList) => {
  const lookup = new Map();
  if (!Array.isArray(fullStatementList)) return lookup;
  for (const entry of fullStatementList) {
    const key = entry?.particular != null ? slugify(entry.particular) : null;
    if (!key || !Array.isArray(entry.history)) continue;
    const periodMap = new Map();
    for (const h of entry.history) {
      const rawPeriod = h?.period != null ? String(h.period) : null;
      if (!rawPeriod) continue;
      periodMap.set(rawPeriod, toNumberOrNull(h?.value));
    }
    lookup.set(key, periodMap);
  }
  return lookup;
};

/**
 * deriveVerifiedDefinition - cross-references ONE summary metric
 * (label/value for a SPECIFIC rawPeriod) against the full_statement lookup
 * for that SAME period -- done per period, not just the latest, since a
 * company's revenue/other-income mix can change year to year. Never
 * guesses: a label this function doesn't recognize, a missing/empty
 * lookup, a missing particular for that period, or a value that doesn't
 * match any candidate particular all resolve to `null`.
 */
const deriveVerifiedDefinition = (label, value, rawPeriod, fullStatementLookup) => {
  if (value === null || value === undefined || !rawPeriod || !fullStatementLookup?.size) return null;
  const valueAt = (particularKey) => fullStatementLookup.get(particularKey)?.get(rawPeriod);

  if (label === 'revenue') {
    if (valuesMatch(value, valueAt('revenue'))) return 'REVENUE_FROM_OPERATIONS';
    if (valuesMatch(value, valueAt('total_revenue'))) return 'TOTAL_INCOME';
    return null;
  }
  if (label === 'operating_profit') {
    if (valuesMatch(value, valueAt('profit_before_tax'))) return 'PROFIT_BEFORE_TAX';
    return null;
  }
  if (label === 'net_profit') {
    if (valuesMatch(value, valueAt('profit_after_tax'))) return 'PROFIT_AFTER_TAX';
    return null;
  }
  return null;
};

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

export const UPSTOX_PER_SHARE_UNIT = 'INR_PER_SHARE';

const EPS_PARTICULARS = [
  ['eps_basic', slugify('EPS - Basic')],
  ['eps_diluted', slugify('EPS - Diluted')],
];

/**
 * extractEpsMetrics - reads EPS straight from the income-statement
 * full_statement lookup (particulars "EPS - Basic"/"EPS - Diluted",
 * confirmed live for TCS/INFY/HDFCBANK). One entry per period actually
 * present; a missing particular yields no entries, a non-numeric value
 * stays null -- never derived from PAT/share count, never fabricated.
 */
const extractEpsMetrics = (fullStatementLookup) => {
  if (!fullStatementLookup?.size) return [];
  return EPS_PARTICULARS.flatMap(([label, key]) => {
    const periodMap = fullStatementLookup.get(key);
    if (!periodMap) return [];
    return [...periodMap.entries()].map(([rawPeriod, value]) => ({
      financialYear: deriveFiscalYearLabel(rawPeriod),
      label,
      value,
      unit: UPSTOX_PER_SHARE_UNIT,
    }));
  });
};

/**
 * Shared builder for balance-sheet/cash-flow/income-statement, which all
 * resolve to the same explicit schema. `annotateProviderFields` is ONLY
 * ever true for income-statement (the one statement with a confirmed
 * provider-label-vs-true-meaning mismatch -- balance-sheet/cash-flow's
 * summary field names are inherently unambiguous aggregates and are
 * deliberately left untouched): when true, each metric also gets
 * `providerLabel` (identical to `label`, kept for backward compat -- see
 * `label` usage check in UpstoxNormalizer's own module comment history)
 * plus `verifiedDefinition`/`verifiedLabel` derived per-period from
 * `data.full_statement` via deriveVerifiedDefinition.
 */
const buildStatement = (raw, {
  symbol = null, isin, fetchedAt, statementType = 'consolidated', period = 'YEARLY', topLevelKeys, flatExcludeKeys,
  annotateProviderFields = false,
}) => {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : {};
  let list = [];
  for (const key of topLevelKeys) {
    if (Array.isArray(data[key])) { list = data[key]; break; }
  }
  const fullStatementLookup = annotateProviderFields ? buildFullStatementLookup(data.full_statement) : null;
  const metrics = extractPeriodicMetrics(list, { flatExcludeKeys }).map(({
    financialYear, rawPeriod, label, value, changePct,
  }) => {
    if (!annotateProviderFields) return { financialYear, label, value, changePct };
    const verifiedDefinition = deriveVerifiedDefinition(label, value, rawPeriod, fullStatementLookup);
    return {
      financialYear,
      label,
      value,
      changePct,
      providerLabel: label,
      verifiedDefinition,
      verifiedLabel: verifiedDefinition ? VERIFIED_LABELS[verifiedDefinition] : null,
    };
  });
  return {
    symbol,
    isin,
    statementType: String(data.type || statementType || 'consolidated').toUpperCase(),
    period: String(data.time_period || period || 'YEARLY').toUpperCase(),
    units: data.units_in && !/^crores?$/i.test(data.units_in) ? `UNSUPPORTED_${String(data.units_in).toUpperCase()}` : UPSTOX_UNIT,
    provider: 'UPSTOX',
    fetchedAt,
    metrics,
    // Only income-statement carries per-share figures (its full_statement's
    // "EPS - Basic"/"EPS - Diluted" particulars). Kept in their OWN array,
    // never mixed into `metrics` -- `metrics` is homogeneously INR_CRORE
    // (see `units` above) and callers rely on that.
    ...(annotateProviderFields ? { epsMetrics: extractEpsMetrics(fullStatementLookup) } : {}),
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
  ...ctx, period: 'YEARLY', topLevelKeys: ['income_statement', 'history'], flatExcludeKeys: ['period'], annotateProviderFields: true,
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

/**
 * parseRatioValue - Upstox mixes percentage STRINGS ("45.89%", "-2.15%")
 * and plain-number strings ("14.82") within the SAME key-ratios response --
 * confirmed live: TCS ROE/ROA/ROCE and HDFCBANK NIM/ROA/ROE/Net NPA are all
 * "%"-suffixed, while P/E, P/B, Quick Ratio, EV/EBITDA, and (notably)
 * HDFCBANK's own CASA are plain numbers with NO "%" despite CASA being a
 * percentage by banking convention -- Upstox simply doesn't format it that
 * way. This is why unit detection must be driven by whatever the raw
 * STRING actually contains, never by the ratio NAME (a name-based guess
 * would have wrongly stripped CASA's non-existent "%", or wrongly assumed
 * every ratio is a plain number). toNumberOrNull("45.89%") alone is NaN
 * (the trailing "%" breaks Number() coercion) -- this strips it first,
 * same fix as parseChangePct, then tags the real unit so nothing
 * downstream has to re-guess.
 */
const parseRatioValue = (value) => {
  if (value === null || value === undefined || value === '') return { value: null, unit: null };
  const str = String(value).trim();
  const isPercent = str.endsWith('%');
  const num = toNumberOrNull(isPercent ? str.slice(0, -1).trim() : str);
  return { value: num, unit: num === null ? null : (isPercent ? 'PERCENT' : 'NUMBER') };
};

/** company_value/sector_value stay clearly separate fields -- company_value is genuinely company-level (unlike profile's sector market cap), sector_value is the sector comparator. Each gets its own unit tag since nothing guarantees they always agree. */
export const normalizeKeyRatios = (raw, { symbol = null, isin, fetchedAt }) => {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const ratios = list
    .map((item) => {
      const company = parseRatioValue(item?.company_value);
      const sector = parseRatioValue(item?.sector_value);
      return {
        name: item?.name || null,
        companyValue: company.value,
        companyValueUnit: company.unit,
        sectorValue: sector.value,
        sectorValueUnit: sector.unit,
      };
    })
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

export { extractPeriodicMetrics, parseChangePct, parseRatioValue, VERIFIED_LABELS };

export default {
  UPSTOX_UNIT,
  UPSTOX_PER_SHARE_UNIT,
  VERIFIED_LABELS,
  deriveFiscalYearLabel,
  normalizeBalanceSheet,
  normalizeCashFlow,
  normalizeIncomeStatement,
  normalizeProfile,
  normalizeKeyRatios,
  normalizeShareholding,
  normalizeCorporateActions,
};
