/**
 * turnClassification.js
 * ========================
 * Phase 5A Part 6: derives the bounded-cardinality labels the metrics
 * store and telemetry events need from a COMPLETED graph turn's state —
 * never a new decision that changes what the user sees, purely a read of
 * fields the graph already computed (groundingStatus, validationStatus,
 * scopeSignal, repairCount, groundedClaims, researchEvidence).
 */
import { classifyOperationalError } from './errorTaxonomy.js';

/**
 * classifyCompletionStatus - one of the 6 bounded buckets Part 6 lists,
 * or null when none applies (an ordinary, successful non-research answer
 * has no grounding/refusal/failure concept to bucket into — it is still
 * counted in the overall request total and the research/ordinary split,
 * just not in this specific breakdown).
 */
export const classifyCompletionStatus = (state = {}) => {
  if (state.groundingStatus) return state.groundingStatus;
  if (state.validationStatus === 'FAILED_SAFE') return 'failed';
  if (state.intent === 'UNSUPPORTED') return 'unsupported';
  if (state.scopeSignal?.ambiguousCompany) return 'refused';
  return null;
};

export const isResearchTurn = (state = {}) => Boolean(state.scopeSignal?.needsResearchCorpus) || Boolean(state.groundingStatus);

/**
 * buildTurnMetrics - the single object both the streaming and legacy
 * controllers, and logDiagnostics.js, feed into the metrics store and the
 * rag.request.completed/failed telemetry event. Every field here is
 * already an allow-listed dimension/measurement (see ragTelemetry.js).
 */
export const buildTurnMetrics = (state = {}) => {
  const completionStatus = classifyCompletionStatus(state);
  const errorCategory = classifyOperationalError(state);
  const verifiedClaims = (state.groundedClaims || []).filter((c) => c.verificationStatus === 'VERIFIED');
  const rejectedClaims = (state.groundedClaims || []).filter((c) => c.verificationStatus && c.verificationStatus !== 'VERIFIED');

  return {
    completionStatus,
    errorCategory,
    isResearch: isResearchTurn(state),
    repairAttempted: Boolean(state.repairAttempted || (state.repairCount || 0) > 0),
    repairSucceeded: Boolean(state.repairAttempted) && state.validationStatus === 'PASSED',
    citationCount: (state.citations || []).length,
    verifiedClaimCount: verifiedClaims.length,
    rejectedClaimCount: rejectedClaims.length,
    retrievalMode: state.retrievalMode || null,
    evidenceCount: (state.researchEvidence || []).length,
    ambiguousCompany: Boolean(state.scopeSignal?.ambiguousCompany),
  };
};

export default { classifyCompletionStatus, isResearchTurn, buildTurnMetrics };
