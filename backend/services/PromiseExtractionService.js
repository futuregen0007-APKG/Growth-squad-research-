/**
 * PromiseExtractionService.js
 * ==============================
 * Two extraction paths into the same models/PromiseCandidate.js shape:
 *
 * 1. `extractPromisesFromDocument` (Phase 5C, pre-existing) -- synchronous,
 *    deterministic, regex/keyword-based extraction over pre-parsed
 *    `{title, sourceUrl, pages}` documents. No OpenAI call, zero cost, used
 *    by the DocumentResearchService-sourced candidate path.
 *
 * 2. `extractPromisesFromPdfBuffer` (this session's addition) -- the
 *    PROMISE_EXTRACTION stage of the universe-scale pipeline:
 *      DOCUMENT_DISCOVERY -> FINANCIAL_FACT_EXTRACTION -> PROMISE_EXTRACTION
 *      -> OUTCOME_VERIFICATION -> FAITH_SCORE_RECALCULATION
 *    Runs an LLM pass (page-batched, like FactExtractionService) over a raw
 *    PDF buffer already downloaded by the automated
 *    backfillHistoricalFacts.js/backfillUniverse.js fact-extraction stage,
 *    for cases the deterministic regex above has low recall on (INFY/HDFCBANK-
 *    style transcripts). Same anti-hallucination contract as
 *    FactExtractionService: every candidate promise must cite a real page
 *    number whose actual text contains the claimed excerpt, and must use
 *    exactly one of ManagementPromise's own enum values for
 *    metric/targetUnit/operator -- anything else is dropped, never defaulted.
 */
import crypto from 'node:crypto';
import { openai } from './openaiClient.js';
import { getCache, setCache } from '../utils/redisClient.js';
import { logger } from '../utils/logger.js';
import { extractPdfPages, findRelevantPages } from './FactExtractionService.js';
import { Semaphore } from '../utils/semaphore.js';
import { calculatePromiseStatus } from './ManagementPromiseService.js';
import { searchActualOutcomesLocalFirst } from './OutcomeEvidenceService.js';
import { validateCandidatePromiseRecord } from '../utils/earningsIntelligenceValidation.js';

// ---------------------------------------------------------------------------
// Path 1 (Phase 5C, pre-existing, restored verbatim) -- deterministic,
// synchronous, regex-based extraction over pre-parsed page text.
// ---------------------------------------------------------------------------
const METRICS = new Set([
  'EMPLOYEE_PERCENTAGE', 'REVENUE', 'REVENUE_GROWTH', 'EBITDA', 'EBITDA_MARGIN', 'PAT',
  'ORDER_BOOK', 'NIM', 'CREDIT_GROWTH', 'DEPOSIT_GROWTH', 'CASA', 'OTHER_QUANTIFIABLE',
]);

const forwardLanguage = /\b(commit(?:s|ted)?|target(?:s|ed)?|expect(?:s|ed)?|plan(?:s|ned)?|intend(?:s|ed)?|aim(?:s|ed)?|guid(?:e|ance|ing)|forecast(?:s|ed)?)\b/i;
const historicalLanguage = /\b(grew|grown|increased|decreased|declined|reported|stood at|was|were|rose|fell)\b/i;
const numberPattern = '(\\d+(?:\\.\\d+)?)';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const metricFor = (statement) => {
  const lower = statement.toLowerCase();
  if (/employee\s+base|employees|workforce/.test(lower)) return 'EMPLOYEE_PERCENTAGE';
  if (/revenue growth|top[- ]line growth/.test(lower)) return 'REVENUE_GROWTH';
  if (/revenue|top[- ]line/.test(lower)) return 'REVENUE';
  if (/ebitda margin|operating margin/.test(lower)) return 'EBITDA_MARGIN';
  if (/ebitda/.test(lower)) return 'EBITDA';
  if (/pat|profit after tax|net profit/.test(lower)) return 'PAT';
  if (/order book|backlog/.test(lower)) return 'ORDER_BOOK';
  if (/nim|net interest margin/.test(lower)) return 'NIM';
  if (/credit growth/.test(lower)) return 'CREDIT_GROWTH';
  if (/deposit growth|deposits/.test(lower)) return 'DEPOSIT_GROWTH';
  if (/casa/.test(lower)) return 'CASA';
  return 'OTHER_QUANTIFIABLE';
};

