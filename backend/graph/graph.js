import { StateGraph, START, END } from '@langchain/langgraph';

import { GraphState } from './state.js';
import { validateInput } from './nodes/validateInput.js';
import { loadThreadMemory, loadUserContext } from './nodes/loadMemory.js';
import { classifyIntent } from './nodes/classifyIntent.js';
import { extractEntities } from './nodes/extractEntities.js';
import { planTools } from './nodes/planTools.js';
import { executeTools } from './nodes/executeTools.js';
import { validateEvidence } from './nodes/validateEvidence.js';
import { assessEvidenceSufficiency } from './nodes/assessEvidenceSufficiency.js';
import { replanMissingEvidence } from './nodes/replanMissingEvidence.js';
import { composeAnswer } from './nodes/composeAnswer.js';
import { validateFinalAnswer } from './nodes/validateFinalAnswer.js';
import { repairAnswer } from './nodes/repairAnswer.js';
import { publishFinalAnswer } from './nodes/publishFinalAnswer.js';
import { buildSafeFallback } from './nodes/buildSafeFallback.js';
import { logDiagnostics } from './nodes/logDiagnostics.js';
import { saveMemory } from './nodes/saveMemory.js';
import { withNodeTiming } from './timing.js';

/**
 * graph.js
 * =========
 * GS Copilot's LangGraph workflow (installed @langchain/langgraph@1.4.8's
 * StateGraph API).
 *
 *   START
 *     → validateInput
 *     → (invalid input) ─────────────────────────────────────────► composeAnswer
 *     → loadThreadMemory → loadUserContext → classifyIntent → extractEntities → planTools
 *     → (no tools planned) ──────────────────────────────────────► composeAnswer
 *     → executeTools → validateEvidence → assessEvidenceSufficiency
 *     → (needsReplan) ──► replanMissingEvidence → executeTools (cycle back)
 *     → (else) ─────────────────────────────────────────────────► composeAnswer
 *     → validateFinalAnswer
 *         → (PASSED / SKIPPED_GENERAL_EDUCATION) ──────────────► publishFinalAnswer
 *         → (REPAIR_REQUIRED, repairCount < 1) ────────────────► repairAnswer → validateFinalAnswer (cycle back)
 *         → (else: FAILED_SAFE, or REPAIR_REQUIRED exhausted) ─► buildSafeFallback
 *     → logDiagnostics → saveMemory → END
 *
 * Conditional edges skip tool execution entirely for purely educational
 * questions or when planTools decided no tool is needed — the graph never
 * runs every node for every question (Phase 11).
 *
 * Phase 2's assessEvidenceSufficiency → replanMissingEvidence → executeTools
 * cycle is guaranteed to terminate: replanCount is capped at 1
 * (assessEvidenceSufficiency's needsReplan check, enforced again inside
 * replanMissingEvidence itself), so executeTools can run AT MOST twice in
 * one turn. state.js's mergeToolResults/mergeEvidence reducers accumulate
 * across both rounds rather than the second round overwriting the first.
 *
 * Phase 3's validateFinalAnswer → repairAnswer → validateFinalAnswer cycle
 * is the graph's SECOND (and only other) cycle, equally bounded:
 * repairCount is capped at 1 by routeAfterValidation below (never inside
 * validateFinalAnswer itself, which always reports REPAIR_REQUIRED
 * honestly regardless of how many repairs have already happened — the
 * cap is enforced entirely at the routing layer, making the termination
 * condition visible in one place). Every branch out of validateFinalAnswer
 * reaches either publishFinalAnswer or buildSafeFallback, and both always
 * continue to logDiagnostics → saveMemory → END — there is no path that
 * leaves the graph without a final answer.
 */

const builder = new StateGraph(GraphState);

