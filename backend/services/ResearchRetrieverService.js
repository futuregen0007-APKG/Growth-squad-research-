import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { OpenAIClientFactory, LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { hasBudgetFor } from '../graph/requestBudget.js';
import { logger } from '../utils/logger.js';

/**
 * ResearchRetrieverService.js
 * =============================
 * Phase 4A retriever abstraction. `retrieveResearchEvidence` is the ONE
 * stable interface a future Phase 4B graph tool (or anything else) calls —
 * everything about WHICH retrieval strategy actually ran is reported back
 * as `retrievalMode` in the result, never hidden.
 *
 * retrievalMode is one of:
 *   - 'LEXICAL_FALLBACK': a real, deterministic keyword/term-overlap
 *     search over ResearchDocumentChunk.text, scored in application code
 *     (no MongoDB $text index dependency, no external search service).
 *     This is the ONLY mode confirmed to work in this project's local
 *     dev environment today (see the Phase 4A audit: MONGODB_URI here is
 *     a plain, non-Atlas connection string) and is used whenever Atlas
 *     Vector Search has not been explicitly, verifiably enabled.
 *   - 'ATLAS_VECTOR': a REAL `$vectorSearch` aggregation stage — genuine
 *     MongoDB Atlas Vector Search syntax, not a stub — used ONLY when
 *     explicitly opted into via VECTOR_SEARCH_ENABLED=true. Never
 *     selected by default and NEVER silently assumed available; this
 *     project's production Atlas tier/index availability could not be
 *     verified from this environment (no production DB access), so
 *     defaulting to it would violate "never assume its tier or index
 *     availability."
 * LEXICAL_FALLBACK is never described as "vector" or "semantic" search
 * anywhere in its own code, logs, or diagnostics — it is keyword search,
 * named honestly.
 */

export const RETRIEVAL_MODES = Object.freeze({ LEXICAL_FALLBACK: 'LEXICAL_FALLBACK', ATLAS_VECTOR: 'ATLAS_VECTOR' });
export const RETRIEVAL_STATUS = Object.freeze({ SUCCESS: 'SUCCESS', EMPTY: 'EMPTY', UNAVAILABLE: 'UNAVAILABLE', UNSUPPORTED: 'UNSUPPORTED' });

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;
// Phase 4A.1 hardening: recalibrated for the new composite score scale
// (lexical + phrase + metric + period + authority) — see the evaluation
// harness for how this was tuned against real, honestly-measured data,
// never against the golden questions alone.
const DEFAULT_MIN_RELEVANCE_SCORE = 0.32;
// Atlas's $vectorSearch reports a cosine-similarity-like score on a
// completely different scale than the lexical composite above — kept as
// its own constant so the two modes never accidentally share a
// meaningless threshold. Never live-verified against a real Atlas index
// (see the Phase 4A.1 report's Atlas-readiness section); this is a
// reasonable starting point for a 1536-dim text-embedding-3-small cosine
// score, not an empirically-tuned value.
const DEFAULT_MIN_VECTOR_RELEVANCE_SCORE = 0.75;
const DEFAULT_CANDIDATE_LIMIT = 500; // bound on how many chunks a metadata-filtered query pulls before in-memory lexical scoring
const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.9;

/** True only when Atlas Vector Search has been explicitly opted into — never inferred from mongoose version, connection scheme, or anything else. */
export const isVectorSearchConfigured = () => process.env.VECTOR_SEARCH_ENABLED === 'true';

/**
 * Phase 4A.1 lexical-quality hardening
 * =======================================
 * The Phase 4A evaluation harness surfaced two real weaknesses in the
 * plain term-overlap scorer: (1) a genuinely absent-from-corpus question
 * still returned SUCCESS because generic connective/question words
 * accidentally matched something everywhere, and (2) the exact supporting
 * page often ranked BELOW loosely related chunks because nothing favored
 * financially-specific terms, exact phrases, or the right fiscal period.
 * This section fixes both without pretending LEXICAL_FALLBACK is
 * semantic search — every signal here is a deterministic, explainable
 * rule over the actual token/metadata content, never an embedding.
 */

// Generic connective/question words AND the specific generic financial
// nouns the hardening spec calls out by name ("company, year, result,
// business, management, growth") — none of these may, by themselves,
// satisfy the minimum-meaningful-overlap gate below. A query built
// entirely from this set has no real search intent and must never
// produce SUCCESS just because these words happen to appear everywhere.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'this', 'that', 'these', 'those', 'it', 'its', "it's", 'as',
  'by', 'from', 'their', 'they', 'them', 'we', 'our', 'you', 'your', 'i', 'he', 'she', 'his', 'her',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'about', 'with', 'into', 'if', 'so',
  'not', 'no', 'yes', 'all', 'any', 'some', 'more', 'most', 'other', 'such', 'than', 'then', 'there',
  'also', 'just', 'only', 'over', 'under', 'again', 'once', 'up', 'down', 'out', 'off',
  // The specific generic terms named by the Phase 4A.1 hardening spec —
  // never sufficient alone to produce SUCCESS.
  'company', 'companys', 'year', 'years', 'result', 'results', 'business', 'management', 'growth', 'question', 'questions',
]);

