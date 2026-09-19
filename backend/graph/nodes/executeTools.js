import { TOOL_REGISTRY } from '../tools/toolRegistry.js';
import { fingerprintToolCall } from '../toolFingerprint.js';
import { hasBudgetFor } from '../requestBudget.js';
import { mergeEarningsIntelligenceEvidence, reconcileEvidenceEnvelope } from '../../services/EvidenceEnvelope.js';
import { SUPPORTED_STOCKS } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';

const STATUS_LABEL = Object.freeze({
  getLiveQuote: 'Checking live market data…',
  getCompanyResearch: 'Searching company research…',
  getCompanyFinancials: 'Reviewing company financials…',
  getCompanyNews: 'Checking recent news…',
  getEarningsTimeline: 'Reviewing management promises…',
  getManagementPromiseDetails: 'Reviewing management promises…',
  searchResearchDocuments: 'Searching research documents…',
  getWatchlist: 'Checking your watchlist…',
  getPortfolio: 'Checking your portfolio…',
  compareStocks: 'Comparing companies…',
  retrieveGroundedEvidence: 'Retrieving evidence from research documents…',
});

// A tool call needs at least this much remaining budget to be worth
// attempting at all — well below any tool's natural timeout (10-25s), so
// this only skips work when the deadline is genuinely almost/already gone,
// never a normal in-budget request.
const MIN_TOOL_BUDGET_MS = 300;

const budgetExhaustedResult = (toolName) => ({
  tool: toolName, status: 'ERROR', data: null, evidence: [],
  resultCount: 0, evidenceCount: 0, errorCode: 'DEADLINE_EXCEEDED',
  fetchedAt: new Date().toISOString(), warning: 'Ran out of time before this could be checked.',
});

/**
 * executeTools - runs every DISTINCT planned tool call in parallel
 * (Promise.allSettled — Phase 11's "parallel independent tools"). One
 * tool throwing/rejecting never discards the others' results.
 *
 * Phase 1 additions:
 *  - request-local deduplication: two planned steps with the same
 *    normalizedToolName+canonicalArgs fingerprint (e.g. the live-observed
 *    duplicate getCompanyFinancials calls) execute the underlying tool
 *    exactly once and share its result/evidence — never duplicated evidence
 *    records, never a second real provider call. Every originally-planned
 *    step still gets its own tool.started/tool.completed SSE events (the
 *    frontend's contract is unchanged), and state.deduplicatedToolCalls
 *    records which fingerprints were collapsed, for diagnostics.
 *  - deadline awareness: a step is not even attempted once the request's
 *    remaining budget is below MIN_TOOL_BUDGET_MS — it comes back as a
 *    safe DEADLINE_EXCEEDED result instead of hanging past the turn's
 *    total time budget.
 *  - cancellation: state.abortSignal is passed into every tool's context
 *    so tools/providers that support it can be genuinely aborted (see
 *    toolRegistry.js); tools that can't still stop *awaiting* it safely.
 */
