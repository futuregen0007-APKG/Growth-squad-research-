/**
 * circuitBreaker.js
 * ===================
 * A small CLOSED/OPEN/HALF_OPEN circuit breaker, one instance per external
 * provider adapter (Angel One, IndianAPI, NewsAPI — see toolRegistry.js's
 * PROVIDER_BREAKERS) rather than one global breaker for every tool: one
 * provider having a bad day must never disable tools that depend on a
 * completely different, healthy provider.
 *
 * Only counts failure modes that genuinely indicate "this provider is
 * unhealthy right now": timeout, rate-limited, network failure, upstream
 * 5xx/unavailable (see isBreakerCountedFailure). It deliberately never
 * counts: cancellation, an invalid/unknown symbol, an empty result, an
 * auth/permission rejection, a validation error, or an unsupported
 * capability — none of those say anything about the provider's health.
 */

export const CIRCUIT_STATE = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30000;

// The same fixed error-code vocabulary already used by graph/safeReasons.js
// and toolRegistry.js's deriveBundleOutcome -- reused here rather than a
// second, competing classification list.
const BREAKER_COUNTED_CODES = new Set([
  'TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_ERROR', 'NETWORK_ERROR',
]);

/** True for the specific failure modes a circuit breaker should count. Never true for cancellation, auth, validation, not-found, or unsupported-capability outcomes. */
export const isBreakerCountedFailure = ({ cancelled = false, errorCode = null, httpStatus = null } = {}) => {
  if (cancelled) return false;
  if (errorCode && BREAKER_COUNTED_CODES.has(errorCode)) return true;
  if (typeof httpStatus === 'number' && httpStatus >= 500) return true;
  return false;
};

export class ProviderCircuitBreaker {
  constructor(name, { failureThreshold = DEFAULT_FAILURE_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.state = CIRCUIT_STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  /** Current state, resolving OPEN -> HALF_OPEN once the cooldown has elapsed (a state transition is only observed lazily, on the next check/call — there is no background timer). */
  getState() {
    if (this.state === CIRCUIT_STATE.OPEN && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = CIRCUIT_STATE.HALF_OPEN;
    }
    return this.state;
  }

  /** Whether a new call may proceed right now (false only while genuinely OPEN — HALF_OPEN allows exactly the next call through as a trial). */
  canAttempt() {
    return this.getState() !== CIRCUIT_STATE.OPEN;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.state = CIRCUIT_STATE.CLOSED;
    this.openedAt = null;
  }

  /** `outcome` is the same shape isBreakerCountedFailure takes -- a call that fails for a non-counted reason (auth, validation, empty, cancelled) never moves the breaker. */
  recordOutcome(outcome) {
    if (!isBreakerCountedFailure(outcome)) {
      // A HALF_OPEN trial that failed for a non-counted reason (e.g. the
      // symbol itself was invalid) must not be treated as "the provider
      // recovered" either -- leave the breaker exactly where it was.
      return;
    }
    if (this.getState() === CIRCUIT_STATE.HALF_OPEN) {
      this.state = CIRCUIT_STATE.OPEN;
      this.openedAt = this.now();
      this.consecutiveFailures = this.failureThreshold;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = CIRCUIT_STATE.OPEN;
      this.openedAt = this.now();
    }
  }

  /** Safe diagnostic snapshot -- state/counters only, never a stack trace or provider payload. */
  getDiagnostics() {
    return { provider: this.name, state: this.getState(), consecutiveFailures: this.consecutiveFailures };
  }
}

const breakers = new Map();

/** One shared breaker instance per provider name, created lazily -- callers never construct ProviderCircuitBreaker directly outside tests. */
export const getProviderBreaker = (providerName, options) => {
  if (!breakers.has(providerName)) {
    breakers.set(providerName, new ProviderCircuitBreaker(providerName, options));
  }
  return breakers.get(providerName);
};

/** Test-only: drops all breaker state so each test file starts clean. Never used by app code. */
export const __resetAllBreakersForTests = () => { breakers.clear(); };

export default { ProviderCircuitBreaker, getProviderBreaker, isBreakerCountedFailure, CIRCUIT_STATE, __resetAllBreakersForTests };
