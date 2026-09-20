import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../../llm/errors.js';
import { repairPrompt } from '../prompts/index.js';
import { formatMissingEvidenceForPrompt } from '../evidenceCoverage.js';
import { boundedTimeout, hasBudgetFor } from '../requestBudget.js';
import { repairGroundedAnswerNode } from '../groundedAnswer.js';
import { logger } from '../../utils/logger.js';
import { emitEvent } from '../../services/telemetry/ragTelemetry.js';
import { recordLlmCall } from '../../services/telemetry/costLedger.js';

const MIN_REPAIR_BUDGET_MS = 800;

/**
 * repairAnswer - the ONE bounded repair pass (graph.js caps this via
 * repairCount, enforced by routeAfterValidation — this node never checks
 * its own cap, it just does the work and increments the counter every
 * time it runs, success or failure, exactly like Phase 2's
 * replanMissingEvidence increments replanCount unconditionally).
 *
 * Never calls a tool, never expands evidence, never streams to the
 * client — its output is a new PRIVATE draftAnswer that validateFinalAnswer
 * (graph.js cycles back to it) must re-check from scratch. If the repair
 * call itself fails/times out/has no budget, draftAnswer is left
 * UNCHANGED (still the original, already-flagged draft) — the router
 * will see repairCount >= 1 and route to buildSafeFallback rather than
 * publishing it or trying again.
 */
const repairAnswerInner = async (state) => {
  // Phase 4B: grounded RAG branch — see graph/groundedAnswer.js's own
  // module note. repairGroundedAnswerNode increments repairCount itself,
  // exactly like the legacy path below, so routeAfterValidation's cap
  // works unchanged either way.
  if (state.groundedAnswer) {
    return repairGroundedAnswerNode(state);
  }

  const repairCount = (state.repairCount || 0) + 1;

  if (!OpenAIClientFactory.isConfigured() || state.aborted?.() || !hasBudgetFor(state.deadlineAt, MIN_REPAIR_BUDGET_MS)) {
    return { repairCount };
  }

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');

  const prompt = repairPrompt({
    message: text,
    requestedDimensions: state.requestedDimensions,
    evidenceCoverage: state.evidenceCoverage,
    evidence: state.evidence,
    draftAnswer: state.draftAnswer,
    deterministicIssues: state.validationIssues,
    claimValidation: state.claimValidation,
    missingDataNotes: formatMissingEvidenceForPrompt(state.missingEvidence),
  });

  const model = LLM_CONFIG.synthesisModel;
  const startedAt = Date.now();
  const timeoutMs = boundedTimeout(LLM_CONFIG.timeoutMs, state.deadlineAt);
  const localController = new AbortController();
  const combinedSignal = state.abortSignal ? AbortSignal.any([state.abortSignal, localController.signal]) : localController.signal;
  const timer = setTimeout(() => localController.abort(), timeoutMs);

  if (state.onEvent) state.onEvent({ type: 'status', message: 'Verifying claims and citations…' });

  try {
    const client = OpenAIClientFactory.getClient();
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: LLM_CONFIG.maxOutputTokens,
      messages: [{ role: 'user', content: prompt }],
    }, { signal: combinedSignal });

    const repaired = response.choices?.[0]?.message?.content || null;
    const usage = response.usage;
    const llmCalls = [recordLlmCall({
      node: 'repairAnswer', role: 'repair', model, durationMs: Date.now() - startedAt, timedOut: false,
      inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    })];

    if (!repaired) return { repairCount, llmCalls };
    return { draftAnswer: repaired, repairCount, llmCalls };
  } catch (error) {
    const timedOut = error?.isAbort || error?.name === 'APIUserAbortError' || combinedSignal.aborted;
    const llmCalls = [recordLlmCall({ node: 'repairAnswer', role: 'repair', model, durationMs: Date.now() - startedAt, timedOut })];
    if (!timedOut) {
      const mapped = mapOpenAIError(error, { operation: 'repairAnswer' });
      logger.warn(`[Graph] repairAnswer failed: ${mapped.message}`);
    }
    // Draft left unchanged on failure — buildSafeFallback (via the router,
    // since repairCount is now >= 1) will handle it, never a fabricated
    // "repaired" answer.
    return { repairCount, llmCalls };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * repairAnswer - Phase 5A wrapper around the untouched repairAnswerInner
 * above. Emits rag.repair.started on entry and exactly one
 * rag.repair.completed on exit, covering BOTH the grounded branch and the
 * legacy branch and every one of the inner function's early returns
 * (not-configured, cancelled, no-budget, empty repair, provider failure) —
 * so a repair that never really ran is still reported as a completed pass
 * that produced nothing, never as a silently missing event.
 *
 * `repairSucceeded` here means THIS PASS produced a new draft, which is not
 * the same question as whether the turn ended well — validateFinalAnswer
 * re-checks the repaired draft from scratch and may still reject it. The
 * turn-level judgement lives on rag.request.completed.
 *
 * graph.js caps this node at one pass per turn (routeAfterValidation reads
 * repairCount), so one turn can never emit more than one started/completed
 * pair. Never changes the inner function's return value or control flow.
 */
export const repairAnswer = async (state) => {
  emitEvent('rag.repair.started', {
    traceId: state.traceId,
    requestId: state.requestId,
    verificationVerdict: state.validationStatus || null,
  });

  const startedAt = performance.now();
  const update = await repairAnswerInner(state);

  emitEvent('rag.repair.completed', {
    traceId: state.traceId,
    requestId: state.requestId,
    repairSucceeded: Boolean(update?.draftAnswer || update?.groundedAnswer),
    llmCallCount: (update?.llmCalls || []).length,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return update;
};

export default repairAnswer;
