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
import mongoose from 'mongoose';
import { openai } from './openaiClient.js';
import { getCache, setCache } from '../utils/redisClient.js';
import { logger } from '../utils/logger.js';
import { extractPdfPages } from './FactExtractionService.js';
import { Semaphore } from '../utils/semaphore.js';
import { calculatePromiseStatus } from './ManagementPromiseService.js';
import { searchActualOutcomesLocalFirst } from './OutcomeEvidenceService.js';
import {
  validateCandidatePromiseRecord, PROMISE_DOCUMENT_TYPES, PROMISE_EVIDENCE_SOURCE_TYPE,
} from '../utils/earningsIntelligenceValidation.js';
import { EXTRACTABLE_METRICS } from '../utils/promiseMetrics.js';
import { toCandidateOutcomeStatus } from '../utils/promiseOutcome.js';

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
// v2: precise metric vocabulary (no catch-all "margin" or level/growth mix-ups),
// a range's upper bound, who said it, company vs segment scope, stated
// reporting / currency basis -- plus deterministic checks below that the model
// output must pass before it can become a candidate.
export const PROMPT_VERSION = 'promise-extraction-v2';
export const EXTRACTION_VERSION = 'v2';
const OPENAI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const PAGES_PER_OPENAI_CALL = 5;

// Earnings-call transcripts, financial-results filings and investor / analyst
// presentations filed with the exchange -- the documents where management
// states forward guidance. One shared list (utils/earningsIntelligenceValidation.js).
export const PROMISE_ELIGIBLE_SOURCE_TYPES = new Set(PROMISE_DOCUMENT_TYPES);

const VALID_METRICS = new Set(EXTRACTABLE_METRICS);
const VALID_UNITS = new Set(['INR_CRORE', 'INR_LAKH', 'USD_MILLION', 'USD_BILLION', 'PERCENTAGE', 'COUNT', 'OTHER']);
const VALID_OPERATORS = new Set(['GTE', 'LTE', 'EQ', 'RANGE']);
const VALID_SPEAKERS = new Set(['MANAGEMENT', 'ANALYST', 'MODERATOR', 'UNKNOWN']);
const VALID_REPORTING_BASIS = new Set(['CONSOLIDATED', 'STANDALONE', 'UNSTATED']);
const VALID_CURRENCY_BASIS = new Set(['CONSTANT_CURRENCY', 'REPORTED_CURRENCY', 'UNSTATED']);

const normalizeText = (value) => String(value || '')
  .replace(/[‘’′]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** excerptOnPage - pure. The WHOLE excerpt (whitespace/quote-normalised) appears in that page's real text. */
export const excerptOnPage = (excerpt, pageText) => {
  const needle = normalizeText(excerpt);
  return needle.length >= 12 && normalizeText(pageText).includes(needle);
};

/**
 * numberInText - pure. `value` appears in `text` as a written number
 * ("1,500", "1500", "15.5", "15.50", "₹28,000"). Guards against a value the
 * model inferred or computed rather than read (e.g. a midpoint of "14%-16%"
 * stored as 15, or a figure absent from the excerpt altogether).
 */
export const numberInText = (value, text) => {
  if (!Number.isFinite(value)) return false;
  const tokens = String(text || '').replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) || [];
  return tokens.some((t) => Math.abs(Number(t) - value) < 1e-9);
};

let openaiSemaphore = new Semaphore(1);
export const configurePromiseExtractionConcurrency = (n) => { if (n) openaiSemaphore = new Semaphore(n); };

const hashBatchForCache = (pages, context) => crypto.createHash('sha256')
  .update(`${PROMPT_VERSION}:${context.symbol}:${context.url}:${pages.map((p) => p.pageNumber).join(',')}:${pages.map((p) => p.text).join('|')}`)
  .digest('hex');

