/**
 * promiseMetrics.js
 * ==================
 * The one vocabulary of guidance metrics shared by extraction
 * (services/PromiseExtractionService.js), the outcome matcher
 * (services/OutcomeEvidenceService.js), and every display surface
 * (Promises vs Actuals, Management Guidance tab). Each metric is a distinct
 * figure: two keys are never compared with each other, so "margin" is never
 * a stand-in for a specific margin and growth is never compared with a level.
 */

export const METRIC_LABELS = Object.freeze({
  REVENUE: 'Revenue',
  REVENUE_GROWTH: 'Revenue growth',
  EBITDA: 'EBITDA',
  EBITDA_MARGIN: 'EBITDA margin',
  EBIT_MARGIN: 'EBIT / operating margin',
  OPERATING_MARGIN: 'Operating margin',
  GROSS_MARGIN: 'Gross margin',
  MARGIN: 'Margin (type not specified)',
  PAT: 'Profit after tax',
  PAT_GROWTH: 'PAT growth',
  PAT_MARGIN: 'Net (PAT) margin',
  EPS: 'Earnings per share',
  PROFITABILITY: 'Profitability',
  TAX_RATE: 'Effective tax rate',
  ORDER_BOOK: 'Order book',
  ORDER_INTAKE: 'Order inflow',
  ARR: 'ARR',
  BOOKINGS: 'Bookings / TCV',
  LARGE_DEALS: 'Large deals',
  CAPEX: 'Capex',
  CAPACITY: 'Capacity',
  VOLUME: 'Volume',
  DEBT: 'Gross debt',
  NET_DEBT: 'Net debt',
  DEBT_REDUCTION: 'Debt reduction',
  FREE_CASH_FLOW: 'Free cash flow',
  OPERATING_CASH_FLOW: 'Operating cash flow',
  WORKING_CAPITAL_DAYS: 'Working capital days',
  ROE: 'Return on equity',
  ROA: 'Return on assets',
  ROCE: 'Return on capital employed',
  NIM: 'Net interest margin',
  CREDIT_GROWTH: 'Credit / loan growth',
  LOAN_GROWTH: 'Loan growth',
  DEPOSIT_GROWTH: 'Deposit growth',
  CASA: 'CASA ratio',
  GNPA: 'Gross NPA',
  NNPA: 'Net NPA',
  CREDIT_COST: 'Credit cost',
  COST_TO_INCOME: 'Cost-to-income ratio',
  ASSET_QUALITY: 'Asset quality',
  AUM_GROWTH: 'AUM growth',
  PREMIUM_GROWTH: 'Premium growth',
  VNB_MARGIN: 'VNB margin',
  ATTRITION: 'Attrition',
  GRADUATE_HIRING: 'Graduate (campus) hiring',
  EMPLOYEE_COUNT: 'Headcount',
  EMPLOYEE_PERCENTAGE: 'Employee share',
  CUSTOMER_COUNT: 'Customer count',
  MARKET_SHARE: 'Market share',
  EXPORT_REVENUE: 'Export revenue',
  DIVIDEND_PAYOUT: 'Dividend payout',
  PRODUCT_LAUNCH: 'Product launches',
  EXPANSION: 'Expansion',
  GUIDANCE: 'Guidance',
  OTHER_QUANTIFIABLE: 'Other (quantified, metric unspecified)',
  OTHER: 'Other (metric not identified)',
});

/** Metrics an extraction may return; everything else is rejected, never coerced. */
// MARGIN stays extractable so a margin whose type the speaker did not name is
// recorded honestly as "type not specified" -- it matches no actual, rather
// than being coerced into EBITDA or operating margin.
export const EXTRACTABLE_METRICS = Object.freeze(Object.keys(METRIC_LABELS).filter((key) => !['PROFITABILITY', 'ASSET_QUALITY', 'EXPANSION', 'GUIDANCE', 'PRODUCT_LAUNCH'].includes(key)));

/**
 * Metrics whose actual can be read from an exchange XBRL filing today
 * (services/OutcomeEvidenceService.js tier (a)): a level, or year-on-year
 * growth derived from two annual levels of the same line and basis. Any other
 * metric is real guidance, but no verified actual source exists for it, so its
 * outcome is reported as INSUFFICIENT_EVIDENCE with that reason.
 */
export const XBRL_EVALUABLE_METRICS = Object.freeze(['REVENUE', 'REVENUE_GROWTH', 'PAT', 'PAT_GROWTH', 'EPS']);

export const metricLabelFor = (key) => {
  const upper = String(key || 'OTHER').toUpperCase();
  return METRIC_LABELS[upper] || upper.charAt(0) + upper.slice(1).toLowerCase().replace(/_/g, ' ');
};

export default { METRIC_LABELS, EXTRACTABLE_METRICS, XBRL_EVALUABLE_METRICS, metricLabelFor };
