/**
 * backendHealth.js
 * =================
 * Cold-start-aware checks against the backend's two distinct health
 * surfaces (see backend/server.js and backend/utils/healthHandlers.js), a
 * single shared (singleton) readiness store, and a shared classifier that
 * lets any API client report "the backend just became unavailable" so the
 * whole app can fall back into the same wake-up UI it shows on first load.
 *
 *  - /health  (liveness): "the Node process is up and Express is
 *    listening". Responds 200 the instant the server binds its port,
 *    regardless of Mongo/Redis. This is what Render's own platform health
 *    check polls -- the frontend must NOT treat a 200 here as "safe to
 *    load data", because Express can be listening for seconds before
 *    Mongo finishes connecting, and almost every real API call needs
 *    Mongo. Kept here only as `pingLiveness` for completeness/diagnostics.
 *  - /ready   (readiness): 503 until MongoDB is actually connected, 200
 *    only once real API calls are expected to work. THIS is what the
 *    frontend waits on before firing dashboard/search/any other request --
 *    Express merely "listening" is not sufficient.
 *
 * Render's free tier sleeps the backend after inactivity and can take
 * ~45-60s to wake back up; a normal per-request timeout (used once the app
 * is actually loading data) is much shorter than that on purpose, so this
 * module exists to absorb the one-time wake-up wait *before* any real
 * request is fired, rather than solving it by making every request's
 * timeout huge.
 *
 * This intentionally does NOT keep the backend warm (no periodic ping/
 * keep-alive) -- it only waits out a wake-up the user has already triggered
 * by opening the app. Eliminating cold starts entirely requires an
 * always-on Render plan; this only makes the wait legible and bounded.
 */
import API_BASE from '@/config/api';

const READY_URL = `${API_BASE}/ready`;
const HEALTH_URL = `${API_BASE}/health`;
const DEFAULT_MAX_WAIT_MS = 75000;
const POLL_INTERVAL_MS = 2000;
const PER_ATTEMPT_TIMEOUT_MS = 5000;

const boundedFetch = async (url, { timeoutMs = PER_ATTEMPT_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return response;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * checkBackendReadiness - a single bounded call to /ready. Never throws --
 * resolves false on any network error, timeout, or a non-2xx status
 * (including the expected 503 "still starting"). This is the check that
 * actually gates real requests: it is false whenever MongoDB isn't
 * connected yet, not merely whenever the process hasn't started.
 */
export const checkBackendReadiness = async (options = {}) => {
  try {
    const response = await boundedFetch(READY_URL, options);
    return response.ok;
  } catch {
    return false;
  }
};

/** A single bounded liveness check against /health. Diagnostic use only -- never used to gate requests (see module header). */
export const pingLiveness = async (options = {}) => {
  try {
    const response = await boundedFetch(HEALTH_URL, options);
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * waitForBackendReady - polls /ready until it reports 200 (Mongo
 * connected) or `maxWaitMs` elapses. `onTick` is called after every
 * attempt with { attempt, elapsedMs, maxWaitMs, ok } so a caller can
 * render "Starting backend service..." with live progress. Always
 * resolves (never rejects) with a boolean -- a timeout is a normal,
 * expected outcome (the caller proceeds anyway; ordinary per-request
 * timeouts and error states take over from there), not an exceptional one.
 * This same bound is what keeps a post-failure *recovery* poll (see
 * reportBackendUnavailable below) from ever retrying forever.
 */
export const waitForBackendReady = async ({
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  onTick = () => {},
} = {}) => {
  const startedAt = Date.now();
  let attempt = 0;

  // Try immediately first -- the common case (already warm) should never
  // wait a full poll interval just to confirm what a first attempt would
  // have shown right away.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    const ok = await checkBackendReadiness();
    const elapsedMs = Date.now() - startedAt;
    onTick({ attempt, elapsedMs, maxWaitMs, ok });
    if (ok) return true;
    if (elapsedMs >= maxWaitMs) return false;
    const remaining = maxWaitMs - elapsedMs;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, remaining))); });
  }
};

