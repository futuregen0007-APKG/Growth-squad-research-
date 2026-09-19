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

import { normalizeGuidanceEvidence } from './guidanceNormalization.js';
import { detectRelationships } from './temporalRelationships.js';

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
export const buildResearchEvidenceEnvelope = (retrieverResults = [], {
  retrievalMode = null, companyNames = {}, chunkAnnotationsByChunkId = new Map(),
} = {}) => {
  const deduped = dedupeByChunkId(retrieverResults || []);
  const ranked = deterministicRank(deduped);

  // Phase 4D: "reconciliation occurs before context budgeting so the
  // budget does not discard the only current/revised record while
  // retaining an obsolete one." Computed on the FULL ranked pool (using
  // chunkId as the temporary identity — real "E#" ids don't exist yet at
  // this stage) purely to decide which items get first claim on the
  // MAX_EVIDENCE_ITEMS/MAX_TOTAL_TEXT_CHARS budget below; it never
  // changes the underlying retrieval SCORE or reorders anything among
  // items with no temporal relationship to each other. A chunk found
  // SUPERSEDED by another chunk THAT IS ALSO in this pool is moved behind
  // every non-superseded item (but still kept, budget permitting) — its
  // superseding sibling is guaranteed to compete for a budget slot first.
  //
  // Phase 4E.1: `chunkAnnotationsByChunkId` (a VERIFIED-only lookup result,
  // pre-fetched by the async orchestration layer — see
  // graph/tools/toolRegistry.js's retrieveGroundedEvidence — over the
  // COMPLETE bounded candidate pool, BEFORE this function ever runs) is
  // threaded into the SAME pre-budget canonicalization pass a runtime-only
  // text parse used to only get after budgeting. This module itself never
  // performs any database I/O — it only ever consumes a plain Map its
  // caller already built.
  const canonicalForBudgeting = ranked
    .map((r) => normalizeGuidanceEvidence({ ...r, evidenceId: r.chunkId }, {
      chunkAnnotation: chunkAnnotationsByChunkId.get(String(r.chunkId)) || null,
    }))
    .filter((c) => c.confidence !== 'unresolved');
  const supersededChunkIds = new Set(
    detectRelationships(canonicalForBudgeting)
      .filter((rel) => rel.type === 'SUPERSEDES')
      .map((rel) => rel.toEvidenceId),
  );
  const prioritized = ranked.filter((r) => !supersededChunkIds.has(r.chunkId));
  const deprioritized = ranked.filter((r) => supersededChunkIds.has(r.chunkId));
  const budgetOrder = [...prioritized, ...deprioritized];

  const included = [];
  let excludedByBudget = 0;
  let totalChars = 0;
  budgetOrder.forEach((r) => {
    if (included.length >= MAX_EVIDENCE_ITEMS) { excludedByBudget += 1; return; }
    const textLength = String(r.text || '').length;
    // The FIRST item is always included even if it alone exceeds the
    // budget (a real answer needs at least one piece of evidence to work
    // with) — every subsequent item still respects the running total.
    if (included.length > 0 && totalChars + textLength > MAX_TOTAL_TEXT_CHARS) { excludedByBudget += 1; return; }
    totalChars += textLength;
    included.push(r);
  });

  const items = included.map((r, index) => {
    const chunkAnnotation = chunkAnnotationsByChunkId.get(String(r.chunkId)) || null;
    return {
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
      // Only ever present when the caller's pre-fetched map had a VERIFIED
      // entry for this chunk (Phase 4E.1) — absent entirely otherwise, so
      // reconcileEvidenceEnvelope's existing `item.chunkAnnotation || null`
      // fallback behaves identically to before this field existed.
      ...(chunkAnnotation ? { chunkAnnotation } : {}),
    };
  });

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
        // Phase 4D Part 2: the REAL structured guidance fields
        // ManagementPromiseService.js's getCompanyTimeline already
        // normalizes (metric/targetValue/targetUnit) — carried through so
        // graph/guidanceNormalization.js can use them DIRECTLY instead of
        // re-parsing the excerpt text, which is strictly more reliable
        // for an Earnings-Intelligence-sourced record.
        //
        // Phase 4F fix: `promise.operator` is REQUIRED here, not just
        // `promise.metric` — a genuinely qualitative promise (e.g. "we
        // don't give specific guidance, but we're more optimistic") is
        // stored with operator: null (see scripts/earningsImport.js's
        // OPERATOR_MAP.QUALITATIVE) precisely because it has no real
        // numeric target; but the underlying Mongoose schema requires
        // promise.targetValue to be a Number, so a qualitative promise's
        // absent target gets coerced to 0 on import. Without this operator
        // check, that coerced 0 would pass `Number.isFinite` below and
        // silently masquerade as a genuine "target: 0" quantified claim —
        // a real hallucinated-field bug this audit surfaced live (TCS's
        // qualitative Q2 FY2026 international-revenue promise was
        // producing a fabricated canonicalGuidance of "revenue = 0").
        // Phase 4F.2 Part 2: a genuinely qualitative promise (operator
        // null -- the ONLY way earningsImport.js's OPERATOR_MAP ever
        // produces a null operator, exclusively for its own QUALITATIVE
        // case; see that module) now gets its OWN structured signal
        // instead of being silently left null. This is what lets a real
        // record like TCS-FY2026-002 ("we are more optimistic...") flow
        // into guidanceNormalization.js's qualitative branch instead of
        // falling all the way to the unstructured text fallback, while
        // STILL never inventing a numeric targetValue (Phase 4F's own
        // fix for the coerced-0 bug stays in force below).
        // Phase 4F.2: `promise.operator === null` STRICTLY (never just
        // falsy/undefined) is the qualitative signal -- earningsImport.js's
        // OPERATOR_MAP is the ONLY place that ever produces a real,
        // explicit null here (its QUALITATIVE case), so this can never be
        // confused with a record that simply omits the field (e.g. an
        // older/looser test fixture or a legacy shape that never set
        // `operator` at all, which stays on the pre-existing `null`
        // structuredGuidance -> text-fallback path exactly as before).
        structuredGuidance: promise.metric && promise.operator ? {
          metric: promise.metric, targetValue: promise.targetValue, targetUnit: promise.targetUnit, operator: promise.operator,
        } : (promise.metric && promise.operator === null && promise.evidence?.excerpt ? {
          metric: promise.metric, valueType: 'QUALITATIVE', qualitativeText: promise.evidence.excerpt,
        } : null),
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
        // Phase 4F.2: an outcome is usually numeric (e.g. TCS-FY2026-002's
        // real "0.6% QoQ" result) but a genuinely qualitative outcome
        // (management describing what happened in words, no reported
        // figure) gets the SAME qualitative structured signal the promise
        // side does, rather than silently falling to the text fallback.
        // Symmetric with the promise-side signal above: an outcome is only
        // ever treated as qualitative when the ORIGINAL promise itself was
        // (operator === null, strictly) AND no real numeric outcome value
        // was captured -- never merely because a numeric value happens to
        // be missing for some unrelated data-quality reason.
        structuredGuidance: promise.metric && Number.isFinite(promise.outcome?.actualValue) ? {
          metric: promise.metric, targetValue: promise.outcome.actualValue, targetUnit: promise.outcome.actualUnit || promise.targetUnit, operator: null,
        } : (promise.metric && promise.operator === null && !Number.isFinite(promise.outcome?.actualValue) ? {
          metric: promise.metric, valueType: 'QUALITATIVE', qualitativeText: outcomeExcerpt,
        } : null),
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
    structuredGuidance: item.structuredGuidance || null,
  }));

  return {
    ...envelope,
    items: [...envelope.items, ...mergedItems],
    mergedEarningsIntelligenceCount: mergedItems.length,
  };
};

