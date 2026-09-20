/**
 * sharedMetrics.js
 * ==================
 * Phase 5B goal 2: make the metrics store multi-instance capable, so
 * /api/ops/rag-metrics reports the whole deployment rather than whichever
 * process happened to serve the request.
 *
 * WHY REDIS, AND NOT MONGO.
 * Both already exist in this project, so neither is a new dependency. The
 * choice went to Redis for four reasons:
 *   1. Counter aggregation is what it is FOR. `HINCRBY` is atomic,
 *      O(1), and needs no read-modify-write, so N instances incrementing
 *      the same field concurrently can never lose an update. Doing the
 *      same in Mongo means either an update-per-event or a read-modify-
 *      write race.
 *   2. Mongo is a REQUIRED dependency here (see dependencyState.js) — it
 *      serves the research corpus every grounded answer depends on.
 *      Putting a write on it for every chat turn adds load to the one
 *      datastore whose failure takes the product down. Redis is already
 *      optional-and-degradable in this codebase, which is the correct
 *      blast radius for observability data.
 *   3. Metrics here are explicitly NOT a source of truth (Phase 5A labels
 *      the snapshot `resetsOnRestart`), so Redis's weaker durability costs
 *      nothing, while its TTLs give bounded, self-cleaning keys for free.
 *   4. utils/redisClient.js ALREADY fails soft: it returns null when Redis
 *      is unavailable and every helper swallows errors. That is exactly
 *      the automatic in-process fallback this goal requires, so the
 *      fallback path is the one the codebase is already proven on.
 *
 * KNOWN CAVEAT, handled: that client is created with
 * `reconnectStrategy: false`, so once a connection drops it does NOT come
 * back until the process restarts. This module therefore re-checks
 * `isOpen` on every operation rather than caching a verdict, reports
 * `degraded` when the shared backend is configured-but-unreachable, and
 * keeps serving local numbers throughout.
 *
 * CARDINALITY AND CONTENT. Every field written here is one of the bounded
 * labels the in-process store already defines — counters keyed by
 * `category:label` from fixed enums, plus a handful of fixed totals. No
 * prompt, answer, evidence, citation, user identity, credential, trace id,
 * symbol, or query string is ever written. The keyspace is fixed-size by
 * construction: two hashes plus one instance-registry hash, all TTL'd.
 *
 * LATENCY PERCENTILES ARE DELIBERATELY NOT MERGED. p50/p95/p99 from
 * separate ring buffers cannot be combined into a correct cluster
 * percentile (averaging percentiles is simply wrong), and shipping every
 * raw sample to Redis would be exactly the unbounded growth this design
 * forbids. Latency therefore stays per-instance and the ops payload says
 * so, rather than presenting a plausible number that is not true.
 *
 * NOTHING HERE IS ON THE REQUEST PATH. Writes are fire-and-forget; reads
 * happen only when an operator calls the ops endpoint.
 *
 * DELIVERY GUARANTEES — read this before trusting a cluster total.
 * These counters are BEST-EFFORT. They are not exact, and they are not
 * strictly at-least-once either. Precisely:
 *
 *   - Healthy steady state: EXACT. Each tick sends the delta since the last
 *     acknowledged tick, applied atomically, so totals equal the sum of what
 *     every instance observed.
 *   - Failed tick (refused / unreachable / timed out): NOTHING is applied
 *     (MULTI is all-or-nothing) and the baseline does not advance, so the
 *     counts fold into the next successful tick. Nothing lost, nothing
 *     doubled.
 *   - AMBIGUOUS ack (the EXEC ran on the server but the reply was lost to a
 *     timeout or a dropped connection): the delta is re-sent next tick and
 *     those counters are DOUBLE-COUNTED. We cannot distinguish "never
 *     applied" from "applied, ack lost", and choosing to re-send means
 *     over-counting in this window rather than silently losing data.
 *   - Process CRASH: everything counted locally since the last successful
 *     tick (up to one interval, 15s by default) is LOST. The in-process
 *     store is not durable by design, and the un-mirrored delta dies with it.
 *
 * So: a crash window can LOSE counts and an ambiguous-ack window can
 * DUPLICATE them. Treat these numbers as operational signal — rates,
 * ratios, order of magnitude — never as billing or audit figures. The
 * per-turn cost ledger and the OTLP event stream are the places to look for
 * anything that must be accounted for precisely.
 */
