import { TOOL_REGISTRY } from '../tools/toolRegistry.js';
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
});

/**
 * executeTools - runs every planned tool call in parallel
 * (Promise.allSettled — Phase 11's "parallel independent tools"). One
 * tool throwing/rejecting never discards the others' results.
 */
export const executeTools = async (state) => {
  if (state.errors.length || !state.toolPlan.length) return {};

  const settled = await Promise.allSettled(
    state.toolPlan.map((step) => {
      const fn = TOOL_REGISTRY[step.tool];
      if (!fn) {
        return Promise.resolve({
          tool: step.tool, status: 'ERROR', data: null, evidence: [],
          resultCount: 0, evidenceCount: 0, errorCode: 'UNKNOWN_TOOL',
          fetchedAt: new Date().toISOString(), warning: 'Unknown tool.',
        });
      }
      if (state.onEvent) {
        state.onEvent({ type: 'tool.started', tool: step.tool });
        state.onEvent({ type: 'status', message: STATUS_LABEL[step.tool] || 'Gathering information…' });
      }
      return fn(step.args, { userId: state.userId });
    }),
  );

  const toolResults = [];
  const evidence = [];
  const warnings = [];

  // ERROR must never be silently reported as EMPTY — the event emitted
  // here always carries the tool's OWN determined status/errorCode
  // verbatim (see toolRegistry.js's deriveBundleOutcome/classifyErrorCode:
  // that's where the real ERROR vs EMPTY vs UNAVAILABLE vs UNSUPPORTED
  // decision is made, once, based on the actual provider error code —
  // this node just relays it, including to the dev-only frontend tool
  // activity panel via resultCount/evidenceCount/errorCode).
  settled.forEach((outcome, index) => {
    const toolName = state.toolPlan[index].tool;
    if (outcome.status === 'fulfilled') {
      const toolResult = outcome.value;
      toolResults.push(toolResult);
      evidence.push(...(toolResult.evidence || []));
      if (state.onEvent) {
        state.onEvent({
          type: 'tool.completed', tool: toolName, status: toolResult.status,
          resultCount: toolResult.resultCount ?? 0, evidenceCount: toolResult.evidenceCount ?? 0,
          errorCode: toolResult.errorCode ?? null,
        });
      }
      if (toolResult.warning) warnings.push(toolResult.warning);
    } else {
      logger.warn(`[Graph] tool ${toolName} rejected: ${outcome.reason?.message}`);
      const failed = {
        tool: toolName, status: 'ERROR', data: null, evidence: [],
        resultCount: 0, evidenceCount: 0, errorCode: 'TOOL_REJECTED',
        fetchedAt: new Date().toISOString(), warning: 'This data source failed unexpectedly.',
      };
      toolResults.push(failed);
      if (state.onEvent) {
        state.onEvent({ type: 'tool.completed', tool: toolName, status: 'ERROR', resultCount: 0, evidenceCount: 0, errorCode: 'TOOL_REJECTED' });
      }
      warnings.push(failed.warning);
    }
  });

  return { toolResults, evidence, warnings };
};

export default executeTools;
