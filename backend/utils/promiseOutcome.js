/**
 * promiseOutcome.js
 * ==================
 * THE single, pure (no DB, no network, no LLM) rule set that decides whether a
 * management promise's numeric target was met, given its verified actual.
 * ManagementPromiseService.calculatePromiseStatus is a thin legacy-shaped
 * wrapper over evaluatePromiseOutcome; ExecutionScoreService (target-hit
 * rate), PromisesVsActualsService and scripts/reevaluatePromises.js all use
 * this module directly, so every surface agrees on what "met" means.
 *
 * Why this replaced the old percentage bands: the earlier fallback (used
 * whenever a promise had a direction but no explicit operator) labelled any
 * result between 90% and 110% of target FULFILLED and 60-90% PARTIALLY_FULFILLED.
 * That reported explicit sub-target results as non-misses -- e.g. TCS
 * "at least 26% margin" vs an actual 25% (96.2% of target). A minimum target
 * is binary: the actual is at or above the floor, or it is not. 80%, 95% or
 * 99% of a floor is MISSED. The achievement percentage is still reported for
 * context, but ALWAYS alongside the outcome label, never instead of it -- an
 * "80%" must never read as "80% = succeeded".
 *
 * Canonical outcomes (PROMISE_OUTCOMES):
 *   MET                   - target satisfied by a direct comparison.
 *   EXCEEDED              - MET, and beaten by the 10% margin below.
 *   MISSED                - target not satisfied, however close.
 *   PENDING               - the target period (plus the statutory reporting
 *                           window) has not closed, so no actual can exist yet.
 *   INSUFFICIENT_EVIDENCE - the period closed but no comparable actual is
 *                           available (none found, lookup failed, or the actual
 *                           found is NOT like-for-like: unit, period
 *                           granularity, statement basis, currency basis,
 *                           metric definition or scope differ). Never coerced
 *                           into a comparison, never defaulted to MISSED.
 *   QUALITATIVE_ONLY      - the promise has no numeric target at all. Never
 *                           scored, never counted as MISSED or as evidence gap.
 */

import { normalizeFinancialValue, financialUnitFamily, normalizePeriod } from './financialNormalization.js';

export const PROMISE_OUTCOMES = Object.freeze(['MET', 'EXCEEDED', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE', 'QUALITATIVE_ONLY']);

/** Outcomes that are completed AND evaluable -- the only ones a target-hit rate may count. */
export const EVALUABLE_OUTCOMES = Object.freeze(['MET', 'EXCEEDED', 'MISSED']);
export const HIT_OUTCOMES = Object.freeze(['MET', 'EXCEEDED']);

export const COMPARISON_TYPES = Object.freeze(['MINIMUM', 'MAXIMUM', 'EXACT', 'RANGE', 'QUALITATIVE']);

// EXCEEDED thresholds. 110% is the exact value the pre-fix banding in
// ManagementPromiseService.calculatePromiseStatus already used for EXCEEDED
// (`achievementPercentage >= 110`), kept verbatim for continuity. The ceiling
// equivalent (actual at or below 90% of a maximum target) is its mirror.
export const EXCEEDED_MINIMUM_RATIO = 1.10;
export const EXCEEDED_MAXIMUM_RATIO = 0.90;

// EXACT targets: an actual within 0.5% (relative) of the target is MET. This
// absorbs ordinary reporting rounding (a "₹5,000 Cr" target reported as
// ₹5,012 Cr, or "12%" reported as 12.04%) without treating a materially
// different figure as on-target. There is no EXCEEDED for EXACT: overshooting
// an exact target is simply not exact.
export const EXACT_RELATIVE_TOLERANCE = 0.005;

// SEBI LODR Regulation 33: quarterly results are due within 45 days of the
// quarter end, annual audited results within 60 days of the fiscal year end.
// A target period is only treated as "closed with no evidence" once that
// window has also passed -- before that, the absence of an actual is expected.
export const REPORTING_LAG_DAYS = Object.freeze({ QUARTER: 45, HALF: 45, NINE_MONTH: 45, ANNUAL: 60 });

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (date) => date.toISOString().slice(0, 10);
const round2 = (value) => Number(value.toFixed(2));
const round4 = (value) => Number(value.toFixed(4));

const isMissingNumber = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value));

/** 'PERCENT' (curated schema) and 'PERCENTAGE' (legacy schema) are the same unit. */
export const canonicalUnit = (unit) => {
  if (unit === null || unit === undefined || unit === '') return null;
  const upper = String(unit).toUpperCase().trim();
  return upper === 'PERCENT' ? 'PERCENTAGE' : upper;
};

const expandYear = (raw) => {
  const digits = String(raw);
  if (digits.length === 2) return 2000 + Number(digits);
  if (digits.length === 4) return Number(digits);
  return null;
};

/**
 * describeTargetPeriod - resolves a period label to its Indian fiscal-year
 * (April-March) end date and statutory reporting deadline.
 *   "FY2026", "FY26", "FY2025-26", "2025-26"  -> ANNUAL, ends 31 Mar 2026
 *   "Q1 FY2026", "Q4FY25", "FY2026 Q2"        -> QUARTER
 *   "H1 FY2026" / "H2 FY2026"                 -> HALF
 *   "9M FY2026"                               -> NINE_MONTH
 *   "GOING_FORWARD", "MEDIUM_TERM", ...       -> { openEnded: true }
 * Returns null when the label cannot be resolved -- never guesses a year.
 */
