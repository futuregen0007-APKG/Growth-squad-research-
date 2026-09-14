import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../../llm/errors.js';
import { buildSystemPrompt, answerComposerPrompt } from '../prompts/index.js';
import { formatMissingEvidenceForPrompt } from '../evidenceCoverage.js';
import { SAFE_REASONS } from '../safeReasons.js';
import { boundedTimeout, hasBudgetFor } from '../requestBudget.js';
import { extractCitations } from '../citations.js';
import { logger } from '../../utils/logger.js';

// Re-exported unchanged for backward compatibility — extractCitations now
// lives in graph/citations.js (see its own module note for why: it's used
// by publishFinalAnswer.js and buildSafeFallback.js too, not just here).
export { extractCitations };

const MIN_COMPOSE_BUDGET_MS = 500;

const GENERAL_EDUCATION_SYSTEM_NOTE = 'This is a general educational question — answer directly and concisely, with no citations needed since no company-specific tool data was used.';

// UNSUPPORTED must NEVER be treated like GENERAL_EDUCATION — a general
// question ("what is a P/E ratio?") is safe to answer from the model's own
// knowledge, but an UNSUPPORTED classification specifically means "this
// requires a capability GS Copilot doesn't have" (e.g. sector-wide
// ranking/discovery — see classifyIntent's isUnsupportedSectorDiscovery).
// Letting the model answer normally here would mean it improvises a
// ranked list of companies from its own training data with no real
// evidence — exactly the "answer from unsupported knowledge" failure mode
// this project must prevent. The model is told plainly to decline instead.
const UNSUPPORTED_SYSTEM_NOTE = `This request needs a capability GS Copilot does not currently have (for example: ranking or discovering companies across a whole sector by a metric like order book — there is no such tool or dataset available). Do not attempt to answer using your own general knowledge or guess a list of companies. Instead, clearly tell the user: "${SAFE_REASONS.CAPABILITY_NOT_SUPPORTED} — GS Copilot can look up named companies individually (e.g. financials, margins, comparisons between specific companies you name), but cannot yet rank or discover companies across an entire sector." Keep it brief and suggest they name specific companies instead.`;

/**
 * composeAnswer - Phase 3: produces a PRIVATE draft only. OpenAI output is
 * still received as a real stream internally (so the SDK's normal
 * streaming/cancellation path is exercised), but individual deltas are
 * accumulated on the server and are NEVER emitted as `token` events and
 * NEVER persisted — see nodes/publishFinalAnswer.js, the only node that
 * ever emits token events or writes `state.answer`, and only once
 * validateFinalAnswer has actually passed (or repaired) this draft.
 *
 * Latency trade-off (documented per instruction): the user's first
 * VISIBLE answer token now arrives after composition AND validation (and,
 * on the minority of turns that need it, one repair pass) complete —
 * strictly later than before, when raw tokens were streamed live as
 * OpenAI produced them. The `status` events below exist specifically to
 * keep the UI feeling responsive during that gap.
 *
 * For every deterministic/safe path below (input errors, not configured,
 * no budget, a provider error, a genuine cancellation) the "draft" is
 * already a fixed, non-LLM-generated safe string — never fabricated, so
 * `validationStatus: 'SKIPPED_GENERAL_EDUCATION'` is set directly and
 * validateFinalAnswer passes it straight through without re-checking.
 * The one exception is a genuine cancellation/timeout, where draftAnswer
 * stays null (nothing to publish) and validationStatus is 'FAILED_SAFE'.
 */
