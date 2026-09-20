/**
 * costLedger.js
 * ===============
 * Phase 5B: the ONE place a real LLM call's tokens and cost enter the
 * metrics store, and the thing that guarantees each call enters it exactly
 * once.
 *
 * WHY THIS EXISTS. Phase 5A summed `state.llmCalls` in logDiagnostics, at
 * the very end of a turn. That is correct for a turn that finishes, and
 * loses everything for a turn that does not: if a node throws, or the
 * client aborts mid-graph, or anything fails before logDiagnostics runs,
 * the calls that were really made — and really billed — were never counted.
 * Cost under-reporting is silent and compounding, which makes it exactly
 * the kind of error nobody notices until the invoice arrives.
 *
 * THE FIX. A call is recorded the moment it COMPLETES, at its own call
 * site, before anything downstream can fail. logDiagnostics still sweeps
 * `state.llmCalls` at the end of the turn as a safety net, so a call site
 * that was never wired up is still counted — just later. The ledger makes
 * the overlap safe by remembering which call objects it has already seen.
 *
 * DEDUPLICATION is by OBJECT IDENTITY, in a WeakSet. The same diagnostic
 * object created at the call site is the one that flows into
 * `state.llmCalls` (graph/state.js's reducer is `x.concat(y)`, which copies
 * references, never the objects), so identity is a reliable key for the
 * real pipeline — and it costs no field on the diagnostic, which keeps
 * Phase 5A's exact-key-set contract for `invokeRoutingModel`'s diagnostic
 * intact. A WeakSet also cannot leak: entries disappear when the turn's
 * state is collected. An explicit `callId` is honoured too, for a caller
 * that has one and for a path where an object might be copied.
 *
 * WHAT IT NEVER DOES: no prompt, no response, no model input of any kind
 * passes through here — only a model name, token counts the provider
 * itself returned, and the cost computed from them.
 */
import { metricsStore as defaultMetricsStore } from './metricsStore.js';
import { estimateCallCost } from './costEstimation.js';

// Bounded id memory for the explicit-callId path. Object identity needs no
// bound (the WeakSet handles it); string ids do, or a long-lived process
// would accumulate them forever.
const MAX_REMEMBERED_IDS = 5000;

/**
 * createCostLedger - a factory, not a singleton, so a test gets an isolated
 * ledger + store rather than sharing global mutable state. The app's own
 * shared instance is exported at the bottom.
 */
export const createCostLedger = ({ store = defaultMetricsStore } = {}) => {
  let seenObjects = new WeakSet();
  let seenIds = new Set();
  let recordedCount = 0;
  let duplicateCount = 0;

  const rememberId = (callId) => {
    if (seenIds.size >= MAX_REMEMBERED_IDS) {
      // FIFO: drop the oldest id. Insertion order is Set's own iteration
      // order, so the first key is the oldest.
      const oldest = seenIds.values().next().value;
      seenIds.delete(oldest);
    }
    seenIds.add(callId);
  };

  const alreadySeen = (call) => {
    if (typeof call.callId === 'string' && call.callId) return seenIds.has(call.callId);
    return seenObjects.has(call);
  };

  const remember = (call) => {
    if (typeof call.callId === 'string' && call.callId) rememberId(call.callId);
    else seenObjects.add(call);
  };

  return {
    /**
     * recordCall - records one completed LLM call's tokens and cost, exactly
     * once. Returns { recorded, reason } so a caller (and a test) can tell
     * "counted" from "already counted" from "nothing to count".
     *
     * Never throws: cost accounting must not be able to break the request
     * that generated the cost.
     */
    recordCall(call) {
      try {
        if (!call || typeof call !== 'object') return { recorded: false, reason: 'NOT_A_CALL' };
        if (alreadySeen(call)) { duplicateCount += 1; return { recorded: false, reason: 'ALREADY_RECORDED' }; }

        remember(call);

        // A call that was never attempted (no budget left) is genuinely zero
        // calls — not an unknown cost, and not unknown usage. Phase 5A's
        // estimateRequestCost draws the same distinction.
        if (call.skipped) return { recorded: false, reason: 'SKIPPED_NEVER_ATTEMPTED' };

        recordedCount += 1;

        const usageUnknown = call.inputTokens == null && call.outputTokens == null;
        store.recordTokenUsage({
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          cachedInputTokens: call.cachedInputTokens,
          reasoningTokens: call.reasoningTokens,
          usageUnknown,
        });

        // null (unknown model, or unknown usage) increments costUnknownCount
        // rather than adding zero — the Phase 5A invariant, preserved.
        store.recordCost(estimateCallCost(call));

        return { recorded: true, reason: usageUnknown ? 'RECORDED_USAGE_UNKNOWN' : 'RECORDED' };
      } catch {
        return { recorded: false, reason: 'LEDGER_ERROR' };
      }
    },

    /** recordMany - the end-of-turn safety net; each call still enters at most once. */
    recordMany(calls = []) {
      const results = { recorded: 0, duplicates: 0, skipped: 0 };
      for (const call of calls || []) {
        const { recorded, reason } = this.recordCall(call);
        if (recorded) results.recorded += 1;
        else if (reason === 'ALREADY_RECORDED') results.duplicates += 1;
        else results.skipped += 1;
      }
      return results;
    },

    /** Observability on the ledger itself — surfaced by the ops endpoint. */
    getStats() {
      return { recordedCallCount: recordedCount, duplicateCallCount: duplicateCount };
    },

    __resetForTests() {
      seenObjects = new WeakSet();
      seenIds = new Set();
      recordedCount = 0;
      duplicateCount = 0;
    },
  };
};

export const costLedger = createCostLedger();

/**
 * recordLlmCall - the call-site entry point. Takes the diagnostic object a
 * node just built, records it, and returns THE SAME OBJECT so the node can
 * put it straight into its `llmCalls` return value:
 *
 *     const llmCalls = [recordLlmCall({ node, role, model, ... })];
 *
 * Returning the identical object (never a copy) is what lets logDiagnostics'
 * later sweep recognise it and not count it twice.
 */
export const recordLlmCall = (diagnostic) => {
  costLedger.recordCall(diagnostic);
  return diagnostic;
};

export default { createCostLedger, costLedger, recordLlmCall };
