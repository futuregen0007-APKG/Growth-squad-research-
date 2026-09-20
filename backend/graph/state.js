import { Annotation } from '@langchain/langgraph';

/**
 * state.js
 * =========
 * GS Copilot's typed LangGraph state (Annotation.Root — the installed
 * @langchain/langgraph@1.4.8's official state API). Deliberately excludes:
 *   - API keys / auth tokens (read from env/req at the controller boundary,
 *     never placed in state or persisted checkpoints)
 *   - Full raw provider payloads (tools compact these into evidence records)
 *   - Chain-of-thought (never generated, never stored)
 *
 * This graph does NOT use a LangGraph checkpointer (none of
 * @langchain/langgraph-checkpoint-mongodb or similar is installed — see
 * the Phase 1 audit). Thread memory is restored explicitly into `messages`
 * by services/ChatThreadService.js before graph.invoke/stream is called;
 * see controllers/ChatController.js.
 */

const replace = (_current, update) => update;

/**
 * mergeToolResults - Phase 2 pre-implementation check #4. Phase 2's bounded
 * replan cycle (assessEvidenceSufficiency -> replanMissingEvidence ->
 * executeTools -> validateEvidence) calls executeTools a second time in the
 * same turn. executeTools.js returns a FRESH {toolResults, evidence, ...}
 * covering only the steps it just ran -- under the old `replace` reducer,
 * round 2's return value would silently wipe out every round-1 result the
 * moment the graph applied the update. This reducer instead accumulates.
 *
 * Identity = fingerprint (graph/toolFingerprint.js's normalized
 * tool+args key -- the same identity executeTools.js already uses for its
 * own request-local dedup within a single round), so:
 *   - a genuinely new fingerprint (a different symbol, tool, or args a
 *     replan round adds) is always appended as its own entry;
 *   - a round that happens to re-touch the SAME fingerprint (e.g. a retry)
 *     updates that one entry in place rather than duplicating it;
 *   - a later FAILURE/ERROR/UNAVAILABLE for a fingerprint that already
 *     succeeded is dropped -- once real data is in hand for a
 *     symbol+operation, a subsequent unlucky attempt at the exact same
 *     fingerprint must never make it look unavailable again. A later
 *     SUCCESS is still allowed to refresh an earlier SUCCESS's data
 *     (fresher real data is strictly better than stale real data).
 * Entries missing a fingerprint (defensive only -- every real executeTools
 * result carries one) are never merged/deduped against anything, so a
 * malformed entry can only ever add, never silently vanish.
 */
export const mergeToolResults = (current = [], update = []) => {
  if (!update.length) return current;
  const merged = new Map();
  let anonymousCounter = 0;
  current.forEach((result) => {
    const key = result?.fingerprint || `__no-fingerprint-current-${anonymousCounter++}`;
    merged.set(key, result);
  });
  update.forEach((result) => {
    const key = result?.fingerprint;
    if (!key) { merged.set(`__no-fingerprint-update-${anonymousCounter++}`, result); return; }
    const existing = merged.get(key);
    if (existing && existing.status === 'SUCCESS' && result.status !== 'SUCCESS') return;
    merged.set(key, result);
  });
  return [...merged.values()];
};

/**
 * mergeEvidence - Phase 2 pre-implementation check #4 (evidence side).
 * Identity here is deliberately NOT evidenceId: buildEvidenceRecord
 * (graph/evidence.js) mints a fresh UUID on every single call, so two
 * evidence records built from the exact same underlying provider fact
 * (e.g. a replan round re-fetching the same live quote) would never
 * collide on evidenceId even though they represent the same real-world
 * fact. Instead this dedupes on the record's actual content identity —
 * claim type + symbol + source + period + published date + title — so a
 * second round's re-observation of an already-known fact never duplicates
 * it, while two genuinely different facts (different symbol, claim type,
 * source/period) are always both kept.
 *
 * An identity MATCH replaces the existing entry in place (never just
 * dropped) rather than keeping whichever came first — this is what keeps
 * validateEvidence.js's own dedup+prompt-trim step working correctly:
 * validateEvidence deliberately re-returns `evidence: evidenceForPrompt(
 * deduped)`, a TRIMMED transformation of the exact same records already in
 * state.evidence (same identity, fewer fields) — that update must replace
 * the untrimmed originals, not be silently discarded as "already seen."
 */
