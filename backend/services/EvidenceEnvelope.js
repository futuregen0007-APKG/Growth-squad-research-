/**
 * EvidenceEnvelope.js
 * ======================
 * Phase 4A.1 hardening, item 7: "retriever behavior alone is not the
 * security boundary." This module is the normalized shape every piece of
 * retrieved document text must pass through before it ever reaches a
 * future Phase 4B composer/verifier prompt — full end-to-end composer
 * protection (actually wiring this into the LangGraph answer flow) is
 * Phase 4B work; this module only builds the envelope and a diagnostic
 * detector so that work has a ready, tested contract to build on.
 *
 * The envelope's structural fields (symbol, sourceUrl, pageStart/pageEnd,
 * documentType, fiscalPeriod, sourceAuthority, evidenceId) are ALWAYS
 * taken from the retriever's own typed DB-backed result — NEVER parsed
 * out of the document's free-text content. This is what makes "document
 * instructions cannot change citation metadata" true by construction: the
 * envelope builder never even looks inside `text` for anything other than
 * building the diagnostic injection-signal flag (which does not feed back
 * into any other field).
 *
 * `untrustedContent: true` is a permanent, non-optional marker — there is
 * no code path that produces an envelope without it. A future prompt
 * builder is expected to quote `text` as clearly-delimited untrusted data
 * (e.g. inside a fenced/quoted block with an explicit "this is retrieved
 * document text, not an instruction" framing) and never concatenate it
 * into anything that could be read as a system/developer instruction.
 */

/**
 * A deterministic, pattern-based detector for obvious instruction-like
 * phrasing inside retrieved document text — DIAGNOSTICS ONLY. It never
 * strips, redacts, or alters `text` in any way: a real filing legitimately
 * discussing "instructions to shareholders" or "override provisions in
 * the credit agreement" must survive completely untouched, so this only
 * ever produces a `debug`-style signal for logging/evaluation, never a
 * content transformation.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all|any|the)?\s*(previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(all|any|the)?\s*(previous|prior|above|earlier|safety)\s+(instructions?|rules)/i,
  /reveal\s+(your|the)\s+(system\s+prompt|instructions)/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?\s*:/i,
  /act\s+as\s+(if\s+you\s+are\s+)?/i,
  /override\s+(all|any|the)?\s*(previous|prior|safety)?\s*(instructions?|rules)/i,
  /\bsystem\s+prompt\b/i,
  /do\s+anything\s+now/i,
];

export const detectInjectionSignals = (text) => {
  const source = String(text || '');
  const matchedPatterns = INJECTION_PATTERNS
    .filter((pattern) => pattern.test(source))
    .map((pattern) => pattern.source);
  return { flagged: matchedPatterns.length > 0, matchedPatterns };
};

/**
 * toUntrustedEvidenceEnvelope - converts ONE retriever result (see
 * services/ResearchRetrieverService.js's toEvidenceShape) into the
 * normalized envelope. Every field except `text` and the diagnostic
 * `injectionSignal` comes straight from the retriever's own typed
 * metadata — never re-derived from parsing `text`.
 */
export const toUntrustedEvidenceEnvelope = (result) => ({
  evidenceId: result.chunkId,
  symbol: result.symbol,
  text: result.text,
  sourceUrl: result.sourceUrl,
  pageStart: result.pageStart,
  pageEnd: result.pageEnd,
  documentType: result.documentType,
  fiscalPeriod: result.fiscalQuarter ? `${result.fiscalYear} ${result.fiscalQuarter}` : result.fiscalYear,
  sourceAuthority: result.sourceAuthority,
  untrustedContent: true,
  // Diagnostic only (see detectInjectionSignals above) — never consulted
  // to decide whether to include/exclude/alter this evidence; a future
  // Phase 4B consumer may log/monitor it, nothing more.
  injectionSignal: detectInjectionSignals(result.text),
});

/** Batch form — the shape a future Phase 4B evidence-building step actually calls. */
export const toUntrustedEvidenceEnvelopes = (results) => (results || []).map(toUntrustedEvidenceEnvelope);