import { logger } from '../../utils/logger.js';
import { getRedisClient } from '../../utils/redisClient.js';
import { metricsStore as defaultMetricsStore } from './metricsStore.js';

export const AGGREGATION_MODES = Object.freeze(['shared', 'local', 'degraded']);

// One version-pinned namespace, so a future shape change cannot read a
// previous version's data back as if it were current.
export const KEY_PREFIX = 'gsr:metrics:v1';
export const COUNTERS_KEY = `${KEY_PREFIX}:counters`;
export const TOTALS_KEY = `${KEY_PREFIX}:totals`;
export const INSTANCES_KEY = `${KEY_PREFIX}:instances`;

// Keys expire if nothing writes to them, so a decommissioned deployment
// cleans itself up. Refreshed on every successful write.
export const KEY_TTL_SECONDS = 24 * 60 * 60;
// An instance not seen within this window is treated as gone and pruned.
export const INSTANCE_STALE_MS = 5 * 60 * 1000;
// Hard cap on the instance registry, so restart churn can never grow it.
export const MAX_TRACKED_INSTANCES = 100;

// Totals mirrored to the shared backend. Fixed list: a field not named here
// is never written, so the hash cannot grow new fields at runtime.
const SHARED_TOTAL_FIELDS = Object.freeze([
  'requestTotal', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens',
  'unknownUsageCount', 'costUnknownCount', 'estimatedCostMicros',
]);

// Cost is accumulated as integer MICRO-dollars because HINCRBY is integer-
// only, and floating-point accumulation across instances would drift.
const COST_SCALE = 1_000_000;

export const toCostMicros = (cost) => (Number.isFinite(cost) ? Math.round(cost * COST_SCALE) : 0);
export const fromCostMicros = (micros) => (Number.isFinite(micros) ? Number((micros / COST_SCALE).toFixed(6)) : 0);

export const isSharedEnabled = (env = process.env) => env.RAG_METRICS_SHARED_AGGREGATION === 'true';

// A half-open Redis connection accepts commands that then never settle:
// node-redis has no per-command timeout, and this project's client is built
// with `reconnectStrategy: false`, so nothing will tear it down for us. An
// unbounded wait here would hang the ops endpoint an operator is using
// DURING an incident, and would wedge the mirror's own in-flight guard
// forever. Every Redis interaction is therefore raced against a deadline.
export const REDIS_OP_TIMEOUT_MS = 1000;

const withTimeout = (promise, ms = REDIS_OP_TIMEOUT_MS) => {
  let handle = null;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const error = new Error('redis operation timed out');
      error.code = 'REDIS_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (handle) clearTimeout(handle); });
};

/**
 * createSharedMetrics - factory so tests can inject a fake Redis client and
 * clock instead of sharing global state.
 */
