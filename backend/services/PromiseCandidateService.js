/**
 * PromiseCandidateService.js
 * ============================
 * Extends the EXISTING research pipeline to assist (never replace) manual
 * verification of Management Faith Score promises.
 *
 * Flow: collectDocuments (DocumentResearchService) -> filter to Tier 1/2
 * (official IR + NSE/BSE exchange sources only, never Tier 3/4 news) ->
 * extractPromisesFromSources (the existing LLM extraction stage in
 * ManagementPromiseService.js) -> for each extracted promise, look for a
 * deterministic outcome match via OutcomeEvidenceService's IndianAPI matcher
 * -> write a fully-schema-valid CANDIDATE record (reviewStatus:
 * 'PENDING_REVIEW') to data/earnings-intelligence/candidates/<SYMBOL>.json.
 *
 * A candidate is stored in MongoDB (models/PromiseCandidate.js), never as a
 * local file -- this project's backend deploys to Render, whose filesystem
 * is ephemeral, so anything an automated job wrote to a local JSON file
 * would be lost on the next restart/redeploy. It is never written to
 * promises/<SYMBOL>.json directly -- that only happens via the explicit
 * `npm run earnings:review -- --accept` CLI (scripts/earningsReview.js),
 * after re-running the SAME validateManagementPromiseRecord used everywhere
 * else in this dataset. A PENDING_REVIEW or REJECTED candidate is never
 * read by CuratedEarningsIntelligenceService, so it is structurally
 * invisible to every public API until explicitly accepted.
 *
 * No fabrication: a candidate whose evidence can't be traced to a real Tier
 * 1/2 document discovered in THIS run is discarded, not guessed. A candidate
 * with no matched outcome stays outcome.status:'PENDING' with actualValue
 * null -- never a guessed number.
 */

import { logger } from '../utils/logger.js';
import { collectDocuments } from '../research/DocumentResearchService.js';
import { getCompanyResearchProfile } from '../research/CompanyResearchProfiles.js';
import { extractPromisesFromSources, calculatePromiseStatus } from './ManagementPromiseService.js';
import { searchActualOutcomesLocalFirst } from './OutcomeEvidenceService.js';
import { validateCandidatePromiseRecord } from '../utils/earningsIntelligenceValidation.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import PromiseCandidate from '../models/PromiseCandidate.js';

// Only these two DocumentResearchService providers are official primary
// sources (company IR site, NSE/BSE exchange filings). Tier 3/4
// ("FinancialMediaAndHistoricalNews") is explicitly excluded here -- it may
// still support a curated record as secondary confirmation, but a candidate
// promise's PRIMARY evidence must come from Tier 1/2.
const TIER_1_2_PROVIDERS = new Set(['InvestorRelations', 'ExchangeFilings']);

export const filterTier1And2Documents = (documents = []) => documents.filter((doc) => TIER_1_2_PROVIDERS.has(doc?.provider));

// Legacy (ManagementPromise/extraction) enums -> curated schema enums.
// Unmapped legacy metrics fall back to 'OTHER' (a real, declared category),
// never a guessed specific one.
const CATEGORY_MAP = {
  REVENUE: 'REVENUE_GROWTH', REVENUE_GROWTH: 'REVENUE_GROWTH',
  EBITDA: 'MARGIN', EBITDA_MARGIN: 'MARGIN', MARGIN: 'MARGIN',
  PAT: 'PROFITABILITY', PAT_GROWTH: 'PROFITABILITY',
  ORDER_BOOK: 'ORDER_BOOK', ORDER_INTAKE: 'ORDER_BOOK', ARR: 'ORDER_BOOK', BOOKINGS: 'ORDER_BOOK',
  CAPEX: 'CAPEX',
  DEBT: 'DEBT_REDUCTION', DEBT_REDUCTION: 'DEBT_REDUCTION',
};
const mapCategory = (legacyMetric) => CATEGORY_MAP[String(legacyMetric || '').toUpperCase()] || 'OTHER';