export const describeTargetPeriod = (period) => {
  const label = normalizePeriod(period);
  if (!label) return null;
  if (/GOING[_ ]?FORWARD|MEDIUM[_ ]?TERM|LONG[_ ]?TERM|NEAR[_ ]?TERM|ONGOING/.test(label)) return { label, openEnded: true };

  let fiscalYear = null;
  const fyMatch = label.match(/FY\s*'?(\d{4}|\d{2})(?:\s*[-–/]\s*'?(\d{4}|\d{2}))?(?!\d)/);
  if (fyMatch) {
    fiscalYear = fyMatch[2] ? expandYear(fyMatch[2]) : expandYear(fyMatch[1]);
  } else {
    const spanMatch = label.match(/\b(20\d{2})\s*[-–/]\s*(\d{4}|\d{2})\b/);
    const yearMatch = label.match(/\b(20\d{2})\b/);
    if (spanMatch) fiscalYear = expandYear(spanMatch[2]);
    else if (yearMatch) fiscalYear = Number(yearMatch[1]);
  }
  if (!Number.isFinite(fiscalYear)) return null;

  let granularity = 'ANNUAL';
  let index = null;
  const quarter = label.match(/Q([1-4])/);
  const half = label.match(/(?:^|[^A-Z0-9])H([12])(?![0-9])/);
  const nineMonth = /(?:^|[^0-9])9M(?![A-Z])/.test(label);
  if (quarter) { granularity = 'QUARTER'; index = Number(quarter[1]); }
  else if (half) { granularity = 'HALF'; index = Number(half[1]); }
  else if (nineMonth) { granularity = 'NINE_MONTH'; index = 9; }

  // Month is 0-based; Date.UTC(year, month + 1, 0) is the last day of `month`.
  const endOf = (year, month) => new Date(Date.UTC(year, month + 1, 0));
  let periodEnd;
  if (granularity === 'QUARTER') {
    periodEnd = [null, endOf(fiscalYear - 1, 5), endOf(fiscalYear - 1, 8), endOf(fiscalYear - 1, 11), endOf(fiscalYear, 2)][index];
  } else if (granularity === 'HALF') {
    periodEnd = index === 1 ? endOf(fiscalYear - 1, 8) : endOf(fiscalYear, 2);
  } else if (granularity === 'NINE_MONTH') {
    periodEnd = endOf(fiscalYear - 1, 11);
  } else {
    periodEnd = endOf(fiscalYear, 2);
  }
  const lagDays = REPORTING_LAG_DAYS[granularity];
  const reportingDeadline = new Date(periodEnd.getTime() + lagDays * DAY_MS);
  return { label, openEnded: false, fiscalYear, granularity, index, periodEnd, reportingDeadline, lagDays };
};

const GRANULARITY_WORDS = { ANNUAL: 'annual', QUARTER: 'quarterly', HALF: 'half-yearly', NINE_MONTH: 'nine-month' };

/**
 * periodComparabilityReason - null when the actual's period is a like-for-like
 * match for the target's, else the specific reason it is not. A quarterly
 * actual is never compared against an annual target (or vice versa), and
 * different fiscal years / quarters are never compared.
 */
export const periodComparabilityReason = (targetPeriod, actualPeriod) => {
  if (!actualPeriod || !targetPeriod) return null; // nothing recorded to check against
  if (normalizePeriod(targetPeriod) === normalizePeriod(actualPeriod)) return null;
  const target = describeTargetPeriod(targetPeriod);
  if (target?.openEnded) return null;
  const actual = describeTargetPeriod(actualPeriod);
  if (!target || !actual || actual.openEnded) {
    return `Period mismatch: the actual is reported for "${actualPeriod}", which cannot be confirmed as the same period as the target "${targetPeriod}".`;
  }
  if (target.granularity !== actual.granularity) {
    return `Period granularity mismatch: the target is for a ${GRANULARITY_WORDS[target.granularity]} period (${targetPeriod}) but the actual is ${GRANULARITY_WORDS[actual.granularity]} (${actualPeriod}); figures of different period lengths are never compared.`;
  }
  if (target.fiscalYear !== actual.fiscalYear || target.index !== actual.index) {
    return `Period mismatch: the target is for ${targetPeriod} but the actual is for ${actualPeriod}.`;
  }
  return null;
};

/**
 * isTargetPeriodClosed - true once the period AND its statutory reporting
 * window have passed. Open-ended or unresolvable periods are never "closed".
 */
export const isTargetPeriodClosed = (targetPeriod, asOf = new Date()) => {
  const period = describeTargetPeriod(targetPeriod);
  if (!period || period.openEnded) return false;
  return new Date(asOf).getTime() >= period.reportingDeadline.getTime();
};

// ---------------------------------------------------------------------------
// Like-for-like basis checks
// ---------------------------------------------------------------------------

