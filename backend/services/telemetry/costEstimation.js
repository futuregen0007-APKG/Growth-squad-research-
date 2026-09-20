/**
 * costEstimation.js
 * ===================
 * Phase 5A Part 5: LLM cost accounting. Estimates a $ cost from ALREADY-
 * CAPTURED provider token usage (graph/llmInvoke.js, graph/nodes/
 * composeAnswer.js already record real `usage.prompt_tokens`/
 * `completion_tokens` when the provider returns them — this module never
 * estimates usage itself, and never makes a model/network call of its own).
 *
 * The price table is explicitly VERSIONED and dated — never presented as
 * permanently current. Update PRICE_TABLE_VERSION and PRICE_TABLE_ASOF
 * whenever prices change; this file's own git history is the source of
 * truth for "when did this change," not a runtime timestamp.
 */

export const PRICE_TABLE_VERSION = '2026-09-1';
// Manually confirmed against OpenAI's published pricing as of this date —
// NOT auto-fetched, NOT guaranteed current at any later date. $ per 1M
// tokens, input/output priced separately (cached input, when known, is
// priced separately too since providers typically discount it).
export const PRICE_TABLE_ASOF = '2026-09-19';
export const PRICE_TABLE = Object.freeze({
  'gpt-4o-mini': { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.60 },
  'gpt-4o': { inputPer1M: 2.50, cachedInputPer1M: 1.25, outputPer1M: 10.00 },
  'gpt-4.1-mini': { inputPer1M: 0.40, cachedInputPer1M: 0.10, outputPer1M: 1.60 },
  'gpt-4.1': { inputPer1M: 2.00, cachedInputPer1M: 0.50, outputPer1M: 8.00 },
});

/**
 * estimateCallCost - one LLM call's estimated cost, or `null` when the
 * model isn't in PRICE_TABLE (an unknown/new model must never silently
 * price as $0) or when token usage itself is unknown (never estimate a
 * cost from a guessed token count).
 */
export const estimateCallCost = ({ model, inputTokens, outputTokens, cachedInputTokens = 0 } = {}) => {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const pricing = PRICE_TABLE[model];
  if (!pricing) return null;

  const billableInput = Math.max(0, inputTokens - (Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0));
  const cachedInput = Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0;
  const cost = (billableInput / 1_000_000) * pricing.inputPer1M
    + (cachedInput / 1_000_000) * pricing.cachedInputPer1M
    + (outputTokens / 1_000_000) * pricing.outputPer1M;
  return Number(cost.toFixed(8));
};

/**
 * estimateRequestCost - sums estimateCallCost over every LLM call this
 * turn made (state.llmCalls). Returns { estimatedCost, currency,
 * priceTableVersion, unknownCallCount } — `estimatedCost` is null (never
 * 0) when EVERY call's cost is unknown, so a caller can never mistake
 * "we don't know" for "this was free." A partial mix of known/unknown
 * calls sums only the known ones and reports how many were excluded.
 */
export const estimateRequestCost = (llmCalls = []) => {
  let total = 0;
  let knownCount = 0;
  let unknownCount = 0;

  for (const call of llmCalls) {
    if (call?.skipped) continue; // never attempted -- not "unknown cost," genuinely zero calls
    const cost = estimateCallCost(call);
    if (cost === null) { unknownCount += 1; continue; }
    total += cost;
    knownCount += 1;
  }

  if (knownCount === 0 && unknownCount === 0) {
    return { estimatedCost: null, currency: 'USD', priceTableVersion: PRICE_TABLE_VERSION, unknownCallCount: 0, isEstimate: true };
  }
  return {
    estimatedCost: knownCount > 0 ? Number(total.toFixed(8)) : null,
    currency: 'USD',
    priceTableVersion: PRICE_TABLE_VERSION,
    unknownCallCount: unknownCount,
    isEstimate: true,
  };
};

export default { PRICE_TABLE_VERSION, PRICE_TABLE_ASOF, PRICE_TABLE, estimateCallCost, estimateRequestCost };