// ---------------------------------------------------------------------------
// Phase 4D Part 4: EvidenceEnvelope temporal annotations. Runs on the
// FINAL, already-budgeted envelope (documents + any merged Earnings
// Intelligence items, real "E#" ids assigned) — this is what actually
// fixes the root cause: relationships are computed by CANONICAL scope
// (symbol/metricKey/targetFiscalYear/targetQuarter), never by
// documentType, so a document chunk and a later Earnings-Intelligence
// record for the exact same guidance lineage are correctly compared.
// Every value here is server-computed and deterministic — the model never
// creates or modifies temporalStatus/supersededByEvidenceId/
// supersedesEvidenceIds/relationshipIds (Part 4's explicit requirement).
// ---------------------------------------------------------------------------

/**
 * temporalStatusFor - the single per-item status derived from this
 * item's relationships:
 *   - UNRESOLVED: normalization itself was uncertain (never guessed).
 *   - HISTORICAL: an outcome-kind record (a realized past fact is never
 *     "current guidance") or a record that OUTCOME_FOR's another.
 *   - CONFLICTING: involved in a CONFLICTS relationship either way — a
 *     real disagreement this deterministic layer could not safely
 *     resolve (never silently picked).
 *   - SUPERSEDED: is the `toEvidenceId` of a SUPERSEDES relationship.
 *   - CURRENT: everything else — including a lone, unchallenged
 *     disclosure, and the `fromEvidenceId` side of a SUPERSEDES.
 */
const temporalStatusFor = (evidenceId, canonicalById, relationships) => {
  const canonical = canonicalById.get(evidenceId);
  if (!canonical || canonical.confidence === 'unresolved') return 'UNRESOLVED';
  if (canonical.guidanceKind === 'outcome') return 'HISTORICAL';

  const involving = relationships.filter((r) => r.fromEvidenceId === evidenceId || r.toEvidenceId === evidenceId);
  if (involving.some((r) => r.type === 'CONFLICTS')) return 'CONFLICTING';
  if (involving.some((r) => r.type === 'SUPERSEDES' && r.toEvidenceId === evidenceId)) return 'SUPERSEDED';
  if (involving.some((r) => r.type === 'OUTCOME_FOR' && r.fromEvidenceId === evidenceId)) return 'HISTORICAL';
  return 'CURRENT';
};