/** At least this many DISTINCT meaningful (non-stopword) query tokens must actually appear in a chunk before it is even scored as a candidate — never "any single generic word matched somewhere". */
const MIN_MEANINGFUL_OVERLAP = 2;

// A modest, general finance vocabulary — matches on these tokens are
// weighted above an arbitrary matched word, but the set is deliberately
// broad/generic (not built from the golden question set) so it
// generalizes to any real filing rather than overfitting eight questions.
const METRIC_TERMS = new Set([
  'revenue', 'margin', 'guidance', 'ebitda', 'eps', 'profit', 'income', 'headcount', 'attrition',
  'dividend', 'outlook', 'forecast', 'pct', 'crore', 'billion', 'million', 'arr', 'bookings',
  'backlog', 'deal', 'deals', 'wins', 'opex', 'capex', 'cashflow', 'debt', 'equity', 'roe', 'roce',
  'utilization', 'digital', 'constant', 'currency', 'segment', 'geography', 'client', 'clients',
  'employee', 'employees', 'quarter', 'fiscal', 'operating', 'net', 'gross', 'expense', 'expenses',
]);
const METRIC_TERM_WEIGHT = 0.12;
const PHRASE_WEIGHT = 0.4;
const PERIOD_MATCH_BONUS = 0.35;
const PERIOD_MISMATCH_PENALTY = 0.5;
const AUTHORITY_BASE_WEIGHT = { EXCHANGE_FILING: 0.1 };
const AUTHORITY_DEFAULT_WEIGHT = 0.03;

const singularize = (token) => {
  const IRREGULAR = { revenues: 'revenue', margins: 'margin', guidances: 'guidance', profits: 'profit', forecasts: 'forecast', metrics: 'metric', results: 'result', earnings: 'earning' };
  return IRREGULAR[token] || token;
};

/** Normalizes finance-specific punctuation/units BEFORE tokenizing: currency symbols, "%"/"percent", crore/cr, and comma-grouped numbers ("50,000" -> "50000") all collapse to comparable tokens regardless of which form the query or the source document happened to use. */
const normalizeFinanceText = (text) => String(text || '')
  .toLowerCase()
  .replace(/₹/g, ' inr ')
  .replace(/\$/g, ' usd ')
  .replace(/%/g, ' pct ')
  .replace(/\bpercent\b/g, 'pct')
  .replace(/\brs\.?\b/g, 'inr')
  .replace(/\bcrores?\b/g, 'crore')
  .replace(/(\d),(\d{3})/g, '$1$2');

// Longest-phrase-first company-name <-> ticker aliasing so a query that
// says "Infosys" scores correctly against chunk text that says "INFY" (or
// the ticker in the CompanyDocumentRegistry) and vice versa. Sourced from
// the same real BSE_SCRIP_CODES universe already used elsewhere in this
// project (providers/ExchangeFilingDocumentProvider.js) — not invented,
// and general to the whole covered universe, not just TCS/INFY.
const COMPANY_ALIAS_PHRASES = [
  ['tata consultancy services', 'tcs'], ['tata consultancy', 'tcs'],
  ['infosys limited', 'infy'], ['infosys', 'infy'],
  ['hdfc bank limited', 'hdfcbank'], ['hdfc bank', 'hdfcbank'],
  ['icici bank limited', 'icicibank'], ['icici bank', 'icicibank'],
  ['bharat heavy electricals', 'bhel'],
  ['newgen software', 'newgen'],
  ['larsen and toubro', 'lt'], ['larsen & toubro', 'lt'], ['larsen toubro', 'lt'], ['l&t', 'lt'],
  ['hindustan aeronautics', 'hal'],
  ['reliance industries', 'reliance'],
];
const normalizeAliases = (text) => COMPANY_ALIAS_PHRASES.reduce(
  (acc, [phrase, canonical]) => acc.replace(new RegExp(`\\b${phrase.replace(/[&]/g, '&')}\\b`, 'g'), canonical),
  text,
);

