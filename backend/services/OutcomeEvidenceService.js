/**
 * OUTCOME_EVIDENCE_SERVICE.JS
 * ============================
 * Provider-neutral metric/period matching between an extracted management
 * promise and structured outcome evidence — the Phase 6/7/8 "safe matching
 * layer" that lets Earnings Intelligence use IndianAPI data as *supporting*
 * evidence without ever fabricating a match.
 *
 * This module is deliberately the ONLY place a promise's numeric target is
 * compared against IndianAPI-sourced data. It never invents a value, never
 * compares incompatible periods (quarterly vs annual, without an explicit
 * rule) or incompatible units, and never treats an analyst forecast
 * (evidenceType ANALYST_SNAPSHOT) as an achieved outcome.
 */

import { getCompanyResearchProvider } from '../providers/ProviderRegistry.js';
import { normalizeFinancialValue, financialUnitFamily, isCompatiblePeriodComparison } from '../utils/financialNormalization.js';
import { logger } from '../utils/logger.js';

export const OUTCOME_EVIDENCE_TYPES = Object.freeze([
  'FINANCIAL_ACTUAL',
  'KEY_METRIC',
  'CORPORATE_ACTION',
  'SHAREHOLDING_CHANGE',
  'ANALYST_SNAPSHOT',
  'COMPANY_NEWS',
  'DOCUMENT_EVIDENCE',
]);

// Candidate raw-field-name fragments per ManagementPromise metric enum,
// used to search the (provider-specific, not fully documented) IndianAPI
// raw financial payload. Matching is a case-insensitive substring match
// against flattened key names (see findMetricValueInRaw). Metrics with no
// listed fragments (OTHER, OTHER_QUANTIFIABLE, MARKET_SHARE,
// CUSTOMER_COUNT, EMPLOYEE_COUNT/PERCENTAGE, LARGE_DEALS, EXPORT_REVENUE,
// ARR, BOOKINGS, ORDER_BOOK, ORDER_INTAKE, CAPEX) are intentionally left
// unmatched here — IndianAPI's structured financials do not reliably
// expose them, and guessing a field would risk a false match. Those metric
// types remain dependent on the document-research pipeline for outcome
// evidence (see Phase 14 report — "promise types that still need documents").
const METRIC_FIELD_HINTS = {
  REVENUE: ['revenue', 'totalincome', 'netsales', 'sales'],
  REVENUE_GROWTH: ['revenue', 'totalincome', 'netsales', 'sales'],
  EBITDA: ['ebitda', 'operatingprofit'],
  EBITDA_MARGIN: ['ebitdamargin', 'opm', 'operatingmargin'],
  PAT: ['netprofit', 'profitaftertax', 'pat'],
  PAT_GROWTH: ['netprofit', 'profitaftertax', 'pat'],
  DEBT: ['totaldebt', 'debt', 'borrowings'],
  DEBT_REDUCTION: ['totaldebt', 'debt', 'borrowings'],
  MARGIN: ['margin'],
  FREE_CASH_FLOW: ['freecashflow', 'fcf'],
  NIM: ['nim', 'netinterestmargin'],
  CREDIT_GROWTH: ['creditgrowth', 'advances'],
  DEPOSIT_GROWTH: ['deposit'],
  CASA: ['casa'],
};

const flattenKeys = (obj, prefix = '') => {
  const result = [];
  if (!obj || typeof obj !== 'object') return result;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result.push(...flattenKeys(value, path));
    } else if (!Array.isArray(value)) {
      result.push({ path, key, value });
    }
  }
  return result;
};

/**
 * findMetricValueInRaw - searches a raw evidence record's payload for a
 * field whose key name matches one of the promise metric's known
 * fragments, and whose value is a genuine finite number. Returns
 * { value, rawFieldName } or null — never guesses a value from an
 * unrelated field, and never invents a number when none is present.
 */
export const findMetricValueInRaw = (metric, raw) => {
  const hints = METRIC_FIELD_HINTS[String(metric || '').toUpperCase()];
  if (!hints || !hints.length || !raw) return null;

  const flattened = flattenKeys(raw);
  for (const hint of hints) {
    const match = flattened.find(({ key }) => String(key).toLowerCase().replace(/[^a-z]/g, '').includes(hint));
    if (!match) continue;
    const numeric = Number(String(match.value).replace(/,/g, ''));
    if (Number.isFinite(numeric)) {
      return { value: numeric, rawFieldName: match.path };
    }
  }
  return null;
};

/**
 * matchPromiseToIndianApiEvidence - deterministic matcher. `evidenceList`
 * is the flat candidate list from IndianApiProvider.getOutcomeEvidence.
 * Only FINANCIAL_ACTUAL / KEY_METRIC candidates are considered — analyst
 * snapshots and undated news are never used to resolve a promise's actual
 * value here. Returns a normalized outcome candidate or null.
 */
