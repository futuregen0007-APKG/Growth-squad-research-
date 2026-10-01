/**
 * StockDetailFinancials - re-shapes the existing on-demand Upstox company
 * financials search (CompanyFinancialsSearchService.searchCompanyFinancials:
 * resolve -> ISIN, parallel section fetch, Redis cache, RateLimitGate) into
 * what the /stock/:symbol page needs. Reuses that pipeline as-is -- nothing
 * here fetches, caches, or persists anything itself. NEVER writes to MongoDB.
 *
 * Honesty rules enforced here:
 *   - Every section carries its own status/asOf/fromCache/error, so a cached
 *     figure is never presented as a live fetch.
 *   - A provider failure/timeout yields an explicit unavailable state, never
 *     a fallback to some other (suspect) figure for the same metric.
 *   - Upstox's summary `operating_profit` is shown ONLY where it reconciles
 *     to "Profit Before Tax" for that year, and is labeled as such -- never
 *     as EBITDA/operating profit.
 *   - Metrics with no source in Upstox's data (EBITDA, Adjusted PAT, Debt /
 *     Borrowings, Bank deposits, CapEx) are listed as unavailable with a
 *     specific reason, never filled in.
 *   - Key ratios (ROE/ROCE/P-E/NIM/...) are CURRENT, point-in-time values:
 *     they never carry a financialYear and are never copied into the annual
 *     rows.
 *   - Sector market cap from the Upstox profile is never surfaced here (it
 *     is sector-level, not company-level).
 */
import { searchCompanyFinancials } from './CompanyFinancialsSearchService.js';
import { UPSTOX_UNIT, UPSTOX_PER_SHARE_UNIT } from '../providers/upstox/UpstoxNormalizer.js';
import { logger } from '../utils/logger.js';

export const STOCK_DETAIL_FINANCIALS_TIMEOUT_MS = 12000;

const PAGE_SECTIONS = ['profile', 'incomeStatement', 'balanceSheet', 'cashFlow', 'keyRatios'];

/** Display labels for summary fields whose meaning is unambiguous (balance-sheet / cash-flow aggregates). */
const UNAMBIGUOUS_LABELS = {
  balanceSheet: { total_asset: 'Total Assets', total_liability: 'Total Liabilities' },
  cashFlow: { operating: 'Operating cash flow', investing: 'Investing cash flow', financing: 'Financing cash flow' },
};

/** Income-statement summary labels -> the verified definitions they may legitimately carry. */
const ALLOWED_VERIFIED_DEFINITIONS = {
  revenue: ['TOTAL_INCOME', 'REVENUE_FROM_OPERATIONS'],
  operating_profit: ['PROFIT_BEFORE_TAX'],
  net_profit: ['PROFIT_AFTER_TAX'],
};

export const UNAVAILABLE_METRICS = {
  incomeStatement: [
    { key: 'ebitda', label: 'EBITDA', reason: 'Not provided by this data source (Upstox reports no EBITDA or depreciation line).' },
    { key: 'adjusted_pat', label: 'Adjusted PAT', reason: 'No verified adjusted-PAT definition from this provider.' },
  ],
  balanceSheet: [
    { key: 'debt', label: 'Debt / Borrowings', reason: 'Not provided by this data source: neither the Upstox balance-sheet summary nor its full statement exposes a borrowings line. Total Liabilities is not debt.' },
    { key: 'deposits', label: 'Bank deposits', reason: 'Not provided by this data source: the Upstox balance sheet exposes no deposits line, including for banks.' },
  ],
  cashFlow: [
    { key: 'capex', label: 'CapEx', reason: 'Not provided by this data source: the Upstox cash-flow statement has no purchase-of-fixed-assets line. Investing cash flow is not CapEx.' },
  ],
};

const EPS_LABELS = { eps_basic: 'EPS (Basic)', eps_diluted: 'EPS (Diluted)' };

const prettify = (label) => String(label || '').replace(/_/g, ' ');

const fyNumber = (financialYear) => {
  const match = String(financialYear || '').match(/^FY(\d{4})$/);
  return match ? Number(match[1]) : null;
};

const unavailableSection = (code, message) => ({
  available: false, data: null, status: 'UNAVAILABLE', error: { code, message }, asOf: null, fromCache: false,
});

const sectionMeta = (section) => ({
  status: section?.status || 'UNAVAILABLE',
  asOf: section?.asOf || null,
  fromCache: Boolean(section?.fromCache),
  error: section?.error || null,
});