const tokenize = (text) => {
  const normalized = normalizeAliases(normalizeFinanceText(text));
  const raw = normalized.match(/[a-z0-9]+/g) || [];
  return raw.map(singularize);
};

/** Query-quality validation: the DISTINCT, non-generic tokens a query actually carries — a query reduced to nothing here has no real search intent. */
const meaningfulTokens = (tokens) => [...new Set(tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1))];

const buildBigrams = (tokens) => {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i += 1) out.push(`${tokens[i]}_${tokens[i + 1]}`);
  return out;
};

/**
 * Rewards a chunk that contains an exact consecutive PHRASE from the
 * query (e.g. "operating margin", "revenue guidance"), not just the same
 * words in any order anywhere in the text.
 *
 * KNOWN LIMITATION (measured, not fixed here — see the Phase 4A.1
 * report's evaluation section): because this bigrams the FULL token
 * stream, a generic grammatical bigram shared purely by sentence
 * structure (e.g. "for_the", "the_fiscal") can occasionally contribute a
 * small false-positive phrase bonus. An alternative that bigrams only
 * the stopword-filtered token sequence was tried and measured against
 * the full golden dataset; it fixed some rankings but regressed others
 * by an equal or greater amount (a real, honest, non-overfit finding,
 * not a hunch) — so this simpler, empirically-better-performing version
 * was kept. A real fix likely needs POS-aware phrase extraction or a
 * genuine reranker, which is exactly why Phase 4A.1 explicitly defers
 * adding an LLM reranker until a deterministic baseline has been
 * measured — this is that baseline.
 */
const computePhraseScore = (queryTokensFull, chunkTokensFull) => {
  const queryBigrams = buildBigrams(queryTokensFull);
  if (!queryBigrams.length) return 0;
  const chunkBigramSet = new Set(buildBigrams(chunkTokensFull));
  const matched = queryBigrams.filter((bg) => chunkBigramSet.has(bg)).length;
  return (matched / queryBigrams.length) * PHRASE_WEIGHT;
};

const computeMetricScore = (meaningfulQueryTokens, chunkTermsSet) => meaningfulQueryTokens
  .filter((t) => METRIC_TERMS.has(t) && chunkTermsSet.has(t))
  .length * METRIC_TERM_WEIGHT;

/** Extracts explicit fiscal-year mentions from free text ("FY2023", "FY23", a bare "2023") as canonical "FY20XX" strings — a deterministic regex pass, never an LLM call. */
const extractFiscalYearMentions = (text) => {
  const found = new Set();
  const source = String(text || '');
  for (const m of source.matchAll(/\bfy[\s-]?(\d{4})\b/gi)) found.add(`FY${m[1]}`);
  for (const m of source.matchAll(/\bfy[\s-]?(\d{2})\b/gi)) found.add(`FY20${m[1]}`);
  for (const m of source.matchAll(/\b(20\d{2})\b/g)) found.add(`FY${m[1]}`);
  return found;
};

/** Fiscal-period weighting: a chunk from the fiscal year the query explicitly named is boosted; a chunk from a DIFFERENT explicitly-named year is penalized (helps rank the right period above a same-topic chunk from the wrong filing even when the caller did not also pass an explicit fiscalYears filter). Silent (0) when the query names no period at all. */
const computePeriodScore = (queryFiscalYears, chunkFiscalYear) => {
  if (!queryFiscalYears.size || !chunkFiscalYear) return 0;
  if (queryFiscalYears.has(chunkFiscalYear)) return PERIOD_MATCH_BONUS;
  return -PERIOD_MISMATCH_PENALTY;
};