const buildPrompt = (pages, context) => `You are extracting VERIFIABLE, QUANTIFIABLE management guidance (forward-looking targets with a real number and a real future period) from pages of an official exchange filing (${context.sourceType}) for ${context.companyName} (${context.symbol}), published ${context.publicationDate ? new Date(context.publicationDate).toISOString().slice(0, 10) : 'on an unknown date'}. Indian fiscal years run April-March: FY2027 = April 2026 to March 2027.

Extract ONLY a target that a member of ${context.companyName}'s MANAGEMENT states, for a specific FUTURE period, with a specific number, in forward-looking language ("we expect", "our guidance is", "we target", "we plan to", "we will"). Do NOT extract:
- anything an analyst, investor or moderator says, even if management does not contradict it
- a question
- vague aspirations without a number, qualitative commentary, or a number that is only an example or a hypothetical ("if we assume ...")
- a historical RESULT in past or current-period tense ("we delivered", "we signed", "we achieved", "stood at", "for the quarter we did"), even with a number
- an economy-wide, industry-wide or market-wide forecast (GDP growth, industry capacity, sector demand) -- only the company's OWN figures
- a number you would have to compute, average or convert: targetValue (and targetValueMax) must be written in the excerpt exactly as you return them
- a multi-year CAGR or a cumulative amount over several years as if it were one year's target (only extract it if the speaker names the single fiscal year it applies to)
- a production, delivery or shipment count recorded as an order metric (orders are contracts won, not units built)
Never invent a number, period or metric. If nothing qualifies on a page, return nothing for it.

Metric -- pick the most precise; never use a level for a growth rate or the reverse:
- REVENUE = an absolute revenue amount; REVENUE_GROWTH = a % growth rate of revenue / top line / sales
- PAT = an absolute profit amount; PAT_GROWTH = a % growth rate of profit; PAT_MARGIN = net profit as % of revenue
- EBITDA = an absolute amount; EBITDA_MARGIN; EBIT_MARGIN (also "operating margin" when it means EBIT); GROSS_MARGIN; MARGIN only when the speaker does not say which margin
- banks/NBFCs/insurers: CREDIT_GROWTH (loans/advances/credit), DEPOSIT_GROWTH, NIM, CASA, GNPA, NNPA, CREDIT_COST, COST_TO_INCOME, ROA, ROE, AUM_GROWTH, PREMIUM_GROWTH, VNB_MARGIN
- others: ORDER_BOOK (backlog), ORDER_INTAKE (new orders / inflow), BOOKINGS (TCV), LARGE_DEALS, ARR, CAPEX, CAPACITY, VOLUME, DEBT (gross), NET_DEBT, FREE_CASH_FLOW, OPERATING_CASH_FLOW, WORKING_CAPITAL_DAYS, ROCE, TAX_RATE, DIVIDEND_PAYOUT, ATTRITION, EMPLOYEE_COUNT, CUSTOMER_COUNT, MARKET_SHARE, EXPORT_REVENUE, EPS
- OTHER_QUANTIFIABLE only if none of these fits

targetPeriod MUST use a full 4-digit fiscal year: "FY2027", "Q1 FY2027", "H1 FY2027" (never "FY27"). Use the period the speaker names; resolve "this year"/"next year" only against the publication date above.
operator: GTE for "at least / over / minimum", LTE for "at most / below / maximum / up to", RANGE for "X to Y" (then targetValue = X and targetValueMax = Y), EQ for a single point ("about", "around", "of").
scope: COMPANY when the target covers the whole company; SEGMENT when it covers one business, product, geography or subsidiary (name it in "segment").

Return strictly valid JSON:
{
  "promises": [
    {
      "pageNumber": <exact integer from the "=== PAGE N ===" marker>,
      "statement": "the target in one sentence",
      "speaker": "MANAGEMENT|ANALYST|MODERATOR|UNKNOWN",
      "metric": "one key from the list above",
      "targetValue": number,
      "targetValueMax": number or null,
      "targetUnit": "INR_CRORE|INR_LAKH|USD_MILLION|USD_BILLION|PERCENTAGE|COUNT|OTHER",
      "targetPeriod": "FY2027 / Q1 FY2027 / H1 FY2027",
      "operator": "GTE|LTE|EQ|RANGE",
      "scope": "COMPANY|SEGMENT",
      "segment": "segment name or null",
      "reportingBasis": "CONSOLIDATED|STANDALONE|UNSTATED",
      "currencyBasis": "CONSTANT_CURRENCY|REPORTED_CURRENCY|UNSTATED",
      "excerpt": "the EXACT sentence(s) from that page, copied verbatim, that state this target"
    }
  ]
}

${pages.map((p) => `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 4000)}`).join('\n\n')}`;

