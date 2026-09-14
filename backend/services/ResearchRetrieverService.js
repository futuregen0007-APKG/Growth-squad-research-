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
const DEFAULT_MIN_RELEVANCE_SCORE = 0.15;
const DEFAULT_CANDIDATE_LIMIT = 500; // bound on how many chunks a metadata-filtered query pulls before in-memory lexical scoring
const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.9;

/** True only when Atlas Vector Search has been explicitly opted into — never inferred from mongoose version, connection scheme, or anything else. */
export const isVectorSearchConfigured = () => process.env.VECTOR_SEARCH_ENABLED === 'true';

const tokenize = (text) => (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);

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

const toEvidenceShape = (doc, score) => ({
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
  score,
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
  const filter = buildMetadataFilter({ symbols, fiscalYears, documentTypes });
  const candidates = await ResearchDocumentChunk.find(filter).limit(DEFAULT_CANDIDATE_LIMIT).lean();
  if (!candidates.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
  }

  const queryTerms = tokenize(query);
  const scored = candidates
    .map((doc) => ({ doc, score: scoreChunkAgainstQuery(queryTerms, doc.text) }))
    .filter((item) => item.score >= minRelevanceScore)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { status: RETRIEVAL_STATUS.EMPTY, results: [] };
  }

  const deduped = dropNearDuplicates(scored.map((item) => ({ ...item.doc, __score: item.score, text: item.doc.text })), NEAR_DUPLICATE_JACCARD_THRESHOLD);
  const top = deduped.slice(0, topK);
  return {
    status: RETRIEVAL_STATUS.SUCCESS,
    results: top.map((doc) => toEvidenceShape(doc, doc.__score)),
  };
};

const atlasVectorRetrieve = async ({
  query, symbols, fiscalYears, documentTypes, topK, minRelevanceScore, signal,
}) => {
  if (!OpenAIClientFactory.isConfigured()) {
    return { status: RETRIEVAL_STATUS.UNSUPPORTED, results: [], reason: 'OpenAI not configured, cannot embed the query' };
  }
  let queryEmbedding;
  try {
    const client = OpenAIClientFactory.getClient();
    const response = await client.embeddings.create({ model: LLM_CONFIG.embeddingModel, input: [query] }, signal ? { signal } : undefined);
    queryEmbedding = response.data?.[0]?.embedding;
  } catch (error) {
    logger.warn(`[ResearchRetrieverService] failed to embed query for Atlas vector search: ${error.message}`);
    return { status: RETRIEVAL_STATUS.UNAVAILABLE, results: [], reason: 'Query embedding failed' };
  }
  if (!queryEmbedding) return { status: RETRIEVAL_STATUS.UNAVAILABLE, results: [], reason: 'Query embedding failed' };

  const filter = buildMetadataFilter({ symbols, fiscalYears, documentTypes });
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
          index: 'research_chunk_vector_index',
          path: 'embedding',
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
  query, symbols, fiscalYears = [], documentTypes = [], topK = DEFAULT_TOP_K, deadlineAt = null, minRelevanceScore = DEFAULT_MIN_RELEVANCE_SCORE, signal = null,
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

  try {
    const outcome = mode === RETRIEVAL_MODES.ATLAS_VECTOR
      ? await atlasVectorRetrieve({
        query, symbols: normalizedSymbols, fiscalYears, documentTypes, topK: boundedTopK, minRelevanceScore, signal,
      })
      : await lexicalRetrieve({
        query, symbols: normalizedSymbols, fiscalYears, documentTypes, topK: boundedTopK, minRelevanceScore,
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