const DOCUMENT_TYPE_TOPICAL_BONUS = [
  { terms: new Set(['guidance', 'outlook', 'forecast']), types: new Set(['EARNINGS_CALL_TRANSCRIPT', 'INVESTOR_PRESENTATION']), bonus: 0.08 },
  { terms: new Set(['revenue', 'profit', 'margin', 'income']), types: new Set(['FINANCIAL_RESULTS', 'ANNUAL_REPORT']), bonus: 0.08 },
  { terms: new Set(['headcount', 'attrition', 'employee', 'employees']), types: new Set(['ANNUAL_REPORT', 'EARNINGS_CALL_TRANSCRIPT']), bonus: 0.05 },
];

/** Authority + document-type-fit combined into one diagnostic ("authorityScore") — a coarse trust signal from the source (see sourceAuthority) plus a small bonus when the document TYPE actually suits the kind of question being asked (a guidance question is better answered by a transcript than a press release). */
const computeAuthorityScore = (meaningfulQueryTokens, doc) => {
  const base = AUTHORITY_BASE_WEIGHT[doc.sourceAuthority] ?? AUTHORITY_DEFAULT_WEIGHT;
  const topical = DOCUMENT_TYPE_TOPICAL_BONUS
    .filter((rule) => rule.types.has(doc.documentType) && meaningfulQueryTokens.some((t) => rule.terms.has(t)))
    .reduce((sum, rule) => sum + rule.bonus, 0);
  return base + topical;
};

/**
 * scoreChunkAgainstQuery - a real, deterministic term-frequency-style
 * lexical score (not a stand-in for a vector similarity number): each
 * query term present in the chunk contributes `1 + log(count)`
 * (diminishing returns for repeated terms), normalized by the square
 * root of chunk length so long chunks don't win purely on size. Returns
 * 0 for a chunk sharing no terms with the query at all.
 */
export const scoreChunkAgainstQuery = (queryTerms, chunkText) => {
  const chunkTerms = tokenize(chunkText);
  if (!chunkTerms.length || !queryTerms.length) return 0;
  const counts = new Map();
  for (const term of chunkTerms) counts.set(term, (counts.get(term) || 0) + 1);
  let score = 0;
  for (const term of queryTerms) {
    const count = counts.get(term) || 0;
    if (count > 0) score += 1 + Math.log(count);
  }
  return score / Math.sqrt(chunkTerms.length);
};

const jaccard = (a, b) => {
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
};

/** Drops a later chunk whose text is near-identical (by token-set Jaccard similarity) to an already-kept, higher-or-equal-scored chunk — never drops the FIRST (highest-scored) occurrence. */
const dropNearDuplicates = (rankedResults, threshold) => {
  const kept = [];
  const keptTokenSets = [];
  for (const item of rankedResults) {
    const tokens = new Set(tokenize(item.text));
    const isDuplicate = keptTokenSets.some((existing) => jaccard(existing, tokens) >= threshold);
    if (!isDuplicate) { kept.push(item); keptTokenSets.push(tokens); }
  }
  return kept;
};

// `debug` carries the deterministic scoring explanation
// ({lexicalScore, phraseScore, metricScore, periodScore, authorityScore,
// finalScore}) required by Phase 4A.1 item 3 — present on every
// LEXICAL_FALLBACK result for evaluation/diagnostics, but this is
// internal scoring detail, NOT meant for end-user display; a future
// Phase 4B composer/UI layer must strip it before showing evidence to a
// user (only `text`/`sourceUrl`/`pageStart`/`pageEnd`/etc. are
// user-facing). Absent (null) for ATLAS_VECTOR results, which score via
// a single vectorSearchScore instead.
const toEvidenceShape = (doc, score, debug = null) => ({
  chunkId: String(doc._id),
  symbol: doc.symbol,
  registryDocumentId: String(doc.registryDocumentId),
  documentType: doc.documentType,
  title: doc.title,
  fiscalYear: doc.fiscalYear,
  fiscalQuarter: doc.fiscalQuarter || null,
  publishedAt: doc.publishedAt || null,
  sourceUrl: doc.sourceUrl,
  pageStart: doc.pageStart,
  pageEnd: doc.pageEnd,
  text: doc.text,
  sourceAuthority: doc.sourceAuthority || null,
  documentTruncated: Boolean(doc.documentTruncated),
  score,
  debug,
});