export const createSharedMetrics = ({
  getClient = getRedisClient,
  store = defaultMetricsStore,
  env = process.env,
  instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  now = () => Date.now(),
  log = logger,
} = {}) => {
  let lastErrorCode = null;
  let writeFailures = 0;
  let writeSuccesses = 0;
  // `isOpen` alone is NOT a health signal: while node-redis is retrying a
  // dropped connection it keeps isOpen true, so a client that is failing
  // every command still looks connected. Verified live against a real Redis
  // restart — the mode said "shared" while nothing was landing. Health is
  // therefore judged by whether operations are actually SUCCEEDING.
  let consecutiveFailures = 0;

  /** The live client, or null — re-checked every time (see the reconnect caveat). */
  const liveClient = () => {
    if (!isSharedEnabled(env)) return null;
    let client = null;
    try { client = getClient(); } catch { return null; }
    return client && client.isOpen ? client : null;
  };

  const noteFailure = (error) => {
    writeFailures += 1;
    consecutiveFailures += 1;
    lastErrorCode = error?.code || error?.name || 'REDIS_ERROR';
  };

  const noteSuccess = () => { consecutiveFailures = 0; };

  return {
    instanceId,

    /**
     * mirrorSnapshot - pushes THIS instance's deltas to the shared backend.
     * Fire-and-forget: callers never await it on a request path, and a
     * rejection can never surface (every path resolves).
     *
     * Deltas, not absolutes: each call sends only what changed since the
     * previous call, so HINCRBY across instances sums to the true total
     * without any instance overwriting another's contribution.
     */
    async mirrorDeltas(deltas = {}) {
      const client = liveClient();
      if (!client) return { mirrored: false, reason: 'SHARED_BACKEND_UNAVAILABLE' };

      try {
        // MULTI/EXEC: the whole delta applies or none of it does. Without
        // this, a connection dying midway through the increments would leave
        // SOME fields advanced while the baseline (which only moves on
        // success) still counts them as unsent — so the next tick would
        // re-send them and DOUBLE-COUNT. All-or-nothing removes that
        // partial-application window entirely. See this module's own
        // "delivery guarantees" note for what remains.
        const tx = client.multi();

        for (const [field, value] of Object.entries(deltas.counters || {})) {
          if (!Number.isFinite(value) || value === 0) continue;
          tx.hIncrBy(COUNTERS_KEY, field, value);
        }
        for (const field of SHARED_TOTAL_FIELDS) {
          const value = deltas.totals?.[field];
          if (!Number.isFinite(value) || value === 0) continue;
          tx.hIncrBy(TOTALS_KEY, field, value);
        }

        tx.hSet(INSTANCES_KEY, instanceId, String(now()));
        tx.expire(COUNTERS_KEY, KEY_TTL_SECONDS);
        tx.expire(TOTALS_KEY, KEY_TTL_SECONDS);
        tx.expire(INSTANCES_KEY, KEY_TTL_SECONDS);

        await withTimeout(tx.exec());
        writeSuccesses += 1;
        noteSuccess();
        return { mirrored: true };
      } catch (error) {
        noteFailure(error);
        // Never rethrow and never log per-event: a Redis outage must not
        // turn into log spam on every chat turn.
        return { mirrored: false, reason: 'WRITE_FAILED' };
      }
    },

    /**
     * readSharedSnapshot - the cluster-wide view, or null when the shared
     * backend is unavailable (the caller then falls back to local).
     */
    async readSharedSnapshot() {
      const client = liveClient();
      if (!client) return null;

      try {
        const [counters, totals, instances] = await withTimeout(Promise.all([
          client.hGetAll(COUNTERS_KEY),
          client.hGetAll(TOTALS_KEY),
          client.hGetAll(INSTANCES_KEY),
        ]));

        const numericCounters = {};
        for (const [field, value] of Object.entries(counters || {})) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed)) numericCounters[field] = parsed;
        }

        const numericTotals = {};
        for (const field of SHARED_TOTAL_FIELDS) {
          const parsed = Number.parseInt(totals?.[field] ?? '0', 10);
          numericTotals[field] = Number.isFinite(parsed) ? parsed : 0;
        }

        const cutoff = now() - INSTANCE_STALE_MS;
        const liveInstances = Object.entries(instances || {})
          .map(([id, seenAt]) => ({ id, seenAt: Number.parseInt(seenAt, 10) }))
          .filter((entry) => Number.isFinite(entry.seenAt) && entry.seenAt >= cutoff);

        noteSuccess();
        return {
          counters: numericCounters,
          requestTotal: numericTotals.requestTotal,
          tokenTotals: {
            inputTokens: numericTotals.inputTokens,
            outputTokens: numericTotals.outputTokens,
            cachedInputTokens: numericTotals.cachedInputTokens,
            reasoningTokens: numericTotals.reasoningTokens,
          },
          unknownUsageCount: numericTotals.unknownUsageCount,
          costUnknownCount: numericTotals.costUnknownCount,
          estimatedCostTotal: fromCostMicros(numericTotals.estimatedCostMicros),
          instanceCount: liveInstances.length,
        };
      } catch (error) {
        noteFailure(error);
        return null;
      }
    },

    /**
     * pruneInstances - drops registry entries for instances that have not
     * reported recently, and enforces the hard cap. Called on read, so the
     * registry can never grow without bound across restarts.
     */
    async pruneInstances() {
      const client = liveClient();
      if (!client) return { pruned: 0 };
      try {
        const instances = await withTimeout(client.hGetAll(INSTANCES_KEY));
        const entries = Object.entries(instances || {})
          .map(([id, seenAt]) => ({ id, seenAt: Number.parseInt(seenAt, 10) || 0 }))
          .sort((a, b) => b.seenAt - a.seenAt);

        const cutoff = now() - INSTANCE_STALE_MS;
        const doomed = entries
          .filter((entry, index) => entry.seenAt < cutoff || index >= MAX_TRACKED_INSTANCES)
          .map((entry) => entry.id);

        if (doomed.length) await withTimeout(client.hDel(INSTANCES_KEY, doomed));
        return { pruned: doomed.length };
      } catch (error) {
        noteFailure(error);
        return { pruned: 0 };
      }
    },

    /**
     * getAggregationStatus - what the ops endpoint reports. `mode` is the
     * honest current state, not the configured intent:
     *   'local'    — shared aggregation is off; these are one instance's numbers
     *   'shared'   — the cluster-wide view is being served
     *   'degraded' — shared aggregation is ON but the backend is unreachable,
     *                so local numbers are being served instead
     */
    getAggregationStatus({ sharedReadSucceeded = null } = {}) {
      const configured = isSharedEnabled(env);
      if (!configured) {
        return {
          mode: 'local', configured: false, backend: 'in-process',
          reason: 'RAG_METRICS_SHARED_AGGREGATION is not enabled',
          scope: 'this instance only', instanceId, writeSuccesses, writeFailures, lastErrorCode,
        };
      }

      // Configured AND a live client AND operations are currently landing.
      // A caller that just performed a read passes its own result, which is
      // the most direct evidence available.
      const healthy = sharedReadSucceeded !== null
        ? sharedReadSucceeded
        : Boolean(liveClient()) && consecutiveFailures === 0;
      return {
        mode: healthy ? 'shared' : 'degraded',
        configured: true,
        backend: 'redis',
        reason: healthy ? null : 'shared backend unreachable — serving this instance only',
        scope: healthy ? 'all reporting instances' : 'this instance only (fallback)',
        instanceId,
        writeSuccesses,
        writeFailures,
        consecutiveFailures,
        lastErrorCode,
      };
    },

    __statsForTests() { return { writeSuccesses, writeFailures, consecutiveFailures, lastErrorCode }; },
  };
};