const mapIncomeRow = (metric) => {
  const allowed = ALLOWED_VERIFIED_DEFINITIONS[metric.label];
  const verified = Boolean(metric.verifiedDefinition && allowed?.includes(metric.verifiedDefinition));
  const base = {
    label: metric.label,
    verifiedLabel: verified ? metric.verifiedLabel : null,
    verifiedDefinition: verified ? metric.verifiedDefinition : null,
    financialYear: metric.financialYear,
    value: metric.value ?? null,
    changePct: metric.changePct ?? null,
    unit: UPSTOX_UNIT,
    definitionCheck: verified ? 'VERIFIED' : 'UNVERIFIED',
  };
  if (metric.label === 'operating_profit') {
    // Only ever shown as "Profit before tax", and only where it reconciled.
    return verified
      ? { ...base, displayLabel: metric.verifiedLabel }
      : {
        ...base, displayLabel: 'Profit before tax', value: null, changePct: null,
        withheldReason: 'Provider figure did not reconcile to Profit Before Tax for this year; withheld rather than mislabeled.',
      };
  }
  return { ...base, displayLabel: verified ? metric.verifiedLabel : prettify(metric.label) };
};

const mapUnambiguousRow = (statementKey, metric) => {
  const known = UNAMBIGUOUS_LABELS[statementKey][metric.label];
  return {
    label: metric.label,
    displayLabel: known || prettify(metric.label),
    verifiedLabel: null,
    verifiedDefinition: null,
    financialYear: metric.financialYear,
    value: metric.value ?? null,
    changePct: metric.changePct ?? null,
    unit: UPSTOX_UNIT,
    definitionCheck: known ? 'NOT_REQUIRED' : 'UNVERIFIED',
  };
};

const buildStatementBlock = (statementKey, section) => {
  const data = section?.available ? section.data : null;
  // EarningsAnnualFinancials applies the same gate: rows are only trusted
  // when the section's own unit is the crore unit every row assumes.
  const unitOk = data?.units === UPSTOX_UNIT;
  const metrics = unitOk && Array.isArray(data?.metrics) ? data.metrics : [];
  const rows = metrics
    .filter((m) => m?.label && m.financialYear)
    .map((m) => (statementKey === 'incomeStatement' ? mapIncomeRow(m) : mapUnambiguousRow(statementKey, m)));
  return {
    ...sectionMeta(section),
    ...(data && !unitOk ? { status: 'UNAVAILABLE', error: { code: 'UNIT_MISMATCH', message: `Unexpected statement unit ${data.units}; figures withheld.` } } : {}),
    statementType: data?.statementType || null,
    period: data?.period || null,
    rows,
    unavailableMetrics: UNAVAILABLE_METRICS[statementKey],
  };
};

/**
 * selectVerifiedGrowth - the growth figure Stock Detail feeds into its score:
 * Upstox's own `changePct` for the most recent financial year whose row is
 * definition-verified AND whose prior-year row is verified with the SAME
 * definition (so the change never compares two differently-defined
 * figures). Returns null when no such year exists -- never derived here.
 */
export const selectVerifiedGrowth = (rows, label) => {
  const allowed = ALLOWED_VERIFIED_DEFINITIONS[label] || [];
  const byYear = new Map(
    (rows || []).filter((r) => r.label === label && fyNumber(r.financialYear) != null).map((r) => [fyNumber(r.financialYear), r]),
  );
  const candidates = [...byYear.values()]
    .filter((r) => allowed.includes(r.verifiedDefinition) && Number.isFinite(r.changePct))
    .sort((a, b) => fyNumber(b.financialYear) - fyNumber(a.financialYear));
  for (const row of candidates) {
    const prior = byYear.get(fyNumber(row.financialYear) - 1);
    if (prior && prior.verifiedDefinition === row.verifiedDefinition) {
      return {
        value: row.changePct, financialYear: row.financialYear, verifiedDefinition: row.verifiedDefinition, verifiedLabel: row.verifiedLabel, provider: 'UPSTOX',
      };
    }
  }
  return null;
};