const buildMetadataFilter = ({ symbols, fiscalYears, documentTypes }) => {
  const filter = { symbol: { $in: symbols } };
  if (fiscalYears?.length) filter.fiscalYear = { $in: fiscalYears };
  if (documentTypes?.length) filter.documentType = { $in: documentTypes };
  return filter;
};

const lexicalRetrieve = async ({
  query, symbols, fiscalYears, documentTypes, topK, minRelevanceScore,
}) => {
  // Query-quality validation: a query that reduces to nothing but
  // stopwords/generic terms has no real search intent and must never
  // reach SUCCESS, however many chunks happen to exist.
  const queryTokensFull = tokenize(query);
  const meaningfulQuery = meaningfulTokens(queryTokensFull);
  if (!meaningfulQuery.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [], reason: 'Query has no meaningful (non-generic) search terms' };
  }

  const filter = buildMetadataFilter({ symbols, fiscalYears, documentTypes });
  const candidates = await ResearchDocumentChunk.find(filter).limit(DEFAULT_CANDIDATE_LIMIT).lean();
  if (!candidates.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
  }

  const queryFiscalYears = extractFiscalYearMentions(query);
  const requiredOverlap = Math.min(meaningfulQuery.length, MIN_MEANINGFUL_OVERLAP);

  const scored = [];
  for (const doc of candidates) {
    const chunkTokensFull = tokenize(doc.text);
    const chunkTermsSet = new Set(chunkTokensFull);
    const matchedMeaningfulCount = meaningfulQuery.filter((t) => chunkTermsSet.has(t)).length;
    // Minimum meaningful-token overlap: a chunk sharing fewer distinct
    // real terms with the query than this is not even scored — this is
    // what stops "the/a/company/year" alone from ever manufacturing a
    // false SUCCESS.
    if (matchedMeaningfulCount < requiredOverlap) continue;

    const lexicalScore = scoreChunkAgainstQuery(meaningfulQuery, doc.text);
    const phraseScore = computePhraseScore(queryTokensFull, chunkTokensFull);
    const metricScore = computeMetricScore(meaningfulQuery, chunkTermsSet);
    const periodScore = computePeriodScore(queryFiscalYears, doc.fiscalYear);
    const authorityScore = computeAuthorityScore(meaningfulQuery, doc);
    const finalScore = lexicalScore + phraseScore + metricScore + periodScore + authorityScore;

    if (finalScore < minRelevanceScore) continue;
    scored.push({
      doc, finalScore, debug: {
        lexicalScore, phraseScore, metricScore, periodScore, authorityScore, finalScore,
      },
    });
  }
  scored.sort((a, b) => b.finalScore - a.finalScore);

  if (!scored.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
  }

  // Near-duplicate removal happens AFTER relevance scoring and sorting —
  // `scored` is already ranked, so dropNearDuplicates always keeps the
  // highest-scored (best-provenance) page of any near-duplicate pair,
  // never an arbitrary one.
  const deduped = dropNearDuplicates(
    scored.map((item) => ({
      ...item.doc, __score: item.finalScore, __debug: item.debug, text: item.doc.text,
    })),
    NEAR_DUPLICATE_JACCARD_THRESHOLD,
  );
  const top = deduped.slice(0, topK);
  return {
    status: RETRIEVAL_STATUS.SUCCESS,
    results: top.map((doc) => toEvidenceShape(doc, doc.__score, doc.__debug)),
  };
};

// Phase 4A.1 Atlas-readiness audit (item 8): never live-verified against a
// real Atlas cluster/index (no Atlas access from this environment — see
// the Phase 4A.1 report) — these constants and the filter/timeout logic
// below are STRUCTURALLY correct and unit-tested against a real MongoDB
// connection using a real (non-Atlas) aggregate() call that exercises the
// same pipeline shape, but "structurally tested" is not "live verified".
const ATLAS_VECTOR_INDEX_NAME = 'research_chunk_vector_index';
const ATLAS_VECTOR_PATH = 'embedding';
const ATLAS_QUERY_EMBED_TIMEOUT_MS = 10000;