const DEFINITION_LABELS = {
  REVENUE_FROM_OPERATIONS: 'revenue from operations',
  TOTAL_INCOME: 'total income',
  PROFIT_AFTER_TAX: 'profit after tax (consolidated, incl. minority interest)',
  PROFIT_ATTRIBUTABLE_TO_OWNERS: 'profit attributable to owners of the parent',
  BASIC_EPS: 'basic EPS',
  DILUTED_EPS: 'diluted EPS',
};
// Two spellings of the same reported line, not different metrics.
const DEFINITION_EQUIVALENTS = { PROFIT_FOR_PERIOD: 'PROFIT_AFTER_TAX' };

const normalizeBasisValue = (key, value) => {
  if (value === null || value === undefined || value === '') return null;
  const upper = String(value).toUpperCase().trim().replace(/[\s-]+/g, '_');
  // "UNKNOWN"/"UNVERIFIED_*" carry no information -- treat as not stated.
  if (upper === 'UNKNOWN' || upper.startsWith('UNVERIFIED')) return null;
  if (key === 'metricDefinition') return DEFINITION_EQUIVALENTS[upper] || upper;
  return upper;
};

const BASIS_KEYS = ['statementBasis', 'currencyBasis', 'metricDefinition', 'scope'];

/**
 * detectStatedBasis - reads ONLY what a text explicitly states (a promise
 * statement/excerpt, or an outcome excerpt) about its own basis. Returns null
 * for any dimension that is not stated, or that is stated ambiguously (both
 * "standalone" and "consolidated" mentioned) -- never a guess.
 */
export const detectStatedBasis = (...texts) => {
  const text = texts.filter(Boolean).join(' \n ');
  const result = { statementBasis: null, currencyBasis: null, metricDefinition: null, scope: null };
  if (!text) return result;

  const standalone = /\bstand[- ]?alone\b/i.test(text);
  const consolidated = /\bconsolidated\b/i.test(text);
  if (standalone !== consolidated) result.statementBasis = standalone ? 'STANDALONE' : 'CONSOLIDATED';

  const constantCurrency = /constant[- ]currency|\bin cc terms\b|\bcc terms\b|\(cc\)|\bcc growth\b/i.test(text);
  const reportedCurrency = /reported[- ]currency|\breported terms\b|\bin (?:inr|rupee|usd|dollar) terms\b/i.test(text);
  if (constantCurrency !== reportedCurrency) result.currencyBasis = constantCurrency ? 'CONSTANT_CURRENCY' : 'REPORTED_CURRENCY';

  const definitions = new Set();
  if (/revenue from operations/i.test(text)) definitions.add('REVENUE_FROM_OPERATIONS');
  if (/\btotal income\b/i.test(text)) definitions.add('TOTAL_INCOME');
  if (/attributable to (?:the )?(?:owners|equity holders|shareholders)/i.test(text)) definitions.add('PROFIT_ATTRIBUTABLE_TO_OWNERS');
  else if (/\bprofit for the (?:period|year)\b/i.test(text)) definitions.add('PROFIT_AFTER_TAX');
  if (definitions.size === 1) [result.metricDefinition] = [...definitions];
  return result;
};

// Metrics whose figure is a revenue / profit line. When the guidance text does
// not name the line itself, the plain reading is assumed explicitly (never
// silently): "revenue" is revenue from operations -- so it can never be scored
// against total income, which also carries other income -- and "PAT" / "net
// profit" is the profit for the period.
const DEFAULT_TARGET_DEFINITION = {
  REVENUE: 'REVENUE_FROM_OPERATIONS', REVENUE_GROWTH: 'REVENUE_FROM_OPERATIONS',
  PAT: 'PROFIT_AFTER_TAX', PAT_GROWTH: 'PROFIT_AFTER_TAX',
};

const BASIS_FIELD_VALUES = {
  statementBasis: ['CONSOLIDATED', 'STANDALONE'],
  currencyBasis: ['CONSTANT_CURRENCY', 'REPORTED_CURRENCY'],
};

/**
 * mergeBasis - text-detected basis overlaid with explicit, structured fields a
 * record may carry (promise.reportingBasis / currencyBasis / scope /
 * metricDefinition). An explicit field wins; an absent one falls back to the
 * text. Unknown values are ignored rather than trusted.
 */
const mergeBasis = (detected, explicit = {}) => {
  const out = { ...detected };
  const statement = String(explicit.reportingBasis || explicit.statementBasis || '').toUpperCase();
  if (BASIS_FIELD_VALUES.statementBasis.includes(statement)) out.statementBasis = statement;
  const currency = String(explicit.currencyBasis || '').toUpperCase();
  if (BASIS_FIELD_VALUES.currencyBasis.includes(currency)) out.currencyBasis = currency;
  if (explicit.scope && String(explicit.scope).toUpperCase() !== 'COMPANY') out.scope = String(explicit.scope).toUpperCase();
  if (explicit.metricDefinition) out.metricDefinition = String(explicit.metricDefinition).toUpperCase();
  return out;
};