// Pages worth sending to the model for guidance. Broader than the fact stage's filter
// (FactExtractionService.findRelevantPages), which has no words for growth, capex, loans, deposits or
// forward-looking language -- so bank and capex guidance pages were never read. Still a filter: a
// page with none of these words (a cover, a disclaimer, a list of attendees) is not sent.
// A page is sent only when it has BOTH forward-looking language and a business measure: a results-only
// slide ("Revenue grew 12% in FY26") or a cover / disclaimer page carries no guidance and is skipped.
const FORWARD_LOOKING_WORDS = /guidance|\bguide[ds]?\b|outlook|target|aspir|comfort range|expect|anticipat|we will|we would|should be|going forward|next (year|fiscal|quarter)|this (year|fiscal)|coming (year|quarter)|plan(ning)? to|aim(ing)? to|confident of|looking at|estimate[sd]? (at|to)/i;
const MEASURE_WORDS = /growth|margin|revenue|top ?line|profit|ebitda|capex|capital expenditure|order (book|inflow|intake)|tcv|deal|attrition|hiring|loan|advances|credit|deposit|\bnim\b|casa|npa|cost[- ]to[- ]income|aum|premium|volume|capacity|market share|debt|crore|%/i;
export const findGuidancePages = (pages) => pages.filter((p) => p.text.length > 100 && FORWARD_LOOKING_WORDS.test(p.text) && MEASURE_WORDS.test(p.text));

/**
 * acceptExtractedPromise - pure. The deterministic gate every model-proposed
 * promise must pass before it becomes a candidate. Returns { ok, reason }.
 * The model's own flags are only trusted to EXCLUDE (an analyst / segment /
 * hypothetical is dropped); nothing it says can make a promise pass a check
 * that the real page text does not support.
 */
export const acceptExtractedPromise = (p, pageText) => {
  const upper = (v) => String(v || '').toUpperCase();
  if (!p?.excerpt) return { ok: false, reason: 'no excerpt' };
  if (!excerptOnPage(p.excerpt, pageText)) return { ok: false, reason: 'excerpt not found verbatim on the cited page' };
  if (/\?/.test(p.excerpt)) return { ok: false, reason: 'excerpt is a question' };
  if (upper(p.speaker) !== 'MANAGEMENT') return { ok: false, reason: `speaker is ${upper(p.speaker) || 'not stated'}, not management` };
  if (!VALID_METRICS.has(upper(p.metric))) return { ok: false, reason: `metric ${p.metric} is not a recognised metric` };
  if (!VALID_UNITS.has(upper(p.targetUnit))) return { ok: false, reason: `unit ${p.targetUnit} is not recognised` };
  if (!VALID_OPERATORS.has(upper(p.operator))) return { ok: false, reason: `operator ${p.operator} is not recognised` };
  if (!Number.isFinite(p.targetValue)) return { ok: false, reason: 'no numeric target' };
  if (!numberInText(p.targetValue, p.excerpt)) return { ok: false, reason: `target value ${p.targetValue} is not written in the excerpt` };
  if (upper(p.operator) === 'RANGE') {
    if (!Number.isFinite(p.targetValueMax) || p.targetValueMax < p.targetValue) return { ok: false, reason: 'range target without a valid upper bound' };
    if (!numberInText(p.targetValueMax, p.excerpt)) return { ok: false, reason: `range upper bound ${p.targetValueMax} is not written in the excerpt` };
  }
  if (!p.targetPeriod) return { ok: false, reason: 'no target period' };
  return { ok: true, reason: null };
};