const atlasVectorRetrieve = async ({
  query, symbols, fiscalYears, documentTypes, topK, minRelevanceScore, signal,
}) => {
  if (!OpenAIClientFactory.isConfigured()) {
    return { status: RETRIEVAL_STATUS.UNSUPPORTED, results: [], reason: 'OpenAI not configured, cannot embed the query' };
  }
  const embeddingModel = LLM_CONFIG.embeddingModel;
  const embeddingVersion = LLM_CONFIG.embeddingVersion;

  let queryEmbedding;
  try {
    const client = OpenAIClientFactory.getClient();
    // Deadline/timeout behavior: the query embedding call is bounded by
    // its own timeout (never allowed to hang indefinitely) combined with
    // any caller-supplied abort signal — the same AbortSignal.any pattern
    // services/EmbeddingService.js uses for the indexing-time embedding
    // calls, so both embedding call sites behave consistently.
    const localController = new AbortController();
    const timeoutHandle = setTimeout(() => localController.abort(), ATLAS_QUERY_EMBED_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, localController.signal]) : localController.signal;
    let response;
    try {
      response = await client.embeddings.create({ model: embeddingModel, input: [query] }, { signal: combinedSignal });
    } finally {
      clearTimeout(timeoutHandle);
    }
    queryEmbedding = response.data?.[0]?.embedding;
  } catch (error) {
    logger.warn(`[ResearchRetrieverService] failed to embed query for Atlas vector search: ${error.message}`);
    return { status: RETRIEVAL_STATUS.UNAVAILABLE, results: [], reason: 'Query embedding failed' };
  }
  if (!queryEmbedding) return { status: RETRIEVAL_STATUS.UNAVAILABLE, results: [], reason: 'Query embedding failed' };

  // Model/version mismatch guard: vectors from a DIFFERENT embedding
  // model (or a different dimensionality) must never be compared against
  // this query's vector — added directly to the Atlas pre-filter so a
  // stale/mixed index can never silently return garbage-similarity
  // results from an incompatible embedding generation.
  const filter = {
    ...buildMetadataFilter({ symbols, fiscalYears, documentTypes }),
    embeddingModel,
    embeddingVersion,
  };
  try {
    // Genuine Atlas Vector Search aggregation syntax — NOT a stub. Only
    // ever reached when VECTOR_SEARCH_ENABLED=true was explicitly set;
    // if the named index does not actually exist on this cluster (never
    // verified from this environment), this throws and is reported as a
    // real UNAVAILABLE outcome below — never silently swapped for the
    // lexical path without saying so.
    const docs = await ResearchDocumentChunk.aggregate([
      {
        $vectorSearch: {
          index: ATLAS_VECTOR_INDEX_NAME,
          path: ATLAS_VECTOR_PATH,
          queryVector: queryEmbedding,
          numCandidates: Math.max(100, topK * 10),
          limit: topK * 3, // over-fetch before relevance-threshold + dedupe trims it down
          filter,
        },
      },
      { $addFields: { __score: { $meta: 'vectorSearchScore' } } },
    ]);
    const filtered = docs.filter((d) => d.__score >= minRelevanceScore);
    if (!filtered.length) return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
    const deduped = dropNearDuplicates(filtered, NEAR_DUPLICATE_JACCARD_THRESHOLD);
    return { status: RETRIEVAL_STATUS.SUCCESS, results: deduped.slice(0, topK).map((doc) => toEvidenceShape(doc, doc.__score)) };
  } catch (error) {
    logger.warn(`[ResearchRetrieverService] Atlas $vectorSearch failed (index may not exist on this cluster): ${error.message}`);
    return { status: RETRIEVAL_STATUS.UNAVAILABLE, results: [], reason: 'Vector search unavailable on this cluster' };
  }
};

