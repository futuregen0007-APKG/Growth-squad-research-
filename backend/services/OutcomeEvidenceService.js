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
import {
  normalizeFinancialValue, financialUnitFamily, isCompatiblePeriodComparison, parseFiscalPeriod,
} from '../utils/financialNormalization.js';
import { logger } from '../utils/logger.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import { getDocumentBuffer } from '../providers/ExchangeFilingDocumentProvider.js';
import { extractFactsFromDocument } from './FactExtractionService.js';

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
// ---------------------------------------------------------------------------
// Local-first outcome verification (tiers a/b below IndianAPI, tier c).
// Priority: (a) later REAL_RESEARCH CompanyHistoricalFact records this
// project already extracted from an official document -> (b) a durably
// persisted BSE/NSE document covering a compatible period that hasn't been
// fact-extracted yet -> (c) IndianAPI as an optional secondary fallback.
// IndianAPI being rate-limited/unavailable must never block verification
// when (a) or (b) already has the answer.
// ---------------------------------------------------------------------------

// promise.metric (ManagementPromise/PromiseCandidate enum) -> the real
// CompanyHistoricalFact.metrics.metric strings this project's own fact
// extraction actually produces (see FactExtractionService.js's VALID_METRICS
// and backfillHistoricalFacts.js's manual records) or OTHER_QUANTIFIABLE-style
// aliases. A promise metric with no listed alias falls back to an exact
// (case-insensitive) string match -- never a guessed mapping.
const FACT_METRIC_ALIASES = {
  MARGIN: ['MARGIN', 'OPERATING_MARGIN', 'EBITDA_MARGIN'],
  EBITDA_MARGIN: ['EBITDA_MARGIN', 'OPERATING_MARGIN'],
  REVENUE: ['REVENUE'],
  REVENUE_GROWTH: ['REVENUE'],
  PAT: ['PAT', 'ADJUSTED_PAT'],
  PAT_GROWTH: ['PAT', 'ADJUSTED_PAT'],
  ORDER_BOOK: ['ORDER_BOOK'],
  ORDER_INTAKE: ['ORDER_BOOK'],
  DEBT: ['DEBT', 'NET_DEBT'],
  DEBT_REDUCTION: ['DEBT', 'NET_DEBT'],
  FREE_CASH_FLOW: ['FREE_CASH_FLOW', 'OPERATING_CASH_FLOW'],
  NIM: ['NIM'],
};

const factMetricMatches = (promiseMetric, factMetric) => {
  if (!factMetric) return false;
  const normalizedFactMetric = String(factMetric).toUpperCase();
  const aliases = FACT_METRIC_ALIASES[String(promiseMetric || '').toUpperCase()];
  if (aliases) return aliases.includes(normalizedFactMetric);
  return String(promiseMetric || '').toUpperCase() === normalizedFactMetric;
};

/**
 * buildLocalMatch - shared conversion from a real fact-shaped value
 * ({ metric, actualValue, unit, period/targetPeriod }, plus a real source)
 * into the same outcome-candidate shape searchActualOutcomesFromIndianApi
 * produces, so every caller downstream treats all three tiers identically.
 * Returns null (never guesses) when the unit families are incompatible.
 */
