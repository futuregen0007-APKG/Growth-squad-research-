/**
 * FinancialIntelligenceService.js
 * =================================
 * Deterministic, provider-neutral financial snapshot built from data that
 * CompanyResearchService.getCompanyResearchBundle() already fetched (the
 * IndianAPI-backed `financials` and `keyMetrics` sections). This answers a
 * different question than the other two Earnings Intelligence pipelines:
 *
 *  - ExecutionScoreService: Mongo-backed, requires live-research-pipeline
 *    CompanyHistoricalFact/ManagementPromise documents (dataOrigin:
 *    'REAL_RESEARCH'). Sparse today -- almost every company has none.
 *  - CuratedEarningsIntelligenceService: curated, hand-verified management
 *    promise/outcome pairs (Faith Score). Even sparser (1 of 215 companies).
 *  - FinancialIntelligenceService (this file): "what do the company's own
 *    reported financial statements show, right now" -- broadly available
 *    for any symbol IndianAPI recognizes, with no manual research required.
 *
 * This module never fetches anything itself and never touches
 * promise/guidance data -- it is a pure function over already-normalized
 * financials/keyMetrics sections, which keeps it cheap to unit-test and
 * keeps provider-fetch failures entirely the caller's concern (mirroring
 * the try/catch-per-section resilience pattern already used by
 * CompanyResearchService.runSection).
 *
 * Every field is either a real, traced number pulled from a named line item
 * or `null` -- never fabricated, never substituted with 0.
 */

import { calculateYoY } from './ExecutionScoreService.js';

// Exact displayName strings confirmed live against real IndianAPI /stock
// responses for TCS (IT services) and HDFCBANK (banking) -- not guessed.
// Both companies expose the same names despite very different statement
// structures (TCS: 87 INC line items incl. "Cost of Revenue"; HDFCBANK: 67
// INC line items incl. "Net Interest Income" instead), so these four are
// treated as reliably present across sectors; anything else is left for a
// later phase rather than guessed at now.
const REVENUE_DISPLAY_NAME = 'Total Revenue';
const NET_INCOME_DISPLAY_NAME = 'Net Income';
const EPS_DISPLAY_NAME = 'Diluted Normalized EPS';
const DEBT_DISPLAY_NAME = 'Long Term Debt';
const OPERATING_MARGIN_DISPLAY_NAME = 'Operating margin - trailing 12 month';

const DEBT_TREND_DECREASE_THRESHOLD = -10;
const DEBT_TREND_INCREASE_THRESHOLD = 10;

// IndianAPI's raw displayName strings sometimes carry stray whitespace
// (confirmed live: "Total Revenue ", "Net Income ", "Diluted Normalized EPS "
// all have a trailing space) -- an exact, untrimmed match against these
// constants silently matched nothing and every field came back null despite
// the data being present. Trimming both sides makes the match resilient to
// that without weakening it (still an exact match once trimmed, never a
// fuzzy/partial one that could pick up the wrong line item).
const normalizeDisplayName = (value) => String(value || '').trim();

const findLineItemValue = (entry, statementType, displayName) => {
  const item = (entry?.lineItems || []).find((li) => li.statementType === statementType && normalizeDisplayName(li.displayName) === displayName);
  return item ? item.value : null;
};

/** Most recent N Annual-statement entries, newest first by date. Interim/quarterly entries are excluded -- this snapshot is a year-over-year view, not a quarterly one. */
const latestAnnualEntries = (financials = [], count = 2) => (
  (Array.isArray(financials) ? financials : [])
    .filter((entry) => entry?.statementType === 'Annual' && entry?.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, count)
);

const findKeyMetric = (keyMetricsCategories = [], displayName) => {
  for (const category of (keyMetricsCategories || [])) {
    const metric = category?.metrics?.find((m) => normalizeDisplayName(m.name) === displayName);
    if (metric) return metric.value;
  }
  return null;
};

const computeDebtTrend = (debt, previousDebt) => {
  if (debt == null) return null;
  if (previousDebt == null) return debt === 0 ? 'Zero Debt' : null;
  if (debt === 0 && previousDebt === 0) return 'Zero Debt';
  const change = calculateYoY(previousDebt, debt);
  if (change == null) return null;
  if (change < DEBT_TREND_DECREASE_THRESHOLD) return `Decreasing (${Math.abs(change)}%)`;
  if (change > DEBT_TREND_INCREASE_THRESHOLD) return `Increasing (${change}%)`;
  return 'Stable';
};

/**
 * buildFinancialIntelligenceSnapshot - pure function over the `financials`
 * array and `keyMetrics.categories` array already produced by
 * CompanyResearchService.getCompanyResearchBundle(). Never fetches, never
 * throws on missing/malformed input -- returns nulls instead.
 */
export const buildFinancialIntelligenceSnapshot = ({
  financials = [],
  keyMetricsCategories = [],
  provider = 'indian-api',
  fetchedAt = null,
} = {}) => {
  const [latest, previous] = latestAnnualEntries(financials, 2);

  const latestPeriod = latest?.period ? `FY${latest.period}` : null;
  const revenue = latest ? findLineItemValue(latest, 'INC', REVENUE_DISPLAY_NAME) : null;
  const previousRevenue = previous ? findLineItemValue(previous, 'INC', REVENUE_DISPLAY_NAME) : null;
  const netProfit = latest ? findLineItemValue(latest, 'INC', NET_INCOME_DISPLAY_NAME) : null;
  const previousNetProfit = previous ? findLineItemValue(previous, 'INC', NET_INCOME_DISPLAY_NAME) : null;
  const eps = latest ? findLineItemValue(latest, 'INC', EPS_DISPLAY_NAME) : null;
  const debt = latest ? findLineItemValue(latest, 'BAL', DEBT_DISPLAY_NAME) : null;
  const previousDebt = previous ? findLineItemValue(previous, 'BAL', DEBT_DISPLAY_NAME) : null;

  const revenueGrowth = (revenue != null && previousRevenue != null) ? calculateYoY(previousRevenue, revenue) : null;
  const netProfitGrowth = (netProfit != null && previousNetProfit != null) ? calculateYoY(previousNetProfit, netProfit) : null;
  const operatingMargin = findKeyMetric(keyMetricsCategories, OPERATING_MARGIN_DISPLAY_NAME);
  const debtTrend = computeDebtTrend(debt, previousDebt);

  const available = revenue != null || netProfit != null || eps != null || operatingMargin != null;

  return {
    dataMode: 'PROVIDER_FINANCIAL',
    available,
    latestPeriod,
    revenue,
    revenueGrowth,
    netProfit,
    netProfitGrowth,
    operatingMargin,
    eps,
    debtTrend,
    sourceProvider: provider,
    fetchedAt: fetchedAt || null,
  };
};

export default { buildFinancialIntelligenceSnapshot };
