/**
 * Deterministic Mathematical Calculation & Execution Score Engine
 * Pure JavaScript - strictly NO LLM hallucination of scores or growth rates.
 */

import { logger } from '../utils/logger.js';
import { selectAnnualFacts } from './AnnualFinancialEvidence.js';
import { resolveRecordOutcome } from '../utils/promiseOutcome.js';

/**
 * Exact Mathematical Compound Annual Growth Rate (CAGR)
 * Formula: ((EndValue / StartValue) ^ (1 / years)) - 1
 *
 * @param {number} startValue - Base year value (must be > 0)
 * @param {number} endValue - Target/Current year value (must be > 0)
 * @param {number} years - Number of elapsed fiscal years (must be > 0)
 * @returns {number|null} CAGR percentage rounded to 2 decimal places, or null if invalid
 */
export const calculateCagr = (startValue, endValue, years) => {
  const start = Number(startValue);
  const end = Number(endValue);
  const n = Number(years);

  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(n)) return null;
  if (start <= 0 || end <= 0 || n <= 0) return null;

  try {
    const cagrFraction = Math.pow(end / start, 1 / n) - 1;
    if (!Number.isFinite(cagrFraction)) return null;
    return Math.round(cagrFraction * 10000) / 100; // Returns percentage e.g. 24.12
  } catch (err) {
    logger.warn(`CAGR calculation failed for start=${start}, end=${end}, n=${n}: ${err.message}`);
    return null;
  }
};

/**
 * Exact Year-over-Year Percentage Change
 * Formula: ((CurrentValue - PreviousValue) / |PreviousValue|) * 100
 */
export const calculateYoY = (previousValue, currentValue) => {
  const prev = Number(previousValue);
  const curr = Number(currentValue);

  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return null;
  if (prev === 0) {
    return curr === 0 ? 0 : null;
  }

  const change = ((curr - prev) / Math.abs(prev)) * 100;
  return Math.round(change * 100) / 100;
};

/**
 * Deterministic Rating Label based on Execution Score (0-100)
 */
export const getExecutionRatingLabel = (score) => {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return 'Insufficient verified history';
  }
  if (score >= 90) return 'Exceptional';
  if (score >= 80) return 'Strong';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Mixed';
  return 'Weak';
};

/**
 * Extracts a numeric 4-digit year from a period string (e.g. 'FY2025' -> 2025, 'FY24' -> 2024)
 */
export const extractYearFromPeriod = (period) => {
  if (!period) return null;
  const match = String(period).match(/(\d{4})/);
  if (match) return parseInt(match[1], 10);
  const shortMatch = String(period).match(/FY(\d{2})/i);
  if (shortMatch) return 2000 + parseInt(shortMatch[1], 10);
  return null;
};

/**
 * isSubYearPeriod - true for a period label that covers less than a fiscal
 * year: "Q3 FY2026", "H1 FY2025", "9M FY2025", "Q4FY25". The annual series
 * below is keyed by fiscal year, so a quarter must never be filed under (and
 * overwrite) its year: one quarter's revenue shown as the year's revenue is a
 * wrong number, and every growth rate and score built on it would be wrong too.
 * Quarterly facts stay available in the timeline; only the annual series
 * excludes them.
 */
export const isSubYearPeriod = (period) => /(^|[^A-Za-z0-9])(Q[1-4]|H[12]|[1-9]M)(?=FY|[^A-Za-z]|$)/i.test(String(period || ''));


const comparableSeries = (series) => {
  const cells = Object.values(series);
  return cells.length >= 2 && !cells.some(c => c.definition?.startsWith('UNVERIFIED')) && new Set(cells.map(c => `${c.basis}:${c.definition}:${c.unit}`)).size === 1;
};

/**
 * Builds 5-Year Verified Financial Track Record matrix and growth calculations
 * from FULL-YEAR facts only (see isSubYearPeriod).
 */
