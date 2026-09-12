/**
 * FactExtractionService.js
 * ===========================
 * Turns one downloaded, real primary-source PDF (from
 * ExchangeFilingDocumentProvider) into strictly-validated
 * CompanyHistoricalFact-shaped records:
 *
 *   deterministic regex extraction over well-known metric phrasings first
 *   (operating margin, revenue, attrition, TCV -- the same real phrasings
 *   confirmed live against TCS/Infosys transcripts) -> only pages that
 *   contain guidance/outlook/target/results keywords AND were not already
 *   resolved deterministically are sent to OpenAI, never the whole
 *   document -> every candidate fact (deterministic or OpenAI) is rejected
 *   unless it carries a real source URL, fiscal year, page number and an
 *   evidence excerpt actually present on that page.
 *
 * OpenAI responses are cached by a hash of (page text + prompt version) in
 * Redis so a re-run of the same document/page never re-spends the API
 * budget.
 */
import crypto from 'node:crypto';
import { openai } from './openaiClient.js';
import { getCache, setCache } from '../utils/redisClient.js';
import { logger } from '../utils/logger.js';
import { FACT_CATEGORIES } from '../models/CompanyHistoricalFact.js';
import { Semaphore } from '../utils/semaphore.js';

const VALID_METRICS = new Set(['REVENUE', 'EBITDA', 'EBITDA_MARGIN', 'OPERATING_MARGIN', 'PAT', 'ADJUSTED_PAT', 'EPS', 'OPERATING_CASH_FLOW', 'FREE_CASH_FLOW', 'DEBT', 'NET_DEBT', 'ROE', 'ROCE', 'ORDER_BOOK', 'NIM', 'GNPA', 'COUNT', 'OTHER']);
const VALID_UNITS = new Set(['INR_CRORE', 'INR_LAKH', 'USD_MILLION', 'USD_BILLION', 'PERCENTAGE', 'COUNT']);

// Global gate -- independent of how many companies the batch runner
// processes in parallel, at most this many OpenAI calls are ever in flight
// across the whole process. Default 1; scripts/backfillUniverse.js
// reconfigures at startup from --openai-concurrency.
let openaiSemaphore = new Semaphore(1);
export const configureOpenAIConcurrency = (n) => { if (n) openaiSemaphore = new Semaphore(n); };

const PROMPT_VERSION = 'fact-extraction-v1';
const OPENAI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // extraction of a fixed real document never changes -- cache long

const RELEVANT_PAGE_KEYWORDS = /guidance|outlook|target|aspiration|comfort range|margin|revenue|attrition|order book|tcv|total contract value|deal wins|profit|attempt/i;

export const extractPdfPages = async (buffer) => {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  await parser.destroy();
  return (parsed.pages || []).map((page, index) => ({
    pageNumber: index + 1,
    text: String(page.text || '').replace(/\s+/g, ' ').trim(),
  }));
};

export const findRelevantPages = (pages) => pages.filter((p) => RELEVANT_PAGE_KEYWORDS.test(p.text) && p.text.length > 100);

// Deterministic patterns, tightly anchored (verb immediately adjacent to the
// number, never a 60-80 char lookahead) so they only ever match a genuine
// single self-contained statement -- a loose "keyword ... anything ... N%"
// pattern was tested live and matched across unrelated sentences (e.g.
// picking up a Q4-specific figure while labeled as the full-year metric),
// so every pattern here requires the metric phrase and the number to appear
// in one short, verb-connected clause.
const DETERMINISTIC_PATTERNS = [
  { metric: 'OPERATING_MARGIN', category: 'FINANCIAL_PERFORMANCE', regex: /((?:operating|ebit|ebitda)\s*margins?\s*(?:was|is|were|stood at|at|of)\s*(\d{1,2}(?:\.\d+)?)\s*%)/gi, valueGroup: 2 },
  { metric: null, category: 'OPERATIONAL_PERFORMANCE', title: 'LTM attrition', regex: /((?:ltm\s+)?attrition\s*(?:was|is|were|stood at|remained|at|of)\s*(?:stable at|contained at)?\s*(\d{1,2}(?:\.\d+)?)\s*%)/gi, valueGroup: 2 },
];

