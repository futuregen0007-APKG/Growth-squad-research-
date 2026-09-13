/**
 * requestBudget.js
 * =================
 * End-to-end request deadline for one GS Copilot turn. Deliberately tiny
 * and pure (no I/O) so it's trivially unit-testable with fake clocks.
 *
 * `deadlineAt` is set exactly ONCE, in validateInput (the first node) —
 * every later node only reads it via remainingMs()/hasBudgetFor(), never
 * recomputes or extends it. This is what lets Phase 1 "stop starting new
 * work when the budget is exhausted" instead of a node silently getting a
 * fresh full timeout of its own.
 */

// Bounds chosen so a misconfigured env var can never make the graph hang
// indefinitely (too high) or fail almost every real request (too low, e.g.
// a research/comparison question that legitimately needs several tool
// calls plus 2 LLM calls).
export const MIN_DEADLINE_MS = 5000;
export const MAX_DEADLINE_MS = 120000;
export const DEFAULT_DEADLINE_MS = 45000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * resolveTotalDeadlineMs - reads CHAT_TOTAL_DEADLINE_MS, clamped to a safe
 * range. An invalid/missing value falls back to DEFAULT_DEADLINE_MS rather
 * than throwing — a misconfigured env var must never crash the graph.
 */
export const resolveTotalDeadlineMs = (env = process.env) => {
  const raw = Number(env.CHAT_TOTAL_DEADLINE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DEADLINE_MS;
  return clamp(raw, MIN_DEADLINE_MS, MAX_DEADLINE_MS);
};

/** Wall-clock ms remaining until deadlineAt. Never negative. Null deadlineAt (deadline not set) returns Infinity — "no budget enforced" rather than "no budget at all". */
export const remainingMs = (deadlineAt, now = Date.now()) => {
  if (deadlineAt == null) return Infinity;
  return Math.max(0, deadlineAt - now);
};

/** True when at least `minMs` remains before the deadline — the check every node/tool makes before starting new work. */
export const hasBudgetFor = (deadlineAt, minMs = 0, now = Date.now()) => remainingMs(deadlineAt, now) >= minMs;

/**
 * boundedTimeout - the timeout a single call should use: never longer
 * than its own natural ceiling, never longer than what's actually left on
 * the request's total budget. Returns 0 when the budget is already
 * exhausted (caller must treat 0 as "do not even attempt this").
 */
export const boundedTimeout = (naturalTimeoutMs, deadlineAt, now = Date.now()) => {
  const remaining = remainingMs(deadlineAt, now);
  if (remaining === Infinity) return naturalTimeoutMs;
  return Math.max(0, Math.min(naturalTimeoutMs, remaining));
};

export default {
  MIN_DEADLINE_MS, MAX_DEADLINE_MS, DEFAULT_DEADLINE_MS, resolveTotalDeadlineMs, remainingMs, hasBudgetFor, boundedTimeout,
};