export const sharedMetrics = createSharedMetrics();

/**
 * computeDeltas - the difference between two local snapshots, in the exact
 * shape mirrorDeltas expects. Pure, so the delta logic is testable on its
 * own and the mirror can stay a thin write.
 */
export const computeDeltas = (previous, current) => {
  const counters = {};
  for (const [field, value] of Object.entries(current.counters || {})) {
    const delta = value - (previous?.counters?.[field] || 0);
    if (delta > 0) counters[field] = delta;
  }

  const totals = {
    requestTotal: (current.requestTotal || 0) - (previous?.requestTotal || 0),
    inputTokens: (current.tokenTotals?.inputTokens || 0) - (previous?.tokenTotals?.inputTokens || 0),
    outputTokens: (current.tokenTotals?.outputTokens || 0) - (previous?.tokenTotals?.outputTokens || 0),
    cachedInputTokens: (current.tokenTotals?.cachedInputTokens || 0) - (previous?.tokenTotals?.cachedInputTokens || 0),
    reasoningTokens: (current.tokenTotals?.reasoningTokens || 0) - (previous?.tokenTotals?.reasoningTokens || 0),
    unknownUsageCount: (current.unknownUsageCount || 0) - (previous?.unknownUsageCount || 0),
    costUnknownCount: (current.costUnknownCount || 0) - (previous?.costUnknownCount || 0),
    estimatedCostMicros: toCostMicros(current.estimatedCostTotal || 0) - toCostMicros(previous?.estimatedCostTotal || 0),
  };

  return { counters, totals };
};