/** Deterministic, regex-based extraction over one page's real text -- no LLM. */
export const extractDeterministicFactsFromPage = (page, context) => {
  const facts = [];
  for (const pattern of DETERMINISTIC_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    // eslint-disable-next-line no-cond-assign
    while ((match = pattern.regex.exec(page.text)) !== null) {
      const value = Number(match[pattern.valueGroup]);
      if (!Number.isFinite(value)) continue;
      const unit = pattern.unitGroup && match[pattern.unitGroup] ? match[pattern.unitGroup] : (pattern.metric === 'ORDER_BOOK' ? 'USD_MILLION' : 'PERCENTAGE');
      const actualValue = /billion/i.test(unit) ? value * 1000 : value;
      facts.push({
        category: pattern.category,
        period: context.fiscalYear,
        title: pattern.title || `${context.fiscalYear} ${(pattern.metric || 'metric').replace(/_/g, ' ').toLowerCase()}`,
        fact: match[1].trim(),
        metric: pattern.metric,
        actualValue,
        unit: pattern.unitGroup ? 'USD_MILLION' : 'PERCENTAGE',
        pageNumber: page.pageNumber,
        excerpt: match[1].trim(),
        extractionMethod: 'DETERMINISTIC_TABLE',
      });
    }
  }
  return facts;
};

const hashPageForCache = (page, context) => crypto.createHash('sha256')
  .update(`${PROMPT_VERSION}:${context.symbol}:${context.url}:${page.pageNumber}:${page.text}`)
  .digest('hex');

const buildPrompt = (page, context) => `You are extracting verified financial facts from ONE page of a real, official primary-source document (${context.sourceType}) for ${context.companyName} (${context.symbol}), fiscal year ${context.fiscalYear}.

Extract ONLY facts explicitly stated on this page. Never invent a number, date, or statement. If nothing verifiable is present, return an empty facts array.

Return strictly valid JSON:
{
  "facts": [
    {
      "category": "FINANCIAL_PERFORMANCE|OPERATIONAL_PERFORMANCE|MANAGEMENT_COMMENTARY|STRATEGY|ORDER_BOOK|CONTRACT|PRODUCT|EXPANSION|ACQUISITION|CAPEX|EARNINGS|CORPORATE_ACTION|RISK|GUIDANCE|OTHER",
      "title": "short title",
      "fact": "the factual statement",
      "metric": "REVENUE|EBITDA_MARGIN|PAT|ORDER_BOOK|DEBT|EPS|ROE|ROCE|OTHER|null",
      "actualValue": number or null,
      "unit": "INR_CRORE|PERCENTAGE|COUNT|USD_MILLION|null",
      "excerpt": "the EXACT sentence from this page's text supporting the fact"
    }
  ]
}

PAGE TEXT:
${page.text.slice(0, 6000)}`;

