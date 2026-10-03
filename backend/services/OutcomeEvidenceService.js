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
import { describeTargetPeriod } from '../utils/promiseOutcome.js';

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
// STRICT one-to-one: a promise metric only ever matches the identical figure.
// The previous table matched "MARGIN" against operating and EBITDA margin,
// EBITDA margin against operating margin, PAT against adjusted PAT, order
// intake against the order book, free cash flow against operating cash flow
// and gross debt against net debt -- different figures that must never be
// compared. A growth rate is never matched against a level (see tier (a)).
// "MARGIN" (type not stated) matches nothing.
const FACT_METRIC_ALIASES = {
  MARGIN: [],
  REVENUE_GROWTH: [],
  PAT_GROWTH: [],
  EBITDA_MARGIN: ['EBITDA_MARGIN'],
  OPERATING_MARGIN: ['OPERATING_MARGIN'],
  EBIT_MARGIN: ['OPERATING_MARGIN'],
  REVENUE: ['REVENUE'],
  PAT: ['PAT'],
  ORDER_BOOK: ['ORDER_BOOK'],
  ORDER_INTAKE: ['ORDER_INTAKE'],
  DEBT: ['DEBT'],
  NET_DEBT: ['NET_DEBT'],
  DEBT_REDUCTION: [],
  FREE_CASH_FLOW: ['FREE_CASH_FLOW'],
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

// ---------------------------------------------------------------------------
// Tier (a): exchange XBRL actuals, matched like-for-like
// ---------------------------------------------------------------------------

// The financial line a stored XBRL fact actually reports, read from the fact's
// own sentence ("... reported Revenue from operations of X for FY2026
// (Consolidated, Audited)."). The fact's metric key alone is NOT enough: for a
// bank the key "REVENUE" holds Total income, which also carries other income.
const FACT_LINE_DEFINITIONS = [
  [/revenue from operations/i, 'REVENUE_FROM_OPERATIONS'],
  [/\btotal income\b/i, 'TOTAL_INCOME'],
  [/attributable to (?:the )?(?:owners|equity holders|shareholders)/i, 'PROFIT_ATTRIBUTABLE_TO_OWNERS'],
  [/\bprofit (?:\(loss\) )?for the (?:period|year)\b/i, 'PROFIT_AFTER_TAX'],
  [/\bdiluted earnings per share\b/i, 'DILUTED_EPS'],
  [/\bbasic earnings per share\b/i, 'BASIC_EPS'],
];
const DEFINITION_WORDS = {
  REVENUE_FROM_OPERATIONS: 'revenue from operations', TOTAL_INCOME: 'total income', PROFIT_AFTER_TAX: 'profit for the period',
  PROFIT_ATTRIBUTABLE_TO_OWNERS: 'profit attributable to owners', BASIC_EPS: 'basic EPS', DILUTED_EPS: 'diluted EPS',
};

/** describeXbrlFact - pure. The line definition, statement basis and period granularity a stored fact states about itself. */
export const describeXbrlFact = (fact) => {
  const text = String(fact?.fact || '');
  const definition = (FACT_LINE_DEFINITIONS.find(([re]) => re.test(text)) || [])[1] || null;
  const basisMatch = text.match(/\((Consolidated|Standalone)\b/i);
  return {
    definition,
    basis: basisMatch ? basisMatch[1].toUpperCase() : null,
    period: describeTargetPeriod(fact?.period),
    isXbrl: /\/xbrl\//i.test(String(fact?.source?.url || '')),
  };
};

// Promise metric -> the fact series that measures it, and (for a level) the
// line definition the guidance means when it does not name one. Growth is
// derived from two annual levels of the SAME line and basis.
const LEVEL_SERIES = { REVENUE: 'REVENUE', PAT: 'PAT', EPS: 'EPS' };
const GROWTH_SERIES = { REVENUE_GROWTH: 'REVENUE', PAT_GROWTH: 'PAT' };
const DEFAULT_DEFINITION = { REVENUE: 'REVENUE_FROM_OPERATIONS', PAT: 'PROFIT_AFTER_TAX', EPS: 'BASIC_EPS' };

// Two bases whose figures differ by less than this are treated as the same
// number for an unstated-basis target; beyond it the basis would change the
// actual materially, so no verdict is given.
const BASIS_AMBIGUITY_TOLERANCE = 0.02;

const samePeriod = (a, b) => a && b && !a.openEnded && !b.openEnded
  && a.granularity === b.granularity && a.fiscalYear === b.fiscalYear && a.index === b.index;

const statedTargetBasis = (promise) => {
  const explicit = String(promise.reportingBasis || '').toUpperCase();
  if (explicit === 'CONSOLIDATED' || explicit === 'STANDALONE') return explicit;
  const text = String(promise.statementText || '');
  const standalone = /\bstand[- ]?alone\b/i.test(text);
  const consolidated = /\bconsolidated\b/i.test(text);
  return standalone !== consolidated ? (standalone ? 'STANDALONE' : 'CONSOLIDATED') : null;
};

const statedTargetDefinition = (promise, series) => {
  if (promise.metricDefinition) return String(promise.metricDefinition).toUpperCase();
  const text = String(promise.statementText || '');
  if (/\btotal income\b/i.test(text)) return 'TOTAL_INCOME';
  if (/attributable to (?:the )?(?:owners|equity holders|shareholders)/i.test(text)) return 'PROFIT_ATTRIBUTABLE_TO_OWNERS';
  if (/\bdiluted\b/i.test(text) && series === 'EPS') return 'DILUTED_EPS';
  return DEFAULT_DEFINITION[series];
};

/**
 * pickByBasis - pure. From same-line facts for one period, the value to use
 * for a target whose basis is `targetBasis` (or null when unstated), or a
 * specific reason there is none. Latest filing first, so a restated figure
 * replaces the original.
 */
const pickByBasis = (facts, targetBasis) => {
  const byBasis = new Map();
  for (const f of facts) {
    const key = f.described.basis || 'UNSTATED';
    if (!byBasis.has(key)) byBasis.set(key, f); // facts arrive newest-first
  }
  if (targetBasis) {
    const hit = byBasis.get(targetBasis);
    return hit ? { fact: hit, note: `${targetBasis.toLowerCase()} basis, as the target states` } : { reason: `the target is stated on a ${targetBasis.toLowerCase()} basis but only ${[...byBasis.keys()].map((k) => k.toLowerCase()).join(' / ')} figures are on file` };
  }
  const consolidated = byBasis.get('CONSOLIDATED');
  const standalone = byBasis.get('STANDALONE');
  if (consolidated && standalone) {
    const a = consolidated.metrics.actualValue;
    const b = standalone.metrics.actualValue;
    const diff = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
    if (diff > BASIS_AMBIGUITY_TOLERANCE) {
      return { reason: `the target does not state a reporting basis, and the consolidated (${a}) and standalone (${b}) figures differ by ${(diff * 100).toFixed(1)}%, so the basis would decide the verdict` };
    }
    return { fact: consolidated, note: `target basis not stated; consolidated and standalone figures agree within ${BASIS_AMBIGUITY_TOLERANCE * 100}%` };
  }
  const only = consolidated || standalone;
  if (only) return { fact: only, note: `target basis not stated; the only ${only.described.basis.toLowerCase()} figure on file is used` };
  return { reason: 'the filed figure does not state whether it is consolidated or standalone' };
};

const factSentence = (f) => String(f.fact || '').replace(/\s+/g, ' ').trim();

/**
 * searchActualOutcomeFromHistoricalFacts - Tier (a). The verified actual for a
 * promise from the company's own exchange XBRL filings (CompanyHistoricalFact
 * rows whose source is an NSE/BSE XBRL document), matched like-for-like:
 *   - the SAME financial line (revenue from operations is never total income;
 *     profit for the period is never profit attributable to owners),
 *   - the SAME period granularity, fiscal year and quarter,
 *   - the SAME statement basis (an unstated-basis target is only scored when
 *     the basis cannot change the figure materially),
 *   - growth derived from two annual figures of the same line and basis.
 * Transcript-derived facts are never used as actuals (they mix up margin types
 * and units). Quarantined facts are excluded.
 *
 * Returns a match, or `{ unavailableReason }` saying exactly why there is no
 * comparable actual -- never a guessed value, never null for a supported
 * metric. Returns null only when the promise lacks a metric or period.
 */
export const searchActualOutcomeFromHistoricalFacts = async (profile, promise) => {
  if (!promise?.targetPeriod || !promise?.metric) return null;
  const metric = String(promise.metric).toUpperCase();
  const series = LEVEL_SERIES[metric] || GROWTH_SERIES[metric];
  if (!series) {
    return { unavailableReason: `no verified exchange-filed actual exists for ${metric.toLowerCase().replace(/_/g, ' ')} -- the XBRL results filings on file carry revenue, profit and EPS lines only` };
  }
  const target = describeTargetPeriod(promise.targetPeriod);
  if (!target || target.openEnded) return { unavailableReason: `the target period "${promise.targetPeriod}" has no fixed end date to compare against` };
  if (GROWTH_SERIES[metric] && target.granularity !== 'ANNUAL') {
    return { unavailableReason: `${target.granularity.toLowerCase()} growth guidance does not say whether it is quarter-on-quarter or year-on-year, so it is not derived` };
  }

  const facts = (await CompanyHistoricalFact.find({
    symbol: profile.symbol, dataOrigin: 'REAL_RESEARCH', 'metrics.metric': series, 'metrics.actualValue': { $ne: null }, 'quarantine.quarantined': { $ne: true },
  }).sort({ date: -1, updatedAt: -1 }).lean())
    .map((f) => ({ ...f, described: describeXbrlFact(f) }))
    .filter((f) => f.described.isXbrl);
  if (!facts.length) return { unavailableReason: `no exchange XBRL ${series.toLowerCase()} figures are on file for ${profile.symbol}` };

  const definition = statedTargetDefinition(promise, series);
  const targetBasis = statedTargetBasis(promise);
  const sameLine = facts.filter((f) => f.described.definition === definition);
  if (!sameLine.length) {
    const filed = [...new Set(facts.map((f) => f.described.definition).filter(Boolean))].map((d) => DEFINITION_WORDS[d] || d);
    return { unavailableReason: `the guidance is for ${DEFINITION_WORDS[definition] || definition}, but the company's filings report ${filed.join(' / ') || 'a different line'}; different lines are never compared` };
  }

  const at = (period) => sameLine.filter((f) => samePeriod(f.described.period, period));
  const source = (f) => ({ url: f.source?.url || null, date: f.source?.publishedAt || f.date });

  if (LEVEL_SERIES[metric]) {
    const pick = pickByBasis(at(target), targetBasis);
    if (!pick.fact) return { unavailableReason: pick.reason || `no filed ${DEFINITION_WORDS[definition]} figure for ${promise.targetPeriod}` };
    const f = pick.fact;
    const match = buildLocalMatch(promise, { actualValue: f.metrics.actualValue, unit: f.metrics.unit, period: f.period }, {
      title: `NSE XBRL results filing (${f.period})`, url: source(f).url, date: source(f).date, provider: 'nse-xbrl', confidence: 0.95,
    });
    if (!match) return { unavailableReason: `the filed figure is in ${f.metrics.unit}, which cannot be compared with a target in ${promise.targetUnit}` };
    return {
      ...match,
      actualPeriod: f.period,
      outcomeStatement: `${factSentence(f)} [${pick.note}]`,
      basis: { statementBasis: f.described.basis, metricDefinition: definition },
    };
  }

  // Growth: year-on-year from two annual figures of the same line and basis.
  const prior = describeTargetPeriod(`FY${target.fiscalYear - 1}`);
  const currentPick = pickByBasis(at(target), targetBasis);
  if (!currentPick.fact) return { unavailableReason: currentPick.reason || `no filed ${DEFINITION_WORDS[definition]} figure for FY${target.fiscalYear}` };
  const basis = currentPick.fact.described.basis;
  const priorPick = pickByBasis(at(prior).filter((f) => f.described.basis === basis), basis);
  if (!priorPick.fact) return { unavailableReason: `no filed ${basis ? basis.toLowerCase() : ''} ${DEFINITION_WORDS[definition]} figure for FY${target.fiscalYear - 1}, so year-on-year growth cannot be derived` };
  const cur = currentPick.fact.metrics.actualValue;
  const prev = priorPick.fact.metrics.actualValue;
  if (!(prev > 0)) return { unavailableReason: `the FY${target.fiscalYear - 1} figure (${prev}) is zero or negative, so a growth rate would be meaningless` };
  if (financialUnitFamily(promise.targetUnit) !== financialUnitFamily('PERCENTAGE')) {
    return { unavailableReason: `growth is a percentage, but the target is in ${promise.targetUnit}` };
  }
  const growth = Number((((cur - prev) / prev) * 100).toFixed(2));
  return {
    actualValue: growth,
    actualUnit: 'PERCENTAGE',
    actualPeriod: `FY${target.fiscalYear}`,
    outcomeStatement: `Year-on-year growth of ${growth}% derived from two exchange XBRL filings of the same line and basis: ${factSentence(currentPick.fact)} ${factSentence(priorPick.fact)} [${currentPick.note}; reported-currency (INR) growth]`,
    outcomeSource: `NSE XBRL results filings (FY${target.fiscalYear} vs FY${target.fiscalYear - 1})`,
    outcomeSourceUrl: source(currentPick.fact).url,
    outcomeSourceDate: source(currentPick.fact).date,
    evidenceType: 'DOCUMENT_EVIDENCE',
    provider: 'nse-xbrl',
    confidence: 0.95,
    basis: { statementBasis: basis, metricDefinition: definition, currencyBasis: 'REPORTED_CURRENCY' },
    derivedFrom: [source(currentPick.fact).url, source(priorPick.fact).url],
  };
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
  if (fromFacts && fromFacts.actualValue != null) return fromFacts;
  // For a line the exchange XBRL filings cover (revenue / profit / EPS and their growth), tier (a) is
  // authoritative: when it says there is no comparable figure (a different line, an ambiguous basis, a
  // missing prior year), a looser source must not supply one instead.
  const metric = String(promise?.metric || '').toUpperCase();
  if (fromFacts?.unavailableReason && (LEVEL_SERIES[metric] || GROWTH_SERIES[metric])) return fromFacts;

  const fromDocuments = await persistedDocumentsFn(profile, promise);
  if (fromDocuments) return fromDocuments;

  const fromIndianApi = await indianApiFn(profile, promise);
  return fromIndianApi || (fromFacts?.unavailableReason ? fromFacts : null);
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