const targetFrom = (statement) => {
  const atLeast = statement.match(new RegExp(`\\bat least\\s+${numberPattern}\\s*(%|percent|percentage)?`, 'i'));
  if (atLeast) return { value: Number(atLeast[1]), unit: atLeast[2] ? 'PERCENTAGE' : 'OTHER', direction: 'AT_LEAST' };
  const atMost = statement.match(new RegExp(`\\bat most\\s+${numberPattern}\\s*(%|percent|percentage)?`, 'i'));
  if (atMost) return { value: Number(atMost[1]), unit: atMost[2] ? 'PERCENTAGE' : 'OTHER', direction: 'AT_MOST' };
  const range = statement.match(new RegExp(`\\b${numberPattern}\\s*(%|percent|percentage)?\\s*(?:to|-)\\s*${numberPattern}\\s*(%|percent|percentage)?`, 'i'));
  if (range) return { value: Number(range[1]), upperValue: Number(range[3]), unit: range[2] || range[4] ? 'PERCENTAGE' : 'OTHER', direction: 'RANGE' };
  const percentage = statement.match(new RegExp(`${numberPattern}\\s*(%|percent|percentage)`, 'i'));
  if (percentage) return { value: Number(percentage[1]), unit: 'PERCENTAGE', direction: /growth|grow|increase|expand/i.test(statement) ? 'GROWTH' : 'EXACT' };
  return null;
};

const sourceFor = (document) => ({
  sourceDocument: document.title || document.sourceName || 'Source document',
  sourceUrl: document.sourceUrl || document.url || document.canonicalUrl || null,
  page: document.page ?? document.pageNumber ?? null,
  sourceDate: document.sourceDate || document.publishedAt || null,
});

export const extractPromisesFromDocument = (document = {}) => {
  const source = sourceFor(document);
  if (!source.sourceUrl) return [];
  const pages = Array.isArray(document.pages) && document.pages.length
    ? document.pages
    : [{ pageNumber: source.page, text: document.fullText || document.text || document.excerpt || '' }];
  const promises = [];

  for (const page of pages) {
    const text = clean(page.text || page.content);
    if (!text) continue;
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const statement = clean(sentence);
      if (!forwardLanguage.test(statement) || historicalLanguage.test(statement)) continue;
      const target = targetFrom(statement);
      if (!target) continue;
      const metric = metricFor(statement);
      if (!METRICS.has(metric)) continue;
      promises.push({
        statement,
        metric,
        targetValue: target.value,
        ...(target.upperValue == null ? {} : { targetUpperValue: target.upperValue }),
        targetUnit: target.unit,
        direction: target.direction,
        period: /going forward|new operating model/.test(statement.toLowerCase()) ? 'GOING_FORWARD' : null,
        confidence: 0.9,
        evidence: {
          ...source,
          page: page.pageNumber ?? source.page,
          excerpt: statement,
        },
      });
    }
  }
  return promises;
};

// ---------------------------------------------------------------------------
// Path 2 (this session) -- LLM-based extraction over a raw PDF buffer, for
// the universe-scale automated backfill pipeline (scripts/backfillPromises.js).
// ---------------------------------------------------------------------------
const PROMPT_VERSION = 'promise-extraction-v1';
const OPENAI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const PAGES_PER_OPENAI_CALL = 5;

// Only earnings-call transcripts and financial-results filings realistically
// contain forward-looking management guidance -- annual reports/investor
// presentations are not sent to this stage (mirrors the fact-extraction
// stage's own default document-type scope).
export const PROMISE_ELIGIBLE_SOURCE_TYPES = new Set(['EARNINGS_CALL_TRANSCRIPT', 'FINANCIAL_RESULTS']);

const VALID_METRICS = new Set([
  'REVENUE', 'REVENUE_GROWTH', 'EBITDA', 'EBITDA_MARGIN', 'PAT', 'PAT_GROWTH',
  'ORDER_BOOK', 'ORDER_INTAKE', 'ARR', 'BOOKINGS', 'CAPEX', 'DEBT', 'DEBT_REDUCTION',
  'MARGIN', 'MARKET_SHARE', 'CUSTOMER_COUNT', 'EMPLOYEE_COUNT', 'EMPLOYEE_PERCENTAGE', 'FREE_CASH_FLOW',
  'LARGE_DEALS', 'EXPORT_REVENUE', 'NIM', 'CREDIT_GROWTH', 'DEPOSIT_GROWTH', 'CASA',
  'OTHER_QUANTIFIABLE', 'OTHER',
]);
const VALID_UNITS = new Set(['INR_CRORE', 'INR_LAKH', 'USD_MILLION', 'USD_BILLION', 'PERCENTAGE', 'COUNT', 'OTHER']);
const VALID_OPERATORS = new Set(['GTE', 'LTE', 'EQ', 'RANGE']);