export const executeTools = async (state) => {
  if (state.errors.length || !state.toolPlan.length) return {};

  const steps = state.toolPlan;
  const fingerprints = steps.map(fingerprintToolCall);
  const firstIndexByFingerprint = new Map();
  fingerprints.forEach((fp, i) => { if (!firstIndexByFingerprint.has(fp)) firstIndexByFingerprint.set(fp, i); });
  const uniqueIndexes = [...firstIndexByFingerprint.values()];
  const deduplicatedToolCalls = steps
    .map((step, i) => ({ step, i, fingerprint: fingerprints[i] }))
    .filter(({ i, fingerprint }) => firstIndexByFingerprint.get(fingerprint) !== i)
    .map(({ step, fingerprint }) => ({ tool: step.tool, fingerprint }));

  if (state.onEvent) {
    steps.forEach((step) => {
      state.onEvent({ type: 'tool.started', tool: step.tool });
      state.onEvent({ type: 'status', message: STATUS_LABEL[step.tool] || 'Gathering information…' });
    });
  }

  const context = { userId: state.userId, signal: state.abortSignal, deadlineAt: state.deadlineAt };

  const settledByIndex = new Map();
  await Promise.allSettled(
    uniqueIndexes.map(async (index) => {
      const step = steps[index];
      const fn = TOOL_REGISTRY[step.tool];
      if (!fn) {
        settledByIndex.set(index, { status: 'fulfilled', value: { tool: step.tool, status: 'ERROR', data: null, evidence: [], resultCount: 0, evidenceCount: 0, errorCode: 'UNKNOWN_TOOL', fetchedAt: new Date().toISOString(), warning: 'Unknown tool.' } });
        return;
      }
      if (!hasBudgetFor(state.deadlineAt, MIN_TOOL_BUDGET_MS)) {
        settledByIndex.set(index, { status: 'fulfilled', value: budgetExhaustedResult(step.tool) });
        return;
      }
      const startedAt = Date.now();
      try {
        const value = await fn(step.args, context);
        settledByIndex.set(index, { status: 'fulfilled', value: { ...value, durationMs: Date.now() - startedAt } });
      } catch (reason) {
        settledByIndex.set(index, { status: 'rejected', reason, durationMs: Date.now() - startedAt });
      }
    }),
  );

  const toolResults = [];
  const evidenceByFingerprint = new Map();
  const warnings = [];

  steps.forEach((step, index) => {
    const masterIndex = firstIndexByFingerprint.get(fingerprints[index]);
    const outcome = settledByIndex.get(masterIndex);
    const isDeduplicated = masterIndex !== index;

    // The single symbol this step targeted, if any (compareStocks' plural
    // `symbols` is deliberately excluded here — its own per-symbol
    // breakdown already lives in its result's `data`; see
    // evidenceCoverage.js, which reads that nested structure directly for
    // compareStocks and this top-level `symbol` field for every other
    // symbol-scoped tool).
    const stepSymbol = typeof step.args?.symbol === 'string' ? step.args.symbol.toUpperCase() : null;

    let toolResult;
    if (outcome.status === 'fulfilled') {
      toolResult = { ...outcome.value, deduplicated: isDeduplicated, fingerprint: fingerprints[index], symbol: stepSymbol };
    } else {
      logger.warn(`[Graph] tool ${step.tool} rejected: ${outcome.reason?.message}`);
      toolResult = {
        tool: step.tool, status: 'ERROR', data: null, evidence: [],
        resultCount: 0, evidenceCount: 0, errorCode: 'TOOL_REJECTED',
        fetchedAt: new Date().toISOString(), warning: 'This data source failed unexpectedly.',
        durationMs: outcome.durationMs, deduplicated: isDeduplicated, fingerprint: fingerprints[index], symbol: stepSymbol,
      };
    }

    toolResults.push(toolResult);
    // Evidence is only ever added once per fingerprint — a deduplicated
    // step must never duplicate the same evidence records a second time.
    if (!evidenceByFingerprint.has(fingerprints[index])) {
      evidenceByFingerprint.set(fingerprints[index], toolResult.evidence || []);
    }
    if (toolResult.warning && !isDeduplicated) warnings.push(toolResult.warning);

    if (state.onEvent) {
      state.onEvent({
        type: 'tool.completed', tool: step.tool, status: toolResult.status,
        resultCount: toolResult.resultCount ?? 0, evidenceCount: toolResult.evidenceCount ?? 0,
        errorCode: toolResult.errorCode ?? null,
      });
    }
  });

  const evidence = [...evidenceByFingerprint.values()].flat();

  // Underlying-operation fingerprints actually attempted THIS round, for
  // Phase 2's cross-round toolCallFingerprints (state.js) — used by
  // replanMissingEvidence.js to recognize a gap already tried (even one
  // that happened INSIDE a compareStocks step, via its own
  // operationFingerprints) and never repeat it. Computed once per UNIQUE
  // executed step (uniqueIndexes), never per deduplicated repeat, since a
  // repeat never made a real call.
  const toolCallFingerprints = [];
  let providerOperationCount = 0;
  uniqueIndexes.forEach((index) => {
    const outcome = settledByIndex.get(index);
    const value = outcome.status === 'fulfilled' ? outcome.value : null;
    if (Array.isArray(value?.operationFingerprints) && value.operationFingerprints.length) {
      toolCallFingerprints.push(...value.operationFingerprints);
      providerOperationCount += value.operationCount ?? value.operationFingerprints.length;
    } else {
      toolCallFingerprints.push(fingerprints[index]);
      providerOperationCount += 1;
    }
  });

  // Phase 4B: retrieveGroundedEvidence carries its trusted evidence
  // envelope in its OWN `researchEvidence` field (see toolRegistry.js),
  // never mixed into the generic `evidence` array above — composeAnswer's
  // grounded branch reads this directly. There is at most one such step
  // per turn (planTools.js's deterministicPlan never plans more than one
  // retrieveGroundedEvidence call), so a plain find is correct here.
  const groundedStep = toolResults.find((t) => t.tool === 'retrieveGroundedEvidence');
  let researchEvidence = groundedStep?.researchEvidence || [];
  const retrievalMode = groundedStep?.retrievalMode || null;

  // Phase 4C Part 5/6: when planTools.js planned BOTH tools for the same
  // grounded turn (guidance/revised-guidance/promise-vs-outcome questions —
  // see researchScope.js's mergeEarningsIntelligence), Earnings
  // Intelligence's own structured promise/outcome data is normalized and
  // appended to the SAME trusted envelope, continuing its "E1"/"E2"
  // numbering, rather than composed into a second, separate answer (Part 6:
  // never two competing final answers to reconcile — there is still only
  // one grounded generation call, over the combined evidence). Only
  // merges on a genuinely grounded turn (groundedStep present) — a plain
  // EARNINGS_INTELLIGENCE question with no research-corpus need never
  // gets this treatment, so its existing timeline/cards behavior (Part 3)
  // is completely unaffected.
  const earningsStep = toolResults.find((t) => t.tool === 'getEarningsTimeline');
  if (groundedStep && earningsStep?.status === 'SUCCESS' && earningsStep.data) {
    const symbol = groundedStep.symbol || earningsStep.symbol || null;
    const merged = mergeEarningsIntelligenceEvidence({ items: researchEvidence }, earningsStep.data, {
      symbol, companyName: symbol ? (SUPPORTED_STOCKS[symbol]?.name || null) : null,
    });
    researchEvidence = merged.items;
  }

  // Phase 4D Part 4: cross-source temporal reconciliation — runs on the
  // FINAL combined envelope (documents + any merged Earnings Intelligence
  // items) so a document chunk and a later Earnings-Intelligence record
  // for the exact same guidance lineage are compared by canonical scope,
  // never by documentType (see services/EvidenceEnvelope.js's
  // reconcileEvidenceEnvelope for the full rationale). Only runs on a
  // genuinely grounded turn — a no-op (empty items) otherwise.
  let researchRelationships = [];
  if (researchEvidence.length) {
    // Phase 4E.1 Part 7: any VERIFIED offline chunk annotation was already
    // attached by buildResearchEvidenceEnvelope itself, back in
    // toolRegistry.js's retrieveGroundedEvidence — BEFORE that envelope's
    // own pre-budget SUPERSEDES prioritization ran, so a superseded chunk
    // can genuinely lose its budget slot to its current successor rather
    // than only being labeled after the fact. This reconciliation pass
    // just reads `item.chunkAnnotation`, already present on `researchEvidence`
    // items where applicable — no DB access anywhere in this node.
    const reconciled = reconcileEvidenceEnvelope({ items: researchEvidence });
    researchEvidence = reconciled.items;
    researchRelationships = reconciled.relationships;
  }

  return {
    toolResults, evidence, warnings, deduplicatedToolCalls, toolCallFingerprints, providerOperationCount, researchEvidence, retrievalMode, researchRelationships,
  };
};

export default executeTools;