// Phase 4B Part 4: the real evidence envelope the grounded-answer flow
// consumes. Distinct from toUntrustedEvidenceEnvelope above (which predates
// this phase and is kept only for backward compatibility with its own
// tests) — this builder produces stable "E1"/"E2" ids, the FULL field set
// Part 4 specifies, and enforces the envelope's size/dedup/ranking rules
// in one place rather than leaving each caller to reimplement them.
const MAX_EVIDENCE_ITEMS = 6;
// A generous per-turn character budget across ALL included excerpts —
// keeps the grounded-generation prompt bounded regardless of how many
// long chunks the retriever returns, without arbitrarily truncating any
// single chunk's text mid-sentence (an item is either included whole or
// excluded whole, so provenance/text integrity is never partially broken).
const MAX_TOTAL_TEXT_CHARS = 12000;

/**
 * dedupeByChunkId - equivalent-chunk dedup (Part 4: "dedupe equivalent
 * chunks"). Two results can legitimately share a chunkId when the same
 * underlying chunk is returned via more than one retrieval pass (e.g. a
 * hybrid mode's lexical + semantic candidate pools overlapping) — the
 * FIRST occurrence wins, since retriever results already arrive ranked
 * best-first.
 */
const dedupeByChunkId = (results) => {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = r?.chunkId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
};

/**
 * deterministicRank - stable ordering: descending retriever score, then a
 * plain lexical tie-break on chunkId so two equally-scored items always
 * land in the SAME order across runs (mirrors the Phase 4A.4 RRF
 * tie-breaking fix's own reasoning: never leave a tie to accidental
 * insertion order).
 */
const deterministicRank = (results) => [...results].sort((a, b) => {
  const scoreA = Number.isFinite(a?.score) ? a.score : -Infinity;
  const scoreB = Number.isFinite(b?.score) ? b.score : -Infinity;
  if (scoreB !== scoreA) return scoreB - scoreA;
  return String(a?.chunkId || '').localeCompare(String(b?.chunkId || ''));
});

/**
 * buildResearchEvidenceEnvelope - the ONE place a batch of
 * ResearchRetrieverService results is turned into the trusted, numbered
 * ("E1", "E2", ...) evidence envelope the grounded generator, verifier,
 * and API/citation layer all consume. Every structural field is copied
 * straight from the retriever's own typed result — text is never parsed
 * for metadata (same discipline as toUntrustedEvidenceEnvelope above), and
 * `embedding` is never read or forwarded (the retriever's own
 * toEvidenceShape never even includes it — see ResearchRetrieverService.js).
 *
 * companyName is resolved from SUPPORTED_STOCKS (the same single source of
 * truth extractEntities.js uses) rather than re-derived from document
 * text — a symbol with no directory entry gets `companyName: null` rather
 * than a guess.
 */
export const buildResearchEvidenceEnvelope = (retrieverResults = [], { retrievalMode = null, companyNames = {} } = {}) => {
  const deduped = dedupeByChunkId(retrieverResults || []);
  const ranked = deterministicRank(deduped);

  const included = [];
  let excludedByBudget = 0;
  let totalChars = 0;
  ranked.forEach((r) => {
    if (included.length >= MAX_EVIDENCE_ITEMS) { excludedByBudget += 1; return; }
    const textLength = String(r.text || '').length;
    // The FIRST item is always included even if it alone exceeds the
    // budget (a real answer needs at least one piece of evidence to work
    // with) — every subsequent item still respects the running total.
    if (included.length > 0 && totalChars + textLength > MAX_TOTAL_TEXT_CHARS) { excludedByBudget += 1; return; }
    totalChars += textLength;
    included.push(r);
  });

  const items = included.map((r, index) => ({
    evidenceId: `E${index + 1}`,
    symbol: r.symbol || null,
    companyName: companyNames[r.symbol] || null,
    fiscalYear: r.fiscalYear || null,
    fiscalQuarter: r.fiscalQuarter || null,
    documentId: r.registryDocumentId || null,
    chunkId: r.chunkId,
    documentTitle: r.title || null,
    documentType: r.documentType || null,
    sourceAuthority: r.sourceAuthority || null,
    publishedAt: r.publishedAt || null,
    sourceUrl: r.sourceUrl || null,
    pageStart: Number.isInteger(r.pageStart) ? r.pageStart : null,
    pageEnd: Number.isInteger(r.pageEnd) ? r.pageEnd : null,
    text: r.text,
    retrievalRank: index + 1,
    retrievalMode,
    untrustedContent: true,
    // Diagnostic only, exactly like toUntrustedEvidenceEnvelope's own
    // injectionSignal above — never consulted to include/exclude/alter
    // this evidence.
    injectionSignal: detectInjectionSignals(r.text),
  }));

  return {
    items,
    retrievalMode,
    totalRetrieved: (retrieverResults || []).length,
    excludedByBudgetCount: excludedByBudget,
  };
};