const UNIT_MAP = { INR_CRORE: 'INR_CRORE', INR_LAKH: 'INR_LAKH', USD_MILLION: 'USD_MILLION', USD_BILLION: 'USD_BILLION', PERCENTAGE: 'PERCENT', COUNT: 'COUNT' };
const OPERATOR_MAP = { GTE: 'AT_LEAST', LTE: 'AT_MOST', EQ: 'EXACT', RANGE: 'RANGE' };
const STATUS_MAP = { FULFILLED: 'ACHIEVED', EXCEEDED: 'ACHIEVED', PARTIALLY_FULFILLED: 'PARTIAL', MISSED: 'MISSED', PENDING: 'PENDING', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE' };

// DocumentResearchService.DOCUMENT_TYPES -> curated EVIDENCE_SOURCE_TYPES.
// Tier 3/4-only types (FINANCIAL_PUBLICATION, MANAGEMENT_INTERVIEW,
// NEWS_ARTICLE) are intentionally absent -- they never reach here because
// filterTier1And2Documents already excluded that tier's documents.
const DOCUMENT_TYPE_TO_EVIDENCE_SOURCE_TYPE = {
  ANNUAL_REPORT: 'ANNUAL_REPORT',
  QUARTERLY_REPORT: 'FINANCIAL_RESULTS',
  INVESTOR_PRESENTATION: 'EARNINGS_PRESENTATION',
  EARNINGS_CALL_TRANSCRIPT: 'EARNINGS_TRANSCRIPT',
  EXCHANGE_FILING: 'EXCHANGE_FILING',
  PRESS_RELEASE: 'PRESS_RELEASE',
  INVESTOR_RELATIONS: 'EARNINGS_PRESENTATION',
};

const toIsoDateOnly = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const buildCandidateId = (symbol, targetPeriod, sequence) => (
  `${symbol}-${String(targetPeriod || 'UNK').replace(/[^A-Z0-9]/gi, '').toUpperCase()}-CAND-${String(sequence).padStart(3, '0')}`
);

/**
 * Builds one candidate record from one LLM-extracted promise, or returns
 * null when it cannot be backed by a real Tier 1/2 document from THIS run,
 * lacks a core required field, or fails schema validation. Never guesses a
 * missing field to make a candidate "pass".
 */
const buildCandidateRecord = async (symbol, profile, extracted, tier12Docs, sequence, { outcomeSearchFn }) => {
  const sourceDoc = tier12Docs.find((doc) => (doc.canonicalUrl || doc.url) === extracted.sourceUrl);
  if (!sourceDoc) {
    logger.debug(`[PromiseCandidateService] Discarding a candidate for ${symbol}: extracted sourceUrl does not match any Tier 1/2 document from this run.`);
    return null;
  }

  const promiseDate = toIsoDateOnly(extracted.promiseDate);
  const targetPeriod = extracted.targetPeriod ? String(extracted.targetPeriod) : null;
  if (!promiseDate || !targetPeriod || typeof extracted.targetValue !== 'number') {
    return null; // core fields required by the schema; never invented here
  }

  const targetUnit = UNIT_MAP[extracted.targetUnit] || null;
  const targetType = targetUnit === 'PERCENT' ? 'PERCENTAGE' : 'ABSOLUTE';
  const operator = OPERATOR_MAP[extracted.operator] || 'QUALITATIVE';
  const statement = extracted.exactManagementStatement || extracted.statement || null;
  if (!statement) return null;

  const evidenceSourceType = DOCUMENT_TYPE_TO_EVIDENCE_SOURCE_TYPE[sourceDoc.sourceType] || 'ANNUAL_REPORT';
  const promiseEvidence = {
    sourceTitle: sourceDoc.title || extracted.sourceDocument || 'Official company document',
    sourceType: evidenceSourceType,
    sourceUrl: sourceDoc.canonicalUrl || sourceDoc.url,
    publishedAt: toIsoDateOnly(sourceDoc.publishedAt || sourceDoc.sourceDate || sourceDoc.retrievedAt) || promiseDate,
    pageNumber: Number.isInteger(extracted.page) ? extracted.page : null,
    excerpt: String(extracted.sourceExcerpt || extracted.exactManagementStatement || '').slice(0, 2000) || statement,
  };

  // Default: unresolved until a matching outcome is deterministically found.
  // Never guessed -- the only two ways this changes below are a real
  // IndianAPI match or nothing at all.
  let outcome = { status: 'PENDING', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null };
  let outcomeEvidence = null;
  let evidenceConfidence = 0.5; // below any accepted record's typical 0.7+ -- unverified until human review

  try {
    const match = await outcomeSearchFn(profile, {
      metric: extracted.metric,
      targetPeriod,
      targetValue: extracted.targetValue,
      targetUnit: extracted.targetUnit,
    });

    if (match && match.actualValue != null && match.outcomeSourceUrl) {
      const verification = calculatePromiseStatus({
        targetValue: extracted.targetValue,
        actualValue: match.actualValue,
        operator: extracted.operator,
        direction: extracted.direction,
        metric: extracted.metric,
        targetPeriod,
        targetUnit: extracted.targetUnit,
        actualUnit: match.actualUnit,
      });

      const mappedStatus = STATUS_MAP[verification.status];
      if (mappedStatus && mappedStatus !== 'PENDING' && mappedStatus !== 'INSUFFICIENT_EVIDENCE') {
        outcome = {
          status: mappedStatus,
          actualValue: match.actualValue,
          actualUnit: targetUnit,
          evaluationDate: toIsoDateOnly(match.outcomeSourceDate) || promiseDate,
          explanation: verification.calculationExplanation || match.outcomeStatement || null,
        };
        outcomeEvidence = {
          sourceTitle: match.outcomeSource || 'IndianAPI company financials',
          sourceType: 'FINANCIAL_RESULTS',
          sourceUrl: match.outcomeSourceUrl,
          publishedAt: toIsoDateOnly(match.outcomeSourceDate) || outcome.evaluationDate,
          pageNumber: null,
          excerpt: (match.outcomeStatement || 'Matched via IndianAPI structured financial data.').slice(0, 2000),
        };
        evidenceConfidence = Math.min(0.75, typeof match.confidence === 'number' ? match.confidence : 0.75);
      }
    }
  } catch (err) {
    logger.warn(`[PromiseCandidateService] Outcome lookup failed for ${symbol}: ${err.message}`);
  }

  const record = {
    id: buildCandidateId(symbol, targetPeriod, sequence),
    symbol,
    dataMode: 'CURATED_VERIFIED',
    reviewStatus: 'PENDING_REVIEW',
    promise: {
      statement,
      originalExcerpt: extracted.sourceExcerpt || statement,
      category: mapCategory(extracted.metric),
      promiseDate,
      targetPeriod,
      targetType,
      targetValue: extracted.targetValue,
      targetUnit,
      operator,
    },
    outcome,
    promiseEvidence,
    outcomeEvidence,
    verification: {
      verifiedAt: new Date().toISOString().slice(0, 10),
      verifiedBy: 'AUTOMATED_CANDIDATE_GENERATOR',
      evidenceConfidence,
      notes: 'Automatically generated from official Tier 1/2 documents. Requires human review before promotion to the verified dataset (npm run earnings:review).',
    },
  };

  const { valid, errors } = validateCandidatePromiseRecord(record, { symbol, allowDemo: false });
  if (!valid) {
    logger.debug(`[PromiseCandidateService] Discarded an invalid candidate for ${symbol}: ${errors.join('; ')}`);
    return null;
  }
  return record;
};

/**
 * generateCandidatesForSymbol - the main entry point. Every dependency is
 * injectable so tests never touch the network/LLM/DB; production callers
 * (the CLI) use the real defaults.
 */
export const generateCandidatesForSymbol = async (symbol, {
  collectDocumentsFn = collectDocuments,
  extractPromisesFn = extractPromisesFromSources,
  outcomeSearchFn = searchActualOutcomesLocalFirst,
  getProfileFn = getCompanyResearchProfile,
} = {}) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  if (!normalized || !SUPPORTED_STOCKS[normalized]) {
    return { symbol: normalized, candidates: [], reason: `${normalized || symbol} is not a supported project stock.` };
  }

  const profile = getProfileFn(normalized, SUPPORTED_STOCKS[normalized]?.name, SUPPORTED_STOCKS[normalized]?.sector);
  const collected = await collectDocumentsFn(normalized);
  const tier12Docs = filterTier1And2Documents(collected?.documents || []);

  if (!tier12Docs.length) {
    return { symbol: normalized, candidates: [], reason: 'No official Tier 1 (investor relations) or Tier 2 (NSE/BSE exchange) documents were discovered for this company in this run.' };
  }

  const extracted = await extractPromisesFn(profile, tier12Docs);
  if (!extracted.length) {
    return { symbol: normalized, candidates: [], reason: 'Tier 1/2 documents were found, but no quantifiable management promise could be extracted from them.' };
  }

  const candidates = [];
  for (const item of extracted) {
    const record = await buildCandidateRecord(normalized, profile, item, tier12Docs, candidates.length + 1, { outcomeSearchFn });
    if (record) candidates.push(record);
  }

  return {
    symbol: normalized,
    candidates,
    reason: candidates.length ? null : 'Every extracted promise was discarded (no traceable Tier 1/2 source match, or failed schema validation) -- none written.',
  };
};

