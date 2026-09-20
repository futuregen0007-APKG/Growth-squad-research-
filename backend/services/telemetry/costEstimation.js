/**
 * costEstimation.js
 * ===================
 * Phase 5A Part 5: LLM cost accounting. Estimates a $ cost from ALREADY-
 * CAPTURED provider token usage (graph/llmInvoke.js, graph/nodes/
 * composeAnswer.js already record real `usage.prompt_tokens`/
 * `completion_tokens` when the provider returns them — this module never
 * estimates usage itself, and never makes a model/network call of its own).
 *
 * Phase 5B: the price DATA moved to services/telemetry/modelPricing.js — a
 * validated configuration module that records where the figures came from,
 * when they were last confirmed, whether they are stale, and which entries
 * it rejected. This module keeps only the arithmetic. The exports below are
 * unchanged in name, shape, and value, so every Phase 5A caller and test
 * continues to work against them.
 */
import {
  getPricing, resolveModelId, PRICING_TABLE, PRICING_VERSION, PRICING_LAST_UPDATED, PRICING_CURRENCY,
} from './modelPricing.js';

// Phase 5A compatibility surface. PRICE_TABLE is modelPricing's own
// validated table (a rejected entry is absent from both, so an invalid
// price can never be used here either).
export const PRICE_TABLE_VERSION = PRICING_VERSION;
export const PRICE_TABLE_ASOF = PRICING_LAST_UPDATED;
export const PRICE_TABLE = PRICING_TABLE;

/**
 * estimateCallCost - one LLM call's estimated cost, or `null` when the
 * model isn't in PRICE_TABLE (an unknown/new model must never silently
 * price as $0) or when token usage itself is unknown (never estimate a
 * cost from a guessed token count).
 */
export const estimateCallCost = ({ model, inputTokens, outputTokens, cachedInputTokens = 0 } = {}) => {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  // Alias-aware: a pinned/dated model id the provider returned is priced
  // as its canonical entry, but only via modelPricing's explicit alias map —
  // an unknown model still prices as null, never at a guessed rate.
  const pricing = getPricing(model);
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
    return { estimatedCost: null, currency: PRICING_CURRENCY, priceTableVersion: PRICE_TABLE_VERSION, unknownCallCount: 0, isEstimate: true };
  }
  return {
    estimatedCost: knownCount > 0 ? Number(total.toFixed(8)) : null,
    currency: PRICING_CURRENCY,
    priceTableVersion: PRICE_TABLE_VERSION,
    unknownCallCount: unknownCount,
    isEstimate: true,
  };
};

export default {
  PRICE_TABLE_VERSION, PRICE_TABLE_ASOF, PRICE_TABLE, estimateCallCost, estimateRequestCost, resolveModelId,
};
