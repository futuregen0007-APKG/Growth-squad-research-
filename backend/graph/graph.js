import { StateGraph, START, END } from '@langchain/langgraph';

import { GraphState } from './state.js';
import { validateInput } from './nodes/validateInput.js';
import { loadThreadMemory, loadUserContext } from './nodes/loadMemory.js';
import { classifyIntent } from './nodes/classifyIntent.js';
import { extractEntities } from './nodes/extractEntities.js';
import { planTools } from './nodes/planTools.js';
import { executeTools } from './nodes/executeTools.js';
import { validateEvidence } from './nodes/validateEvidence.js';
import { composeAnswer } from './nodes/composeAnswer.js';
import { validateFinalAnswer } from './nodes/validateFinalAnswer.js';
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
 *     → executeTools → validateEvidence → composeAnswer
 *     → validateFinalAnswer → logDiagnostics → saveMemory → END
 *
 * Conditional edges skip tool execution entirely for purely educational
 * questions or when planTools decided no tool is needed — the graph never
 * runs every node for every question (Phase 11).
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
builder.addNode('composeAnswer', withNodeTiming('composeAnswer', composeAnswer));
builder.addNode('validateFinalAnswer', withNodeTiming('validateFinalAnswer', validateFinalAnswer));
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
builder.addEdge('validateEvidence', 'composeAnswer');

builder.addEdge('composeAnswer', 'validateFinalAnswer');
builder.addEdge('validateFinalAnswer', 'logDiagnostics');
builder.addEdge('logDiagnostics', 'saveMemory');
builder.addEdge('saveMemory', END);

export const graph = builder.compile();

export default graph;