/**
 * saveCandidate - upserts one built candidate into MongoDB, keyed by the
 * business identity (symbol + targetPeriod + category + promiseEvidence
 * sourceUrl) rather than the run-local `id` field, so re-running generation
 * over the same source documents can never create a duplicate. A candidate
 * a human has already ACCEPTED or REJECTED is left untouched -- a later
 * generation run must never silently overwrite a human decision.
 */
export const saveCandidate = async (record) => {
  const filter = {
    symbol: record.symbol,
    'promise.targetPeriod': record.promise.targetPeriod,
    'promise.category': record.promise.category,
    'promiseEvidence.sourceUrl': record.promiseEvidence.sourceUrl,
  };

  const existing = await PromiseCandidate.findOne(filter).lean();
  if (existing && existing.reviewStatus !== 'PENDING_REVIEW') {
    return { action: 'SKIPPED_ALREADY_REVIEWED', id: existing.id, reviewStatus: existing.reviewStatus };
  }

  const update = {
    id: existing?.id || record.id, // keep the id stable across regenerations once first created
    symbol: record.symbol,
    dataMode: record.dataMode,
    promise: record.promise,
    outcome: record.outcome,
    promiseEvidence: record.promiseEvidence,
    outcomeEvidence: record.outcomeEvidence,
    verification: record.verification,
    reviewStatus: 'PENDING_REVIEW',
  };

  const saved = await PromiseCandidate.findOneAndUpdate(filter, update, { upsert: true, new: true }).lean();
  return { action: existing ? 'UPDATED' : 'INSERTED', id: saved.id };
};

/** Persists every candidate in `candidates` via saveCandidate; never throws for one bad record -- reports it and continues. */
export const saveCandidates = async (candidates = []) => {
  const results = [];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await saveCandidate(candidate);
      results.push({ ...result, symbol: candidate.symbol });
    } catch (err) {
      logger.warn(`[PromiseCandidateService] Failed to save candidate ${candidate.id} for ${candidate.symbol}: ${err.message}`);
      results.push({ action: 'FAILED', id: candidate.id, symbol: candidate.symbol, error: err.message });
    }
  }
  return results;
};

/** All candidates on file for a symbol (any reviewStatus) -- used by the review CLI. Never throws; returns [] if the DB is unavailable. */
export const listCandidatesForSymbol = async (symbol) => {
  try {
    return await PromiseCandidate.find({ symbol: String(symbol || '').toUpperCase() }).lean();
  } catch (err) {
    logger.warn(`[PromiseCandidateService] Failed to list candidates for ${symbol}: ${err.message}`);
    return [];
  }
};

export default {
  filterTier1And2Documents,
  generateCandidatesForSymbol,
  saveCandidate,
  saveCandidates,
  listCandidatesForSymbol,
};