const buildLocalMatch = (promise, fact, source) => {
  const targetFamily = financialUnitFamily(promise.targetUnit);
  const factFamily = financialUnitFamily(fact.unit);
  if (targetFamily !== factFamily) return null;

  const normalizedTarget = normalizeFinancialValue(promise.targetValue, promise.targetUnit);
  const normalizedActual = normalizeFinancialValue(fact.actualValue, fact.unit);
  if (normalizedTarget === null || normalizedActual === null) return null;

  const targetUnitMultiplier = normalizeFinancialValue(1, promise.targetUnit);
  const actualValueInTargetUnit = targetUnitMultiplier
    ? Number((normalizedActual / targetUnitMultiplier).toFixed(4))
    : fact.actualValue;

  return {
    actualValue: actualValueInTargetUnit,
    actualUnit: promise.targetUnit,
    actualPeriod: promise.targetPeriod,
    outcomeStatement: `${source.title || 'Company historical fact'}: ${fact.actualValue} ${fact.unit} for ${fact.period}, equivalent to ${actualValueInTargetUnit} ${promise.targetUnit} for ${promise.targetPeriod}.`,
    outcomeSource: source.title || 'Company historical fact (REAL_RESEARCH)',
    outcomeSourceUrl: source.url || null,
    outcomeSourceDate: source.date || null,
    evidenceType: 'DOCUMENT_EVIDENCE',
    provider: source.provider || 'company-historical-fact',
    confidence: source.confidence ?? 0.85,
  };
};

/**
 * searchActualOutcomeFromHistoricalFacts - Tier (a). Looks for a
 * REAL_RESEARCH CompanyHistoricalFact this project already extracted from a
 * real primary-source document, for a period compatible with the promise's
 * targetPeriod and a metric this project's own extraction is known to
 * produce. Never fabricates: returns null if nothing compatible is on file.
 */
export const searchActualOutcomeFromHistoricalFacts = async (profile, promise) => {
  if (!promise?.targetPeriod || !promise?.metric) return null;

  const facts = await CompanyHistoricalFact.find({
    symbol: profile.symbol, dataOrigin: 'REAL_RESEARCH', 'metrics.actualValue': { $ne: null },
  }).sort({ date: -1 }).lean();

  for (const record of facts) {
    if (!factMetricMatches(promise.metric, record.metrics?.metric)) continue;
    if (!isCompatiblePeriodComparison(promise.targetPeriod, record.period)) continue;

    const match = buildLocalMatch(promise, {
      actualValue: record.metrics.actualValue, unit: record.metrics.unit, period: record.period,
    }, {
      title: record.source?.title, url: record.source?.url, date: record.source?.publishedAt || record.date, provider: 'company-historical-fact', confidence: record.confidence,
    });
    if (match) {
      logger.info(`[OutcomeEvidence] CompanyHistoricalFact deterministic match for ${profile.symbol} ${promise.metric} ${promise.targetPeriod}`);
      return match;
    }
  }
  return null;
};

/**
 * searchActualOutcomeFromPersistedDocuments - Tier (b). For a durably
 * stored (S3/GridFS) document covering a period compatible with the
 * promise's targetPeriod that has NOT yet produced a matching
 * CompanyHistoricalFact (tier (a) already checked and found nothing), runs
 * the SAME anti-hallucination LLM fact extraction used by the batch
 * pipeline on-demand against that one document, and matches its output the
 * same way. Deliberately scoped to documents with a storageKey -- this tier
 * exists precisely so a stale/expired source URL never blocks verification,
 * so it must never itself depend on re-fetching from the original URL.
 */
// Hard bound on tier (b)'s cost: at most this many documents get a full
// on-demand LLM fact extraction pass per promise. Without this, a symbol
// with many durably-stored documents turns every unmatched promise into an
// unbounded sweep of full-document extractions -- observed live during the
// INFY FY2022-2025 rediscovery run, where processing stalled for 7+ minutes
// on a single document once ~10 documents were durable.
const MAX_TIER_B_DOCUMENTS = 2;
// Hard wall-clock bound on the whole tier -- a single slow/huge document
// (INFY has had a 350+ page filing) must never hang promise-generation
// indefinitely. Times out to null (falls through to tier c), never throws.
const TIER_B_TIMEOUT_MS = 45000;

const withTimeout = (promiseValue, ms, onTimeoutValue) => Promise.race([
  promiseValue,
  new Promise((resolve) => { setTimeout(() => resolve(onTimeoutValue), ms); }),
]);

