import { remainingMs } from '../requestBudget.js';
import { logger } from '../../utils/logger.js';

/**
 * logDiagnostics - the ONE place a structured, safe summary of the whole
 * turn gets logged. Fields exactly as specified: requestId, intent,
 * symbols, periods, plannedTools, toolStatus, resultCount, evidenceCount,
 * durationMs, errorCode — plus Phase 1's additions: remainingDeadlineMs,
 * nodeTimings, llmCalls (role/model/tokens/duration per call, never the
 * prompt or parsed content), deduplicatedToolCalls, and per-tool
 * cacheStatus/circuitState/cancellationMode (already attached to each
 * toolResults entry by graph/tools/toolRegistry.js).
 *
 * NEVER logs: API keys, JWTs/Authorization headers, complete private
 * message content, full prompts, full tool payloads, or raw provider
 * payloads — only the message LENGTH (not content), tool names/statuses/
 * counts, and safe error codes already produced by graph/safeReasons.js /
 * llm/errors.js / providers' own error mappers (never a raw upstream
 * error string). llmCalls carries only role/model/token-counts/timing —
 * never the prompt text or the model's output.
 */
export const buildDiagnostics = (state) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const messageLength = typeof lastMessage?.content === 'string' ? lastMessage.content.length : 0;

  const toolStatus = state.toolResults.map((t) => ({
    tool: t.tool, status: t.status, errorCode: t.errorCode || null,
    resultCount: t.resultCount ?? 0, evidenceCount: t.evidenceCount ?? 0,
    durationMs: t.durationMs ?? null,
    cacheStatus: t.cacheStatus ?? null,
    circuitState: t.circuitState ?? null,
    cancellationMode: t.cancellationMode ?? null,
    deduplicated: t.deduplicated ?? false,
  }));

  const firstErrorEntry = toolStatus.find((t) => t.errorCode) || null;

  const llmCalls = (state.llmCalls || []).map((c) => ({
    node: c.node, role: c.role, model: c.model,
    inputTokens: c.inputTokens ?? null, outputTokens: c.outputTokens ?? null,
    durationMs: c.durationMs ?? null, timedOut: Boolean(c.timedOut), skipped: c.skipped || null,
  }));
  const tokenTotals = llmCalls.reduce((acc, c) => ({
    inputTokens: acc.inputTokens + (c.inputTokens || 0),
    outputTokens: acc.outputTokens + (c.outputTokens || 0),
  }), { inputTokens: 0, outputTokens: 0 });

  return {
    requestId: state.requestId || null,
    intent: state.intent || null,
    symbols: state.entities?.symbols || [],
    periods: state.entities?.periods || [],
    messageLength,
    plannedTools: state.toolPlan.map((t) => t.tool),
    toolStatus,
    resultCount: state.toolResults.reduce((sum, t) => sum + (t.resultCount || 0), 0),
    evidenceCount: state.evidence.length,
    durationMs: state.turnStartedAt ? Date.now() - state.turnStartedAt : null,
    remainingDeadlineMs: state.deadlineAt != null ? remainingMs(state.deadlineAt) : null,
    nodeTimings: state.nodeTimings || [],
    llmCalls,
    tokenTotals,
    deduplicatedToolCalls: state.deduplicatedToolCalls || [],
    errorCode: firstErrorEntry?.errorCode || (state.errors.length ? 'GRAPH_ERROR' : null),
  };
};

export const logDiagnostics = async (state) => {
  const diagnostics = buildDiagnostics(state);
  logger.info(`[GS Copilot] ${JSON.stringify(diagnostics)}`);
  return {};
};

export default logDiagnostics;