// Deterministic safety net -- never trust the LLM alone to follow the
// 4-digit-year instruction. Converts "FY27"/"Q1 FY27" (2-digit) into
// "FY2027"/"Q1 FY2027" so the same real guidance is never counted twice
// under two different period spellings. Assumes 20xx (valid through 2099).
const normalizeTargetPeriod = (period) => String(period || '').trim()
  .replace(/FY\s*'?(\d{2})\b/gi, (_, yy) => `FY20${yy}`);

/**
 * PromiseExtractionFailure - the extraction could not be carried out (no model,
 * an API/parse error, an unreadable PDF). It is thrown, never returned as an
 * empty list, because an empty list means "the document was read and holds no
 * qualifying guidance": a caller that recorded a failure as that would present
 * an outage as a finding.
 */
export class PromiseExtractionFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromiseExtractionFailure';
  }
}

// A transcript or results filing with less text than this has no usable text layer (a scan or an empty file).
const MIN_DOCUMENT_TEXT_CHARS = 200;

// Durable checkpoint of each page-batch's validated result, so an interrupted or retried run never pays
// for the same pages twice. Redis (when reachable) is the fast path; this Mongo collection is the one a
// batch job can always reach. Keyed by the same content hash (prompt version, document, page text), so a
// changed prompt or document is never served a stale answer. Holds model output only -- never financial
// statement data -- and expires with a TTL index.
export const EXTRACTION_CHECKPOINT_COLLECTION = 'promiseextractioncheckpoints';
const CHECKPOINT_TTL_SECONDS = OPENAI_CACHE_TTL_SECONDS;
let checkpointIndexEnsured = false;
const checkpointCollection = () => (mongoose.connection.readyState === 1 ? mongoose.connection.db.collection(EXTRACTION_CHECKPOINT_COLLECTION) : null);
const readCheckpoint = async (key) => {
  const col = checkpointCollection();
  if (!col) return null;
  try { return (await col.findOne({ _id: key }))?.result ?? null; } catch { return null; }
};
const writeCheckpoint = async (key, result) => {
  const col = checkpointCollection();
  if (!col) return;
  try {
    if (!checkpointIndexEnsured) { await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: CHECKPOINT_TTL_SECONDS, name: 'checkpoint_ttl' }); checkpointIndexEnsured = true; }
    await col.updateOne({ _id: key }, { $set: { result, createdAt: new Date() } }, { upsert: true });
  } catch { /* a checkpoint that cannot be written only costs a re-read later */ }
};

