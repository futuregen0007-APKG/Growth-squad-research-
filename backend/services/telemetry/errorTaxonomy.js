/**
 * errorTaxonomy.js
 * ==================
 * Phase 5A Part 7: canonical OPERATIONAL error classification for
 * telemetry/metrics — a distinct, additive layer from:
 *   - utils/errorHandler.js's AppError/ERROR_CODES (HTTP-response-layer
 *     errors for non-chat routes — untouched, still used for those);
 *   - graph/safeReasons.js's SAFE_REASONS (the small set of USER-FACING
 *     phrases a tool result may surface — untouched).
 *
 * This module answers a different question: "for observability purposes,
 * what CATEGORY of thing happened during this chat turn?" — derived
 * deterministically from signals the graph already produces (never a new
 * classification computed by re-parsing a raw error message).
 */

import { SAFE_REASONS } from '../../graph/safeReasons.js';

export const OPERATIONAL_ERROR_CATEGORIES = Object.freeze([
  'INVALID_REQUEST', 'AUTHENTICATION_FAILED', 'AUTHORIZATION_FAILED', 'AMBIGUOUS_COMPANY', 'UNSUPPORTED_SYMBOL',
  'UNSUPPORTED_PERIOD', 'RETRIEVAL_TIMEOUT', 'RETRIEVAL_FAILURE', 'EVIDENCE_INSUFFICIENT', 'LLM_TIMEOUT',
  'LLM_RATE_LIMITED', 'LLM_PROVIDER_FAILURE', 'VERIFICATION_FAILED', 'REPAIR_FAILED', 'REQUEST_DEADLINE_EXCEEDED',
  'CLIENT_ABORTED', 'INTERNAL_ERROR', 'NONE',
]);