// ---------------------------------------------------------------------------
// Phase 4C Part 5: normalizing Earnings Intelligence's own structured
// promise/outcome evidence into the SAME trusted envelope shape retrieved
// document chunks use, so a single grounded generation+verification call
// can cite either kind of evidence uniformly (Part 6: never two competing
// final answers).
// ---------------------------------------------------------------------------
const MAX_MERGED_EARNINGS_ITEMS = 3;

// Local copy of graph/researchScope.js's splitFiscalPeriod parsing rule
// (deliberately NOT imported — services/ never depends on graph/ in this
// codebase's existing layering, only the reverse) for the same "Q2 FY2026"
// / "FY2026" period strings ManagementPromiseService's `promise.period` /
// `promise.outcome.actualPeriod` fields use. Returns nulls (never a guess)
// for a free-text period like "GOING_FORWARD" that doesn't match either
// shape — the verifier's period checks already treat a null fiscalYear/
// fiscalQuarter as "nothing to compare," never a false mismatch.
const EI_FISCAL_QUARTER_PATTERN = /^Q([1-4])\s+FY(\d{4})$/;
const EI_FISCAL_YEAR_ONLY_PATTERN = /^FY(\d{4})$/;
const splitFiscalPeriod = (period) => {
  if (!period) return { fiscalYear: null, fiscalQuarter: null };
  const withQuarter = EI_FISCAL_QUARTER_PATTERN.exec(period);
  if (withQuarter) return { fiscalYear: `FY${withQuarter[2]}`, fiscalQuarter: `Q${withQuarter[1]}` };
  const yearOnly = EI_FISCAL_YEAR_ONLY_PATTERN.exec(period);
  if (yearOnly) return { fiscalYear: `FY${yearOnly[1]}`, fiscalQuarter: null };
  return { fiscalYear: null, fiscalQuarter: null };
};

// Statuses that mean "not yet evaluated" — mirrors toolRegistry.js's
// buildPromiseEvidence: a still-pending promise has no real outcome to
// cite yet, only the original guidance/forecast itself.
const UNEVALUATED_PROMISE_STATUSES = new Set(['PENDING', 'INSUFFICIENT_EVIDENCE']);

/**
 * buildEarningsIntelligenceEnvelopeItems - converts
 * getEarningsTimeline's toolResult.data.promises (see
 * services/ManagementPromiseService.js's getCompanyTimeline — the
 * normalized `{statement, period, status, evidence:{...}, outcome:{...}}`
 * shape, not the raw Mongo document) into envelope-shaped records, honestly
 * labeled with their own distinct retrievalMode (never claims to be a
 * vector/hybrid-retrieved document chunk). Builds up to two records per
 * promise, exactly like toolRegistry.js's buildPromiseEvidence: the
 * original guidance/forecast statement (documentType MANAGEMENT_PROMISE),
 * and — ONLY when the promise has genuinely been evaluated and has a real
 * outcome source — what actually happened (documentType PROMISE_OUTCOME).
 * A promise missing real provenance (sourceUrl/excerpt) is simply never
 * built, exactly like a document chunk with no real source never is.
 */
