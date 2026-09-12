import { renderHook, waitFor } from '@testing-library/react';
import { useBackendReadiness, __resetBackendReadinessForTests } from '@/hooks/useBackendReadiness';

/**
 * The whole point of the singleton store (now living in
 * services/backendHealth.js, with this hook as a thin useSyncExternalStore
 * wrapper): Layout, Dashboard, and SearchBar (and any other consumer) must
 * all observe the SAME wake-up/recovery operation -- not one /ready poll
 * loop per mounted component. These tests mock only the network boundary
 * (global.fetch) so the real store/hook wiring is what's under test.
 */
describe('useBackendReadiness singleton (single-flight readiness, via the real store)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    __resetBackendReadinessForTests({ maxWaitMs: 500, pollIntervalMs: 20 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('starts exactly one /ready poll no matter how many components subscribe', async () => {
    global.fetch = jest.fn().mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve({ ok: true }), 40); }));

    const hookA = renderHook(() => useBackendReadiness());
    const hookB = renderHook(() => useBackendReadiness());
    const hookC = renderHook(() => useBackendReadiness());

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(hookA.result.current.status).toBe('waking');
    expect(hookB.result.current.status).toBe('waking');
    expect(hookC.result.current.status).toBe('waking');

    await waitFor(() => expect(hookA.result.current.status).toBe('ready'));
    // All three subscribers observe the same resolved state from the one shared call.
    expect(hookB.result.current.status).toBe('ready');
    expect(hookC.result.current.status).toBe('ready');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('a component that mounts after readiness already resolved sees the resolved state immediately, without starting a second poll', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const first = renderHook(() => useBackendReadiness());
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    const callsAfterFirst = global.fetch.mock.calls.length;

    const second = renderHook(() => useBackendReadiness());
    expect(second.result.current.status).toBe('ready');
    expect(global.fetch.mock.calls.length).toBe(callsAfterFirst);
  });

  it('reports "timed-out" (not stuck "waking" forever) when the wake-up wait exhausts its bound', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const { result } = renderHook(() => useBackendReadiness());
    await waitFor(() => expect(result.current.status).toBe('timed-out'));
  });
});