/**
 * reconcileEvidenceEnvelope - Part 4's main entry point. Takes the
 * complete, already-budgeted envelope (buildResearchEvidenceEnvelope's
 * output, optionally already merged with Earnings Intelligence items) and
 * returns a NEW envelope whose items carry additive temporal fields:
 * `temporalStatus`, `supersededByEvidenceId`, `supersedesEvidenceIds`,
 * `relationshipIds`, and the canonical guidance fields themselves
 * (`canonicalGuidance`) when normalization succeeded. `envelope.relationships`
 * carries the full relationship list. Every existing field (evidenceId,
 * citation provenance, dedup, ordering) is passed through completely
 * unchanged — this only ever ADDS metadata, never removes or reorders.
 */
export const reconcileEvidenceEnvelope = (envelope) => {
  const items = envelope?.items || [];
  // `chunkAnnotation`, when present, was attached by buildResearchEvidenceEnvelope
  // itself (Phase 4E.1 — from a pre-fetched map its caller passed in, never
  // a database read this module performs) — an item with no such field
  // (every existing Phase 4D test fixture, and any item nobody has
  // annotated yet) falls through to `null` here exactly as before this
  // field existed.
  const canonicalRecords = items.map((item) => normalizeGuidanceEvidence(item, {
    structured: item.structuredGuidance || null,
    chunkAnnotation: item.chunkAnnotation || null,
  }));
  const canonicalById = new Map(canonicalRecords.map((c) => [c.evidenceId, c]));
  const relationships = detectRelationships(canonicalRecords).map((rel, index) => ({ ...rel, relationshipId: `R${index + 1}` }));

  const relationshipIdsFor = (evidenceId) => relationships
    .filter((r) => r.fromEvidenceId === evidenceId || r.toEvidenceId === evidenceId)
    .map((r) => r.relationshipId);

  const supersededByFor = (evidenceId) => {
    const rel = relationships.find((r) => r.type === 'SUPERSEDES' && r.toEvidenceId === evidenceId);
    return rel ? rel.fromEvidenceId : null;
  };
  const supersedesFor = (evidenceId) => relationships
    .filter((r) => r.type === 'SUPERSEDES' && r.fromEvidenceId === evidenceId)
    .map((r) => r.toEvidenceId);
  // Phase 4F.2 Part 6: an OUTCOME item's own fulfillmentEvaluable flag
  // (see services/temporalRelationships.js), surfaced onto the item itself
  // so groundedVerification.js can check it without needing the whole
  // relationships array threaded through separately — the SAME pattern
  // supersededByEvidenceId/supersedesEvidenceIds already use.
  const fulfillmentInfoFor = (evidenceId) => {
    const rel = relationships.find((r) => r.type === 'OUTCOME_FOR' && r.fromEvidenceId === evidenceId);
    if (!rel) return { fulfillmentEvaluable: null, fulfillmentReason: null };
    return { fulfillmentEvaluable: rel.fulfillmentEvaluable, fulfillmentReason: rel.fulfillmentReason };
  };

  const annotatedItems = items.map((item) => {
    const canonical = canonicalById.get(item.evidenceId);
    const fulfillment = fulfillmentInfoFor(item.evidenceId);
    return {
      ...item,
      temporalStatus: temporalStatusFor(item.evidenceId, canonicalById, relationships),
      supersededByEvidenceId: supersededByFor(item.evidenceId),
      supersedesEvidenceIds: supersedesFor(item.evidenceId),
      relationshipIds: relationshipIdsFor(item.evidenceId),
      // Additive; null/null for anything that isn't the OUTCOME side of an
      // OUTCOME_FOR relationship (every existing item is unaffected).
      fulfillmentEvaluable: fulfillment.fulfillmentEvaluable,
      fulfillmentReason: fulfillment.fulfillmentReason,
      canonicalGuidance: canonical && canonical.confidence !== 'unresolved' ? {
        metric: canonical.metric,
        metricKey: canonical.metricKey,
        targetFiscalYear: canonical.targetFiscalYear,
        targetQuarter: canonical.targetQuarter,
        guidanceKind: canonical.guidanceKind,
        valueType: canonical.valueType,
        lowerBound: canonical.lowerBound,
        upperBound: canonical.upperBound,
        exactValue: canonical.exactValue,
        unit: canonical.unit,
        currency: canonical.currency,
        // Phase 4F.2: additive, present only for a genuine valueType
        // 'qualitative' record -- absent (undefined, never even null-
        // valued) on every existing numeric citation so nothing that
        // reads this object today sees a new field it doesn't expect.
        ...(canonical.valueType === 'qualitative' ? {
          qualitativeDirection: canonical.qualitativeDirection,
          qualitativeText: canonical.qualitativeText,
        } : {}),
      } : null,
    };
  });

  return { ...envelope, items: annotatedItems, relationships };
};

export default {
  detectInjectionSignals, toUntrustedEvidenceEnvelope, toUntrustedEvidenceEnvelopes, buildResearchEvidenceEnvelope,
  buildEarningsIntelligenceEnvelopeItems, mergeEarningsIntelligenceEvidence, reconcileEvidenceEnvelope,
};
