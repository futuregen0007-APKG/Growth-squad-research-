/**
 * FINANCIAL_NORMALIZATION.JS
 * ===========================
 * Shared period/unit-normalization primitives used by both
 * ManagementPromiseService (LLM-assisted promise verification) and
 * OutcomeEvidenceService (deterministic IndianAPI evidence matching), so
 * the two Stage-B tiers agree on what "the same period" and "the same
 * value" mean. ManagementPromiseService re-exports normalizeFinancialValue
 * and periodsMatch from here for backward compatibility with existing
 * imports/tests — the implementation moved, the behavior did not.
 */

export const normalizePeriod = (value) => String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();

export const periodsMatch = (targetPeriod, actualPeriod) => {
  if (!targetPeriod || !actualPeriod) return false;
  return normalizePeriod(targetPeriod) === normalizePeriod(actualPeriod);
};

const UNIT_MULTIPLIERS = {
  INR_LAKH: 0.1,
  INR_CRORE: 1,
  INR_MILLION: 0.1,
  INR_BILLION: 100,
  USD_MILLION: 1,
  USD_BILLION: 1000,
  PERCENTAGE: 1,
  COUNT: 1,
  OTHER: 1,
};

export const normalizeFinancialValue = (value, unit) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const normalizedUnit = String(unit || '').toUpperCase();
  const multiplier = UNIT_MULTIPLIERS[normalizedUnit];
  return multiplier == null ? null : numericValue * multiplier;
};

export const financialUnitFamily = (unit) => {
  const normalizedUnit = String(unit || '').toUpperCase();
  if (normalizedUnit.startsWith('USD_')) return 'USD';
  if (normalizedUnit.startsWith('INR_')) return 'INR';
  return normalizedUnit;
};

/**
 * parseFiscalPeriod - recognizes "FY2025", "FY25", "Q1 FY2025", "Q4FY25"
 * style labels used throughout ManagementPromise/IndianAPI period strings.
 * Returns { fiscalYear: number|null, quarter: number|null } — quarter null
 * means an annual (not quarterly) period.
 */
export const parseFiscalPeriod = (value) => {
  const normalized = normalizePeriod(value);
  if (!normalized) return { fiscalYear: null, quarter: null };
  const quarterMatch = normalized.match(/Q([1-4])/);
  const yearMatch = normalized.match(/(?:FY)\s*'?(\d{4}|\d{2})\b/) || normalized.match(/\b(\d{4})\b/);
  let fiscalYear = null;
  if (yearMatch) {
    const rawYear = yearMatch[1];
    fiscalYear = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  }
  return {
    fiscalYear: Number.isFinite(fiscalYear) ? fiscalYear : null,
    quarter: quarterMatch ? Number(quarterMatch[1]) : null,
  };
};

/**
 * isCompatiblePeriodComparison - guards against comparing a quarterly
 * actual to an annual promise (or vice versa) without an explicit rule,
 * and against comparing periods that don't share a fiscal year.
 */
export const isCompatiblePeriodComparison = (targetPeriod, actualPeriod) => {
  if (periodsMatch(targetPeriod, actualPeriod)) return true;
  const target = parseFiscalPeriod(targetPeriod);
  const actual = parseFiscalPeriod(actualPeriod);
  if (target.fiscalYear == null || actual.fiscalYear == null) return false;
  if (target.fiscalYear !== actual.fiscalYear) return false;
  return target.quarter === actual.quarter;
};

export default {
  normalizePeriod,
  periodsMatch,
  normalizeFinancialValue,
  financialUnitFamily,
  parseFiscalPeriod,
  isCompatiblePeriodComparison,
};
