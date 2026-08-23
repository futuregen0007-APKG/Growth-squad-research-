/**
 * Deterministic Mathematical Calculation & Execution Score Engine
 * Pure JavaScript - strictly NO LLM hallucination of scores or growth rates.
 */

import { logger } from '../utils/logger.js';

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
 * Builds 5-Year Verified Financial Track Record matrix and growth calculations
 */
export const buildFinancialSnapshot = (facts = []) => {
  const metricHistory = {
    REVENUE: {},
    EBITDA: {},
    EBITDA_MARGIN: {},
    PAT: {},
    ADJUSTED_PAT: {},
    EPS: {},
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
    const rawMetric = String(fact.metrics?.metric || '').toUpperCase().trim();
    const period = fact.period;
    const year = extractYearFromPeriod(period);
    const value = fact.metrics?.actualValue;

    if (year && value !== null && value !== undefined && Number.isFinite(Number(value))) {
      const numVal = Number(value);

      if (rawMetric === 'REVENUE' || rawMetric === 'TOTAL_REVENUE' || rawMetric === 'TURNOVER') {
        metricHistory.REVENUE[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'EBITDA') {
        metricHistory.EBITDA[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'EBITDA_MARGIN' || rawMetric === 'OPERATING_MARGIN' || rawMetric === 'EBIT_MARGIN') {
        metricHistory.EBITDA_MARGIN[year] = { value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'PAT' || rawMetric === 'NET_PROFIT' || rawMetric === 'PROFIT_AFTER_TAX') {
        metricHistory.PAT[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'ADJUSTED_PAT') {
        metricHistory.ADJUSTED_PAT[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'EPS' || rawMetric === 'DILUTED_EPS') {
        metricHistory.EPS[year] = { value: numVal, period, unit: 'INR' };
      } else if (rawMetric === 'OPERATING_CASH_FLOW' || rawMetric === 'CASH_FLOW_OPERATIONS') {
        metricHistory.OPERATING_CASH_FLOW[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'FREE_CASH_FLOW' || rawMetric === 'FCF') {
        metricHistory.FREE_CASH_FLOW[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'DEBT' || rawMetric === 'TOTAL_DEBT' || rawMetric === 'BORROWINGS') {
        metricHistory.DEBT[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'NET_DEBT') {
        metricHistory.NET_DEBT[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'ROE') {
        metricHistory.ROE[year] = { value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'ROCE') {
        metricHistory.ROCE[year] = { value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'ORDER_BOOK') {
        metricHistory.ORDER_BOOK[year] = { value: numVal, period, unit: fact.metrics?.unit || 'INR_CRORE' };
      } else if (rawMetric === 'NIM') {
        metricHistory.NIM[year] = { value: numVal, period, unit: 'PERCENTAGE' };
      } else if (rawMetric === 'GNPA') {
        metricHistory.GNPA[year] = { value: numVal, period, unit: 'PERCENTAGE' };
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
    if (yearsDiff >= 1) {
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
    if (yearsDiff >= 1) {
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
    if (yearsDiff >= 1) {
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
  let debtTrend = 'Stable';
  let debtChangePercent = null;

  if (debtYears.length >= 2) {
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
  const allYears = [...new Set([
    ...revYears, ...patYears, ...ebitdaYears, ...marginYears, ...debtYears,
    ...Object.keys(metricHistory.EPS).map(Number),
    ...Object.keys(metricHistory.ROE).map(Number)
  ])].sort((a, b) => a - b);

  const annualSeries = allYears.map(yr => ({
    year: yr,
    period: `FY${yr}`,
    revenue: metricHistory.REVENUE[yr]?.value ?? null,
    ebitda: metricHistory.EBITDA[yr]?.value ?? null,
    ebitdaMargin: metricHistory.EBITDA_MARGIN[yr]?.value ?? null,
    pat: metricHistory.PAT[yr]?.value ?? null,
    adjustedPat: metricHistory.ADJUSTED_PAT[yr]?.value ?? null,
    eps: metricHistory.EPS[yr]?.value ?? null,
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

  return {
    revenueCagr,
    revenueCagrFormula,
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

/**
 * Calculates Guidance Accuracy & Success Rate from Verified Promises
 */
export const calculateGuidanceAccuracyScore = (promises = []) => {
  const verifiedPromises = promises.filter(p => {
    const status = p.verification?.status || p.status;
    return status && status !== 'PENDING';
  });

  if (verifiedPromises.length === 0) return null;

  let totalWeight = 0;
  let weightedScore = 0;

  verifiedPromises.forEach(p => {
    const status = p.verification?.status || p.status;
    const importance = p.promise?.importance || p.importance || 'MEDIUM';
    const weight = importance === 'HIGH' ? 1.5 : importance === 'LOW' ? 0.75 : 1.0;

    let achievement = p.verification?.achievementPercentage ?? p.achievementPercentage;
    if (achievement === null || achievement === undefined) {
      if (status === 'FULFILLED') achievement = 100;
      else if (status === 'PARTIALLY_FULFILLED') achievement = 60;
      else achievement = 0;
    }

    const cappedScore = Math.min(100, Math.max(0, achievement));
    weightedScore += cappedScore * weight;
    totalWeight += weight;
  });

  if (totalWeight === 0) return null;
  return Math.round(weightedScore / totalWeight);
};

/**
 * Guidance Success Percentage (0-100)
 */
export const calculateGuidanceSuccessRate = (promises = []) => {
  const verified = promises.filter(p => {
    const status = p.verification?.status || p.status;
    return status && status !== 'PENDING';
  });

  if (verified.length === 0) return null;

  let totalSuccess = 0;
  verified.forEach(p => {
    const status = p.verification?.status || p.status;
    if (status === 'FULFILLED') totalSuccess += 100;
    else if (status === 'PARTIALLY_FULFILLED') totalSuccess += 60;
    else totalSuccess += 0;
  });

  return Math.round(totalSuccess / verified.length);
};

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
 * Overall Deterministic Company Execution Score (0-100)
 */
export const calculateCompanyExecutionScore = ({ facts = [], promises = [], profile = {} }) => {
  const financialSnapshot = buildFinancialSnapshot(facts);

  // Insufficient verified history threshold:
  // Must have at least 3 verified facts and multi-year financial history
  if (facts.length < 3 || financialSnapshot.annualSeries.length < 2) {
    return {
      executionScore: null,
      ratingLabel: 'Insufficient verified history',
      isInsufficient: true,
      scoreBreakdown: {
        financialDelivery: null,
        guidanceAccuracy: null,
        strategicExecution: null,
        operationalDelivery: null,
        capitalAllocation: null
      },
      weightsUsed: {},
      financialSnapshot,
      guidanceSuccessRate: null
    };
  }

  const financialScore = calculateFinancialDeliveryScore(financialSnapshot);
  const guidanceScore = calculateGuidanceAccuracyScore(promises);
  const guidanceSuccessRate = calculateGuidanceSuccessRate(promises);
  const strategicScore = calculateStrategicExecutionScore(facts);
  const operationalScore = calculateOperationalDeliveryScore(facts);
  const capitalScore = calculateCapitalAllocationScore(financialSnapshot, facts);

  let overallScore;
  let weightsUsed = {};

  if (guidanceScore !== null) {
    overallScore = (
      financialScore * 0.30 +
      guidanceScore * 0.25 +
      strategicScore * 0.20 +
      operationalScore * 0.15 +
      capitalScore * 0.10
    );
    weightsUsed = {
      financialDelivery: 30,
      guidanceAccuracy: 25,
      strategicExecution: 20,
      operationalDelivery: 15,
      capitalAllocation: 10
    };
  } else {
    overallScore = (
      financialScore * 0.40 +
      strategicScore * 0.25 +
      operationalScore * 0.20 +
      capitalScore * 0.15
    );
    weightsUsed = {
      financialDelivery: 40,
      guidanceAccuracy: 0,
      strategicExecution: 25,
      operationalDelivery: 20,
      capitalAllocation: 15
    };
  }

  const roundedExecutionScore = Math.round(overallScore);
  const ratingLabel = getExecutionRatingLabel(roundedExecutionScore);

  return {
    executionScore: roundedExecutionScore,
    ratingLabel,
    isInsufficient: false,
    guidanceSuccessRate,
    scoreBreakdown: {
      financialDelivery: financialScore,
      guidanceAccuracy: guidanceScore,
      strategicExecution: strategicScore,
      operationalDelivery: operationalScore,
      capitalAllocation: capitalScore
    },
    weightsUsed,
    financialSnapshot
  };
};

/**
 * Confidence Level Assessment (HIGH, MEDIUM, LOW)
 */
export const calculateConfidence = ({ facts = [], promises = [], sources = [], coverageYears = [] }) => {
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
  calculateStrategicExecutionScore,
  calculateOperationalDeliveryScore,
  calculateCapitalAllocationScore,
  calculateCompanyExecutionScore,
  calculateConfidence
};