export const buildFinancialSnapshot = (facts = []) => {
  const { selected, rejected } = selectAnnualFacts(facts);
  facts = selected;
  const metricHistory = {
    REVENUE: {},
    EBITDA: {},
    EBITDA_MARGIN: {},
    PAT: {},
    ADJUSTED_PAT: {},
    EPS: {}, BASIC_EPS: {}, DILUTED_EPS: {}, PBT: {}, TOTAL_ASSETS: {}, TOTAL_LIABILITIES: {}, INVESTING_CASH_FLOW: {}, FINANCING_CASH_FLOW: {},
    OPERATING_CASH_FLOW: {},
    FREE_CASH_FLOW: {},
    DEBT: {},
    NET_DEBT: {},
    ROE: {},
    ROCE: {},
    ORDER_BOOK: {},
    NIM: {},
    GNPA: {}
  };

  facts.forEach(fact => {
    if (isSubYearPeriod(fact.period)) return;
    const rawMetric = String(fact.metrics?.metric || '').toUpperCase().trim();
    const period = fact.period;
    const year = extractYearFromPeriod(period);
    const value = fact.metrics?.actualValue;

    if (year && value !== null && value !== undefined && Number.isFinite(Number(value))) {
      const numVal = Number(value);
      const evidence = { ...fact.annualEvidence, sourceUrl: fact.source?.url || null, sourceFactId: fact._id ? String(fact._id) : null };

      if (rawMetric === 'REVENUE' || rawMetric === 'TOTAL_REVENUE' || rawMetric === 'TURNOVER') {
        metricHistory.REVENUE[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'EBITDA') {
        metricHistory.EBITDA[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'EBITDA_MARGIN' || rawMetric === 'OPERATING_MARGIN' || rawMetric === 'EBIT_MARGIN') {
        metricHistory.EBITDA_MARGIN[year] = { ...evidence, value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'PAT' || rawMetric === 'NET_PROFIT' || rawMetric === 'PROFIT_AFTER_TAX') {
        metricHistory.PAT[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'ADJUSTED_PAT') {
        metricHistory.ADJUSTED_PAT[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (['BASIC_EPS', 'DILUTED_EPS', 'PBT', 'TOTAL_ASSETS', 'TOTAL_LIABILITIES', 'INVESTING_CASH_FLOW', 'FINANCING_CASH_FLOW'].includes(rawMetric)) {
        metricHistory[rawMetric][year] = { ...evidence, value: numVal, period, unit: fact.metrics.unit };
      } else if (rawMetric === 'EPS') {
        metricHistory.EPS[year] = { ...evidence, value: numVal, period, unit: 'INR' };
      } else if (rawMetric === 'OPERATING_CASH_FLOW' || rawMetric === 'CASH_FLOW_OPERATIONS') {
        metricHistory.OPERATING_CASH_FLOW[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'FREE_CASH_FLOW' || rawMetric === 'FCF') {
        metricHistory.FREE_CASH_FLOW[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'DEBT' || rawMetric === 'TOTAL_DEBT' || rawMetric === 'BORROWINGS') {
        metricHistory.DEBT[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'NET_DEBT') {
        metricHistory.NET_DEBT[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'ROE') {
        metricHistory.ROE[year] = { ...evidence, value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'ROCE') {
        metricHistory.ROCE[year] = { ...evidence, value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'ORDER_BOOK') {
        metricHistory.ORDER_BOOK[year] = { ...evidence, value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'NIM') {
        metricHistory.NIM[year] = { ...evidence, value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'GNPA') {
        metricHistory.GNPA[year] = { ...evidence, value: numVal, period, unit: 'PERCENTAGE' };
      }
    }
  });

  // Calculate Revenue CAGR & Formula Explanation
  const revYears = Object.keys(metricHistory.REVENUE).map(Number).sort((a, b) => a - b);
  let revenueCagr = null;
  let revenueCagrFormula = null;
  let revenueStart = null;
  let revenueEnd = null;

  if (revYears.length >= 2) {
    const startYr = revYears[0];
    const endYr = revYears[revYears.length - 1];
    const yearsDiff = endYr - startYr;
    revenueStart = metricHistory.REVENUE[startYr].value;
    revenueEnd = metricHistory.REVENUE[endYr].value;
    if (yearsDiff >= 1 && comparableSeries(metricHistory.REVENUE)) {
      revenueCagr = calculateCagr(revenueStart, revenueEnd, yearsDiff);
      if (revenueCagr !== null) {
        revenueCagrFormula = `((${revenueEnd} / ${revenueStart})^(1/${yearsDiff}) - 1) * 100 = ${revenueCagr}% (FY${startYr} to FY${endYr})`;
      }
    }
  }

  // Calculate PAT CAGR & Formula Explanation
  const patYears = Object.keys(metricHistory.PAT).map(Number).sort((a, b) => a - b);
  let patCagr = null;
  let patCagrFormula = null;
  let patStart = null;
  let patEnd = null;

  if (patYears.length >= 2) {
    const startYr = patYears[0];
    const endYr = patYears[patYears.length - 1];
    const yearsDiff = endYr - startYr;
    patStart = metricHistory.PAT[startYr].value;
    patEnd = metricHistory.PAT[endYr].value;
    if (yearsDiff >= 1 && comparableSeries(metricHistory.PAT)) {
      patCagr = calculateCagr(patStart, patEnd, yearsDiff);
      if (patCagr !== null) {
        patCagrFormula = `((${patEnd} / ${patStart})^(1/${yearsDiff}) - 1) * 100 = ${patCagr}% (FY${startYr} to FY${endYr})`;
      }
    }
  }

  // Calculate EBITDA CAGR
  const ebitdaYears = Object.keys(metricHistory.EBITDA).map(Number).sort((a, b) => a - b);
  let ebitdaCagr = null;
  if (ebitdaYears.length >= 2) {
    const startYr = ebitdaYears[0];
    const endYr = ebitdaYears[ebitdaYears.length - 1];
    const yearsDiff = endYr - startYr;
    if (yearsDiff >= 1 && comparableSeries(metricHistory.EBITDA)) {
      ebitdaCagr = calculateCagr(metricHistory.EBITDA[startYr].value, metricHistory.EBITDA[endYr].value, yearsDiff);
    }
  }

  // Latest EBITDA Margin
  const marginYears = Object.keys(metricHistory.EBITDA_MARGIN).map(Number).sort((a, b) => a - b);
  let latestEbitdaMargin = null;
  if (marginYears.length > 0) {
    const latestYr = marginYears[marginYears.length - 1];
    latestEbitdaMargin = metricHistory.EBITDA_MARGIN[latestYr].value;
  }

  // Calculate Debt Trend
  const debtYears = Object.keys(metricHistory.DEBT).map(Number).sort((a, b) => a - b);
  let debtTrend = 'Unavailable';
  let debtChangePercent = null;

  if (debtYears.length >= 2 && comparableSeries(metricHistory.DEBT)) {
    const firstDebt = metricHistory.DEBT[debtYears[0]].value;
    const lastDebt = metricHistory.DEBT[debtYears[debtYears.length - 1]].value;
    debtChangePercent = calculateYoY(firstDebt, lastDebt);
    if (firstDebt === 0 && lastDebt === 0) {
      debtTrend = 'Zero Debt';
    } else if (debtChangePercent < -10) {
      debtTrend = `Decreasing (${Math.abs(debtChangePercent)}%)`;
    } else if (debtChangePercent > 10) {
      debtTrend = `Increasing (${debtChangePercent}%)`;
    } else {
      debtTrend = 'Stable';
    }
  } else if (debtYears.length === 1 && metricHistory.DEBT[debtYears[0]].value === 0) {
    debtTrend = 'Zero Debt';
  }

  // Build Chronological 5-Year Annual Series (e.g. FY2022 to FY2026)
  const allYears = [...new Set(Object.values(metricHistory).flatMap(series => Object.keys(series).map(Number)))].sort((a, b) => a - b);

  const annualSeries = allYears.map(yr => ({
    year: yr,
    period: `FY${yr}`,
    revenue: metricHistory.REVENUE[yr]?.value ?? null,
    ebitda: metricHistory.EBITDA[yr]?.value ?? null,
    ebitdaMargin: metricHistory.EBITDA_MARGIN[yr]?.value ?? null,
    pat: metricHistory.PAT[yr]?.value ?? null,
    adjustedPat: metricHistory.ADJUSTED_PAT[yr]?.value ?? null,
    eps: metricHistory.EPS[yr]?.value ?? null,
    basicEps: metricHistory.BASIC_EPS[yr]?.value ?? null,
    dilutedEps: metricHistory.DILUTED_EPS[yr]?.value ?? null,
    pbt: metricHistory.PBT[yr]?.value ?? null,
    totalAssets: metricHistory.TOTAL_ASSETS[yr]?.value ?? null,
    totalLiabilities: metricHistory.TOTAL_LIABILITIES[yr]?.value ?? null,
    investingCashFlow: metricHistory.INVESTING_CASH_FLOW[yr]?.value ?? null,
    financingCashFlow: metricHistory.FINANCING_CASH_FLOW[yr]?.value ?? null,
    operatingCashFlow: metricHistory.OPERATING_CASH_FLOW[yr]?.value ?? null,
    freeCashFlow: metricHistory.FREE_CASH_FLOW[yr]?.value ?? null,
    debt: metricHistory.DEBT[yr]?.value ?? null,
    netDebt: metricHistory.NET_DEBT[yr]?.value ?? null,
    roe: metricHistory.ROE[yr]?.value ?? null,
    roce: metricHistory.ROCE[yr]?.value ?? null,
    orderBook: metricHistory.ORDER_BOOK[yr]?.value ?? null,
    nim: metricHistory.NIM[yr]?.value ?? null,
    gnpa: metricHistory.GNPA[yr]?.value ?? null
  }));

  const revenueDefinitions = [...new Set(Object.values(metricHistory.REVENUE).map(v => v.definition))];
  const epsDefinitions = [...new Set(Object.values(metricHistory.EPS).map(v => v.definition))];
  return {
    quality: { status: rejected.length ? 'PARTIAL' : selected.length ? 'AVAILABLE' : 'UNAVAILABLE', excludedFactsCount: rejected.length, excludedFacts: rejected },
    patLabel: [...new Set(Object.values(metricHistory.PAT).map(v => v.definition))].join() === 'PROFIT_FOR_PERIOD' ? 'Profit for period (filing definition)' : 'Profit after tax',
    revenueLabel: revenueDefinitions.length === 1 && revenueDefinitions[0] === 'TOTAL_INCOME' ? 'Total income' : revenueDefinitions.length === 1 && revenueDefinitions[0] === 'REVENUE_FROM_OPERATIONS' ? 'Revenue from operations' : 'Revenue / income (definition unverified)',
    epsLabel: epsDefinitions.length === 1 && epsDefinitions[0] === 'BASIC_EPS' ? 'Basic EPS' : epsDefinitions.length === 1 && epsDefinitions[0] === 'DILUTED_EPS' ? 'Diluted EPS' : 'EPS (basis unverified)',
    revenueCagr,
    revenueCagrFormula,
    revenueWindow: revenueCagr !== null ? `FY${revYears[0]}–FY${revYears[revYears.length - 1]} (${revYears[revYears.length - 1] - revYears[0]} year(s) elapsed)` : null,
    patWindow: patCagr !== null ? `FY${patYears[0]}–FY${patYears[patYears.length - 1]} (${patYears[patYears.length - 1] - patYears[0]} year(s) elapsed)` : null,
    revenueStart,
    revenueEnd,
    patCagr,
    patCagrFormula,
    patStart,
    patEnd,
    ebitdaCagr,
    latestEbitdaMargin,
    debtTrend,
    debtChangePercent,
    metricHistory,
    annualSeries,
    coveredYears: allYears.map(y => `FY${y}`)
  };
};

/**
 * 1. Financial Delivery Score (30%)
 */
export const calculateFinancialDeliveryScore = (snapshot) => {
  let score = 70; // baseline

  if (snapshot.revenueCagr !== null) {
    if (snapshot.revenueCagr >= 20) score += 15;
    else if (snapshot.revenueCagr >= 12) score += 10;
    else if (snapshot.revenueCagr >= 6) score += 5;
    else if (snapshot.revenueCagr < 0) score -= 15;
  }

  if (snapshot.patCagr !== null) {
    if (snapshot.patCagr >= 20) score += 15;
    else if (snapshot.patCagr >= 12) score += 10;
    else if (snapshot.patCagr >= 5) score += 5;
    else if (snapshot.patCagr < 0) score -= 15;
  }

  if (snapshot.latestEbitdaMargin !== null) {
    if (snapshot.latestEbitdaMargin >= 22) score += 5;
    else if (snapshot.latestEbitdaMargin < 10) score -= 10;
  }

  if (snapshot.debtTrend === 'Zero Debt' || snapshot.debtTrend?.includes('Decreasing')) {
    score += 5;
  } else if (snapshot.debtTrend?.includes('Increasing')) {
    score -= 10;
  }

  return Math.min(100, Math.max(30, Math.round(score)));
};

export const GUIDANCE_ACCURACY_METHODOLOGY = 'Importance-weighted target-hit rate: sum(weight x hit) / sum(weight) x 100 over completed, evaluable targets only, where hit = 1 for MET or EXCEEDED and 0 for MISSED, and weight = 1.5 (HIGH importance), 1.0 (MEDIUM, the default) or 0.75 (LOW). Outcomes are recomputed from the stored target and actual with the current rules. Pending, insufficient-evidence and qualitative statements are excluded; an achievement percentage is never averaged in, so a 97%-of-target miss counts as a miss.';

/**
 * calculateGuidanceAccuracyScore - importance-weighted target-hit rate (see
 * GUIDANCE_ACCURACY_METHODOLOGY). It used to average achievement percentages,
 * which scored a just-missed target as ~97 and a qualitative statement stored
 * "FULFILLED" as 100 -- reading as near-perfect delivery for a company that
 * had met none of its numeric targets. null (never 0) when nothing is evaluable.
 */
export const calculateGuidanceAccuracyScore = (promises = [], { asOf = new Date() } = {}) => {
  let totalWeight = 0;
  let weightedHits = 0;
  for (const p of promises) {
    const { outcome } = resolveRecordOutcome(p, { asOf });
    if (!['MET', 'EXCEEDED', 'MISSED'].includes(outcome)) continue;
    const importance = p.promise?.importance || p.importance || 'MEDIUM';
    const weight = importance === 'HIGH' ? 1.5 : importance === 'LOW' ? 0.75 : 1.0;
    weightedHits += (outcome === 'MISSED' ? 0 : 1) * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  return Math.round((weightedHits / totalWeight) * 100);
};

/**
 * calculateTargetHitRate - THE one authoritative "target-hit rate" in this
 * codebase (Management Delivery). A transparent, unweighted ratio:
 *
 *   targetHitRate = (MET + EXCEEDED) / (MET + EXCEEDED + MISSED) * 100
 *
 * Only completed, evaluable targets are in the denominator: PENDING,
 * INSUFFICIENT_EVIDENCE and QUALITATIVE_ONLY are excluded from BOTH sides and
 * reported as separate counts. null (never 0) when nothing is evaluable. No
 * confidence weighting (that is the curated Faith Score's job) and no
 * percentage banding (a 95%-of-floor result is a miss, full stop).
 *
 * Each input is a stored promise record (any status vocabulary; its outcome
 * is RECOMPUTED from the stored target/actual when both are numeric -- see
 * utils/promiseOutcome.js resolveRecordOutcome), a record already carrying a
 * `canonicalOutcome`, or a bare outcome string.
 *
 * Replaces the earlier calculateGuidanceSuccessRate body, which scored
 * PARTIALLY_FULFILLED as 60% "success" and -- because EXCEEDED fell into its
 * `else` branch -- scored an exceeded promise as 0%.
 */
export const calculateTargetHitRate = (records = [], { asOf = new Date() } = {}) => {
  const counts = { met: 0, exceeded: 0, missed: 0, pending: 0, insufficientEvidence: 0, qualitativeOnly: 0, unclassified: 0 };
  for (const record of records) {
    const { outcome } = resolveRecordOutcome(record, { asOf });
    if (outcome === 'MET') counts.met += 1;
    else if (outcome === 'EXCEEDED') counts.exceeded += 1;
    else if (outcome === 'MISSED') counts.missed += 1;
    else if (outcome === 'PENDING') counts.pending += 1;
    else if (outcome === 'INSUFFICIENT_EVIDENCE') counts.insufficientEvidence += 1;
    else if (outcome === 'QUALITATIVE_ONLY') counts.qualitativeOnly += 1;
    else counts.unclassified += 1;
  }
  const hits = counts.met + counts.exceeded;
  const completed = hits + counts.missed;
  return {
    targetHitRate: completed > 0 ? Number(((hits / completed) * 100).toFixed(1)) : null,
    hits,
    completed,
    ...counts,
  };
};

/**
 * Guidance Success Percentage -- kept as a backward-compatible name for the
 * SAME number as calculateTargetHitRate().targetHitRate (not a second,
 * divergent formula).
 */
export const calculateGuidanceSuccessRate = (promises = [], options = {}) => calculateTargetHitRate(promises, options).targetHitRate;

/**
 * 3. Strategic Execution Score (20%)
 */
export const calculateStrategicExecutionScore = (facts = []) => {
  const strategicFacts = facts.filter(f => 
    f.category === 'STRATEGY' || 
    f.category === 'EXPANSION' || 
    f.category === 'ACQUISITION' || 
    f.category === 'CONTRACT' || 
    f.category === 'PRODUCT'
  );

  let score = 70;
  if (strategicFacts.length >= 6) score += 20;
  else if (strategicFacts.length >= 3) score += 12;
  else if (strategicFacts.length >= 1) score += 5;

  const negativeFacts = facts.filter(f => f.isNegative || f.category === 'RISK');
  score -= negativeFacts.length * 5;

  return Math.min(100, Math.max(30, Math.round(score)));
};

/**
 * 4. Operational Delivery Score (15%)
 */
export const calculateOperationalDeliveryScore = (facts = []) => {
  const opFacts = facts.filter(f => 
    f.category === 'OPERATIONAL_PERFORMANCE' || 
    f.category === 'ORDER_BOOK' ||
    f.category === 'FINANCIAL_PERFORMANCE'
  );

  let score = 72;
  if (opFacts.length >= 8) score += 18;
  else if (opFacts.length >= 4) score += 10;
  else if (opFacts.length >= 1) score += 5;

  return Math.min(100, Math.max(30, Math.round(score)));
};

/**
 * 5. Capital Allocation Score (10%)
 */
export const calculateCapitalAllocationScore = (snapshot, facts = []) => {
  let score = 75;

  if (snapshot.debtTrend) {
    if (snapshot.debtTrend === 'Zero Debt' || snapshot.debtTrend.includes('Decreasing')) {
      score += 15;
    } else if (snapshot.debtTrend.includes('Increasing')) {
      score -= 15;
    }
  }

  const corpFacts = facts.filter(f => f.category === 'CORPORATE_ACTION' || f.category === 'CAPEX');
  if (corpFacts.length > 0) {
    score += 5;
  }

  return Math.min(100, Math.max(30, Math.round(score)));
};

/**
 * Base weights of the Financial / Execution score. Guidance accuracy is NOT a
 * component: management's delivery against its own targets is reported
 * separately (target-hit rate + curated Faith Score -- the "Management
 * Delivery" score), so this score measures financial and operating
 * execution only. These are the weights this function already used whenever
 * guidance data was absent (40/25/20/15), so a company with no guidance sees
 * no change; a component that is null is still dropped and its weight
 * redistributed proportionally across the rest (see below).
 */
export const EXECUTION_SCORE_BASE_WEIGHTS = Object.freeze({
  financialDelivery: 40,
  strategicExecution: 25,
  operationalDelivery: 20,
  capitalAllocation: 15,
});

export const EXECUTION_SCORE_METHODOLOGY = 'Financial / Execution Score: weighted average of financial delivery (revenue/PAT growth, margin, debt trend), strategic execution, operational delivery and capital allocation, from verified annual financials and historical facts. Components without verified inputs are excluded and their weight redistributed. It does NOT include guidance-delivery accuracy -- see the Management Delivery Score (target-hit rate and Faith Score), which is reported separately.';

/**
 * Overall Deterministic Company Execution Score (0-100)
 */
export const calculateCompanyExecutionScore = ({ facts = [], promises = [], profile = {}, financialFacts = null }) => {
  // Belt-and-suspenders: the real query path (ManagementPromiseService's NOT_QUARANTINED_FILTER) already
  // excludes these, but this function must never let a quarantined value (source verified, value implausible
  // -- see models/CompanyHistoricalFact.js) into a growth rate or score even if some other caller forgets to filter.
  facts = facts.filter((fact) => fact.dataOrigin !== 'SEEDED_DEMO' && !fact.quarantine?.quarantined);
  promises = promises.filter((promise) => promise.dataOrigin !== 'SEEDED_DEMO');
  const financialSnapshot = buildFinancialSnapshot(financialFacts ?? facts);
  if (financialFacts !== null) {
    const historicalQuality = buildFinancialSnapshot(facts).quality;
    financialSnapshot.quality.historicalExcludedFactsCount = historicalQuality.excludedFactsCount;
  }
  const { selected } = selectAnnualFacts(facts);
  facts = facts.filter(f => f.metrics?.actualValue == null || !f.metrics?.metric).concat(selected);

  // Management-delivery figures: computed and returned on their own, never
  // blended into executionScore, and independent of whether the financial
  // history below is sufficient.
  const guidanceScore = calculateGuidanceAccuracyScore(promises);
  const targetHitRate = calculateTargetHitRate(promises);
  const guidanceSuccessRate = targetHitRate.targetHitRate;

  // Insufficient verified history threshold:
  // Must have at least 3 verified facts and multi-year financial history
  if (facts.length < 3 || financialSnapshot.annualSeries.length < 2 || (financialSnapshot.revenueCagr === null && financialSnapshot.patCagr === null && financialSnapshot.ebitdaCagr === null)) {
    return {
      executionScore: null,
      ratingLabel: 'Insufficient verified history',
      isInsufficient: true,
      scoreBreakdown: {
        financialDelivery: null,
        guidanceAccuracy: guidanceScore,
        strategicExecution: null,
        operationalDelivery: null,
        capitalAllocation: null
      },
      weightsUsed: {},
      scoreMissingReasons: { financialDelivery: 'Insufficient verified comparable annual history to calculate a score.' },
      methodology: EXECUTION_SCORE_METHODOLOGY,
      financialSnapshot,
      guidanceAccuracyScore: guidanceScore,
      guidanceSuccessRate,
      targetHitRate
    };
  }

  const financialScore = calculateFinancialDeliveryScore(financialSnapshot);
  const strategicScore = financialFacts !== null && !facts.some(f => ['STRATEGY', 'EXPANSION', 'ACQUISITION', 'CONTRACT', 'PRODUCT'].includes(f.category)) ? null : calculateStrategicExecutionScore(facts);
  const operationalScore = financialFacts !== null && !facts.some(f => ['OPERATIONAL_PERFORMANCE', 'ORDER_BOOK', 'FINANCIAL_PERFORMANCE'].includes(f.category)) ? null : calculateOperationalDeliveryScore(facts);
  const capitalScore = financialFacts !== null && financialSnapshot.debtChangePercent === null && financialSnapshot.debtTrend !== 'Zero Debt' ? null : calculateCapitalAllocationScore(financialSnapshot, facts);

  // guidanceAccuracy is deliberately absent from the weighting (see
  // EXECUTION_SCORE_BASE_WEIGHTS): it is always treated as excluded, exactly
  // like a null component, so its former 25% share is spread across the
  // financial/operating components instead.
  let weightsUsed = { ...EXECUTION_SCORE_BASE_WEIGHTS };
  const components = { financialDelivery: financialScore, strategicExecution: strategicScore, operationalDelivery: operationalScore, capitalAllocation: capitalScore };
  let overallScore = Object.entries(weightsUsed).reduce((sum, [key, weight]) => sum + (components[key] ?? 0) * weight / 100, 0);

  if (financialFacts !== null) {
    const availableWeight = Object.entries(weightsUsed).reduce((sum, [key, weight]) => sum + (components[key] !== null ? weight : 0), 0);
    const baseWeights = { ...weightsUsed };
    weightsUsed = Object.fromEntries(Object.entries(baseWeights).map(([key, weight]) => [key, components[key] !== null ? Number((weight / availableWeight * 100).toFixed(2)) : 0]));
    overallScore = Object.entries(baseWeights).reduce((sum, [key, weight]) => sum + (components[key] !== null ? components[key] * weight / availableWeight : 0), 0);
  }

  const roundedExecutionScore = Math.round(overallScore);
  const ratingLabel = getExecutionRatingLabel(roundedExecutionScore);

  return {
    executionScore: roundedExecutionScore,
    ratingLabel,
    isInsufficient: false,
    guidanceSuccessRate,
    targetHitRate,
    // Reported for reference only -- NOT a component of executionScore.
    guidanceAccuracyScore: guidanceScore,
    scoreBreakdown: {
      financialDelivery: financialScore,
      guidanceAccuracy: guidanceScore,
      strategicExecution: strategicScore,
      operationalDelivery: operationalScore,
      capitalAllocation: capitalScore
    },
    weightsUsed,
    methodology: EXECUTION_SCORE_METHODOLOGY,
    scoreMissingReasons: Object.fromEntries(Object.entries({ financialDelivery: financialScore === null ? 'Insufficient comparable annual financial history.' : null, strategicExecution: strategicScore === null ? 'No verified strategy or expansion evidence.' : null, operationalDelivery: operationalScore === null ? 'No verified operational delivery evidence.' : null, capitalAllocation: capitalScore === null ? 'No verified comparable debt or capital-allocation inputs.' : null }).filter(([, reason]) => reason)),
    financialSnapshot
  };
};

/**
 * Confidence Level Assessment (HIGH, MEDIUM, LOW)
 */
export const calculateConfidence = ({ facts = [], promises = [], sources = [], coverageYears = [], financialQuality = null }) => {
  const factCount = facts.length;
  const sourceCount = sources.length;
  const yearsCount = coverageYears.length;

  let level = 'LOW';
  let reason = 'Limited historical coverage';

  if (factCount >= 10 && sourceCount >= 4 && yearsCount >= 4) {
    level = 'HIGH';
    reason = 'Extensive verified historical facts across multi-year primary statutory filings.';
  } else if (factCount >= 6 && yearsCount >= 3) {
    level = 'MEDIUM';
    reason = 'Sufficient historical coverage with verified multi-year primary records.';
  } else if (factCount > 0) {
    level = 'LOW';
    reason = 'Preliminary historical facts identified; continuous research ongoing.';
  } else {
    level = 'LOW';
    reason = 'Insufficient verified historical evidence in public records.';
  }

  if (financialQuality?.excludedFactsCount > 0) {
    level = 'LOW';
    reason = 'Conflicting or unverifiable financial records excluded; annual financial coverage is partial.';
  }
  return {
    level,
    reason,
    verifiedFactsCount: factCount,
    verifiedSourcesCount: sourceCount,
    verifiedPromisesCount: promises.filter(p => p.verification?.status || p.status).length,
    coverageYears
  };
};

export default {
  calculateCagr,
  calculateYoY,
  getExecutionRatingLabel,
  buildFinancialSnapshot,
  calculateFinancialDeliveryScore,
  calculateGuidanceAccuracyScore,
  calculateGuidanceSuccessRate,
  calculateTargetHitRate,
  calculateStrategicExecutionScore,
  calculateOperationalDeliveryScore,
  calculateCapitalAllocationScore,
  calculateCompanyExecutionScore,
  calculateConfidence,
  EXECUTION_SCORE_BASE_WEIGHTS,
  EXECUTION_SCORE_METHODOLOGY,
  GUIDANCE_ACCURACY_METHODOLOGY
};
