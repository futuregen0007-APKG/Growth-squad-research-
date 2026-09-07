import { logger } from '../../utils/logger.js';

/**
 * logDiagnostics - the ONE place a structured, safe summary of the whole
 * turn gets logged. Fields exactly as specified: requestId, intent,
 * symbols, periods, plannedTools, toolStatus, resultCount, evidenceCount,
 * durationMs, errorCode.
 *
 * NEVER logs: API keys, JWTs/Authorization headers, complete private
 * message content, or raw provider payloads — only the message LENGTH
 * (not content), tool names/statuses/counts, and safe error codes already
 * produced by graph/safeReasons.js / llm/errors.js / providers' own error
 * mappers (never a raw upstream error string).
 */
export const buildDiagnostics = (state) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const messageLength = typeof lastMessage?.content === 'string' ? lastMessage.content.length : 0;

  const toolStatus = state.toolResults.map((t) => ({
    tool: t.tool, status: t.status, errorCode: t.errorCode || null,
    resultCount: t.resultCount ?? 0, evidenceCount: t.evidenceCount ?? 0,
  }));

  const firstErrorEntry = toolStatus.find((t) => t.errorCode) || null;

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
    errorCode: firstErrorEntry?.errorCode || (state.errors.length ? 'GRAPH_ERROR' : null),
  };
};

export const logDiagnostics = async (state) => {
  const diagnostics = buildDiagnostics(state);
  logger.info(`[GS Copilot] ${JSON.stringify(diagnostics)}`);
  return {};
};

export default logDiagnostics;