const searchActualOutcomeFromPersistedDocumentsInner = async (profile, promise, { getDocumentBufferFn = getDocumentBuffer, extractFactsFn = extractFactsFromDocument } = {}) => {
  if (!promise?.targetPeriod || !promise?.metric) return null;

  // Query-level fiscal-year bound (not just an in-loop filter) -- a
  // document's fiscalYear is always a single annual label, so a promise
  // whose own targetPeriod can't be resolved to one real fiscal year has no
  // compatible document to look for and tier (b) is skipped entirely rather
  // than scanning every durably-stored document for this symbol.
  const { fiscalYear: targetFiscalYear } = parseFiscalPeriod(promise.targetPeriod);
  if (!targetFiscalYear) return null;

  const candidateDocs = await CompanyDocumentRegistry.find({
    symbol: profile.symbol, fiscalYear: `FY${targetFiscalYear}`, storageKey: { $ne: null }, storageBackend: { $ne: null },
  }).sort({ publicationDate: -1 }).limit(MAX_TIER_B_DOCUMENTS).lean();

  for (const doc of candidateDocs) {
    // eslint-disable-next-line no-await-in-loop
    const { buffer } = await getDocumentBufferFn(doc);
    if (!buffer) continue;

    // eslint-disable-next-line no-await-in-loop
    const facts = await extractFactsFn(buffer, {
      symbol: profile.symbol, companyName: doc.companyName, fiscalYear: doc.fiscalYear, sourceType: doc.sourceType, url: doc.url, title: doc.sourceType,
    }).catch((error) => {
      logger.warn(`[OutcomeEvidence] Tier-b on-demand fact extraction failed for ${profile.symbol} ${doc.url}: ${error.message}`);
      return [];
    });

    for (const fact of facts) {
      if (!factMetricMatches(promise.metric, fact.metric) || fact.actualValue == null) continue;
      if (!isCompatiblePeriodComparison(promise.targetPeriod, fact.period)) continue;
      const match = buildLocalMatch(promise, fact, {
        title: doc.sourceType, url: doc.url, date: doc.publicationDate, provider: 'persisted-document', confidence: 0.8,
      });
      if (match) {
        logger.info(`[OutcomeEvidence] Persisted-document deterministic match for ${profile.symbol} ${promise.metric} ${promise.targetPeriod}`);
        return match;
      }
    }
  }
  return null;
};

export const searchActualOutcomeFromPersistedDocuments = async (profile, promise, options = {}) => {
  const result = await withTimeout(
    searchActualOutcomeFromPersistedDocumentsInner(profile, promise, options).catch((error) => {
      logger.warn(`[OutcomeEvidence] Tier-b failed for ${profile.symbol} ${promise?.metric} ${promise?.targetPeriod}: ${error.message}`);
      return null;
    }),
    TIER_B_TIMEOUT_MS,
    null,
  );
  return result;
};

/**
 * searchActualOutcomesLocalFirst - the combined, priority-ordered outcome
 * verifier every promise-generation path (PromiseCandidateService,
 * PromiseExtractionService) should use as its default outcomeSearchFn.
 * IndianAPI is tried LAST and only as an optional secondary fallback --
 * its unavailability (rate limit, outage) must never block verification
 * when tier (a) or (b) already has a real, local answer.
 */
export const searchActualOutcomesLocalFirst = async (profile, promise, {
  historicalFactsFn = searchActualOutcomeFromHistoricalFacts,
  persistedDocumentsFn = searchActualOutcomeFromPersistedDocuments,
  indianApiFn = searchActualOutcomesFromIndianApi,
} = {}) => {
  const fromFacts = await historicalFactsFn(profile, promise);
  if (fromFacts) return fromFacts;

  const fromDocuments = await persistedDocumentsFn(profile, promise);
  if (fromDocuments) return fromDocuments;

  return indianApiFn(profile, promise);
};

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
  searchActualOutcomeFromHistoricalFacts,
  searchActualOutcomeFromPersistedDocuments,
  searchActualOutcomesLocalFirst,
};
