import { remainingMs } from '../requestBudget.js';
import { logger } from '../../utils/logger.js';
import { emitEvent } from '../../services/telemetry/ragTelemetry.js';
import { metricsStore } from '../../services/telemetry/metricsStore.js';
import { buildTurnMetrics } from '../../services/telemetry/turnClassification.js';
import { estimateRequestCost } from '../../services/telemetry/costEstimation.js';

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

/**
 * Phase 5A Part 3/6/9: the ONE place a completed turn's safe operational
 * summary feeds the telemetry event stream + bounded metrics store —
 * reusing buildDiagnostics' own already-safe fields entirely rather than
 * recomputing anything, and adding nothing that risks leaking a prompt,
 * an evidence excerpt, or a secret (buildDiagnostics already excludes all
 * of those — see its own module note above).
 */
export const logDiagnostics = async (state) => {
  const diagnostics = buildDiagnostics(state);
  logger.info(`[GS Copilot] ${JSON.stringify(diagnostics)}`);

  const turnMetrics = buildTurnMetrics(state);
  const cost = estimateRequestCost(state.llmCalls || []);

  metricsStore.recordRequest({
    completionStatus: turnMetrics.completionStatus,
    isResearch: turnMetrics.isResearch,
    repairAttempted: turnMetrics.repairAttempted,
    repairSucceeded: turnMetrics.repairSucceeded,
  });
  if (turnMetrics.ambiguousCompany) metricsStore.recordAmbiguousCompany();
  if (turnMetrics.errorCategory === 'UNSUPPORTED_PERIOD') metricsStore.recordUnsupportedPeriod();
  if (turnMetrics.isResearch && turnMetrics.evidenceCount === 0) metricsStore.recordZeroEvidence();
  metricsStore.recordCitationCount(turnMetrics.citationCount);
  metricsStore.recordVerifiedClaimCount(turnMetrics.verifiedClaimCount);
  metricsStore.recordRejectedClaimCount(turnMetrics.rejectedClaimCount);
  if (turnMetrics.retrievalMode) metricsStore.recordRetrievalMode(turnMetrics.retrievalMode);
  metricsStore.recordErrorCategory(turnMetrics.errorCategory);
  for (const call of state.llmCalls || []) {
    metricsStore.recordTokenUsage({
      inputTokens: call.inputTokens, outputTokens: call.outputTokens,
      cachedInputTokens: call.cachedInputTokens, reasoningTokens: call.reasoningTokens,
      usageUnknown: call.inputTokens == null && call.outputTokens == null && !call.skipped,
    });
  }
  metricsStore.recordCost(cost.estimatedCost);

  emitEvent('rag.request.completed', {
    traceId: state.traceId, requestId: state.requestId, intent: state.intent,
    researchQuestionType: state.scopeSignal?.researchQuestionType || null,
    companySymbol: state.scopeSignal?.symbol || null,
    fiscalYear: state.scopeSignal?.fiscalYear || null,
    retrievalMode: state.retrievalMode || null,
    groundingStatus: state.groundingStatus || null,
    completionStatus: turnMetrics.completionStatus, errorCategory: turnMetrics.errorCategory,
    durationMs: diagnostics.durationMs, evidenceCount: turnMetrics.evidenceCount,
    citationCount: turnMetrics.citationCount, verifiedClaimCount: turnMetrics.verifiedClaimCount,
    rejectedClaimCount: turnMetrics.rejectedClaimCount, repairAttempted: turnMetrics.repairAttempted,
    estimatedCost: cost.estimatedCost, llmCallCount: (state.llmCalls || []).length,
  });

  return {};
};

export default logDiagnostics;