/** OpenAI extraction for ONE page, cached by content hash. Never called for a page a deterministic pattern already fully covers. */
export const extractFactsFromPageWithOpenAI = async (page, context) => {
  const cacheKey = `factextract:${hashPageForCache(page, context)}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  if (!openai || !process.env.OPENAI_API_KEY) {
    logger.warn('[FactExtractionService] OpenAI not configured -- skipping LLM extraction for this page.');
    return [];
  }

  try {
    // Explicit timeout -- the SDK's own default (10 minutes) would let one
    // slow/hung page silently stall an entire multi-document backfill run;
    // a page that doesn't answer in 45s degrades to "no facts from this
    // page" (caught below), never a multi-minute stall.
    const response = await openaiSemaphore.run(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: buildPrompt(page, context) }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }, { timeout: 45000 }));
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const rawFacts = Array.isArray(parsed.facts) ? parsed.facts : [];

    // Reject any candidate whose excerpt isn't actually present on this real
    // page -- the strongest guard against a hallucinated fact regardless of
    // how well-formed the JSON is.
    const validated = rawFacts
      .filter((f) => f.excerpt && page.text.includes(f.excerpt.slice(0, 40)))
      .map((f) => ({ ...f, period: context.fiscalYear, pageNumber: page.pageNumber, extractionMethod: 'OPENAI_GUIDANCE_PAGE' }));

    await setCache(cacheKey, validated, OPENAI_CACHE_TTL_SECONDS);
    return validated;
  } catch (error) {
    logger.warn(`[FactExtractionService] OpenAI extraction failed for ${context.symbol} p.${page.pageNumber}: ${error.message}`);
    return [];
  }
};

const PAGES_PER_OPENAI_CALL = 5; // batches several relevant pages into one call -- a large filing (300+ pages) can have dozens of keyword-matching pages, and one call per page made a full backfill run take hours

const hashBatchForCache = (pages, context) => crypto.createHash('sha256')
  .update(`${PROMPT_VERSION}:batch:${context.symbol}:${context.url}:${pages.map((p) => p.pageNumber).join(',')}:${pages.map((p) => p.text).join('|')}`)
  .digest('hex');

const buildBatchPrompt = (pages, context) => `You are extracting verified financial facts from SEVERAL pages of a real, official primary-source document (${context.sourceType}) for ${context.companyName} (${context.symbol}), fiscal year ${context.fiscalYear}.

Extract ONLY facts explicitly stated on these pages. Never invent a number, date, or statement. Each fact MUST include the exact page number (from the "=== PAGE N ===" markers below) it came from. If nothing verifiable is present on a page, do not include any fact for it.

Return strictly valid JSON:
{
  "facts": [
    {
      "pageNumber": <the exact integer from the "=== PAGE N ===" marker this fact came from>,
      "category": "FINANCIAL_PERFORMANCE|OPERATIONAL_PERFORMANCE|MANAGEMENT_COMMENTARY|STRATEGY|ORDER_BOOK|CONTRACT|PRODUCT|EXPANSION|ACQUISITION|CAPEX|EARNINGS|CORPORATE_ACTION|RISK|GUIDANCE|OTHER",
      "title": "short title",
      "fact": "the factual statement",
      "metric": "REVENUE|EBITDA_MARGIN|PAT|ORDER_BOOK|DEBT|EPS|ROE|ROCE|OTHER|null",
      "actualValue": number or null,
      "unit": "INR_CRORE|PERCENTAGE|COUNT|USD_MILLION|null",
      "excerpt": "the EXACT sentence from that page's text supporting the fact"
    }
  ]
}

${pages.map((p) => `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 4000)}`).join('\n\n')}`;

/** Batched OpenAI extraction over several relevant pages in one call, cached by the batch's combined content hash. Each returned fact is validated against its OWN claimed page's real text, never any page in the batch -- a fact citing the wrong page number is rejected, not silently reattributed. */
export const extractFactsFromPageBatchWithOpenAI = async (pages, context) => {
  const cacheKey = `factextract:${hashBatchForCache(pages, context)}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  if (!openai || !process.env.OPENAI_API_KEY) {
    logger.warn('[FactExtractionService] OpenAI not configured -- skipping LLM extraction for this batch.');
    return [];
  }

  const pageTextByNumber = new Map(pages.map((p) => [p.pageNumber, p.text]));

  try {
    const response = await openaiSemaphore.run(() => openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: buildBatchPrompt(pages, context) }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }, { timeout: 60000 }));
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const rawFacts = Array.isArray(parsed.facts) ? parsed.facts : [];

    const validated = rawFacts
      .filter((f) => f.excerpt && Number.isInteger(f.pageNumber) && pageTextByNumber.has(f.pageNumber) && pageTextByNumber.get(f.pageNumber).includes(f.excerpt.slice(0, 40)))
      .map((f) => ({ ...f, period: context.fiscalYear, extractionMethod: 'OPENAI_GUIDANCE_PAGE' }));

    await setCache(cacheKey, validated, OPENAI_CACHE_TTL_SECONDS);
    return validated;
  } catch (error) {
    logger.warn(`[FactExtractionService] Batched OpenAI extraction failed for ${context.symbol} (pages ${pages.map((p) => p.pageNumber).join(',')}): ${error.message}`);
    return [];
  }
};