/**
 * resolveCuratedRecordOutcome - THE outcome for one stored promise record in
 * the curated shape (promises/<SYMBOL>.json, an ACCEPTED or pending
 * PromiseCandidate: promise / outcome / promiseEvidence / outcomeEvidence).
 * Every surface that shows or counts an outcome -- the Promises vs Actuals
 * table, the Management Guidance tab, the Faith Score, coverage counts, the
 * company report and the company cards -- calls this one function, so they
 * cannot disagree. Stored target / actual / evidence are only read; the stored
 * status is never trusted when a numeric target and actual are on file.
 *
 * Returns the evaluatePromiseOutcome result plus targetBasis / actualBasis.
 */
export const resolveCuratedRecordOutcome = (record, { asOf = new Date() } = {}) => {
  const promise = record?.promise || {};
  const outcome = record?.outcome || {};
  const metric = String(promise.metric || '').toUpperCase();
  const detectedTarget = detectStatedBasis(promise.statement, promise.originalExcerpt, record?.promiseEvidence?.excerpt);
  if (!detectedTarget.metricDefinition && DEFAULT_TARGET_DEFINITION[metric]) detectedTarget.metricDefinition = DEFAULT_TARGET_DEFINITION[metric];
  const targetBasis = mergeBasis(detectedTarget, promise);
  // The actual's basis is read from the outcome SOURCE's own words (or explicit fields), never the curator's narrative.
  const actualBasis = mergeBasis(detectStatedBasis(record?.outcomeEvidence?.excerpt), outcome.basis || {});
  // Every actual this project records comes from a company-level results filing, so a segment target
  // (one business, product or geography) is never scored against it.
  if (targetBasis.scope && !actualBasis.scope && !isMissingNumber(outcome.actualValue)) actualBasis.scope = 'COMPANY';

  const storedCanonical = canonicalOutcomeFromStoredStatus(outcome.status);
  const hasActual = !isMissingNumber(outcome.actualValue);
  const evidenceUnavailableReason = !hasActual && storedCanonical === 'INSUFFICIENT_EVIDENCE' && outcome.explanation ? outcome.explanation : null;

  // No numeric target on record but not marked qualitative either: nothing to recompute from, so the
  // recorded status is kept (a human verdict without figures, or a pending record), never re-labelled.
  const markedQualitative = String(promise.operator || '').toUpperCase() === 'QUALITATIVE' || String(promise.targetType || '').toUpperCase() === 'QUALITATIVE';
  if (isMissingNumber(promise.targetValue) && !markedQualitative && storedCanonical) {
    const recordedVerdict = ['MET', 'EXCEEDED', 'MISSED'].includes(storedCanonical);
    return {
      comparisonType: null, outcome: storedCanonical, achievementPercentage: null, achievementReason: 'No numeric target is recorded.', shortfall: null,
      reason: recordedVerdict ? null : (outcome.explanation || 'No numeric target is recorded for this promise.'),
      calculationExplanation: `No numeric target is recorded; the status is shown as recorded (${outcome.status}). ${outcome.explanation || ''}`.trim(),
      targetBasis, actualBasis,
    };
  }

  const verdict = evaluatePromiseOutcome({
    targetValue: promise.targetValue,
    targetValueMax: promise.targetValueMax ?? null,
    targetUnit: promise.targetUnit ?? null,
    actualValue: hasActual ? outcome.actualValue : null,
    actualUnit: outcome.actualUnit ?? promise.targetUnit ?? null,
    operator: promise.operator ?? null,
    direction: promise.direction ?? null,
    metric: metric || promise.category || '',
    targetType: promise.targetType ?? null,
    targetPeriod: promise.targetPeriod || '',
    actualPeriod: outcome.actualPeriod ?? null,
    targetBasis,
    actualBasis,
    asOf,
    evidenceUnavailableReason,
  });

  // A human-resolved met/missed verdict with no single actual figure (rare)
  // has nothing numeric to recompute from; it is kept rather than downgraded.
  if (!hasActual && verdict.outcome === 'INSUFFICIENT_EVIDENCE' && ['MET', 'EXCEEDED', 'MISSED'].includes(storedCanonical)) {
    return {
      ...verdict,
      outcome: storedCanonical,
      reason: null,
      calculationExplanation: `No single actual figure is recorded; the curated verdict (${outcome.status}) is shown as recorded. ${outcome.explanation || ''}`.trim(),
      targetBasis,
      actualBasis,
    };
  }
  return { ...verdict, targetBasis, actualBasis };
};

const basisLabel = (key, value) => {
  if (key === 'metricDefinition') return DEFINITION_LABELS[value] || value.toLowerCase().replace(/_/g, ' ');
  return value.toLowerCase().replace(/_/g, '-');
};