// The exact tool-level error codes (graph/safeReasons.js's own vocabulary,
// and toolRegistry.js's raw errorCode values) that mean "the retrieval/
// evidence-gathering layer itself failed" vs. "it genuinely timed out."
const RETRIEVAL_TIMEOUT_CODES = new Set(['TIMEOUT', 'CANCELLED']);
const RETRIEVAL_FAILURE_CODES = new Set(['UPSTREAM_UNAVAILABLE', 'UPSTREAM_ERROR', 'NETWORK_ERROR', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE']);

// The tools that ARE the retrieval/evidence-gathering layer. Named once so
// the rate-limit check below and the retrieval check further down agree on
// exactly which failures belong to which layer — without this, the generic
// rate-limit check would claim a rate-limited RETRIEVAL tool as an LLM
// failure, and RETRIEVAL_FAILURE_CODES' own 'RATE_LIMITED' entry could
// never be reached for the one kind of tool it exists to describe.
const RETRIEVAL_TOOLS = new Set(['retrieveGroundedEvidence', 'getEarningsTimeline']);

/**
 * classifyOperationalError - one deterministic pass over a completed
 * turn's already-produced signals, in priority order. Returns exactly one
 * category from OPERATIONAL_ERROR_CATEGORIES, never 'INTERNAL_ERROR' for a
 * cancellation, never 'EVIDENCE_INSUFFICIENT' for a genuine provider
 * outage, and never 'CLIENT_ABORTED' counted as an application failure by
 * a caller that checks for that category specifically.
 */
export const classifyOperationalError = (state = {}) => {
  // 1. Client cancellation always takes priority — never misclassified as
  // any kind of application failure, regardless of what else was mid-flight.
  if (typeof state.aborted === 'function' ? state.aborted() : state.aborted) return 'CLIENT_ABORTED';

  // 2. The request's own deadline was exhausted (distinct from a client
  // hanging up — the server itself decided to stop).
  const anyDeadlineExhausted = (state.llmCalls || []).some((c) => c.skipped === 'SKIPPED_NO_BUDGET')
    || (state.toolResults || []).some((t) => t.errorCode === 'DEADLINE_EXCEEDED');
  if (anyDeadlineExhausted && state.validationStatus !== 'PASSED') return 'REQUEST_DEADLINE_EXCEEDED';

  // 3. Ambiguous-company scope failure (never an LLM or retrieval
  // failure — resolved by composeAnswer.js before either runs). Mirrored
  // into state.scopeSignal by composeAnswer.js's own resolveResearchScope
  // call — see graph/nodes/composeAnswer.js.
  if (state.scopeSignal?.ambiguousCompany) return 'AMBIGUOUS_COMPANY';

  // Unsupported/mismatched period — the deterministic verifier's own
  // PERIOD_MISMATCH verdict (graph/groundedVerification.js), already
  // persisted per-claim in state.groundedClaims; never re-derived from
  // free text.
  if ((state.groundedClaims || []).some((c) => c.reasonCode === 'EVIDENCE_FISCAL_YEAR_MISMATCH' || c.reasonCode === 'QUARTERLY_VS_ANNUAL_OR_WRONG_QUARTER')) {
    return 'UNSUPPORTED_PERIOD';
  }
  // Unsupported/unresolved symbol — a tool result that could not resolve
  // the company at all (graph/safeReasons.js's COMPANY_NOT_RESOLVED reason,
  // carried on the result's own `warning` field — see toolRegistry.js's
  // shared `result()` builder).
  if ((state.toolResults || []).some((t) => t.warning === SAFE_REASONS.COMPANY_NOT_RESOLVED)) return 'UNSUPPORTED_SYMBOL';

  // 4. LLM-layer failures — a genuine provider timeout is never reported
  // as "insufficient evidence," and a rate limit is distinguished from a
  // generic provider failure.
  const timedOutLlmCall = (state.llmCalls || []).find((c) => c.timedOut);
  if (timedOutLlmCall) return 'LLM_TIMEOUT';
  // A rate limit raised by a NON-retrieval tool is the model/provider layer
  // pushing back; a rate-limited retrieval tool is a retrieval-layer failure
  // and is classified as one in step 5 below, never as an LLM failure.
  const rateLimitedTool = (state.toolResults || []).find((t) => t.errorCode === 'RATE_LIMITED' && !RETRIEVAL_TOOLS.has(t.tool));
  if (rateLimitedTool) return 'LLM_RATE_LIMITED';
  const providerErrorCall = (state.llmCalls || []).find((c) => c.error === 'PROVIDER_ERROR');
  if (providerErrorCall) return 'LLM_PROVIDER_FAILURE';

  // 5. Retrieval-layer failures — timeout vs. genuine failure, distinct
  // categories (never conflated).
  const retrievalTool = (state.toolResults || []).find((t) => RETRIEVAL_TOOLS.has(t.tool));
  if (retrievalTool?.errorCode && RETRIEVAL_TIMEOUT_CODES.has(retrievalTool.errorCode)) return 'RETRIEVAL_TIMEOUT';
  if (retrievalTool?.errorCode && RETRIEVAL_FAILURE_CODES.has(retrievalTool.errorCode)) return 'RETRIEVAL_FAILURE';

  // 6. Verification/repair outcomes — a REPAIR_REQUIRED verdict that
  // exhausted its one allowed repair, or a repair call that itself failed.
  if (state.repairAttempted && state.validationStatus === 'REPAIR_REQUIRED') return 'REPAIR_FAILED';
  if (state.validationStatus === 'FAILED_SAFE') return 'VERIFICATION_FAILED';

  // 7. Honest "no evidence, nothing else went wrong" — never a crash.
  if (state.groundingStatus === 'insufficient_evidence') return 'EVIDENCE_INSUFFICIENT';

  // 8. A genuinely unexpected failure (state.errors non-empty with none of
  // the above signals present) — the deliberate last resort, never the
  // default for an ordinary honest "no evidence" answer.
  if ((state.errors || []).length) return 'INTERNAL_ERROR';

  return 'NONE';
};

export default { OPERATIONAL_ERROR_CATEGORIES, classifyOperationalError };