export const composeAnswer = async (state) => {
  if (state.errors.length) {
    const draftAnswer = state.errors[0];
    return { draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION' };
  }

  if (!OpenAIClientFactory.isConfigured()) {
    const draftAnswer = "GS Copilot isn't configured yet — the site administrator needs to set an OpenAI API key.";
    return { draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION', warnings: ['OpenAI is not configured.'] };
  }

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');

  // Phase 2 bug found via live evaluation: this used to check
  // `!state.toolPlan.length` to mean "planTools decided no tool was
  // needed." That stopped being true once a bounded replan round could
  // exist (nodes/replanMissingEvidence.js) — a replan round that
  // correctly finds nothing further worth fetching (e.g. every gap is
  // UNAVAILABLE with no alternative tool) legitimately returns
  // `toolPlan: []`, overwriting round 1's real plan even though real
  // tools DID run and produced real (if empty/unavailable) toolResults.
  // Composing with GENERAL_EDUCATION_SYSTEM_NOTE in that case is actively
  // wrong: that note explicitly tells the model "no citations needed,
  // answer from your own knowledge" for what was really an
  // evidence-dependent question — confirmed live, this caused a
  // "Compare HAL and BEL" comparison (both symbols UNAVAILABLE from a
  // real IndianAPI rate limit) to be answered with fabricated general
  // knowledge (invented founding years, etc.) instead of the honest
  // "I don't have data right now" the warnings already correctly said.
  // toolResults — accumulated across BOTH rounds via state.js's
  // mergeToolResults — is the reliable signal for "did any tool actually
  // run this turn," regardless of what the LATEST round's plan was.
  const isGeneralEducation = state.intent === 'GENERAL_EDUCATION' || !state.toolResults.length;
  const userPrompt = state.intent === 'UNSUPPORTED'
    ? `${UNSUPPORTED_SYSTEM_NOTE}\n\nUser question: "${text}"`
    : isGeneralEducation
      ? `${GENERAL_EDUCATION_SYSTEM_NOTE}\n\nUser question: "${text}"`
      : answerComposerPrompt({
        message: text, conversationSummary: state.conversationSummary, evidence: state.evidence, toolResults: state.toolResults,
        warnings: state.warnings, missingDataNotes: formatMissingEvidenceForPrompt(state.missingEvidence),
      });

  // Never start a synthesis call with essentially no budget left — a
  // partial-evidence, honest "ran out of time" answer beats hanging past
  // the turn's total deadline.
  if (!hasBudgetFor(state.deadlineAt, MIN_COMPOSE_BUDGET_MS)) {
    const draftAnswer = 'I ran out of time gathering everything for this answer — please try again.';
    return {
      draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION',
      warnings: ['Response generation skipped: request deadline exhausted.'],
      llmCalls: [{ node: 'composeAnswer', role: 'synthesis', model: LLM_CONFIG.synthesisModel, durationMs: 0, timedOut: false, skipped: 'SKIPPED_NO_BUDGET' }],
    };
  }

  const systemPrompt = buildSystemPrompt(state.userContext);
  if (state.onEvent) state.onEvent({ type: 'status', message: 'Composing evidence-backed answer…' });

  // Recent prior turns are included verbatim (never summarized) so the
  // model has real conversational continuity beyond the factual summary.
  const historyMessages = (state.recentHistory || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const model = LLM_CONFIG.synthesisModel;
  const startedAt = Date.now();
  // Real cancellation: a controller-provided AbortSignal (client
  // disconnect or the request's total deadline — see ChatController.js)
  // is combined with a local timer bounded to whatever's left of the
  // budget, so composeAnswer never waits past either.
  const timeoutMs = boundedTimeout(LLM_CONFIG.timeoutMs, state.deadlineAt);
  const localController = new AbortController();
  const combinedSignal = state.abortSignal ? AbortSignal.any([state.abortSignal, localController.signal]) : localController.signal;
  const timer = setTimeout(() => localController.abort(), timeoutMs);

  try {
    const client = OpenAIClientFactory.getClient();
    const stream = await client.chat.completions.create({
      model,
      temperature: LLM_CONFIG.temperature,
      max_tokens: LLM_CONFIG.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: userPrompt },
      ],
    }, { signal: combinedSignal });

    let full = '';
    let tokenUsage = null;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      // Draft chunks are accumulated PRIVATELY — never emitted as a
      // user-visible `token` event and never persisted. Only
      // publishFinalAnswer, after validation, emits the final text.
      if (delta) full += delta;
      if (chunk.usage) {
        tokenUsage = {
          inputTokens: chunk.usage.prompt_tokens ?? null,
          outputTokens: chunk.usage.completion_tokens ?? null,
          totalTokens: chunk.usage.total_tokens ?? null,
        };
      }
      if (state.aborted?.()) {
        stream.controller?.abort?.();
        break;
      }
    }

    const llmCalls = [{
      node: 'composeAnswer', role: 'synthesis', model, durationMs: Date.now() - startedAt, timedOut: false,
      inputTokens: tokenUsage?.inputTokens ?? null, outputTokens: tokenUsage?.outputTokens ?? null,
    }];
    if (state.onEvent) state.onEvent({ type: 'status', message: 'Verifying claims and citations…' });
    return { draftAnswer: full, tokenUsage, llmCalls };
  } catch (error) {
    const timedOut = error?.isAbort || error?.name === 'APIUserAbortError' || combinedSignal.aborted;
    const llmCalls = [{ node: 'composeAnswer', role: 'synthesis', model, durationMs: Date.now() - startedAt, timedOut }];
    if (timedOut) {
      // A caller-initiated cancellation (client disconnect / deadline) is
      // never reported as a provider failure, and there is nothing safe
      // to publish — draftAnswer stays null, FAILED_SAFE short-circuits
      // the rest of the pipeline cheaply (see validateFinalAnswer.js).
      return { draftAnswer: null, validationStatus: 'FAILED_SAFE', warnings: ['Generation was stopped.'], llmCalls };
    }
    const mapped = mapOpenAIError(error, { operation: 'composeAnswer' });
    logger.warn(`[Graph] composeAnswer failed: ${mapped.message}`);
    const draftAnswer = 'I ran into a problem generating a response just now. Please try again.';
    return { draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION', errors: [mapped.message], llmCalls };
  } finally {
    clearTimeout(timer);
  }
};

export default composeAnswer;