let openaiSemaphore = new Semaphore(1);
export const configurePromiseExtractionConcurrency = (n) => { if (n) openaiSemaphore = new Semaphore(n); };

const hashBatchForCache = (pages, context) => crypto.createHash('sha256')
  .update(`${PROMPT_VERSION}:${context.symbol}:${context.url}:${pages.map((p) => p.pageNumber).join(',')}:${pages.map((p) => p.text).join('|')}`)
  .digest('hex');

const buildPrompt = (pages, context) => `You are extracting VERIFIABLE, QUANTIFIABLE management promises (forward-looking targets/guidance with a real number and a real future period) from pages of a real, official primary-source document (${context.sourceType}) for ${context.companyName} (${context.symbol}).

Extract ONLY a promise that states a specific numeric target for a specific FUTURE period, using genuinely forward-looking language ("we expect", "our guidance is", "we target", "we plan to", "we will"). Do NOT extract:
- vague aspirations without a number, or qualitative-only commentary
- a statement describing something ALREADY delivered/achieved/signed/recruited/completed in the past or current-quarter tense ("we delivered", "we signed", "we did", "we recruited", "we achieved") -- that is a historical RESULT, not a promise, even if it contains a number
Never invent a number or period. If nothing qualifies on a page, do not include it.

targetPeriod MUST use a full 4-digit fiscal year, never a 2-digit abbreviation: "FY2027" (not "FY27"), "Q1 FY2027" (not "Q1 FY27").

Return strictly valid JSON:
{
  "promises": [
    {
      "pageNumber": <exact integer from the "=== PAGE N ===" marker>,
      "statement": "the promise in one sentence",
      "metric": "REVENUE|REVENUE_GROWTH|EBITDA|EBITDA_MARGIN|PAT|PAT_GROWTH|ORDER_BOOK|ORDER_INTAKE|ARR|BOOKINGS|CAPEX|DEBT|DEBT_REDUCTION|MARGIN|MARKET_SHARE|CUSTOMER_COUNT|EMPLOYEE_COUNT|EMPLOYEE_PERCENTAGE|FREE_CASH_FLOW|LARGE_DEALS|EXPORT_REVENUE|NIM|CREDIT_GROWTH|DEPOSIT_GROWTH|CASA|OTHER_QUANTIFIABLE|OTHER",
      "targetValue": number,
      "targetUnit": "INR_CRORE|INR_LAKH|USD_MILLION|USD_BILLION|PERCENTAGE|COUNT|OTHER",
      "targetPeriod": "full 4-digit fiscal year, e.g. FY2027 or Q1 FY2027 -- never FY27",
      "operator": "GTE|LTE|EQ|RANGE",
      "excerpt": "the EXACT sentence from that page supporting this promise"
    }
  ]
}

${pages.map((p) => `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 4000)}`).join('\n\n')}`;

