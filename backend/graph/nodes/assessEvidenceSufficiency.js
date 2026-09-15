import { computeEvidenceCoverage } from '../evidenceCoverage.js';
import { hasBudgetFor } from '../requestBudget.js';
import { resolveResearchScope } from '../researchScope.js';

// The minimum remaining budget worth spending on a replan round at all —
// well below any single tool's natural timeout, so this only skips a
// replan when the deadline is genuinely almost gone, never a normal
// in-budget request (same reasoning as executeTools.js's own
// MIN_TOOL_BUDGET_MS, just measured before committing to a whole extra
// round rather than one call).
const MIN_REPLAN_ROUND_BUDGET_MS = 2000;

// A replan can never help close these two gaps — see toolRegistry.js/
// planTools.js: AUTH_REQUIRED means the user isn't signed in (no retry
// fixes that), UNSUPPORTED means the provider genuinely doesn't offer
// that capability (retrying calls the same unsupported operation again).
const NEVER_REPLAN_STATUSES = new Set(['AUTH_REQUIRED', 'UNSUPPORTED']);

/**
 * assessEvidenceSufficiency - deterministic, no LLM. Computes the
 * evidence-coverage matrix (graph/evidenceCoverage.js) from whatever
 * executeTools/validateEvidence have accumulated so far this turn, and
 * decides (via the returned `needsReplan` flag, read by graph.js's
 * conditional edge) whether ONE bounded replan round is worth attempting.
 *
 * needsReplan is a coarse, cheap pre-check ("is there anything at all
 * worth trying, and do we still have the time/replan budget for it") —
 * the FINE-grained decision of exactly which tool call to issue (and the
 * final "no repeated fingerprint" guarantee) is nodes/replanMissingEvidence.js's
 * job, not this node's.
 */
export const assessEvidenceSufficiency = async (state) => {
  if (state.errors.length) return {};

  // Phase 4B/4C: the grounded RAG flow (see graph/researchScope.js) has
  // its own, fully self-contained evidence-sufficiency decision — zero
  // researchEvidence already correctly abstains inside composeAnswer.js's
  // grounded branch, and a bounded repair (never a replan/re-retrieval)
  // is the ONLY recovery path Part 7 allows for it. Its evidence
  // deliberately never populates the legacy `evidence` array (see
  // toolRegistry.js's retrieveGroundedEvidence), so computeEvidenceCoverage
  // below would otherwise see nothing and trigger an expensive, pointless
  // legacy replan (confirmed live: it fell back to the slow legacy
  // searchResearchDocuments tool, burning the whole request budget on
  // real network calls) for a turn that already has everything it needs.
  // Phase 4C: this must recompute the SAME deterministic scope every other
  // grounded-aware node does (never a bare intent check) — the grounded
  // route is no longer tied to a single intent label.
  const lastMessage = state.messages?.[state.messages.length - 1];
  const scope = resolveResearchScope({ text: String(lastMessage?.content || ''), entities: state.entities, intent: state.intent });
  if (scope.needsResearchCorpus) {
    return { evidenceCoverage: [], missingEvidence: [], needsReplan: false };
  }

  const { evidenceCoverage, missingEvidence } = computeEvidenceCoverage({
    symbols: state.entities?.symbols || [],
    requestedDimensions: state.requestedDimensions || [],
    toolResults: state.toolResults || [],
    evidence: state.evidence || [],
    userId: state.userId,
  });

  const replanEligible = missingEvidence.filter((gap) => !NEVER_REPLAN_STATUSES.has(gap.status) && gap.symbol);
  const needsReplan = (state.replanCount || 0) < 1
    && replanEligible.length > 0
    && hasBudgetFor(state.deadlineAt, MIN_REPLAN_ROUND_BUDGET_MS);

  return { evidenceCoverage, missingEvidence, needsReplan };
};

export default assessEvidenceSufficiency;
