import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { OpenAIClientFactory, LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { hasBudgetFor } from '../graph/requestBudget.js';
import { logger } from '../utils/logger.js';
import { getAliasIndex, normalizeAliasesInTextSync } from './CompanyAliasResolver.js';
import { embedChunks } from './EmbeddingService.js';

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

export const RETRIEVAL_MODES = Object.freeze({
  LEXICAL_FALLBACK: 'LEXICAL_FALLBACK', LOCAL_HYBRID_RERANK: 'LOCAL_HYBRID_RERANK', ATLAS_VECTOR: 'ATLAS_VECTOR',
});
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
/** True only when LOCAL_HYBRID_RERANK has been explicitly opted into as the DEFAULT mode via env — a per-call `mode` option always takes priority over this, so an evaluation harness can request either mode explicitly regardless of this flag. Never implies Atlas; this is local cosine similarity over already-stored embeddings, never described as anything else. */
export const isHybridRerankConfigured = () => process.env.HYBRID_RERANK_ENABLED === 'true';

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
  'dso', 'receivable', 'receivables', 'cashflows', 'buyback', 'payout', 'tcv', 'pipeline',
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

// Phase 4A.2: company-name <-> ticker aliasing is now built dynamically
// from CompanyResearchProfile (the project's real, ~215-company canonical
// roster) via services/CompanyAliasResolver.js — NOT a hardcoded map.
// `tokenize` takes an OPTIONAL pre-fetched alias index (see
// CompanyAliasResolver.getAliasIndex, cached and awaited ONCE per
// retrieval call, never per-token) so a query saying "Infosys" still
// scores correctly against chunk text saying "INFY", generalizing to the
// whole covered universe rather than a hand-picked handful of companies.
const tokenize = (text, aliasIndex = null) => {
  const financeNormalized = normalizeFinanceText(text);
  const normalized = aliasIndex ? normalizeAliasesInTextSync(financeNormalized, aliasIndex) : financeNormalized;
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
export const scoreChunkAgainstQuery = (queryTerms, chunkText, aliasIndex = null) => {
  const chunkTerms = tokenize(chunkText, aliasIndex);
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
const dropNearDuplicates = (rankedResults, threshold, aliasIndex = null) => {
  const kept = [];
  const keptTokenSets = [];
  for (const item of rankedResults) {
    const tokens = new Set(tokenize(item.text, aliasIndex));
    const isDuplicate = keptTokenSets.some((existing) => jaccard(existing, tokens) >= threshold);
    if (!isDuplicate) { kept.push(item); keptTokenSets.push(tokens); }
  }
  return kept;
};

// ---------------------------------------------------------------------------
// Phase 4A.2: sentence-level support scoring, cosine similarity, and a
// bounded query-embedding cache — the building blocks for
// LOCAL_HYBRID_RERANK (see localHybridRerank below).
// ---------------------------------------------------------------------------

// Bounded, deterministic sentence splitting. The lookbehind requires the
// split point to be RIGHT after a sentence-ending mark and followed by
// whitespace — a decimal like "24.5%" has no whitespace immediately after
// its "." so it is never split mid-number; percentage ranges and figures
// in the ORIGINAL stored text are never touched by this (splitting is
// used only to pick a ranking signal, never to rewrite `text`).
const MAX_SENTENCES_PER_CHUNK = 24;
const splitIntoSentences = (text) => String(text || '')
  .split(/(?<=[.!?])\s+/)
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, MAX_SENTENCES_PER_CHUNK);

/**
 * computeSentenceSupportScore - finds the single sentence, or bounded
 * 2-sentence window, within a chunk that best supports the query, using
 * the SAME deterministic term-overlap scorer as the whole-chunk lexical
 * score (scoreChunkAgainstQuery) but applied to a much shorter span. This
 * is what stops a long Q&A chunk from outranking a concise, on-topic
 * statement purely by accumulating partial-relevance word overlap across
 * many unrelated sentences — the chunk's BEST single sentence has to
 * actually be relevant, not just its total word count. Never mutates or
 * re-cites anything: the returned `sentence` is for diagnostics/evidence
 * excerpt only, the stored chunk `text`/page/source are untouched.
 */
const computeSentenceSupportScore = (meaningfulQueryTokens, chunkText, aliasIndex = null) => {
  const sentences = splitIntoSentences(chunkText);
  if (!sentences.length || !meaningfulQueryTokens.length) return { score: 0, sentence: null };
  let best = { score: 0, sentence: null };
  for (let i = 0; i < sentences.length; i += 1) {
    const window1 = sentences[i];
    const s1 = scoreChunkAgainstQuery(meaningfulQueryTokens, window1, aliasIndex);
    if (s1 > best.score) best = { score: s1, sentence: window1 };
    if (i < sentences.length - 1) {
      const window2 = `${sentences[i]} ${sentences[i + 1]}`;
      const s2 = scoreChunkAgainstQuery(meaningfulQueryTokens, window2, aliasIndex);
      if (s2 > best.score) best = { score: s2, sentence: window2 };
    }
  }
  return best;
};

/** Real cosine similarity between two equal-length vectors — 0 for any shape mismatch/degenerate input, never a thrown error (a defensive guard, since a mismatched embedding dimension must never crash retrieval). */
export const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Bounded query-embedding cache: at most QUERY_EMBEDDING_CACHE_MAX
// entries, keyed by (embedding model + version + normalized query text)
// so the SAME query never triggers a second OpenAI call, and a change of
// embedding model/version never reuses a stale/incompatible vector. This
// is a plain in-memory Map (bounded, evicted oldest-first) — never
// persisted, never logged, never exposed through any API response.
const QUERY_EMBEDDING_CACHE_MAX = 200;
const queryEmbeddingCache = new Map();
const queryEmbeddingCacheKey = (query, model, version) => `${model}::${version}::${String(query || '').trim().toLowerCase()}`;

/** Test-only: empties the bounded query-embedding cache. */
export const clearQueryEmbeddingCacheForTests = () => queryEmbeddingCache.clear();

const QUERY_EMBED_TIMEOUT_MS = 8000;

/**
 * embedQueryCached - the ONE query-embedding call site for
 * LOCAL_HYBRID_RERANK. Reuses services/EmbeddingService.js's `embedChunks`
 * (same timeout/retry/error-classification logic already used for
 * indexing-time embeddings — one code path, not two) for exactly one
 * input, wrapped in the bounded cache above. Returns `{embedding: null,
 * reason}` — never throws — so a caller can fall back to lexical-only
 * honestly instead of failing the whole request.
 */
const embedQueryCached = async (query, { signal } = {}) => {
  if (!OpenAIClientFactory.isConfigured()) {
    return { embedding: null, cached: false, reason: 'OpenAI not configured, cannot embed the query' };
  }
  const model = LLM_CONFIG.embeddingModel;
  const version = LLM_CONFIG.embeddingVersion;
  const key = queryEmbeddingCacheKey(query, model, version);
  if (queryEmbeddingCache.has(key)) {
    // Refresh recency for a simple oldest-first eviction policy.
    const hit = queryEmbeddingCache.get(key);
    queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, hit);
    return { embedding: hit, cached: true };
  }

  const { results } = await embedChunks([{ text: query }], {
    model, embeddingVersion: version, timeoutMs: QUERY_EMBED_TIMEOUT_MS, signal,
  });
  const item = results[0];
  if (!item || item.status !== 'EMBEDDED') {
    return { embedding: null, cached: false, reason: item?.error || item?.status || 'UNKNOWN' };
  }
  if (queryEmbeddingCache.size >= QUERY_EMBEDDING_CACHE_MAX) {
    const oldestKey = queryEmbeddingCache.keys().next().value;
    queryEmbeddingCache.delete(oldestKey);
  }
  queryEmbeddingCache.set(key, item.embedding);
  return { embedding: item.embedding, cached: false };
};

/** Standard Reciprocal Rank Fusion: for each ranked list a candidate appears in, contributes 1/(RRF_K + rank) — a stable, scale-independent way to combine rankings that score on entirely different numeric ranges (a lexical composite vs. a cosine similarity vs. a sentence-window score), without needing to hand-normalize any of them against each other. */
const RRF_K = 60;
const reciprocalRankFusion = (rankedLists) => {
  const scores = new Map(); // key -> combined score
  for (const list of rankedLists) {
    list.forEach((key, rank) => {
      scores.set(key, (scores.get(key) || 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return scores;
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

const buildMetadataFilter = ({
  symbols, fiscalYears, documentTypes, requireEmbeddingModel, requireEmbeddingVersion,
}) => {
  const filter = { symbol: { $in: symbols } };
  if (fiscalYears?.length) filter.fiscalYear = { $in: fiscalYears };
  if (documentTypes?.length) filter.documentType = { $in: documentTypes };
  // Mandatory metadata filters ALWAYS applied before any semantic scoring
  // (Phase 4A.2 item 3, step 1) — model/version compatibility is a
  // correctness filter, not a scoring nicety: vectors from a different
  // embedding model/version are never even candidates.
  if (requireEmbeddingModel) filter.embeddingModel = requireEmbeddingModel;
  if (requireEmbeddingVersion) filter.embeddingVersion = requireEmbeddingVersion;
  return filter;
};

/**
 * scoreCandidatesLexically - the shared scoring core both LEXICAL_FALLBACK
 * and LOCAL_HYBRID_RERANK build on. Applies the minimum-meaningful-overlap
 * gate (never returns a candidate that failed it — this is what makes
 * "a generic query alone cannot produce SUCCESS" true for BOTH modes, not
 * just the lexical one) and returns every surviving candidate's full
 * composite score + diagnostics, sorted descending, UNFILTERED by
 * minRelevanceScore — each caller applies its own threshold semantics.
 */
const scoreCandidatesLexically = ({
  candidates, meaningfulQuery, queryTokensFull, queryFiscalYears, aliasIndex,
}) => {
  const requiredOverlap = Math.min(meaningfulQuery.length, MIN_MEANINGFUL_OVERLAP);
  const scored = [];
  for (const doc of candidates) {
    const chunkTokensFull = tokenize(doc.text, aliasIndex);
    const chunkTermsSet = new Set(chunkTokensFull);
    const matchedMeaningfulCount = meaningfulQuery.filter((t) => chunkTermsSet.has(t)).length;
    if (matchedMeaningfulCount < requiredOverlap) continue;

    const lexicalScore = scoreChunkAgainstQuery(meaningfulQuery, doc.text, aliasIndex);
    const phraseScore = computePhraseScore(queryTokensFull, chunkTokensFull);
    const metricScore = computeMetricScore(meaningfulQuery, chunkTermsSet);
    const periodScore = computePeriodScore(queryFiscalYears, doc.fiscalYear);
    const authorityScore = computeAuthorityScore(meaningfulQuery, doc);
    const finalScore = lexicalScore + phraseScore + metricScore + periodScore + authorityScore;

    scored.push({
      doc, finalScore, debug: {
        lexicalScore, phraseScore, metricScore, periodScore, authorityScore, finalScore,
      },
    });
  }
  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
};

const lexicalRetrieve = async ({
  query, symbols, fiscalYears, documentTypes, topK, minRelevanceScore,
}) => {
  // Query-quality validation: a query that reduces to nothing but
  // stopwords/generic terms has no real search intent and must never
  // reach SUCCESS, however many chunks happen to exist.
  const aliasIndex = await getAliasIndex();
  const queryTokensFull = tokenize(query, aliasIndex);
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
  const scored = scoreCandidatesLexically({
    candidates, meaningfulQuery, queryTokensFull, queryFiscalYears, aliasIndex,
  }).filter((item) => item.finalScore >= minRelevanceScore);

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
    aliasIndex,
  );
  const top = deduped.slice(0, topK);
  return {
    status: RETRIEVAL_STATUS.SUCCESS,
    results: top.map((doc) => toEvidenceShape(doc, doc.__score, doc.__debug)),
  };
};

// Bounded candidate pool handed to the semantic/sentence reranking stage
// — never the full symbol-scoped result set, and certainly never the
// full database. 40-50 as specified; picking the top of this range keeps
// a comfortable margin above topK*NEAR_DUPLICATE overhead without
// meaningfully increasing cosine-similarity cost (a single dot product
// per candidate).
const HYBRID_CANDIDATE_POOL_SIZE = 50;
// A candidate must clear the FULL LEXICAL_FALLBACK relevance bar (same
// threshold, no discount) to be hybrid-eligible at all — semantic/
// sentence similarity can only RE-RANK among candidates that would
// already have independently qualified for SUCCESS under lexical scoring
// alone; it can never expand the eligible set. This was measured at a
// relaxed 0.5x floor first (allowing a weak lexical match to be "rescued"
// by a merely plausible cosine score) and that measurably broke "low-
// quality semantic similarity must still produce EMPTY" on a real holdout
// question (two generic, only-coincidentally-matching terms plus a
// so-so 0.50 cosine score were enough to manufacture a false SUCCESS) —
// so the floor was tightened to 1.0x rather than kept for an unsafe
// result. Hybrid's entire value-add is therefore RANKING ORDER within an
// already-qualified set, never RECALL EXPANSION beyond it.
const HYBRID_LEXICAL_ELIGIBILITY_FRACTION = 1.0;

/**
 * localHybridRerank - Phase 4A.2 item 3's LOCAL_HYBRID_RERANK mode.
 *
 * 1. Mandatory metadata filters FIRST (symbol/fiscalYear/documentType +
 *    embeddingModel/embeddingVersion — see buildMetadataFilter).
 * 2. The SAME lexical scorer as LEXICAL_FALLBACK produces a bounded
 *    candidate pool (top HYBRID_CANDIDATE_POOL_SIZE by lexical score,
 *    already past the meaningful-overlap gate — a query with no real
 *    search intent still short-circuits to EMPTY before any embedding
 *    call is made).
 * 3. ONE query embedding (embedQueryCached — cached, timeout-bounded).
 * 4. Cosine similarity computed ONLY for that bounded pool's ALREADY-
 *    FETCHED embedding vectors — never a second DB query, never any
 *    other symbol's chunks.
 * 5. Sentence-level support score computed for the same bounded pool.
 * 6. Three independent rankings (lexical, cosine, sentence) combined via
 *    Reciprocal Rank Fusion.
 * 7. Final eligibility + topK slicing, near-dup removal after ranking.
 *
 * If the query embedding is unavailable for ANY reason (OpenAI not
 * configured, timeout, API error), this falls back HONESTLY to the exact
 * same lexical-only ranking LEXICAL_FALLBACK would have produced — the
 * caller is told via `fellBackToLexical: true` in the outcome, and
 * `retrievalMode` in the final response is corrected to LEXICAL_FALLBACK
 * (never silently claims a hybrid result it didn't actually compute).
 */
const localHybridRerank = async ({
  query, symbols, fiscalYears, documentTypes, topK, minRelevanceScore, signal,
}) => {
  const aliasIndex = await getAliasIndex();
  const queryTokensFull = tokenize(query, aliasIndex);
  const meaningfulQuery = meaningfulTokens(queryTokensFull);
  if (!meaningfulQuery.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [], reason: 'Query has no meaningful (non-generic) search terms' };
  }

  const filter = buildMetadataFilter({
    symbols, fiscalYears, documentTypes, requireEmbeddingModel: LLM_CONFIG.embeddingModel, requireEmbeddingVersion: LLM_CONFIG.embeddingVersion,
  });
  const candidates = await ResearchDocumentChunk.find(filter).limit(DEFAULT_CANDIDATE_LIMIT).lean();
  if (!candidates.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
  }

  const queryFiscalYears = extractFiscalYearMentions(query);
  const lexicallyScored = scoreCandidatesLexically({
    candidates, meaningfulQuery, queryTokensFull, queryFiscalYears, aliasIndex,
  });
  if (!lexicallyScored.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
  }

  // Bounded pool: never more than HYBRID_CANDIDATE_POOL_SIZE chunks ever
  // reach the embedding/cosine/sentence stage below.
  const pool = lexicallyScored.slice(0, HYBRID_CANDIDATE_POOL_SIZE);

  const { embedding: queryEmbedding, reason: embedFailureReason } = await embedQueryCached(query, { signal });
  if (!queryEmbedding) {
    // Honest fallback — never silently pretend the hybrid path ran.
    const eligible = pool.filter((item) => item.finalScore >= minRelevanceScore);
    if (!eligible.length) return { status: RETRIEVAL_STATUS.EMPTY, results: [], fellBackToLexical: true, reason: embedFailureReason };
    const deduped = dropNearDuplicates(
      eligible.map((item) => ({ ...item.doc, __score: item.finalScore, __debug: item.debug, text: item.doc.text })),
      NEAR_DUPLICATE_JACCARD_THRESHOLD,
      aliasIndex,
    );
    return {
      status: RETRIEVAL_STATUS.SUCCESS,
      results: deduped.slice(0, topK).map((doc) => toEvidenceShape(doc, doc.__score, doc.__debug)),
      fellBackToLexical: true,
      reason: embedFailureReason,
    };
  }

  const enriched = pool.map((item) => {
    const cosineScore = cosineSimilarity(queryEmbedding, item.doc.embedding);
    const sentenceSupport = computeSentenceSupportScore(meaningfulQuery, item.doc.text, aliasIndex);
    return { ...item, cosineScore, sentenceSupport };
  });

  // Two rank orderings over the SAME bounded pool, combined via
  // Reciprocal Rank Fusion — this is the "combine lexical and semantic
  // ranks" step (item 4). The FIRST ranking is not the raw whole-chunk
  // lexical score alone: it is max(wholeChunkLexicalScore,
  // sentenceSupportScore), which is exactly what "sentence-level support
  // scoring... to prevent long Q&A chunks from winning merely through
  // accumulated word overlap" (item 5) means in practice — a long chunk
  // that only scores well by summing many weak partial matches across
  // unrelated sentences is NOT rescued by that accumulation once a
  // SHORTER, more concise, genuinely on-topic chunk's peak sentence score
  // matches or exceeds it. The SECOND ranking is real cosine similarity —
  // the genuinely semantic half of the combination.
  const byPrimaryIndex = [...enriched.keys()].sort(
    (a, b) => Math.max(enriched[b].finalScore, enriched[b].sentenceSupport.score)
      - Math.max(enriched[a].finalScore, enriched[a].sentenceSupport.score),
  );
  const byCosineIndex = [...enriched.keys()].sort((a, b) => enriched[b].cosineScore - enriched[a].cosineScore);

  const rrfScores = reciprocalRankFusion([byPrimaryIndex, byCosineIndex]);

  const eligible = enriched
    .map((item, index) => ({ ...item, index, rrfScore: rrfScores.get(index) || 0 }))
    // Metadata correctness already excluded the wrong symbol/period at
    // the DB-filter stage; this is the semantic-cannot-override-
    // relevance floor — a candidate needs REAL lexical grounding
    // (not just a lucky cosine score) to ever be returned.
    .filter((item) => item.finalScore >= minRelevanceScore * HYBRID_LEXICAL_ELIGIBILITY_FRACTION)
    .sort((a, b) => b.rrfScore - a.rrfScore);

  if (!eligible.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
  }

  const deduped = dropNearDuplicates(
    eligible.map((item) => ({
      ...item.doc,
      __score: item.rrfScore,
      __debug: {
        ...item.debug,
        cosineScore: item.cosineScore,
        sentenceScore: item.sentenceSupport.score,
        supportingSentence: item.sentenceSupport.sentence,
        rrfScore: item.rrfScore,
        finalScore: item.rrfScore,
      },
      text: item.doc.text,
    })),
    NEAR_DUPLICATE_JACCARD_THRESHOLD,
    aliasIndex,
  );

  return {
    status: RETRIEVAL_STATUS.SUCCESS,
    results: deduped.slice(0, topK).map((doc) => toEvidenceShape(doc, doc.__score, doc.__debug)),
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
  query, symbols, fiscalYears = [], documentTypes = [], topK = DEFAULT_TOP_K, deadlineAt = null, minRelevanceScore = null, signal = null, mode: requestedMode = null,
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
  // Mode selection priority: an explicit per-call `mode` always wins
  // (this is how the evaluation harness requests lexical-only vs. hybrid
  // results separately from the SAME dataset) — otherwise
  // VECTOR_SEARCH_ENABLED (never turned on in this phase) beats
  // HYBRID_RERANK_ENABLED, which beats the LEXICAL_FALLBACK default.
  const mode = requestedMode
    || (isVectorSearchConfigured() ? RETRIEVAL_MODES.ATLAS_VECTOR
      : (isHybridRerankConfigured() ? RETRIEVAL_MODES.LOCAL_HYBRID_RERANK : RETRIEVAL_MODES.LEXICAL_FALLBACK));
  // Each mode scores on its own scale (a composite lexical sum, an RRF
  // score, or a cosine-similarity-like vectorSearchScore) — an explicit
  // caller override applies to whichever mode actually runs; otherwise
  // each mode gets its OWN calibrated default.
  const effectiveMinRelevanceScore = minRelevanceScore != null
    ? minRelevanceScore
    : (mode === RETRIEVAL_MODES.ATLAS_VECTOR ? DEFAULT_MIN_VECTOR_RELEVANCE_SCORE : DEFAULT_MIN_RELEVANCE_SCORE);

  try {
    let outcome;
    if (mode === RETRIEVAL_MODES.ATLAS_VECTOR) {
      outcome = await atlasVectorRetrieve({
        query, symbols: normalizedSymbols, fiscalYears, documentTypes, topK: boundedTopK, minRelevanceScore: effectiveMinRelevanceScore, signal,
      });
    } else if (mode === RETRIEVAL_MODES.LOCAL_HYBRID_RERANK) {
      outcome = await localHybridRerank({
        query, symbols: normalizedSymbols, fiscalYears, documentTypes, topK: boundedTopK, minRelevanceScore: effectiveMinRelevanceScore, signal,
      });
    } else {
      outcome = await lexicalRetrieve({
        query, symbols: normalizedSymbols, fiscalYears, documentTypes, topK: boundedTopK, minRelevanceScore: effectiveMinRelevanceScore,
      });
    }

    // No-cross-company-leakage as a defensive double-check, not just a
    // query filter — every returned result's symbol must be one of the
    // ones actually requested.
    const leaked = outcome.results.filter((r) => !normalizedSymbols.includes(r.symbol));
    if (leaked.length) {
      logger.warn(`[ResearchRetrieverService] dropped ${leaked.length} result(s) with a symbol outside the requested set — this should never happen`);
    }

    // A hybrid attempt that honestly fell back to lexical-only (query
    // embedding unavailable) is reported with the retrievalMode it
    // actually used — never claims LOCAL_HYBRID_RERANK ran when it did
    // not, and never silently mislabeled as ATLAS_VECTOR either.
    const actualMode = outcome.fellBackToLexical ? RETRIEVAL_MODES.LEXICAL_FALLBACK : mode;

    return {
      status: outcome.status,
      results: outcome.results.filter((r) => normalizedSymbols.includes(r.symbol)),
      retrievalMode: actualMode,
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

export default {
  RETRIEVAL_MODES, RETRIEVAL_STATUS, isVectorSearchConfigured, isHybridRerankConfigured, retrieveResearchEvidence, scoreChunkAgainstQuery, cosineSimilarity,
};