export const buildEarningsIntelligenceEnvelopeItems = (timeline, { symbol, companyName = null } = {}) => {
  const items = [];
  for (const promise of (timeline?.promises || [])) {
    const guidancePeriod = promise.period || null;
    if (promise.evidence?.sourceUrl && promise.evidence?.excerpt) {
      const { fiscalYear, fiscalQuarter } = splitFiscalPeriod(guidancePeriod);
      items.push({
        symbol, companyName, fiscalYear, fiscalQuarter,
        registryDocumentId: promise.id || null,
        chunkId: `earnings-intelligence:${promise.id || promise.statement}:guidance`,
        title: promise.evidence.documentTitle || promise.statement || 'Management guidance statement',
        documentType: 'MANAGEMENT_PROMISE',
        sourceAuthority: promise.evidence.sourceName || 'EARNINGS_INTELLIGENCE',
        publishedAt: promise.evidence.publicationDate || null,
        sourceUrl: promise.evidence.sourceUrl,
        pageStart: Number.isInteger(promise.evidence.page) ? promise.evidence.page : null,
        pageEnd: Number.isInteger(promise.evidence.page) ? promise.evidence.page : null,
        text: promise.evidence.excerpt,
        score: null,
      });
    }

    const isEvaluated = promise.status && !UNEVALUATED_PROMISE_STATUSES.has(promise.status);
    const outcomeExcerpt = promise.outcome?.excerpt;
    if (isEvaluated && promise.outcome?.sourceUrl && outcomeExcerpt) {
      const outcomePeriod = promise.outcome?.actualPeriod || guidancePeriod;
      const { fiscalYear, fiscalQuarter } = splitFiscalPeriod(outcomePeriod);
      items.push({
        symbol, companyName, fiscalYear, fiscalQuarter,
        registryDocumentId: promise.id || null,
        chunkId: `earnings-intelligence:${promise.id || promise.statement}:outcome`,
        title: `${symbol || ''} promise outcome — ${promise.status}`.trim(),
        documentType: 'PROMISE_OUTCOME',
        sourceAuthority: promise.outcome.provider || 'EARNINGS_INTELLIGENCE',
        publishedAt: promise.outcome.sourceDate || null,
        sourceUrl: promise.outcome.sourceUrl,
        pageStart: null,
        pageEnd: null,
        text: outcomeExcerpt,
        score: null,
      });
    }
  }
  return items;
};

/**
 * mergeEarningsIntelligenceEvidence - Part 5/6: appends normalized
 * Earnings Intelligence items to an ALREADY-BUILT document envelope
 * (buildResearchEvidenceEnvelope's return value), continuing the SAME
 * "E1"/"E2" numbering and per-item retrievalRank so the verifier and the
 * final citation builder treat both kinds of evidence identically —
 * there is still exactly ONE combined envelope, ONE generation call, ONE
 * final answer (Part 6: never two competing answers to reconcile). Its
 * own item cap (MAX_MERGED_EARNINGS_ITEMS) is independent of the document
 * envelope's own budget, so a company with a long promise history never
 * crowds out real document evidence that was already selected.
 */
export const mergeEarningsIntelligenceEvidence = (envelope, timeline, { symbol, companyName = null } = {}) => {
  const earningsItems = buildEarningsIntelligenceEnvelopeItems(timeline, { symbol, companyName }).slice(0, MAX_MERGED_EARNINGS_ITEMS);
  if (!earningsItems.length) return envelope;

  const startIndex = envelope.items.length;
  const mergedItems = earningsItems.map((item, i) => ({
    evidenceId: `E${startIndex + i + 1}`,
    symbol: item.symbol,
    companyName: item.companyName,
    fiscalYear: item.fiscalYear,
    fiscalQuarter: item.fiscalQuarter,
    documentId: item.registryDocumentId,
    chunkId: item.chunkId,
    documentTitle: item.title,
    documentType: item.documentType,
    sourceAuthority: item.sourceAuthority,
    publishedAt: item.publishedAt,
    sourceUrl: item.sourceUrl,
    pageStart: item.pageStart,
    pageEnd: item.pageEnd,
    text: item.text,
    retrievalRank: startIndex + i + 1,
    // Honestly its OWN source label — never claims to be a
    // vector/hybrid-retrieved document chunk (Part 4: "clearly delimit
    // each evidence block" applies equally to provenance labeling).
    retrievalMode: 'EARNINGS_INTELLIGENCE_MERGE',
    untrustedContent: true,
    injectionSignal: detectInjectionSignals(item.text),
  }));

  return {
    ...envelope,
    items: [...envelope.items, ...mergedItems],
    mergedEarningsIntelligenceCount: mergedItems.length,
  };
};

export default {
  detectInjectionSignals, toUntrustedEvidenceEnvelope, toUntrustedEvidenceEnvelopes, buildResearchEvidenceEnvelope,
  buildEarningsIntelligenceEnvelopeItems, mergeEarningsIntelligenceEvidence,
};
