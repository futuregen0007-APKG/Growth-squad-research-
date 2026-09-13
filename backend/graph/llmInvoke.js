/**
 * llmInvoke.js
 * ==============
 * Shared instrumentation wrapper around the OpenAI SDK calls made by
 * classifyIntent/extractEntities/planTools (all "routing"-role, structured
 * output via zodResponseFormat). Centralizes exactly the cross-cutting
 * Phase 1 behavior every one of those call sites needs, instead of
 * repeating it three times:
 *   - skip the call entirely once the request's deadline is already
 *     exhausted (never start new LLM work with no budget left)
 *   - bound the per-call timeout to whatever's actually left on the budget
 *   - pass the request's AbortSignal through to the SDK call (true
 *     cancellation — the OpenAI SDK supports {signal} natively)
 *   - record a safe diagnostic entry (node, role, model, token usage,
 *     duration, timedOut) — never the prompt text or the parsed content
 *
 * composeAnswer is deliberately NOT built on this helper — it streams
 * (chat.completions.create({stream:true})) rather than using .parse(), and
 * already has its own abort-aware loop; see composeAnswer.js.
 */
import { zodResponseFormat } from 'openai/helpers/zod';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { boundedTimeout } from './requestBudget.js';

export const SKIPPED_NO_BUDGET = 'SKIPPED_NO_BUDGET';

/**
 * invokeRoutingModel - returns { parsed, error, diagnostic }. `parsed` is
 * null (never thrown) when the model isn't configured, the budget is
 * already exhausted, the call times out, or the SDK call otherwise fails —
 * every caller already has its own deterministic fallback for "no parsed
 * result", so this never throws.
 */
export const invokeRoutingModel = async ({
  node, model, temperature = 0, maxTokens, schema, schemaName, prompt, signal, deadlineAt, minBudgetMs = 500,
}) => {
  const startedAt = Date.now();
  const baseDiagnostic = { node, role: 'routing', model };

  if (!OpenAIClientFactory.isConfigured()) {
    return { parsed: null, error: 'NOT_CONFIGURED', diagnostic: { ...baseDiagnostic, durationMs: 0, timedOut: false, skipped: 'NOT_CONFIGURED' } };
  }

  const timeoutMs = boundedTimeout(60000, deadlineAt);
  if (timeoutMs < minBudgetMs) {
    return { parsed: null, error: SKIPPED_NO_BUDGET, diagnostic: { ...baseDiagnostic, durationMs: 0, timedOut: false, skipped: SKIPPED_NO_BUDGET } };
  }

  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const client = OpenAIClientFactory.getClient();
    const response = await client.chat.completions.parse({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      response_format: zodResponseFormat(schema, schemaName),
    }, { signal: combinedSignal });

    const parsed = response.choices?.[0]?.message?.parsed || null;
    const usage = response.usage || null;
    return {
      parsed,
      error: parsed ? null : 'NO_PARSED_RESULT',
      diagnostic: {
        ...baseDiagnostic,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        inputTokens: usage?.prompt_tokens ?? null,
        outputTokens: usage?.completion_tokens ?? null,
      },
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || combinedSignal.aborted;
    // A cancellation (client disconnect / deadline) is never reported as a
    // provider failure — see graph/tools/circuitBreaker.js's same rule for
    // tools. This node's own error field distinguishes CANCELLED from a
    // genuine SDK/provider error for the caller and for diagnostics.
    return {
      parsed: null,
      error: timedOut ? 'CANCELLED' : 'PROVIDER_ERROR',
      diagnostic: { ...baseDiagnostic, durationMs: Date.now() - startedAt, timedOut },
    };
  } finally {
    clearTimeout(timer);
  }
};

export default { invokeRoutingModel, SKIPPED_NO_BUDGET };