// Every node is wrapped with withNodeTiming (Phase 1 observability) so
// state.nodeTimings covers all 12 nodes uniformly — including the ones
// that never call an LLM — without repeating start/end timestamp
// boilerplate inside each node file.
builder.addNode('validateInput', withNodeTiming('validateInput', validateInput));
builder.addNode('loadThreadMemory', withNodeTiming('loadThreadMemory', loadThreadMemory));
builder.addNode('loadUserContext', withNodeTiming('loadUserContext', loadUserContext));
builder.addNode('classifyIntent', withNodeTiming('classifyIntent', classifyIntent));
builder.addNode('extractEntities', withNodeTiming('extractEntities', extractEntities));
builder.addNode('planTools', withNodeTiming('planTools', planTools));
builder.addNode('executeTools', withNodeTiming('executeTools', executeTools));
builder.addNode('validateEvidence', withNodeTiming('validateEvidence', validateEvidence));
builder.addNode('assessEvidenceSufficiency', withNodeTiming('assessEvidenceSufficiency', assessEvidenceSufficiency));
builder.addNode('replanMissingEvidence', withNodeTiming('replanMissingEvidence', replanMissingEvidence));
builder.addNode('composeAnswer', withNodeTiming('composeAnswer', composeAnswer));
builder.addNode('validateFinalAnswer', withNodeTiming('validateFinalAnswer', validateFinalAnswer));
builder.addNode('repairAnswer', withNodeTiming('repairAnswer', repairAnswer));
builder.addNode('publishFinalAnswer', withNodeTiming('publishFinalAnswer', publishFinalAnswer));
builder.addNode('buildSafeFallback', withNodeTiming('buildSafeFallback', buildSafeFallback));
builder.addNode('logDiagnostics', withNodeTiming('logDiagnostics', logDiagnostics));
builder.addNode('saveMemory', withNodeTiming('saveMemory', saveMemory));

builder.addEdge(START, 'validateInput');

builder.addConditionalEdges('validateInput', (state) => (state.errors.length ? 'composeAnswer' : 'loadThreadMemory'));

builder.addEdge('loadThreadMemory', 'loadUserContext');
builder.addEdge('loadUserContext', 'classifyIntent');
builder.addEdge('classifyIntent', 'extractEntities');
builder.addEdge('extractEntities', 'planTools');

builder.addConditionalEdges('planTools', (state) => (state.toolPlan.length ? 'executeTools' : 'composeAnswer'));

builder.addEdge('executeTools', 'validateEvidence');
builder.addEdge('validateEvidence', 'assessEvidenceSufficiency');

builder.addConditionalEdges('assessEvidenceSufficiency', (state) => (state.needsReplan ? 'replanMissingEvidence' : 'composeAnswer'));
builder.addEdge('replanMissingEvidence', 'executeTools');

builder.addEdge('composeAnswer', 'validateFinalAnswer');

// Phase 3's ONLY routing decision: repairCount < 1 is checked HERE, not
// inside validateFinalAnswer or repairAnswer — one visible place proves
// the repair cycle terminates, rather than an unbounded loop hidden
// inside a node.
export const routeAfterValidation = (state) => {
  if (state.validationStatus === 'PASSED' || state.validationStatus === 'SKIPPED_GENERAL_EDUCATION') return 'publishFinalAnswer';
  if (state.validationStatus === 'REPAIR_REQUIRED' && (state.repairCount || 0) < 1) return 'repairAnswer';
  return 'buildSafeFallback'; // FAILED_SAFE, ABSTAINED (composeAnswer's Phase 4A zero-evidence fast path), or REPAIR_REQUIRED with the one repair already spent
};
builder.addConditionalEdges('validateFinalAnswer', routeAfterValidation);
builder.addEdge('repairAnswer', 'validateFinalAnswer');

builder.addEdge('publishFinalAnswer', 'logDiagnostics');
builder.addEdge('buildSafeFallback', 'logDiagnostics');
builder.addEdge('logDiagnostics', 'saveMemory');
builder.addEdge('saveMemory', END);

export const graph = builder.compile();

export default graph;
