import { useSyncExternalStore } from 'react';
import { subscribeReadiness, getReadinessSnapshot, __resetBackendReadinessForTests } from '@/services/backendHealth';

/**
 * useBackendReadiness - subscribes to the shared singleton readiness store
 * (see services/backendHealth.js). `status` is 'waking' | 'ready' |
 * 'timed-out'. Every component that calls this hook -- Layout, Dashboard,
 * SearchBar, any other page -- observes the exact same wake-up (or later
 * recovery) operation; none of them trigger a second one.
 */
export const useBackendReadiness = () => useSyncExternalStore(subscribeReadiness, getReadinessSnapshot);

export { __resetBackendReadinessForTests };

export default useBackendReadiness;