/** buildStockDetailFinancials - pure re-shape of a searchCompanyFinancials() result (or a failure) into the Stock Detail payload. */
export const buildStockDetailFinancials = (searchResult, { failure = null } = {}) => {
  let sections;
  let resolution = { symbol: null, companyName: null, isin: null };
  if (failure) {
    sections = Object.fromEntries(PAGE_SECTIONS.map((key) => [key, unavailableSection(failure.code, failure.message)]));
  } else if (!searchResult?.data?.sections) {
    const failureFor = searchResult?.isinUnavailable
      ? ['ISIN_UNAVAILABLE', 'No ISIN on file for this company; Upstox financials cannot be fetched.']
      : searchResult?.ambiguous
        ? ['AMBIGUOUS', 'Symbol matched more than one company; financials withheld.']
        : ['NOT_RESOLVED', 'Company could not be resolved for the financials provider.'];
    sections = Object.fromEntries(PAGE_SECTIONS.map((key) => [key, unavailableSection(...failureFor)]));
  } else {
    sections = searchResult.data.sections;
    resolution = { symbol: searchResult.data.symbol, companyName: searchResult.data.companyName, isin: searchResult.data.isin };
  }

  const profileSection = sections.profile;
  const profile = {
    ...sectionMeta(profileSection),
    description: profileSection?.available ? (profileSection.data?.companyProfile || null) : null,
    sector: profileSection?.available ? (profileSection.data?.sector || null) : null,
  };

  const annualFinancials = {
    incomeStatement: buildStatementBlock('incomeStatement', sections.incomeStatement),
    balanceSheet: buildStatementBlock('balanceSheet', sections.balanceSheet),
    cashFlow: buildStatementBlock('cashFlow', sections.cashFlow),
  };

  const incomeData = sections.incomeStatement?.available ? sections.incomeStatement.data : null;
  const perShareFinancials = (Array.isArray(incomeData?.epsMetrics) ? incomeData.epsMetrics : [])
    .filter((m) => m?.label && m.financialYear)
    .map((m) => ({
      label: m.label,
      displayLabel: EPS_LABELS[m.label] || prettify(m.label),
      financialYear: m.financialYear,
      value: m.value ?? null,
      unit: UPSTOX_PER_SHARE_UNIT,
    }));

  const ratiosSection = sections.keyRatios;
  const currentRatios = {
    ...sectionMeta(ratiosSection),
    pointInTime: true,
    // Copied field-by-field so no financialYear (or any other annual tag)
    // can ever ride along onto a current ratio.
    ratios: (ratiosSection?.available && Array.isArray(ratiosSection.data?.ratios) ? ratiosSection.data.ratios : []).map((r) => ({
      name: r.name,
      companyValue: r.companyValue ?? null,
      companyValueUnit: r.companyValueUnit ?? null,
      sectorValue: r.sectorValue ?? null,
      sectorValueUnit: r.sectorValueUnit ?? null,
    })),
  };

  const peRatio = currentRatios.ratios.find((r) => r.name === 'P/E');
  const pe = Number.isFinite(peRatio?.companyValue) ? peRatio.companyValue : null;

  const availableCount = PAGE_SECTIONS.filter((key) => sections[key]?.available).length;
  const status = availableCount === PAGE_SECTIONS.length ? 'AVAILABLE' : (availableCount > 0 ? 'PARTIAL' : 'UNAVAILABLE');

  return {
    provider: 'UPSTOX',
    status,
    ...resolution,
    missingSections: PAGE_SECTIONS.filter((key) => !sections[key]?.available),
    dataCoveragePct: Math.round((availableCount / PAGE_SECTIONS.length) * 100),
    configurationError: Boolean(searchResult?.data?.configurationError),
    error: failure || null,
    profile,
    annualFinancials,
    perShareFinancials,
    currentRatios,
    valuation: { pe, peAsOf: pe != null ? currentRatios.asOf : null, source: pe != null ? 'UPSTOX_KEY_RATIOS' : null },
    growthInputs: {
      revenueGrowth: selectVerifiedGrowth(annualFinancials.incomeStatement.rows, 'revenue'),
      profitGrowth: selectVerifiedGrowth(annualFinancials.incomeStatement.rows, 'net_profit'),
    },
  };
};

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Upstox financials did not respond within ${ms}ms`);
      error.errorCode = 'TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * getStockDetailFinancials - never throws. A failure or timeout returns the
 * same shape with every section UNAVAILABLE and the reason attached.
 */
export const getStockDetailFinancials = async (symbol, { search = searchCompanyFinancials, timeoutMs = STOCK_DETAIL_FINANCIALS_TIMEOUT_MS } = {}) => {
  try {
    const result = await withTimeout(Promise.resolve().then(() => search(symbol)), timeoutMs);
    return buildStockDetailFinancials(result);
  } catch (error) {
    logger.warn(`[StockDetailFinancials] Upstox financials unavailable for ${symbol}: ${error?.message}`);
    return buildStockDetailFinancials(null, {
      failure: { code: error?.errorCode || 'UPSTREAM_UNAVAILABLE', message: error?.message || 'Upstox financials request failed' },
    });
  }
};

export default { getStockDetailFinancials, buildStockDetailFinancials, selectVerifiedGrowth, UNAVAILABLE_METRICS };
