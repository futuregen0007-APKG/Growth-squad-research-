import { DIMENSION_TOOLS } from '../evidenceCoverage.js';
import { fingerprintToolCall } from '../toolFingerprint.js';
import { logger } from '../../utils/logger.js';

// Deliberately small and separate from planTools.js's top-level
// MAX_TOOL_CALLS_PER_REQUEST — a replan round is meant to be a cheap,
// targeted top-up for a few specific gaps, never a second full planning
// pass.
export const MAX_REPLAN_TOOL_CALLS = 3;

const REPLAN_ELIGIBLE_STATUSES = new Set(['EMPTY', 'UNAVAILABLE']);

/**
 * replanMissingEvidence - the ONE bounded replan round. Turns
 * state.missingEvidence gaps into a small, concrete tool plan, enforcing
 * every hard termination constraint itself (this node, not just the
 * assessEvidenceSufficiency edge, is the actual guarantee):
 *   - never for AUTH_REQUIRED/UNSUPPORTED (no retry fixes either);
 *   - never repeats a fingerprint already attempted this turn — checked
 *     against state.toolCallFingerprints, which (see toolRegistry.js's
 *     compareStocks/operationFingerprints and executeTools.js) covers
 *     underlying operations attempted INSIDE a compareStocks step too,
 *     not just top-level planned steps;
 *   - only proceeds for a dimension that has an actual APPROVED
 *     alternative tool (graph/evidenceCoverage.js's DIMENSION_TOOLS) whose
 *     fingerprint hasn't been tried yet — a dimension with only one known
 *     tool, already attempted, has no alternative and is simply left as
 *     an honest gap for composeAnswer to report;
 *   - bounded to MAX_REPLAN_TOOL_CALLS steps.
 * replanCount is incremented UNCONDITIONALLY (even when no actionable
 * step is found) — a replan round was genuinely considered/attempted,
 * which is what the hard "at most one replan" cap counts.
 */
export const replanMissingEvidence = async (state) => {
  if (state.errors.length) return { replanCount: (state.replanCount || 0) + 1 };

  const alreadyAttempted = new Set(state.toolCallFingerprints || []);
  const candidates = (state.missingEvidence || [])
    .filter((gap) => REPLAN_ELIGIBLE_STATUSES.has(gap.status) && gap.symbol);

  const newSteps = [];
  for (const gap of candidates) {
    if (newSteps.length >= MAX_REPLAN_TOOL_CALLS) break;
    const toolNames = DIMENSION_TOOLS[gap.dimension] || [];
    const step = toolNames
      .map((tool) => ({ tool, args: { symbol: gap.symbol } }))
      .find((candidateStep) => !alreadyAttempted.has(fingerprintToolCall(candidateStep)));
    if (step) newSteps.push(step);
  }

  if (newSteps.length) {
    logger.info(`[Graph] replan round: fetching ${newSteps.length} missing evidence gap(s) — ${newSteps.map((s) => s.tool).join(', ')}`);
    if (state.onEvent) state.onEvent({ type: 'status', message: 'Filling in missing information…' });
  }

  return { toolPlan: newSteps, replanCount: (state.replanCount || 0) + 1 };
};

export default replanMissingEvidence;