export const matchPromiseToIndianApiEvidence = (promise, evidenceList = []) => {
  const candidates = evidenceList.filter(
    (item) => item.evidenceType === 'FINANCIAL_ACTUAL' || item.evidenceType === 'KEY_METRIC',
  );

  for (const candidate of candidates) {
    if (!isCompatiblePeriodComparison(promise.targetPeriod, candidate.period)) continue;

    const found = findMetricValueInRaw(promise.metric, candidate.raw);
    if (!found) continue;

    // IndianAPI reports financial-statement figures in INR Crore by
    // documented convention; percentage/count metrics are compared as-is.
    // A USD-denominated promise cannot be safely matched against an
    // Indian-market provider's figures without an explicit conversion
    // source, so it is left unmatched rather than guessed.
    const targetFamily = financialUnitFamily(promise.targetUnit);
    let actualUnit;
    if (targetFamily === 'INR') {
      actualUnit = 'INR_CRORE';
    } else if (targetFamily === 'PERCENTAGE' || targetFamily === 'COUNT') {
      actualUnit = promise.targetUnit;
    } else {
      continue;
    }

    const normalizedTarget = normalizeFinancialValue(promise.targetValue, promise.targetUnit);
    const normalizedActual = normalizeFinancialValue(found.value, actualUnit);
    if (normalizedTarget === null || normalizedActual === null) continue;
    if (financialUnitFamily(promise.targetUnit) !== financialUnitFamily(actualUnit)) continue;

    // Report the actual value converted into the promise's own unit/period
    // labels — ManagementPromiseService's downstream consumer
    // (refreshCompanyResearch's outcomeMatchesPromise gate) does a strict
    // string comparison against promise.targetUnit/targetPeriod, not a
    // re-derived normalization, so a fiscally-equivalent-but-differently-
    // spelled period (e.g. "FY25" vs "FY2025") or an equivalent-but-
    // different unit (INR_CRORE vs INR_LAKH) must be expressed in the
    // promise's own terms here or it would be silently discarded despite
    // being a valid match. The original raw value/unit/period are kept in
    // outcomeStatement for audit purposes.
    const targetUnitMultiplier = normalizeFinancialValue(1, promise.targetUnit);
    const actualValueInTargetUnit = targetUnitMultiplier
      ? Number((normalizedActual / targetUnitMultiplier).toFixed(4))
      : found.value;

    return {
      actualValue: actualValueInTargetUnit,
      actualUnit: promise.targetUnit,
      actualPeriod: promise.targetPeriod,
      outcomeStatement: `IndianAPI reported ${found.rawFieldName} = ${found.value} (${actualUnit}) for ${candidate.period}, equivalent to ${actualValueInTargetUnit} ${promise.targetUnit} for ${promise.targetPeriod}.`,
      outcomeSource: candidate.sourceTitle || 'IndianAPI company financials',
      outcomeSourceUrl: candidate.sourceUrl || null,
      outcomeSourceDate: candidate.evidenceDate || null,
      evidenceType: candidate.evidenceType,
      provider: 'indian-api',
      rawFieldName: found.rawFieldName,
      // Deterministic field-match confidence — lower than a document/LLM
      // match with an exact quoted excerpt, since it relies on inferred
      // field-name hints rather than a verified statement. Surfaced so
      // downstream scoring can weight it accordingly.
      confidence: 0.75,
    };
  }
  return null;
};

/**
 * searchActualOutcomesFromIndianApi - Stage B tier, tried before the
 * LLM-based document/news extraction tiers in ManagementPromiseService, per
 * the rule that structured numbers should be verified deterministically
 * before falling back to an LLM. Returns the same
 * { actualValue, actualUnit, actualPeriod, outcomeStatement, outcomeSource,
 *   outcomeSourceUrl, outcomeSourceDate } shape the other Stage B tiers
 * produce (so refreshCompanyResearch's existing consumer code needs no
 * change), or null when no confident deterministic match exists — callers
 * must fall back to the document/news tiers in that case, never treat null
 * as "zero" or "no promise made".
 */
export const searchActualOutcomesFromIndianApi = async (profile, promise) => {
  if (!promise?.targetPeriod || !promise?.metric) return null;

  const provider = getCompanyResearchProvider();
  if (!provider || !provider.isConfigured) return null;

  try {
    const evidence = await provider.getOutcomeEvidence(profile.symbol, { targetPeriod: promise.targetPeriod });
    const match = matchPromiseToIndianApiEvidence(promise, evidence);
    if (match) {
      logger.info(`[OutcomeEvidence] IndianAPI deterministic match for ${profile.symbol} ${promise.metric} ${promise.targetPeriod} (field: ${match.rawFieldName})`);
    }
    return match;
  } catch (error) {
    logger.warn(`[OutcomeEvidence] IndianAPI lookup failed for ${profile.symbol}: ${error.message}`);
    return null;
  }
};

export default {
  OUTCOME_EVIDENCE_TYPES,
  findMetricValueInRaw,
  matchPromiseToIndianApiEvidence,
  searchActualOutcomesFromIndianApi,
};
