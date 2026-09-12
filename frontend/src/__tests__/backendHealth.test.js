import {
  checkBackendReadiness,
  pingLiveness,
  waitForBackendReady,
  subscribeReadiness,
  getReadinessSnapshot,
  reportBackendUnavailable,
  isAvailabilityImpactingAxiosError,
  isAvailabilityImpactingFetchOutcome,
  __resetBackendReadinessForTests,
} from '@/services/backendHealth';

describe('backendHealth (cold-start wake-up polling)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('checkBackendReadiness calls /ready (not /health) -- readiness must reflect Mongo, not just Express listening', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const result = await checkBackendReadiness();
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/ready'), expect.any(Object));
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/health'), expect.any(Object));
  });

  it('checkBackendReadiness resolves false (never throws) on a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(checkBackendReadiness()).resolves.toBe(false);
  });

  it('checkBackendReadiness resolves false on a 503 ("still starting") response, exactly like a network failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(checkBackendReadiness()).resolves.toBe(false);
  });

  it('pingLiveness calls /health -- kept separate from readiness, never used to gate requests', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const result = await pingLiveness();
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/health'), expect.any(Object));
  });

  it('waitForBackendReady resolves true on the very first attempt when /ready already reports 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const onTick = jest.fn();
    const result = await waitForBackendReady({ maxWaitMs: 1000, pollIntervalMs: 10, onTick });
    expect(result).toBe(true);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0]).toMatchObject({ attempt: 1, ok: true });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/ready'), expect.any(Object));
  });

  it('waitForBackendReady keeps polling /ready (e.g. while it reports 503) and resolves true once it reports 200', async () => {
    let call = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve({ ok: call >= 3 });
    });
    const onTick = jest.fn();
    const result = await waitForBackendReady({ maxWaitMs: 2000, pollIntervalMs: 10, onTick });
    expect(result).toBe(true);
    expect(call).toBe(3);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it('waitForBackendReady gives up and resolves false (never rejects) once maxWaitMs elapses with /ready still failing', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false });
    const result = await waitForBackendReady({ maxWaitMs: 60, pollIntervalMs: 20 });
    expect(result).toBe(false);
  });
});

describe('isAvailabilityImpactingAxiosError (classifies a failure as "backend unreachable" or not)', () => {
  it('flags a network failure (no response at all) as availability-impacting', () => {
    expect(isAvailabilityImpactingAxiosError({ code: 'ERR_NETWORK', message: 'Network Error' })).toBe(true);
  });

  it('flags a request timeout (ECONNABORTED, no response) as availability-impacting', () => {
    expect(isAvailabilityImpactingAxiosError({ code: 'ECONNABORTED', message: 'timeout of 25000ms exceeded' })).toBe(true);
  });

  it.each([502, 503, 504])('flags HTTP %d as availability-impacting', (status) => {
    expect(isAvailabilityImpactingAxiosError({ response: { status } })).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])('never flags HTTP %d (business/validation error) as availability-impacting', (status) => {
    expect(isAvailabilityImpactingAxiosError({ response: { status } })).toBe(false);
  });

  it('never flags a generic 500 (an app bug, not an infra outage) as availability-impacting', () => {
    expect(isAvailabilityImpactingAxiosError({ response: { status: 500 } })).toBe(false);
  });

  it('never flags a caller-initiated cancellation (AbortController/unmount/superseded request) as availability-impacting', () => {
    expect(isAvailabilityImpactingAxiosError({ code: 'ERR_CANCELED', name: 'CanceledError' })).toBe(false);
    expect(isAvailabilityImpactingAxiosError({ name: 'CanceledError' })).toBe(false);
  });
});

describe('isAvailabilityImpactingFetchOutcome (same classification for fetch-based clients)', () => {
  it('flags a thrown network/timeout failure (no status) as availability-impacting', () => {
    expect(isAvailabilityImpactingFetchOutcome({ status: null })).toBe(true);
  });

  it.each([502, 503, 504])('flags HTTP %d as availability-impacting', (status) => {
    expect(isAvailabilityImpactingFetchOutcome({ status })).toBe(true);
  });

  it.each([400, 401, 404, 422])('never flags HTTP %d as availability-impacting', (status) => {
    expect(isAvailabilityImpactingFetchOutcome({ status })).toBe(false);
  });

  it('never flags an aborted (canceled) fetch as availability-impacting', () => {
    expect(isAvailabilityImpactingFetchOutcome({ aborted: true, status: null })).toBe(false);
  });
});

describe('reportBackendUnavailable (post-recovery: the backend was ready, then a request failed)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    __resetBackendReadinessForTests({ maxWaitMs: 200, pollIntervalMs: 20 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const markReadyFirst = async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const unsubscribe = subscribeReadiness(() => {});
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(getReadinessSnapshot().status).toBe('ready');
    unsubscribe();
  };

  it('a 503 after the app was ready flips the shared state back to "waking" and re-polls /ready (never /health)', async () => {
    await markReadyFirst();
    global.fetch = jest.fn().mockResolvedValue({ ok: true }); // /ready recovers immediately
    reportBackendUnavailable();
    expect(getReadinessSnapshot().status).toBe('waking');
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(getReadinessSnapshot().status).toBe('ready');
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/ready'), expect.any(Object));
  });

  it('does not reset an already-"waking" store into starting a second poll (single-flight)', async () => {
    global.fetch = jest.fn().mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve({ ok: true }), 50); }));
    subscribeReadiness(() => {});
    expect(getReadinessSnapshot().status).toBe('waking');
    const callsBefore = global.fetch.mock.calls.length;
    reportBackendUnavailable(); // must be a no-op: the initial wait is already in flight
    reportBackendUnavailable();
    reportBackendUnavailable();
    // No extra /ready call was fired synchronously by the redundant reports.
    expect(global.fetch.mock.calls.length).toBe(callsBefore);
  });

  it('several requests failing together (a concurrent burst) trigger only one recovery poll, not one per failure', async () => {
    await markReadyFirst();
    global.fetch = jest.fn().mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve({ ok: true }), 30); }));
    // Simulate 5 requests in a Dashboard-style burst all failing around the same time.
    reportBackendUnavailable();
    reportBackendUnavailable();
    reportBackendUnavailable();
    reportBackendUnavailable();
    reportBackendUnavailable();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    // Only the first call's poll actually issued a fetch; the rest no-opped.
    expect(global.fetch.mock.calls.length).toBe(1);
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(getReadinessSnapshot().status).toBe('ready');
  });

  it('gives up (times out) rather than retrying forever when /ready keeps failing after a recovery report', async () => {
    await markReadyFirst();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    reportBackendUnavailable();
    expect(getReadinessSnapshot().status).toBe('waking');
    await new Promise((resolve) => { setTimeout(resolve, 300); }); // > the 200ms test maxWaitMs
    expect(getReadinessSnapshot().status).toBe('timed-out');
    const callsAtTimeout = global.fetch.mock.calls.length;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    // No further polling happens on its own once the bounded wait gives up.
    expect(global.fetch.mock.calls.length).toBe(callsAtTimeout);
  });
});