// Deterministic safety net -- never trust the LLM alone to follow the
// 4-digit-year instruction. Converts "FY27"/"Q1 FY27" (2-digit) into
// "FY2027"/"Q1 FY2027" so the same real guidance is never counted twice
// under two different period spellings. Assumes 20xx (valid through 2099).
const normalizeTargetPeriod = (period) => String(period || '').trim()
  .replace(/FY\s*'?(\d{2})\b/gi, (_, yy) => `FY20${yy}`);

const extractPromisesFromPageBatch = async (pages, context) => {
  const cacheKey = `promiseextract:${hashBatchForCache(pages, context)}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  if (!openai || !process.env.OPENAI_API_KEY) {
    logger.warn('[PromiseExtractionService] OpenAI not configured -- skipping promise extraction for this batch.');
    return [];
  }

  const pageTextByNumber = new Map(pages.map((p) => [p.pageNumber, p.text]));

  try {
    const response = await openaiSemaphore.run(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: buildPrompt(pages, context) }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }, { timeout: 60000 }));
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const raw = Array.isArray(parsed.promises) ? parsed.promises : [];

    const validated = raw.filter((p) => (
      p.excerpt
      && Number.isInteger(p.pageNumber) && pageTextByNumber.has(p.pageNumber) && pageTextByNumber.get(p.pageNumber).includes(p.excerpt.slice(0, 40))
      && VALID_METRICS.has(String(p.metric || '').toUpperCase())
      && VALID_UNITS.has(String(p.targetUnit || '').toUpperCase())
      && VALID_OPERATORS.has(String(p.operator || '').toUpperCase())
      && Number.isFinite(p.targetValue)
      && p.targetPeriod
    )).map((p) => ({
      pageNumber: p.pageNumber,
      statement: p.statement,
      metric: String(p.metric).toUpperCase(),
      targetValue: p.targetValue,
      targetUnit: String(p.targetUnit).toUpperCase(),
      targetPeriod: normalizeTargetPeriod(p.targetPeriod),
      operator: String(p.operator).toUpperCase(),
      excerpt: p.excerpt,
    }));

    await setCache(cacheKey, validated, OPENAI_CACHE_TTL_SECONDS);
    return validated;
  } catch (error) {
    logger.warn(`[PromiseExtractionService] Extraction failed for ${context.symbol} (pages ${pages.map((p) => p.pageNumber).join(',')}): ${error.message}`);
    return [];
  }
};

/**
 * Full per-document promise-extraction pass over an already-downloaded PDF
 * buffer. Returns [] immediately for a document type that is not a realistic
 * guidance source (rule: never send an annual report/investor deck to this
 * stage by default).
 */
export const extractPromisesFromPdfBuffer = async (buffer, context) => {
  if (!PROMISE_ELIGIBLE_SOURCE_TYPES.has(context.sourceType)) return [];

  const pages = await extractPdfPages(buffer);
  const relevantPages = findRelevantPages(pages);
  const promises = [];

  for (let i = 0; i < relevantPages.length; i += PAGES_PER_OPENAI_CALL) {
    const batch = relevantPages.slice(i, i + PAGES_PER_OPENAI_CALL);
    if (!batch.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const batchPromises = await extractPromisesFromPageBatch(batch, context);
    promises.push(...batchPromises);
  }

  // Dedup near-identical promises within this one document (same metric+period+page).
  const seen = new Set();
  return promises.filter((p) => {
    const key = `${p.metric}:${p.targetPeriod}:${p.pageNumber}:${Math.round(p.targetValue * 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Curated-schema (models/PromiseCandidate.js) enum mappings -- same fixed
// lookup tables PromiseCandidateService.js uses for its own (DocumentResearchService-
// sourced) candidates, duplicated here rather than imported since that
// module doesn't export them and they are small, schema-fixed constants,
// not business logic that could drift between the two extraction paths.
const CATEGORY_MAP = {
  REVENUE: 'REVENUE_GROWTH', REVENUE_GROWTH: 'REVENUE_GROWTH',
  EBITDA: 'MARGIN', EBITDA_MARGIN: 'MARGIN', MARGIN: 'MARGIN',
  PAT: 'PROFITABILITY', PAT_GROWTH: 'PROFITABILITY',
  ORDER_BOOK: 'ORDER_BOOK', ORDER_INTAKE: 'ORDER_BOOK', ARR: 'ORDER_BOOK', BOOKINGS: 'ORDER_BOOK',
  CAPEX: 'CAPEX',
  DEBT: 'DEBT_REDUCTION', DEBT_REDUCTION: 'DEBT_REDUCTION',
};
const mapCategory = (metric) => CATEGORY_MAP[String(metric || '').toUpperCase()] || 'OTHER';
const CANDIDATE_UNIT_MAP = { INR_CRORE: 'INR_CRORE', INR_LAKH: 'INR_LAKH', USD_MILLION: 'USD_MILLION', USD_BILLION: 'USD_BILLION', PERCENTAGE: 'PERCENT', COUNT: 'COUNT', OTHER: 'OTHER' };
const CANDIDATE_OPERATOR_MAP = { GTE: 'AT_LEAST', LTE: 'AT_MOST', EQ: 'EXACT', RANGE: 'RANGE' };
const CANDIDATE_STATUS_MAP = { FULFILLED: 'ACHIEVED', EXCEEDED: 'ACHIEVED', PARTIALLY_FULFILLED: 'PARTIAL', MISSED: 'MISSED', PENDING: 'PENDING', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE' };

const toIsoDateOnly = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const buildCandidateId = (symbol, targetPeriod, sequence) => (
  `${symbol}-${String(targetPeriod || 'UNK').replace(/[^A-Z0-9]/gi, '').toUpperCase()}-CAND-${String(sequence).padStart(3, '0')}`
);

/**
 * Turns one validated extracted-promise (from extractPromisesFromPdfBuffer)
 * plus its OWN source document context into a fully schema-valid
 * models/PromiseCandidate.js record, running the SAME deterministic
 * IndianAPI outcome matcher used by the DocumentResearchService-sourced
 * PromiseCandidateService pipeline (OUTCOME_VERIFICATION stage). Returns
 * null only when a required schema field cannot be derived -- never guesses.
 */
export const buildPromiseCandidate = async (extracted, context, sequence, { outcomeSearchFn = searchActualOutcomesLocalFirst } = {}) => {
  const promiseDate = toIsoDateOnly(context.publicationDate);
  if (!promiseDate) return null;

  const targetUnit = CANDIDATE_UNIT_MAP[extracted.targetUnit] || null;
  if (!targetUnit) return null;
  const targetType = targetUnit === 'PERCENT' ? 'PERCENTAGE' : 'ABSOLUTE';
  const operator = CANDIDATE_OPERATOR_MAP[extracted.operator] || 'QUALITATIVE';

  let outcome = { status: 'PENDING', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null };
  let outcomeEvidence = null;
  let evidenceConfidence = 0.5;

  try {
    const match = await outcomeSearchFn(context.profile, {
      metric: extracted.metric, targetPeriod: extracted.targetPeriod, targetValue: extracted.targetValue, targetUnit: extracted.targetUnit,
    });
    if (match && match.actualValue != null && match.outcomeSourceUrl) {
      const verification = calculatePromiseStatus({
        targetValue: extracted.targetValue, actualValue: match.actualValue, operator: extracted.operator,
        metric: extracted.metric, targetPeriod: extracted.targetPeriod, targetUnit: extracted.targetUnit, actualUnit: match.actualUnit,
      });
      const mappedStatus = CANDIDATE_STATUS_MAP[verification.status];
      if (mappedStatus && mappedStatus !== 'PENDING' && mappedStatus !== 'INSUFFICIENT_EVIDENCE') {
        outcome = {
          status: mappedStatus, actualValue: match.actualValue, actualUnit: targetUnit,
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
    logger.warn(`[PromiseExtractionService] Outcome lookup failed for ${context.symbol}: ${err.message}`);
  }

  const record = {
    id: buildCandidateId(context.symbol, extracted.targetPeriod, sequence),
    symbol: context.symbol,
    dataMode: 'CURATED_VERIFIED',
    reviewStatus: 'PENDING_REVIEW',
    promise: {
      statement: extracted.statement,
      originalExcerpt: extracted.excerpt,
      category: mapCategory(extracted.metric),
      promiseDate,
      targetPeriod: extracted.targetPeriod,
      targetType,
      targetValue: extracted.targetValue,
      targetUnit,
      operator,
    },
    outcome,
    promiseEvidence: {
      sourceTitle: context.title || 'Official BSE/NSE exchange filing',
      sourceType: context.sourceType === 'EARNINGS_CALL_TRANSCRIPT' ? 'EARNINGS_TRANSCRIPT' : 'FINANCIAL_RESULTS',
      sourceUrl: context.url,
      publishedAt: promiseDate,
      pageNumber: extracted.pageNumber,
      excerpt: extracted.excerpt,
    },
    outcomeEvidence,
    verification: {
      verifiedAt: new Date().toISOString().slice(0, 10),
      verifiedBy: 'AUTOMATED_CANDIDATE_GENERATOR',
      evidenceConfidence,
      notes: 'Automatically generated by PromiseExtractionService from an already-downloaded, real BSE/NSE exchange filing. Requires human review before promotion (npm run earnings:review).',
    },
  };

  const { valid, errors } = validateCandidatePromiseRecord(record, { symbol: context.symbol, allowDemo: false });
  if (!valid) {
    logger.debug(`[PromiseExtractionService] Discarding an invalid candidate for ${context.symbol} ${extracted.targetPeriod}: ${errors.join('; ')}`);
    return null;
  }
  return record;
};

export default {
  extractPromisesFromDocument,
  extractPromisesFromPdfBuffer,
  configurePromiseExtractionConcurrency,
  PROMISE_ELIGIBLE_SOURCE_TYPES,
  buildPromiseCandidate,
};