const evidenceIdentityKey = (record = {}) => [
  record.claimType, record.symbol, record.sourceUrl, record.reportingPeriod, record.publishedAt, record.title,
].map((value) => (value === null || value === undefined ? '' : String(value))).join('|');

export const mergeEvidence = (current = [], update = []) => {
  if (!update.length) return current;
  const merged = new Map(current.map((record) => [evidenceIdentityKey(record), record]));
  update.forEach((record) => { merged.set(evidenceIdentityKey(record), record); });
  return [...merged.values()];
};

export const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  userId: Annotation({ reducer: replace, default: () => null }),
  threadId: Annotation({ reducer: replace, default: () => null }),
  requestId: Annotation({ reducer: replace, default: () => null }),
  // Phase 5A Part 2: a SEPARATE, purely observability-scoped identifier
  // from requestId above (which keeps its own pre-existing meaning —
  // thread/message correlation, SSE payloads). traceId is either accepted
  // from a strictly-validated incoming header or minted fresh — see
  // services/telemetry/traceContext.js — and is safe to hand to an
  // external tracing backend (CloudWatch/OTel) with no PII risk.
  traceId: Annotation({ reducer: replace, default: () => null }),
  currentMessageId: Annotation({ reducer: replace, default: () => null }),
  turnStartedAt: Annotation({ reducer: replace, default: () => null }),

  // Phase 1 (performance/reliability). deadlineAt is set exactly ONCE, in
  // validateInput — see graph/requestBudget.js. Every later node only
  // reads it (via remainingMs/boundedTimeout), never resets or extends it.
  deadlineAt: Annotation({ reducer: replace, default: () => null }),
  // The request's AbortSignal (client disconnect OR deadline expiry —
  // see controllers/ChatController.js). Transient, exactly like onEvent/
  // aborted below: never persisted, never part of any checkpoint (this
  // graph has none).
  abortSignal: Annotation({ reducer: replace, default: () => null }),
  // One entry per LLM call this turn: {node, role, model, inputTokens,
  // outputTokens, durationMs, timedOut}. Never the prompt text or the
  // parsed content — see logDiagnostics.js.
  llmCalls: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
  // Fingerprints of tool calls executeTools collapsed into a single real
  // execution this turn (see graph/toolFingerprint.js) — a safe count/list
  // for diagnostics, never re-derived from toolResults after the fact.
  deduplicatedToolCalls: Annotation({ reducer: replace, default: () => [] }),
  // One entry per graph node this turn: {node, durationMs} — set by
  // graph.js's withNodeTiming wrapper (see graph/timing.js), never by the
  // node functions themselves, so every node (not just the LLM-calling
  // ones) is covered without repeating timing boilerplate in each file.
  nodeTimings: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),

  // Short-term memory restored from ChatThread/ChatMessage before this
  // turn's model calls. `recentHistory` holds the last N prior turns
  // VERBATIM (plain {role, content} objects — never summarized);
  // `conversationSummary` covers everything older than that window.
  conversationSummary: Annotation({ reducer: replace, default: () => null }),
  recentHistory: Annotation({ reducer: replace, default: () => [] }),
  activeEntities: Annotation({ reducer: replace, default: () => ({ symbols: [], companyNames: [] }) }),

  intent: Annotation({ reducer: replace, default: () => null }),
  intentConfidence: Annotation({ reducer: replace, default: () => null }),

  entities: Annotation({
    reducer: replace,
    default: () => ({ symbols: [], companyNames: [], periods: [], comparisonMode: false }),
  }),

  // Phase 2 "requested-dimension planning" (graph/dimensions.js) — the
  // strict-enum data types the message actually asked for (PRICE,
  // FINANCIALS, NEWS, GUIDANCE, ...), computed deterministically once in
  // extractEntities and consumed by planTools' canonical compareStocks
  // design and by the evidence-coverage matrix below.
  requestedDimensions: Annotation({ reducer: replace, default: () => [] }),

  // Long-term memory (UserPreference) — read-only within a turn; writes go
  // through ChatThreadService.saveExplicitPreferences from saveMemory.
  userContext: Annotation({
    reducer: replace,
    default: () => ({ riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] }),
  }),

  toolPlan: Annotation({ reducer: replace, default: () => [] }),
  // Phase 2 pre-check #4: executeTools may run a second time this turn (the
  // bounded replan cycle) — these two fields accumulate across rounds
  // instead of the round-2 return value overwriting round-1's, via
  // mergeToolResults/mergeEvidence above. toolPlan itself stays `replace`:
  // each round's plan is a fresh, self-contained instruction to executeTools,
  // not something later rounds append to.
  toolResults: Annotation({ reducer: mergeToolResults, default: () => [] }),
  evidence: Annotation({ reducer: mergeEvidence, default: () => [] }),

  // Phase 2 evidence-coverage matrix (assessEvidenceSufficiency) — recomputed
  // FRESH from the full accumulated toolResults/evidence every time that
  // node runs (never incremental itself — `replace` is correct here; the
  // accumulation already happened one layer down, in toolResults/evidence).
  evidenceCoverage: Annotation({ reducer: replace, default: () => [] }),
  missingEvidence: Annotation({ reducer: replace, default: () => [] }),
  // How many replan cycles have run this turn (hard cap: 1 — see
  // replanMissingEvidence.js). The node computes current+1 itself and
  // returns that, so `replace` is correct; this field is never reset mid-turn.
  replanCount: Annotation({ reducer: replace, default: () => 0 }),
  // Every tool-call fingerprint attempted this turn, across BOTH rounds —
  // a deduplicating union (not a plain concat) so a replan round that
  // happens to re-touch a round-1 fingerprint is still counted once.
  toolCallFingerprints: Annotation({
    reducer: (current = [], update = []) => (update.length ? [...new Set([...current, ...update.filter(Boolean)])] : current),
    default: () => [],
  }),
  // Total underlying PROVIDER operations this turn (a single planned step
  // like compareStocks can internally fan out to several — see its
  // MAX_COMPARISON_OPERATIONS budget) — distinct from the top-level
  // MAX_TOOL_CALLS_PER_REQUEST, which counts planned STEPS, not the calls
  // each step may make underneath. Sums across rounds, never replaced.
  providerOperationCount: Annotation({
    reducer: (current = 0, update = 0) => current + (Number.isFinite(update) ? update : 0),
    default: () => 0,
  }),
  // Transient routing signal set by assessEvidenceSufficiency and read
  // ONLY by graph.js's conditional edge right after it — never persisted,
  // never read by any other node (same category as onEvent/aborted below).
  needsReplan: Annotation({ reducer: replace, default: () => false }),

  // Phase 3: the PRIVATE, unvalidated draft composeAnswer/repairAnswer
  // produce. Never emitted over SSE, never persisted — see
  // nodes/publishFinalAnswer.js, the only place content ever moves from
  // draftAnswer into the public `answer` field, and only after validation
  // has actually passed (or a deterministic safe fallback replaces it
  // entirely — see nodes/buildSafeFallback.js).
  draftAnswer: Annotation({ reducer: replace, default: () => null }),
  // One of schemas.js's VALIDATION_STATUSES. Recomputed fresh by
  // validateFinalAnswer every time it runs (including its second pass
  // after a repair) — `replace` is correct, this is never accumulated.
  validationStatus: Annotation({ reducer: replace, default: () => null }),
  // Safe issue codes only (graph/claimValidation.js's SAFE_VALIDATION_REASONS
  // + the verifier's own reasonCode strings) — never raw model text,
  // never chain-of-thought. Reflects the LATEST validation pass only; a
  // prior round's now-fixed issues are not accumulated (repairCount tells
  // you whether there was a prior round at all).
  validationIssues: Annotation({ reducer: replace, default: () => [] }),
  // The structured claim verifier's per-claim verdicts, when it ran this
  // pass — {claimId, verdict, evidenceIndexes, reasonCode}[]. Same
  // "latest pass only" reasoning as validationIssues.
  claimValidation: Annotation({ reducer: replace, default: () => [] }),
  // How many repair attempts have run this turn (hard cap: 1 — see
  // nodes/repairAnswer.js). The node computes current+1 itself and
  // returns that, so `replace` is correct.
  repairCount: Annotation({ reducer: replace, default: () => 0 }),

  answer: Annotation({ reducer: replace, default: () => null }),
  citations: Annotation({ reducer: replace, default: () => [] }),
  tokenUsage: Annotation({ reducer: replace, default: () => null }),

  // Phase 4B: grounded RAG answer generation. `researchEvidence` is the
  // trusted evidence envelope built by retrieveGroundedEvidence/
  // buildResearchEvidenceEnvelope (see services/EvidenceEnvelope.js) —
  // "E1"/"E2"-style stable ids, kept in a SEPARATE field from the legacy
  // `evidence` array above (different shape, different provenance
  // discipline) so the Phase 1-3 pipeline is never touched. Populated once
  // per turn by executeTools (no cross-round accumulation like
  // mergeEvidence — Phase 4B's bounded repair never re-retrieves), so
  // `replace` is correct.
  researchEvidence: Annotation({ reducer: replace, default: () => [] }),
  // Phase 4D: the trusted, server-computed cross-source temporal
  // relationships between researchEvidence items (SUPERSEDES/REPEATS/
  // SUPPORTS/CONFLICTS/OUTCOME_FOR/UNRESOLVED — see
  // services/temporalRelationships.js), attached by executeTools.js's
  // reconcileEvidenceEnvelope call alongside researchEvidence itself.
  // Shown to the model as reference-only context (graph/prompts/index.js)
  // and consulted directly by graph/groundedVerification.js — never
  // created or modified by the model.
  researchRelationships: Annotation({ reducer: replace, default: () => [] }),
  // The actual ResearchRetrieverService mode used this turn (e.g.
  // 'LOCAL_HYBRID_RERANK') — always the REAL mode the retriever reports,
  // never the requested one if it silently fell back (see
  // ResearchRetrieverService.js's retrievalMode field). Exposed in the API
  // response (Part 9) so a client can tell dev-mode retrieval apart from a
  // future Atlas mode without guessing from env config.
  retrievalMode: Annotation({ reducer: replace, default: () => null }),
  // The model's structured grounded-answer output (schemas.js's
  // GroundedAnswerSchema) — `claims` here are PRE-verification; only
  // groundedClaims (below) carries the trusted, server-computed
  // verificationStatus. Never sent to the client directly.
  groundedAnswer: Annotation({ reducer: replace, default: () => null }),
  // Final per-claim verdicts AFTER deterministic verification (and the one
  // possible repair pass) — {claimId, text, claimType, evidenceIds,
  // verificationStatus}[]. Recomputed fresh on every validation pass
  // (including the repaired one), never accumulated.
  groundedClaims: Annotation({ reducer: replace, default: () => [] }),
  // 'grounded' | 'partially_grounded' | 'insufficient_evidence' — computed
  // by the server from the FINAL verified claims, never trusted from the
  // model's own self-reported value (Part 5/6: the model may not grade its
  // own work).
  groundingStatus: Annotation({ reducer: replace, default: () => null }),
  coverage: Annotation({ reducer: replace, default: () => null }),
  // Whether the bounded grounded-answer repair actually ran this turn —
  // distinct from the shared `repairCount` (which also covers the legacy
  // Phase 3 pipeline) so the API response can report it directly.
  repairAttempted: Annotation({ reducer: replace, default: () => false }),

  warnings: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
  errors: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),

  // Phase 5A Part 7: composeAnswer.js's own resolveResearchScope verdict,
  // persisted so operational telemetry can distinguish "ambiguous company"/
  // "no research corpus needed" from other failure categories without
  // re-parsing draftAnswer text. Never used for any routing/answer-content
  // decision — composeAnswerInner already made that decision itself,
  // this is purely an observability mirror of it.
  scopeSignal: Annotation({ reducer: replace, default: () => null }),

  // Streaming callback set by the controller — not persisted, not part of
  // any checkpoint (this graph has none), purely an in-memory hook the
  // composeAnswer node uses to emit token/status events as they happen.
  onEvent: Annotation({ reducer: replace, default: () => null }),

  // Abort check set by the controller (returns true once the client has
  // disconnected or called stop) — composeAnswer polls it between stream
  // chunks so generation halts promptly instead of running to completion
  // after nobody is listening.
  aborted: Annotation({ reducer: replace, default: () => null }),
});

export default GraphState;