// ---------------------------------------------------------------------------
// Shared singleton readiness store. One instance for the whole app -- every
// subscriber (Layout, Dashboard, SearchBar, any API client reporting a
// failure) reads/drives the exact same state, so at most one /ready poll
// loop is ever in flight, whether that's the initial wake-up wait or a
// later recovery after the backend drops out mid-session.
// ---------------------------------------------------------------------------
let state = { status: 'waking', attempt: 0, elapsedMs: 0 };
const listeners = new Set();
let started = false; // the initial (first-load) wait has been kicked off
let pollInFlight = false; // true for either the initial wait OR a recovery poll -- never both at once
// Overridable only by __resetBackendReadinessForTests (never by app code) --
// tests use tiny bounds so "gives up" / "no infinite loop" assertions don't
// need to wait out the real 75s production bound.
let storeMaxWaitMs = DEFAULT_MAX_WAIT_MS;
let storePollIntervalMs = POLL_INTERVAL_MS;

const setState = (next) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};

/** Runs exactly one bounded /ready poll loop and never a second one concurrently. */
const runPoll = () => {
  if (pollInFlight) return;
  pollInFlight = true;
  waitForBackendReady({
    maxWaitMs: storeMaxWaitMs,
    pollIntervalMs: storePollIntervalMs,
    onTick: ({ attempt, elapsedMs }) => setState({ attempt, elapsedMs }),
  }).then((ok) => {
    pollInFlight = false;
    setState({ status: ok ? 'ready' : 'timed-out' });
  });
};

const ensureStarted = () => {
  if (started) return;
  started = true;
  runPoll();
};

export const subscribeReadiness = (listener) => {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getReadinessSnapshot = () => state;

// The exact HTTP outcomes that mean "the backend is genuinely unreachable"
// as opposed to "the backend answered, and the answer was an error" --
// per the spec: network failure, request timeout, and 502/503/504. A
// generic 500 (an application bug in an otherwise-healthy backend) and
// every 4xx (auth/validation/business errors, or a caller-initiated
// cancellation) must never reset readiness -- those say nothing about
// whether the backend is up.
const AVAILABILITY_IMPACTING_HTTP_STATUSES = new Set([502, 503, 504]);

/** Classifies a normalized axios-style error/response shape as availability-impacting or not. */
const isAvailabilityImpactingOutcome = ({ canceled, status }) => {
  if (canceled) return false;
  if (status != null) return AVAILABILITY_IMPACTING_HTTP_STATUSES.has(status);
  return true; // no response at all reached the caller: network failure or timeout
};

/**
 * reportBackendUnavailable - called by an API client's error handling
 * after classifying a failure as availability-impacting (see
 * isAvailabilityImpactingAxiosError / isAvailabilityImpactingFetchOutcome
 * below). Single-flight: if a recovery poll (or the initial wait) is
 * already running, or the app is already showing the waking screen, this
 * is a no-op -- several requests failing together (e.g. Dashboard's
 * parallel burst) must start only one shared check, never one per failed
 * request.
 */
export const reportBackendUnavailable = () => {
  // pollInFlight is the sole single-flight guard (not state.status) so this
  // is correct regardless of call order -- it never leaves the store
  // showing "waking" with no poll actually running underneath it.
  if (pollInFlight) return;
  setState({ status: 'waking', attempt: 0, elapsedMs: 0 });
  runPoll();
};

/**
 * isAvailabilityImpactingAxiosError - for axios-based clients. `error.code`
 * covers a caller-initiated AbortController cancel (ERR_CANCELED) as well
 * as axios's own timeout code (ECONNABORTED, no HTTP response at all).
 */
export const isAvailabilityImpactingAxiosError = (error) => {
  const canceled = error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError';
  const status = error?.response?.status ?? null;
  return isAvailabilityImpactingOutcome({ canceled, status });
};

/** For fetch-based clients: pass `{ aborted, status }` describing how the call ended (status is null for a thrown network/timeout failure). */
export const isAvailabilityImpactingFetchOutcome = ({ aborted = false, status = null } = {}) => (
  isAvailabilityImpactingOutcome({ canceled: aborted, status })
);

/** Test-only: resets the singleton so each test file starts from a clean 'waking' state. Never used by app code. */
export const __resetBackendReadinessForTests = ({ maxWaitMs, pollIntervalMs } = {}) => {
  state = { status: 'waking', attempt: 0, elapsedMs: 0 };
  started = false;
  pollInFlight = false;
  listeners.clear();
  storeMaxWaitMs = maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  storePollIntervalMs = pollIntervalMs ?? POLL_INTERVAL_MS;
};

export default {
  checkBackendReadiness,
  pingLiveness,
  waitForBackendReady,
  subscribeReadiness,
  getReadinessSnapshot,
  reportBackendUnavailable,
  isAvailabilityImpactingAxiosError,
  isAvailabilityImpactingFetchOutcome,
};