/**
 * mergeSnapshots - the cluster view served by the ops endpoint. Counters and
 * totals are SUMS across instances; latency stays local and is labelled as
 * such (see the module note on why percentiles are not merged).
 */
export const mergeSnapshots = (localSnapshot, sharedSnapshot) => {
  if (!sharedSnapshot) return localSnapshot;

  const counters = { ...sharedSnapshot.counters };
  return {
    ...localSnapshot,
    requestTotal: sharedSnapshot.requestTotal,
    counters,
    tokenTotals: { ...sharedSnapshot.tokenTotals },
    unknownUsageCount: sharedSnapshot.unknownUsageCount,
    costUnknownCount: sharedSnapshot.costUnknownCount,
    estimatedCostTotal: sharedSnapshot.estimatedCostTotal,
    instanceCount: sharedSnapshot.instanceCount,
    latencyByStage: localSnapshot.latencyByStage,
    latencyScope: 'this instance only — percentiles from separate instances cannot be validly merged',
  };
};

/**
 * startMetricsMirror - the only writer to the shared backend. Runs on a
 * timer, NEVER on the request path: each tick diffs the local snapshot
 * against the previous tick and pushes just the delta.
 *
 * Deliberately periodic rather than per-event. A chat turn writes to the
 * in-process store synchronously (as it always has) and returns; the cost
 * of talking to Redis is paid once every few seconds by a background timer
 * instead of on every turn. That keeps the request path free of network
 * I/O, and collapses many small increments into one round trip.
 *
 * On failure the delta is deliberately NOT retried: the next tick's diff is
 * computed against the last SUCCESSFULLY mirrored snapshot, so nothing is
 * lost and nothing is double-counted — a missed tick simply folds into the
 * next one.
 */
export const startMetricsMirror = ({
  shared = sharedMetrics,
  store = defaultMetricsStore,
  env = process.env,
  intervalMs = 15000,
  log = logger,
} = {}) => {
  if (!isSharedEnabled(env)) {
    log.info('[shared-metrics] RAG_METRICS_SHARED_AGGREGATION not enabled — metrics stay in-process');
    return null;
  }

  let lastMirrored = null;
  let timer = null;
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const current = store.getSnapshot();
      const deltas = computeDeltas(lastMirrored, current);
      const result = await shared.mirrorDeltas(deltas);
      // Only advance the baseline when the write actually landed, so a
      // failed tick's counts are included in the next one.
      if (result.mirrored) lastMirrored = current;
    } catch (error) {
      log.warn(`[shared-metrics] mirror tick failed: ${error.message}`);
    } finally {
      ticking = false;
    }
  };

  timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  timer.unref?.(); // never holds the process open
  log.info(`[shared-metrics] mirroring to redis every ${intervalMs}ms as instance ${shared.instanceId}`);

  return {
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    async flushNow() { await tick(); },
    __lastMirrored() { return lastMirrored; },
  };
};

let activeMirror = null;

export const initializeSharedMetrics = (options = {}) => {
  activeMirror = startMetricsMirror(options);
  return activeMirror;
};

/** Final flush + stop, wired into server.js's graceful shutdown. */
export const shutdownSharedMetrics = async () => {
  if (!activeMirror) return null;
  await activeMirror.flushNow().catch(() => {});
  activeMirror.stop();
  activeMirror = null;
  return { stopped: true };
};

export default {
  createSharedMetrics, sharedMetrics, computeDeltas, mergeSnapshots, isSharedEnabled, AGGREGATION_MODES,
  startMetricsMirror, initializeSharedMetrics, shutdownSharedMetrics,
};
