/**
 * toolFingerprint.js
 * ====================
 * Deterministic fingerprint for one planned tool call, used by
 * executeTools.js to deduplicate exact-duplicate calls WITHIN a single
 * request (e.g. the live-observed bug: the LLM planner planned
 * `getCompanyFinancials` twice for the same symbol on top of compareStocks
 * already fetching it internally). Two calls fingerprint identically only
 * when the tool name and every argument value are identical after
 * normalization — a different symbol, period, or any other argument
 * always produces a different fingerprint and is never deduplicated.
 */

const normalizeValue = (value) => {
  if (Array.isArray(value)) return value.map(normalizeValue).sort();
  if (typeof value === 'string') return value.trim().toUpperCase();
  if (value && typeof value === 'object') return normalizeArgs(value);
  return value ?? null;
};

/** Sorts object keys and normalizes each value so argument-order/case never affects the fingerprint. */
const normalizeArgs = (args = {}) => {
  const normalized = {};
  for (const key of Object.keys(args).sort()) {
    normalized[key] = normalizeValue(args[key]);
  }
  return normalized;
};

/** Stable serialization: normalizeArgs already sorts keys, so plain JSON.stringify is order-independent here. */
const stableCanonicalSerialization = (normalizedArgs) => JSON.stringify(normalizedArgs);

/**
 * fingerprintToolCall - `normalizedToolName + stableCanonicalSerialization(normalizedArgs)`.
 * Pure and synchronous, no I/O — safe to call for every planned step
 * before any tool actually executes.
 */
export const fingerprintToolCall = (step) => {
  const tool = String(step?.tool || '').trim();
  const normalizedArgs = normalizeArgs(step?.args || {});
  return `${tool}:${stableCanonicalSerialization(normalizedArgs)}`;
};

export default { fingerprintToolCall };