const basisMismatchReason = (targetBasis = {}, actualBasis = {}) => {
  for (const key of BASIS_KEYS) {
    const target = normalizeBasisValue(key, targetBasis?.[key]);
    const actual = normalizeBasisValue(key, actualBasis?.[key]);
    if (!target || !actual || target === actual) continue;
    const t = basisLabel(key, target);
    const a = basisLabel(key, actual);
    if (key === 'statementBasis') return `Statement-basis mismatch: the target is stated on a ${t} basis but the actual is ${a}; standalone and consolidated figures are never compared.`;
    if (key === 'currencyBasis') return `Currency-basis mismatch: the target is ${t} but the actual is ${a}; constant-currency and reported-currency growth are never compared.`;
    if (key === 'metricDefinition') return `Metric-definition mismatch: the target is "${t}" but the actual is "${a}"; different line items are never compared.`;
    return `Scope mismatch: the target covers "${t}" but the actual covers "${a}"; different segments or scopes are never compared.`;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Comparison type
// ---------------------------------------------------------------------------

const OPERATOR_TO_TYPE = {
  GTE: 'MINIMUM', AT_LEAST: 'MINIMUM',
  LTE: 'MAXIMUM', AT_MOST: 'MAXIMUM',
  EQ: 'EXACT', EXACT: 'EXACT',
  RANGE: 'RANGE', TARGET_RANGE: 'RANGE',
  QUALITATIVE: 'QUALITATIVE',
};
const DIRECTION_TO_TYPE = {
  AT_LEAST: 'MINIMUM', HIGHER_IS_BETTER: 'MINIMUM', GROWTH: 'MINIMUM',
  AT_MOST: 'MAXIMUM', LOWER_IS_BETTER: 'MAXIMUM',
  EXACT: 'EXACT',
  RANGE: 'RANGE', TARGET_RANGE: 'RANGE',
};

/**
 * resolveComparisonType - explicit operator first, then direction, then the
 * same metric-name inference the pre-fix code used when neither was given
 * (debt / cost targets are ceilings, everything else a floor).
 */
export const resolveComparisonType = ({ operator = null, direction = null, metric = '', targetType = null } = {}) => {
  if (String(targetType || '').toUpperCase() === 'QUALITATIVE') return 'QUALITATIVE';
  const byOperator = OPERATOR_TO_TYPE[String(operator || '').toUpperCase()];
  if (byOperator) return byOperator;
  const byDirection = DIRECTION_TO_TYPE[String(direction || '').toUpperCase()];
  if (byDirection) return byDirection;
  const normMetric = String(metric || '').toUpperCase().trim();
  if (normMetric === 'DEBT' || normMetric === 'DEBT_REDUCTION' || normMetric.includes('COST')) return 'MAXIMUM';
  return 'MINIMUM';
};

const TYPE_WORDS = {
  MINIMUM: 'MINIMUM (at least / higher-is-better floor)',
  MAXIMUM: 'MAXIMUM (at most / lower-is-better ceiling)',
  EXACT: `EXACT (within ±${EXACT_RELATIVE_TOLERANCE * 100}% rounding tolerance)`,
  RANGE: 'RANGE (low ≤ actual ≤ high)',
};

const fmt = (value, unit) => `${value}${unit ? ` ${unit}` : ''}`;

/**
 * evaluatePromiseOutcome - the authoritative rule set. Pure and deterministic.
 * Returns { outcome, comparisonType, achievementPercentage, achievementReason,
 *   shortfall, reason, calculationExplanation }.
 *   - achievementPercentage is null whenever a ratio would be misleading
 *     (zero/negative target, sign-crossing actual, zero actual against a
 *     ceiling), with achievementReason saying why; the outcome is still
 *     decided by the direct comparison, which stays well-defined.
 *   - shortfall is set only for MISSED.
 *   - reason is set for PENDING / INSUFFICIENT_EVIDENCE / QUALITATIVE_ONLY.
 */
export const evaluatePromiseOutcome = ({
  targetValue,
  targetValueMax = null,
  targetUnit = null,
  actualValue = null,
  actualUnit = null,
  operator = null,
  direction = null,
  metric = '',
  targetType = null,
  targetPeriod = '',
  actualPeriod = null,
  targetBasis = {},
  actualBasis = {},
  asOf = new Date(),
  evidenceUnavailableReason = null,
} = {}) => {
  const comparisonType = resolveComparisonType({ operator, direction, metric, targetType });
  const base = { comparisonType, achievementPercentage: null, achievementReason: null, shortfall: null, reason: null };

  // 1. No numeric target at all -> qualitative, never scored.
  if (comparisonType === 'QUALITATIVE' || isMissingNumber(targetValue)) {
    const reason = 'Qualitative statement with no numeric target; it is shown for context and never scored as met or missed.';
    return { ...base, comparisonType: 'QUALITATIVE', outcome: 'QUALITATIVE_ONLY', reason, calculationExplanation: reason };
  }

  // 2. No actual: PENDING while the period (plus reporting window) is open, else INSUFFICIENT_EVIDENCE.
  if (isMissingNumber(actualValue)) {
    const period = describeTargetPeriod(targetPeriod);
    let outcome;
    let reason;
    if (period?.openEnded) {
      outcome = 'PENDING';
      reason = `Open-ended target period ("${targetPeriod}") has no fixed deadline; the outcome stays pending until a verified actual is reported.`;
    } else if (!period) {
      outcome = 'INSUFFICIENT_EVIDENCE';
      reason = evidenceUnavailableReason || `Target period "${targetPeriod || 'unspecified'}" could not be resolved to a reporting deadline, and no verified actual result is on file.`;
    } else if (new Date(asOf).getTime() < period.reportingDeadline.getTime()) {
      outcome = 'PENDING';
      reason = `Target period ${targetPeriod} ends ${isoDay(period.periodEnd)}; results are due by ${isoDay(period.reportingDeadline)} (SEBI LODR: ${period.lagDays} days after period end). The outcome is pending official reporting.`;
    } else {
      outcome = 'INSUFFICIENT_EVIDENCE';
      reason = evidenceUnavailableReason
        ? `Target period ${targetPeriod} closed on ${isoDay(period.periodEnd)}, but the actual result could not be verified: ${evidenceUnavailableReason}`
        : `Target period ${targetPeriod} closed on ${isoDay(period.periodEnd)} and results were due by ${isoDay(period.reportingDeadline)}, but no verified actual result has been matched to this target.`;
    }
    return { ...base, outcome, reason, calculationExplanation: reason };
  }

  const insufficient = (reason) => ({ ...base, outcome: 'INSUFFICIENT_EVIDENCE', reason, calculationExplanation: reason });

  // 3. Units must be like-for-like.
  const tUnit = canonicalUnit(targetUnit);
  const aUnit = canonicalUnit(actualUnit) ?? tUnit;
  let t; let tMax; let a; let multiplier = 1;
  if (!tUnit && !aUnit) {
    t = Number(targetValue); a = Number(actualValue); tMax = isMissingNumber(targetValueMax) ? null : Number(targetValueMax);
  } else {
    if (!tUnit || financialUnitFamily(tUnit) !== financialUnitFamily(aUnit)) {
      return insufficient(`Unit mismatch: the target is in ${targetUnit || 'an unstated unit'} but the actual is in ${actualUnit || 'an unstated unit'}; values in different units or currencies are never compared.`);
    }
    t = normalizeFinancialValue(targetValue, tUnit);
    a = normalizeFinancialValue(actualValue, aUnit);
    tMax = isMissingNumber(targetValueMax) ? null : normalizeFinancialValue(targetValueMax, tUnit);
    multiplier = normalizeFinancialValue(1, tUnit) || 1;
    if (t === null || a === null) {
      return insufficient(`Unit could not be normalized (target ${targetUnit}, actual ${actualUnit || targetUnit}); the values are not compared.`);
    }
  }

  // 4. Period, statement basis, currency basis, metric definition, scope.
  const periodReason = periodComparabilityReason(targetPeriod, actualPeriod);
  if (periodReason) return insufficient(periodReason);
  const basisReason = basisMismatchReason(targetBasis, actualBasis);
  if (basisReason) return insufficient(basisReason);

  const eps = 1e-9 * Math.max(1, Math.abs(t));
  const inTargetUnit = (value) => round4(value / multiplier);
  const displayTarget = fmt(targetValue, targetUnit);
  const displayActual = fmt(round4(a / multiplier), targetUnit || actualUnit);

  // 5. Ratio meaningfulness (the comparison below does not depend on it).
  let achievementPercentage = null;
  let achievementReason = null;
  const ratioBase = t; // the target, or the range's low bound
  if (comparisonType === 'MAXIMUM') {
    if (t <= 0) achievementReason = 'Achievement percentage is not meaningful for a zero or negative ceiling target.';
    else if (a <= 0) achievementReason = 'Achievement percentage is not meaningful when the actual is zero or negative against a ceiling target.';
    else achievementPercentage = round2((t / a) * 100);
  } else if (ratioBase === 0) {
    achievementReason = 'Achievement percentage is not meaningful for a zero target.';
  } else if (ratioBase < 0) {
    achievementReason = 'Achievement percentage is not meaningful for a negative target (the ratio inverts its meaning).';
  } else if (a < 0) {
    achievementReason = 'Achievement percentage is not meaningful for a sign-crossing result (positive target, negative actual).';
  } else {
    achievementPercentage = round2((a / ratioBase) * 100);
  }

  // 6. Direct comparison.
  let outcome;
  let shortfall = null;
  let comparisonText;
  const pctOf = (gap, denominator) => (denominator > 0 ? round2((gap / denominator) * 100) : null);

  if (comparisonType === 'MINIMUM') {
    if (a >= t - eps) {
      outcome = t > 0 && a >= t * EXCEEDED_MINIMUM_RATIO - eps ? 'EXCEEDED' : 'MET';
      comparisonText = outcome === 'EXCEEDED'
        ? `${displayActual} ≥ ${displayTarget} and at least ${Math.round((EXCEEDED_MINIMUM_RATIO - 1) * 100)}% above it`
        : `${displayActual} ≥ ${displayTarget}`;
    } else {
      outcome = 'MISSED';
      shortfall = { value: inTargetUnit(t - a), unit: targetUnit || actualUnit || null, percentage: pctOf(t - a, t), direction: 'BELOW_FLOOR' };
      comparisonText = `${displayActual} < ${displayTarget} (below the floor)`;
    }
  } else if (comparisonType === 'MAXIMUM') {
    if (a <= t + eps) {
      outcome = t > 0 && a <= t * EXCEEDED_MAXIMUM_RATIO + eps ? 'EXCEEDED' : 'MET';
      comparisonText = outcome === 'EXCEEDED'
        ? `${displayActual} ≤ ${displayTarget} and at least ${Math.round((1 - EXCEEDED_MAXIMUM_RATIO) * 100)}% below it`
        : `${displayActual} ≤ ${displayTarget}`;
    } else {
      outcome = 'MISSED';
      shortfall = { value: inTargetUnit(a - t), unit: targetUnit || actualUnit || null, percentage: pctOf(a - t, t), direction: 'ABOVE_CEILING' };
      comparisonText = `${displayActual} > ${displayTarget} (above the ceiling)`;
    }
  } else if (comparisonType === 'EXACT') {
    const tolerance = Math.abs(t) * EXACT_RELATIVE_TOLERANCE + eps;
    if (Math.abs(a - t) <= tolerance) {
      outcome = 'MET';
      comparisonText = `${displayActual} is within ±${EXACT_RELATIVE_TOLERANCE * 100}% of ${displayTarget}`;
    } else {
      outcome = 'MISSED';
      shortfall = { value: inTargetUnit(Math.abs(a - t)), unit: targetUnit || actualUnit || null, percentage: pctOf(Math.abs(a - t), Math.abs(t)), direction: 'OFF_EXACT' };
      comparisonText = `${displayActual} is not within ±${EXACT_RELATIVE_TOLERANCE * 100}% of ${displayTarget}`;
    }
  } else {
    // RANGE: targetValue is the low bound, targetValueMax the high bound.
    if (tMax !== null && tMax < t) return insufficient(`Invalid range target: upper bound ${targetValueMax} is below lower bound ${targetValue}.`);
    const rangeText = `${targetValue}${tMax !== null ? `–${targetValueMax}` : '–(upper bound not recorded)'}${targetUnit ? ` ${targetUnit}` : ''}`;
    if (a < t - eps) {
      // Below the floor is outside the range whatever the (possibly unrecorded) ceiling is.
      outcome = 'MISSED';
      shortfall = { value: inTargetUnit(t - a), unit: targetUnit || actualUnit || null, percentage: pctOf(t - a, t), direction: 'BELOW_RANGE' };
      comparisonText = `${displayActual} is below the range ${rangeText}`;
    } else if (tMax === null) {
      return insufficient(`Range target is missing its upper bound, so an actual of ${displayActual} (at or above the ${displayTarget} lower bound) cannot be confirmed as inside the range.`);
    } else if (a > tMax + eps) {
      // Out-of-range on either side is MISSED: no favourable direction is assumed for a range.
      outcome = 'MISSED';
      shortfall = { value: inTargetUnit(a - tMax), unit: targetUnit || actualUnit || null, percentage: pctOf(a - tMax, tMax), direction: 'ABOVE_RANGE' };
      comparisonText = `${displayActual} is above the range ${rangeText}`;
    } else {
      outcome = 'MET';
      comparisonText = `${displayActual} is inside the range ${rangeText}`;
    }
  }

  const contextNote = achievementPercentage === null
    ? ` Achievement percentage withheld: ${achievementReason}`
    : comparisonType === 'MINIMUM' || comparisonType === 'MAXIMUM'
      ? ` Achievement ${achievementPercentage}% of target (100% = exactly at the ${comparisonType === 'MINIMUM' ? 'floor' : 'ceiling'}); shown for context only -- the outcome above is decided by the direct comparison.`
      : ` Actual is ${achievementPercentage}% of ${comparisonType === 'RANGE' ? 'the range low bound' : 'the target'}; shown for context only and never a score -- the outcome above is decided by the direct comparison.`;
  const shortfallNote = shortfall
    ? ` Shortfall: ${shortfall.value}${shortfall.unit ? ` ${shortfall.unit}` : ''}${shortfall.percentage !== null ? ` (${shortfall.percentage}%)` : ''}.`
    : '';
  const calculationExplanation = `Comparison: ${TYPE_WORDS[comparisonType]}. Target ${displayTarget}${targetPeriod ? ` for ${targetPeriod}` : ''}; actual ${displayActual}. ${comparisonText}, so the outcome is ${outcome}.${shortfallNote}${contextNote}`;

  return { comparisonType, outcome, achievementPercentage, achievementReason, shortfall, reason: null, calculationExplanation };
};

// ---------------------------------------------------------------------------
// Vocabulary mapping (canonical <-> stored enums)
// ---------------------------------------------------------------------------

/** Canonical -> legacy ManagementPromise.verification.status (existing literals reused; MET -> FULFILLED). */
export const LEGACY_VERIFICATION_STATUS = Object.freeze({
  MET: 'FULFILLED', EXCEEDED: 'EXCEEDED', MISSED: 'MISSED', PENDING: 'PENDING',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE', QUALITATIVE_ONLY: 'QUALITATIVE_ONLY',
});
export const toLegacyVerificationStatus = (outcome) => LEGACY_VERIFICATION_STATUS[outcome] || 'INSUFFICIENT_EVIDENCE';

/** Canonical -> curated / PromiseCandidate outcome.status (MET -> ACHIEVED; EXCEEDED kept distinct). */
export const CANDIDATE_OUTCOME_STATUS = Object.freeze({
  MET: 'ACHIEVED', EXCEEDED: 'EXCEEDED', MISSED: 'MISSED', PENDING: 'PENDING',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE', QUALITATIVE_ONLY: 'QUALITATIVE_ONLY',
});
export const toCandidateOutcomeStatus = (outcome) => CANDIDATE_OUTCOME_STATUS[outcome] || 'INSUFFICIENT_EVIDENCE';

/**
 * canonicalOutcomeFromStoredStatus - reads ANY stored status vocabulary
 * (legacy, curated, canonical). PARTIAL / PARTIALLY_FULFILLED map to MISSED:
 * the pre-fix banding only ever produced them for a result short of the
 * stated target (60-90% of a floor, or above a ceiling), so they are misses
 * of the target as stated. Unknown values return null (not counted anywhere).
 */
export const canonicalOutcomeFromStoredStatus = (status) => {
  switch (String(status || '').toUpperCase()) {
    case 'MET': case 'FULFILLED': case 'ACHIEVED': return 'MET';
    case 'EXCEEDED': return 'EXCEEDED';
    case 'MISSED': case 'PARTIAL': case 'PARTIALLY_FULFILLED': return 'MISSED';
    case 'PENDING': return 'PENDING';
    case 'INSUFFICIENT_EVIDENCE': case 'CONFLICTING_EVIDENCE': return 'INSUFFICIENT_EVIDENCE';
    case 'QUALITATIVE_ONLY': return 'QUALITATIVE_ONLY';
    default: return null;
  }
};

/**
 * resolveRecordOutcome - canonical outcome for one stored promise record
 * (legacy ManagementPromise document OR curated/PromiseCandidate record --
 * both keep promise.targetValue / outcome.actualValue). Whenever the stored
 * target AND actual are numeric, the verdict is RECOMPUTED with the current
 * rules rather than trusting a possibly pre-fix stored status; the stored
 * target/actual/evidence are never modified. Without a numeric actual, a
 * stored human-resolved verdict (met/missed with no single figure) is kept;
 * otherwise PENDING vs INSUFFICIENT_EVIDENCE is decided from the period.
 */
export const resolveRecordOutcome = (record, { asOf = new Date() } = {}) => {
  if (!record) return { outcome: null };
  if (typeof record === 'string') return { outcome: canonicalOutcomeFromStoredStatus(record) };
  if (record.canonicalOutcome) return { outcome: record.canonicalOutcome };
  // Curated shape (JSON record / PromiseCandidate): the one shared resolver.
  if (record.promiseEvidence || record.outcomeEvidence !== undefined) return resolveCuratedRecordOutcome(record, { asOf });
  const promise = record.promise || {};
  const outcome = record.outcome || {};
  const storedStatus = outcome.status || record.verification?.status || record.status;
  const storedCanonical = canonicalOutcomeFromStoredStatus(storedStatus);
  const targetValue = promise.targetValue ?? record.targetValue;
  const actualValue = outcome.actualValue ?? record.actualValue;

  if (isMissingNumber(targetValue)) {
    // A legacy record that genuinely lacks a target field keeps its stored status (nothing to recompute from).
    if (!promise.operator && !promise.targetType && storedCanonical) return { outcome: storedCanonical };
    return evaluatePromiseOutcome({ targetValue: null, operator: promise.operator, targetType: promise.targetType });
  }
  if (isMissingNumber(actualValue) && ['MET', 'EXCEEDED', 'MISSED'].includes(storedCanonical)) {
    return { outcome: storedCanonical };
  }
  return evaluatePromiseOutcome({
    targetValue,
    targetValueMax: promise.targetValueMax ?? null,
    targetUnit: promise.targetUnit ?? record.targetUnit ?? null,
    actualValue: isMissingNumber(actualValue) ? null : actualValue,
    actualUnit: outcome.actualUnit ?? record.actualUnit ?? null,
    operator: promise.operator ?? null,
    direction: promise.direction ?? null,
    metric: promise.metric || record.metric || record.metricType || '',
    targetType: promise.targetType ?? null,
    targetPeriod: promise.targetPeriod || record.targetPeriod || '',
    actualPeriod: outcome.actualPeriod ?? record.actualPeriod ?? null,
    targetBasis: detectStatedBasis(promise.statement, record.evidence?.promiseSource?.excerpt),
    actualBasis: detectStatedBasis(outcome.excerpt, record.evidence?.outcomeSource?.excerpt),
    asOf,
  });
};

export default {
  PROMISE_OUTCOMES,
  EVALUABLE_OUTCOMES,
  HIT_OUTCOMES,
  COMPARISON_TYPES,
  EXCEEDED_MINIMUM_RATIO,
  EXCEEDED_MAXIMUM_RATIO,
  EXACT_RELATIVE_TOLERANCE,
  REPORTING_LAG_DAYS,
  canonicalUnit,
  describeTargetPeriod,
  periodComparabilityReason,
  isTargetPeriodClosed,
  detectStatedBasis,
  resolveComparisonType,
  evaluatePromiseOutcome,
  toLegacyVerificationStatus,
  toCandidateOutcomeStatus,
  canonicalOutcomeFromStoredStatus,
  resolveRecordOutcome,
  resolveCuratedRecordOutcome,
};