/**
 * Full per-document pipeline: deterministic first, OpenAI only on relevant
 * pages the deterministic pass didn't already resolve. Every returned fact
 * carries sourceUrl/fiscalYear/pageNumber/excerpt -- anything missing one is
 * dropped before it ever reaches the caller.
 */
export const extractFactsFromDocument = async (buffer, context) => {
  const pages = await extractPdfPages(buffer);
  const facts = [];
  const pagesNeedingOpenAI = [];

  for (const page of findRelevantPages(pages)) {
    const deterministic = extractDeterministicFactsFromPage(page, context);
    if (deterministic.length) facts.push(...deterministic);
    else pagesNeedingOpenAI.push(page);
  }

  // Batched into groups of PAGES_PER_OPENAI_CALL -- a large filing can have
  // dozens of keyword-matching pages, and one OpenAI round-trip per page
  // made a full multi-document backfill take hours. Falls back to the
  // single-page path only if a batch is empty.
  for (let i = 0; i < pagesNeedingOpenAI.length; i += PAGES_PER_OPENAI_CALL) {
    const batch = pagesNeedingOpenAI.slice(i, i + PAGES_PER_OPENAI_CALL);
    if (!batch.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const llmFacts = await extractFactsFromPageBatchWithOpenAI(batch, context);
    facts.push(...llmFacts);
  }

  const validated = facts
    .filter((f) => f.fact || f.excerpt)
    .filter((f) => context.url && context.fiscalYear && f.pageNumber && f.excerpt)
    // A model that returns something other than exactly one enum value (e.g.
    // a pipe-joined list when it's unsure) is rejected outright rather than
    // defaulted to OTHER -- defaulting would silently accept a fact the
    // model itself couldn't confidently categorize.
    .filter((f) => !f.category || FACT_CATEGORIES.includes(f.category))
    .filter((f) => !f.metric || VALID_METRICS.has(String(f.metric).toUpperCase()))
    .filter((f) => !f.unit || VALID_UNITS.has(String(f.unit).toUpperCase()))
    .map((f) => ({
      category: f.category || 'OTHER',
      period: f.period || context.fiscalYear,
      title: f.title || context.title,
      fact: f.fact || f.excerpt,
      metric: f.metric ? String(f.metric).toUpperCase() : null,
      actualValue: Number.isFinite(f.actualValue) ? f.actualValue : null,
      unit: f.unit ? String(f.unit).toUpperCase() : 'PERCENTAGE',
      pageNumber: f.pageNumber,
      excerpt: f.excerpt,
      extractionMethod: f.extractionMethod,
    }));

  // Dedup near-identical facts (same category+period+page+rounded value) --
  // real transcripts often restate the same figure across nearby pages/Q&A.
  const seen = new Set();
  return validated.filter((f) => {
    const key = `${f.category}:${f.period}:${f.metric}:${Math.round((f.actualValue ?? 0) * 10)}:${f.pageNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export default { extractPdfPages, findRelevantPages, extractDeterministicFactsFromPage, extractFactsFromPageWithOpenAI, extractFactsFromPageBatchWithOpenAI, extractFactsFromDocument, configureOpenAIConcurrency };
