import { LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { claimVerificationPrompt } from '../prompts/index.js';
import { ClaimVerificationSchema } from '../schemas.js';
import { invokeRoutingModel } from '../llmInvoke.js';
import { runDeterministicChecks, needsClaimVerifier } from '../claimValidation.js';
import { hasBudgetFor } from '../requestBudget.js';
import { verifyGroundedAnswerNode } from '../groundedAnswer.js';
import { emitEvent } from '../../services/telemetry/ragTelemetry.js';

// Below this remaining budget, the structured verifier call is skipped
// entirely (fail-closed: see the REPAIR_REQUIRED-with-no-budget path
// below, which routes straight to buildSafeFallback rather than
// publishing an unverified draft just because there was no time left to
// check it).
const MIN_VERIFIER_BUDGET_MS = 800;

// Claim verdicts that mean "this specific claim is wrong or unsupported
// and needs fixing" — PARTIALLY_SUPPORTED is included deliberately
// (partial support for a specific number/detail is still not fully safe
// to publish as stated).
const REPAIRABLE_CLAIM_VERDICTS = new Set([
  'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'WRONG_SYMBOL', 'WRONG_PERIOD',
  'WRONG_DIMENSION', 'FORECAST_AS_ACTUAL', 'GUIDANCE_AS_OUTCOME', 'INVALID_CITATION',
]);

/**
 * validateFinalAnswer - Phase 3's validation gate. Runs on EVERY draft
 * (deterministic checks always; the structured claim verifier only when
 * needsClaimVerifier says it's worth the call), and on the REPAIRED draft
 * too (repairAnswer.js routes back here — see graph.js's cycle). Never
 * publishes anything itself; only ever decides state.validationStatus,
 * which graph.js's routeAfterValidation reads to go to publishFinalAnswer,
 * repairAnswer, or buildSafeFallback. Never blocks by throwing — a broken
 * verifier call fails closed (FAILED_SAFE), never silently passes.
 */
const validateFinalAnswerInner = async (state) => {
  // Phase 4B: grounded RAG branch — state.groundedAnswer is only ever set
  // by composeAnswer.js's/repairAnswer.js's grounded branches (see
  // graph/groundedAnswer.js), never by the legacy pipeline, so this check
  // is unambiguous and safe to run before any of the legacy logic below.
  // Purely deterministic (no LLM call — Part 6: "not relying on the LLM
  // to verify itself").
  if (state.groundedAnswer) {
    return verifyGroundedAnswerNode(state);
  }

  // composeAnswer already decided this draft is a fixed, non-LLM-generated
  // safe string (input error, not-configured, no-budget, provider-error
  // fallback text) — nothing to re-check, pass straight through. Also
  // covers composeAnswer's genuine-cancellation path (FAILED_SAFE,
  // draftAnswer: null) — already terminal, nothing more to compute.
  //
  // ABSTAINED here specifically covers composeAnswer's Phase 4A
  // zero-evidence fast path (see its own module note): it deliberately
  // never sets draftAnswer at all (there was nothing worth drafting), so
  // this MUST be checked before the `draftAnswer == null` branch below —
  // otherwise a real, deliberate ABSTAINED would be misread as the
  // cancellation case and mislabeled FAILED_SAFE.
  if (state.validationStatus === 'SKIPPED_GENERAL_EDUCATION' || state.validationStatus === 'FAILED_SAFE' || state.validationStatus === 'ABSTAINED') {
    return {};
  }

  // A client disconnect / deadline hit between composeAnswer and here —
  // stop before spending an extra verifier call on work nobody will see.
  if (state.aborted?.() || state.draftAnswer == null) {
    return { validationStatus: 'FAILED_SAFE', validationIssues: ['CANCELLED'] };
  }

  const deterministic = runDeterministicChecks({
    draftAnswer: state.draftAnswer,
    evidence: state.evidence,
    entities: state.entities,
    missingEvidence: state.missingEvidence,
    intent: state.intent,
    toolResults: state.toolResults,
  });

  let claimValidation = [];
  let claimIssues = [];
  let llmCalls;

  // Hardening: eligibility is now purely intent + genuine-evidence based —
  // citation presence/absence/validity plays NO role (see
  // claimValidation.js's needsClaimVerifier for the full policy and why
  // the previous citation-gated version was unsafe). deterministic.issues
  // and deterministic.citedIndexes (already computed above) are exactly
  // what the narrow isExactlyDeterministicallyVerified exception needs.
  if (needsClaimVerifier({
    evidence: state.evidence, intent: state.intent, entities: state.entities,
    deterministicIssues: deterministic.issues, citedIndexes: deterministic.citedIndexes,
  })) {
    if (!hasBudgetFor(state.deadlineAt, MIN_VERIFIER_BUDGET_MS)) {
      // Fail-closed: never publish an unverified draft just because time
      // ran out before it could be checked.
      return { validationStatus: 'FAILED_SAFE', validationIssues: [...deterministic.issues, 'VERIFIER_SKIPPED_NO_BUDGET'] };
    }

    const lastMessage = state.messages[state.messages.length - 1];
    const { parsed, error, diagnostic } = await invokeRoutingModel({
      node: 'validateFinalAnswer',
      role: 'verification',
      model: LLM_CONFIG.validationModel,
      maxTokens: 900,
      schema: ClaimVerificationSchema,
      schemaName: 'claim_verification',
      prompt: claimVerificationPrompt({
        message: String(lastMessage?.content || ''), draftAnswer: state.draftAnswer, evidence: state.evidence,
      }),
      signal: state.abortSignal,
      deadlineAt: state.deadlineAt,
    });
    llmCalls = [diagnostic];

    if (!parsed) {
      // Verifier timeout/cancellation/provider failure/invalid structured
      // output — fail closed, never trust an unverified draft.
      return {
        validationStatus: 'FAILED_SAFE',
        validationIssues: [...deterministic.issues, `VERIFIER_${error || 'FAILED'}`],
        llmCalls,
      };
    }

    claimValidation = parsed.claims;
    claimIssues = parsed.claims
      .filter((c) => REPAIRABLE_CLAIM_VERDICTS.has(c.verdict))
      .map((c) => `${c.claimId}:${c.verdict}:${c.reasonCode}`);
  }

  const allIssues = [...deterministic.issues, ...claimIssues];
  const validationStatus = allIssues.length ? 'REPAIR_REQUIRED' : 'PASSED';

  return {
    validationStatus, validationIssues: allIssues, claimValidation, ...(llmCalls ? { llmCalls } : {}),
  };
};

/**
 * validateFinalAnswer - Phase 5A wrapper around the untouched
 * validateFinalAnswerInner above. Emits exactly one
 * rag.verification.completed per VERIFICATION PASS, from one place, so
 * every one of the inner function's many early returns (grounded branch,
 * pass-through, cancellation, no-budget fail-closed, verifier failure,
 * normal verdict) is covered identically and none can be missed.
 *
 * A repaired draft is re-verified (graph.js cycles repairAnswer back into
 * this node), so a second event for one turn is a real second pass, not a
 * duplicate — `repairAttempted` tells the two apart. Never changes the
 * inner function's return value or control flow.
 */
export const validateFinalAnswer = async (state) => {
  const startedAt = performance.now();
  const update = await validateFinalAnswerInner(state);

  // The verdict this pass produced: an inner branch that returns {} left the
  // status untouched, so fall back to the status already on state.
  const verdict = update?.validationStatus || state.validationStatus || null;
  const claims = update?.groundedClaims || state.groundedClaims || [];

  emitEvent('rag.verification.completed', {
    traceId: state.traceId,
    requestId: state.requestId,
    verificationVerdict: verdict,
    groundingStatus: update?.groundingStatus || state.groundingStatus || null,
    verifiedClaimCount: claims.filter((c) => c.verificationStatus === 'VERIFIED').length,
    rejectedClaimCount: claims.filter((c) => c.verificationStatus && c.verificationStatus !== 'VERIFIED').length,
    repairAttempted: Boolean(state.repairAttempted || (state.repairCount || 0) > 0),
    llmCallCount: (update?.llmCalls || []).length,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return update;
};

export default validateFinalAnswer;