const extractPromisesFromPageBatch = async (pages, context) => {
  const cacheKey = `promiseextract:${hashBatchForCache(pages, context)}`;
  const cached = (await getCache(cacheKey)) ?? (await readCheckpoint(cacheKey));
  if (cached) return cached;

  if (!openai || !process.env.OPENAI_API_KEY) {
    throw new PromiseExtractionFailure('OpenAI is not configured, so promise extraction could not run');
  }

  const pageTextByNumber = new Map(pages.map((p) => [p.pageNumber, p.text]));

  try {
    const response = await openaiSemaphore.run(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: buildPrompt(pages, context) }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      // 429 (tokens-per-minute) is retried with the SDK's backoff, which honours retry-after, instead of
      // failing the whole document; a rejected request is not billed.
    }, { timeout: 60000, maxRetries: 8 }));
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const raw = Array.isArray(parsed.promises) ? parsed.promises : [];

    const validated = raw.filter((p) => (
      Number.isInteger(p.pageNumber) && pageTextByNumber.has(p.pageNumber)
      && acceptExtractedPromise(p, pageTextByNumber.get(p.pageNumber)).ok
    )).map((p) => {
      const upper = (v) => String(v || '').toUpperCase();
      const scope = upper(p.scope) === 'SEGMENT' ? 'SEGMENT' : 'COMPANY';
      return {
        pageNumber: p.pageNumber,
        statement: p.statement,
        metric: upper(p.metric),
        targetValue: p.targetValue,
        targetValueMax: upper(p.operator) === 'RANGE' ? p.targetValueMax : null,
        targetUnit: upper(p.targetUnit),
        targetPeriod: normalizeTargetPeriod(p.targetPeriod),
        operator: upper(p.operator),
        speaker: VALID_SPEAKERS.has(upper(p.speaker)) ? upper(p.speaker) : 'UNKNOWN',
        scope,
        segment: scope === 'SEGMENT' && p.segment ? String(p.segment).slice(0, 120) : null,
        reportingBasis: VALID_REPORTING_BASIS.has(upper(p.reportingBasis)) ? upper(p.reportingBasis) : 'UNSTATED',
        currencyBasis: VALID_CURRENCY_BASIS.has(upper(p.currencyBasis)) ? upper(p.currencyBasis) : 'UNSTATED',
        excerpt: p.excerpt,
      };
    });

    await setCache(cacheKey, validated, OPENAI_CACHE_TTL_SECONDS);
    await writeCheckpoint(cacheKey, validated);
    return validated;
  } catch (error) {
    logger.warn(`[PromiseExtractionService] Extraction failed for ${context.symbol} (pages ${pages.map((p) => p.pageNumber).join(',')}): ${error.message}`);
    throw new PromiseExtractionFailure(`Promise extraction failed on pages ${pages.map((p) => p.pageNumber).join(',')}: ${error.message}`);
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
  if (pages.reduce((total, page) => total + page.text.length, 0) < MIN_DOCUMENT_TEXT_CHARS) {
    throw new PromiseExtractionFailure('The PDF has no extractable text layer (a scan or an empty file), so it could not be read for guidance');
  }
  const relevantPages = findGuidancePages(pages);

  const batches = [];
  for (let i = 0; i < relevantPages.length; i += PAGES_PER_OPENAI_CALL) batches.push(relevantPages.slice(i, i + PAGES_PER_OPENAI_CALL));
  // Issued together; the shared semaphore (configurePromiseExtractionConcurrency) is what bounds how many run at once.
  const promises = (await Promise.all(batches.map((batch) => extractPromisesFromPageBatch(batch, context)))).flat();

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
// CANDIDATE_STATUS_MAP is imported from utils/earningsIntelligenceValidation.js (the one shared copy).

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
  const statementText = [extracted.statement, extracted.excerpt].filter(Boolean).join(' \n ');
  const targetBasis = {
    statementBasis: extracted.reportingBasis && extracted.reportingBasis !== 'UNSTATED' ? extracted.reportingBasis : null,
    currencyBasis: extracted.currencyBasis && extracted.currencyBasis !== 'UNSTATED' ? extracted.currencyBasis : null,
    scope: extracted.scope === 'SEGMENT' ? `SEGMENT${extracted.segment ? `: ${extracted.segment}` : ''}` : null,
  };
  const verdictFor = (match, unavailableReason = null) => calculatePromiseStatus({
    targetValue: extracted.targetValue,
    targetValueMax: extracted.targetValueMax ?? null,
    actualValue: match ? match.actualValue : null,
    operator: extracted.operator,
    metric: extracted.metric,
    targetPeriod: extracted.targetPeriod,
    actualPeriod: match?.actualPeriod ?? null,
    targetUnit: extracted.targetUnit,
    actualUnit: match?.actualUnit ?? extracted.targetUnit,
    targetBasis,
    actualBasis: match?.basis ? { statementBasis: match.basis.statementBasis, currencyBasis: match.basis.currencyBasis, scope: 'COMPANY' } : {},
    evidenceUnavailableReason: unavailableReason,
  });

  try {
    const match = await outcomeSearchFn(context.profile, {
      metric: extracted.metric,
      targetPeriod: extracted.targetPeriod,
      targetValue: extracted.targetValue,
      targetUnit: extracted.targetUnit,
      statementText,
      reportingBasis: targetBasis.statementBasis,
    });
    if (match && match.actualValue != null && match.outcomeSourceUrl) {
      const verification = verdictFor(match);
      if (['MET', 'EXCEEDED', 'MISSED'].includes(verification.outcome)) {
        outcome = {
          status: toCandidateOutcomeStatus(verification.outcome), actualValue: match.actualValue, actualUnit: targetUnit,
          evaluationDate: toIsoDateOnly(match.outcomeSourceDate) || promiseDate,
          explanation: verification.calculationExplanation || match.outcomeStatement || null,
        };
        outcomeEvidence = {
          sourceTitle: match.outcomeSource || 'Exchange results filing',
          sourceType: 'FINANCIAL_RESULTS',
          sourceUrl: match.outcomeSourceUrl,
          publishedAt: toIsoDateOnly(match.outcomeSourceDate) || outcome.evaluationDate,
          pageNumber: null,
          excerpt: (match.outcomeStatement || 'Matched from a structured exchange filing.').slice(0, 2000),
        };
        evidenceConfidence = Math.min(0.75, typeof match.confidence === 'number' ? match.confidence : 0.75);
      } else {
        // A figure was found but is not like-for-like (scope / basis / period): recorded with the reason, never compared.
        outcome = { ...outcome, status: toCandidateOutcomeStatus(verification.outcome), explanation: verification.reason || verification.calculationExplanation };
      }
    } else {
      const verification = verdictFor(null, match?.unavailableReason || null);
      outcome = { ...outcome, status: toCandidateOutcomeStatus(verification.outcome), explanation: verification.reason || null };
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
      // Additive: RANGE upper bound (when extracted) and the precise metric, used by scripts/reevaluatePromises.js.
      targetValueMax: typeof extracted.targetValueMax === 'number' ? extracted.targetValueMax : null,
      metric: extracted.metric ? String(extracted.metric).toUpperCase() : null,
      targetUnit,
      operator,
      // v2: who/what the target covers, as the speaker stated it (never assumed).
      scope: extracted.scope || null,
      segment: extracted.segment || null,
      reportingBasis: extracted.reportingBasis && extracted.reportingBasis !== 'UNSTATED' ? extracted.reportingBasis : null,
      currencyBasis: extracted.currencyBasis && extracted.currencyBasis !== 'UNSTATED' ? extracted.currencyBasis : null,
      speaker: extracted.speaker || null,
    },
    outcome,
    promiseEvidence: {
      sourceTitle: context.title || 'Official BSE/NSE exchange filing',
      sourceType: PROMISE_EVIDENCE_SOURCE_TYPE[context.sourceType] || 'EXCHANGE_FILING',
      sourceUrl: context.url,
      publishedAt: promiseDate,
      pageNumber: extracted.pageNumber,
      excerpt: extracted.excerpt,
    },
    outcomeEvidence,
    extractionVersion: EXTRACTION_VERSION,
    verification: {
      verifiedAt: new Date().toISOString().slice(0, 10),
      verifiedBy: 'AUTOMATED_CANDIDATE_GENERATOR',
      evidenceConfidence,
      notes: `Automatically generated (${PROMPT_VERSION}) from a real BSE/NSE exchange filing; the excerpt was checked verbatim against the cited page and the target value against the excerpt. Not public until it passes the review gate (npm run earnings:review / earnings:auto-review).`,
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
  PromiseExtractionFailure,
  configurePromiseExtractionConcurrency,
  PROMISE_ELIGIBLE_SOURCE_TYPES,
  buildPromiseCandidate,
};