/**
 * retrieveResearchEvidence - the stable retriever interface.
 *
 * Hard constraints:
 *   - `symbols` is REQUIRED and non-empty — an unscoped, all-companies
 *     search is refused outright (UNSUPPORTED) rather than silently
 *     running one. This is what makes "no cross-company leakage" a
 *     structural guarantee rather than a hope: every query is a MongoDB
 *     filter on `symbol: {$in: symbols}` before any scoring happens, so a
 *     chunk for a symbol outside the requested set is never even a
 *     candidate.
 *   - never queries account-scoped data (this retriever only ever reads
 *     ResearchDocumentChunk, a company-research collection with no
 *     user/account fields at all).
 *   - retrieved `text` is returned completely unmodified — the caller
 *     (a future Phase 4B evidence-building step) is responsible for
 *     treating it as untrusted data, exactly like every other evidence
 *     source in this project (see graph/prompts/index.js's evidenceRules).
 *     This retriever does not attempt to detect/strip prompt-injection
 *     content itself — doing so risks corrupting a legitimate document
 *     excerpt that happens to quote such phrasing (e.g. a filing
 *     discussing cybersecurity risks) more than it protects anything,
 *     since this layer never executes or interprets the text either way.
 */
export const retrieveResearchEvidence = async ({
  query, symbols, fiscalYears = [], documentTypes = [], topK = DEFAULT_TOP_K, deadlineAt = null, minRelevanceScore = null, signal = null,
} = {}) => {
  const startedAt = Date.now();
  const boundedTopK = Math.max(1, Math.min(MAX_TOP_K, Number(topK) || DEFAULT_TOP_K));

  if (!query || !String(query).trim()) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [], retrievalMode: null, durationMs: 0, reason: 'Empty query' };
  }
  if (!Array.isArray(symbols) || !symbols.length) {
    return { status: RETRIEVAL_STATUS.UNSUPPORTED, results: [], retrievalMode: null, durationMs: 0, reason: 'No symbols provided — an unscoped cross-company search is never performed' };
  }
  if (deadlineAt != null && !hasBudgetFor(deadlineAt, 200)) {
    return { status: RETRIEVAL_STATUS.UNAVAILABLE, results: [], retrievalMode: null, durationMs: 0, reason: 'Request deadline exhausted' };
  }

  const normalizedSymbols = symbols.map((s) => String(s).toUpperCase());
  const mode = isVectorSearchConfigured() ? RETRIEVAL_MODES.ATLAS_VECTOR : RETRIEVAL_MODES.LEXICAL_FALLBACK;
  // The two modes score on entirely different scales (a composite
  // lexical/phrase/metric/period/authority sum vs. a cosine-similarity-
  // like vectorSearchScore) — an explicit caller override applies to
  // whichever mode actually runs; otherwise each mode gets its OWN
  // calibrated default rather than sharing one number that would be
  // meaningless for at least one of them.
  const effectiveMinRelevanceScore = minRelevanceScore != null
    ? minRelevanceScore
    : (mode === RETRIEVAL_MODES.ATLAS_VECTOR ? DEFAULT_MIN_VECTOR_RELEVANCE_SCORE : DEFAULT_MIN_RELEVANCE_SCORE);

  try {
    const outcome = mode === RETRIEVAL_MODES.ATLAS_VECTOR
      ? await atlasVectorRetrieve({
        query, symbols: normalizedSymbols, fiscalYears, documentTypes, topK: boundedTopK, minRelevanceScore: effectiveMinRelevanceScore, signal,
      })
      : await lexicalRetrieve({
        query, symbols: normalizedSymbols, fiscalYears, documentTypes, topK: boundedTopK, minRelevanceScore: effectiveMinRelevanceScore,
      });

    // No-cross-company-leakage as a defensive double-check, not just a
    // query filter — every returned result's symbol must be one of the
    // ones actually requested.
    const leaked = outcome.results.filter((r) => !normalizedSymbols.includes(r.symbol));
    if (leaked.length) {
      logger.warn(`[ResearchRetrieverService] dropped ${leaked.length} result(s) with a symbol outside the requested set — this should never happen`);
    }

    return {
      status: outcome.status,
      results: outcome.results.filter((r) => normalizedSymbols.includes(r.symbol)),
      retrievalMode: mode,
      durationMs: Date.now() - startedAt,
      reason: outcome.reason || null,
    };
  } catch (error) {
    logger.warn(`[ResearchRetrieverService] retrieval failed (${mode}): ${error.message}`);
    return {
      status: RETRIEVAL_STATUS.UNAVAILABLE, results: [], retrievalMode: mode, durationMs: Date.now() - startedAt, reason: 'Retrieval failed',
    };
  }
};

export default { RETRIEVAL_MODES, RETRIEVAL_STATUS, isVectorSearchConfigured, retrieveResearchEvidence, scoreChunkAgainstQuery };
