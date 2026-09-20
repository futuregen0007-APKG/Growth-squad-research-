import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSharedMetrics, computeDeltas, mergeSnapshots, isSharedEnabled, startMetricsMirror,
  COUNTERS_KEY, TOTALS_KEY, INSTANCES_KEY, KEY_PREFIX, INSTANCE_STALE_MS, toCostMicros, fromCostMicros,
  REDIS_OP_TIMEOUT_MS,
} from '../services/telemetry/sharedMetrics.js';
import { createMetricsStore } from '../services/telemetry/metricsStore.js';

/**
 * telemetrySharedMetrics.test.js
 * =================================
 * Phase 5B goal 2. Two invariants: N instances' numbers add up to the truth
 * without any instance clobbering another, and a shared backend that is
 * off, down, or failing mid-flight degrades to this instance's own numbers
 * while SAYING so — never silently reporting a partial view as if it were
 * the whole deployment.
 *
 * The fake Redis below implements the handful of commands this module
 * actually uses, with real HINCRBY semantics (atomic add, not
 * read-modify-write), so a test genuinely exercises concurrent accumulation.
 */

const sharedEnv = { RAG_METRICS_SHARED_AGGREGATION: 'true' };
const silentLog = { warn() {}, info() {}, debug() {}, error() {} };

/** A minimal in-memory Redis double covering exactly the commands used. */
const makeFakeRedis = ({ isOpen = true, failOn = null } = {}) => {
  const hashes = new Map();
  const expiries = new Map();
  const getHash = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  const maybeFail = (command) => {
    if (failOn === command || failOn === 'ALL') {
      const error = new Error(`redis ${command} failed`);
      error.code = 'ECONNRESET';
      throw error;
    }
  };

  return {
    isOpen,
    hashes,
    expiries,
    async hIncrBy(key, field, delta) {
      maybeFail('hIncrBy');
      const hash = getHash(key);
      const next = (Number.parseInt(hash.get(field) ?? '0', 10) || 0) + delta;
      hash.set(field, String(next));
      return next;
    },
    async hSet(key, field, value) { maybeFail('hSet'); getHash(key).set(field, String(value)); return 1; },
    async hGetAll(key) {
      maybeFail('hGetAll');
      return Object.fromEntries(getHash(key).entries());
    },
    async hDel(key, fields) {
      maybeFail('hDel');
      const hash = getHash(key);
      for (const field of [].concat(fields)) hash.delete(field);
      return 1;
    },
    async expire(key, seconds) { maybeFail('expire'); expiries.set(key, seconds); return 1; },

    /**
     * A real MULTI: commands are QUEUED and applied only when exec()
     * succeeds, so a failure leaves the hashes completely untouched —
     * matching Redis, and letting a test prove the all-or-nothing property
     * rather than assume it.
     */
    multi() {
      const queued = [];
      const tx = {
        hIncrBy(key, field, delta) { queued.push(['hIncrBy', key, field, delta]); return tx; },
        hSet(key, field, value) { queued.push(['hSet', key, field, value]); return tx; },
        expire(key, seconds) { queued.push(['expire', key, seconds]); return tx; },
        async exec() {
          maybeFail('exec');
          for (const [command] of queued) maybeFail(command);
          const results = [];
          for (const [command, ...args] of queued) {
            if (command === 'hIncrBy') {
              const [key, field, delta] = args;
              const hash = getHash(key);
              const next = (Number.parseInt(hash.get(field) ?? '0', 10) || 0) + delta;
              hash.set(field, String(next));
              results.push(next);
            } else if (command === 'hSet') {
              const [key, field, value] = args;
              getHash(key).set(field, String(value));
              results.push(1);
            } else if (command === 'expire') {
              const [key, seconds] = args;
              expiries.set(key, seconds);
              results.push(1);
            }
          }
          return results;
        },
      };
      return tx;
    },
  };
};

const snapshotWith = (overrides = {}) => ({
  counters: {},
  requestTotal: 0,
  tokenTotals: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
  unknownUsageCount: 0,
  costUnknownCount: 0,
  estimatedCostTotal: 0,
  latencyByStage: {},
  ...overrides,
});

test('shared aggregation is opt-in: unset means local, and nothing is written anywhere', async () => {
  assert.equal(isSharedEnabled({}), false);
  assert.equal(isSharedEnabled({ RAG_METRICS_SHARED_AGGREGATION: 'false' }), false);
  assert.equal(isSharedEnabled(sharedEnv), true);

  const redis = makeFakeRedis();
  const shared = createSharedMetrics({ getClient: () => redis, env: {}, log: silentLog });
  const result = await shared.mirrorDeltas({ counters: { 'requestKind:research': 5 } });

  assert.equal(result.mirrored, false);
  assert.equal(redis.hashes.size, 0, 'a disabled aggregator writes nothing at all');
  assert.equal(shared.getAggregationStatus().mode, 'local');
  assert.equal(shared.getAggregationStatus().configured, false);
});

test('two instances accumulate into one shared total, neither overwriting the other', async () => {
  const redis = makeFakeRedis();
  const instanceA = createSharedMetrics({ getClient: () => redis, env: sharedEnv, instanceId: 'a', log: silentLog });
  const instanceB = createSharedMetrics({ getClient: () => redis, env: sharedEnv, instanceId: 'b', log: silentLog });

  await instanceA.mirrorDeltas({ counters: { 'completionStatus:grounded': 3 }, totals: { requestTotal: 3, inputTokens: 100 } });
  await instanceB.mirrorDeltas({ counters: { 'completionStatus:grounded': 4 }, totals: { requestTotal: 4, inputTokens: 250 } });

  const snapshot = await instanceA.readSharedSnapshot();
  assert.equal(snapshot.counters['completionStatus:grounded'], 7, 'atomic increments add, they do not replace');
  assert.equal(snapshot.requestTotal, 7);
  assert.equal(snapshot.tokenTotals.inputTokens, 350);
  assert.equal(snapshot.instanceCount, 2, 'both instances are reporting');
});

test('cost survives multi-instance accumulation without floating-point drift', async () => {
  const redis = makeFakeRedis();
  const instance = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });

  // Three instances each contributing a small fractional cost.
  for (let i = 0; i < 3; i += 1) {
    await instance.mirrorDeltas({ totals: { estimatedCostMicros: toCostMicros(0.000123) } });
  }

  const snapshot = await instance.readSharedSnapshot();
  assert.equal(snapshot.estimatedCostTotal, 0.000369, 'integer micro-dollars add exactly');
  assert.equal(fromCostMicros(toCostMicros(1.5)), 1.5);
});

test('the shared keyspace is fixed and namespaced -- no key is ever derived from request content', async () => {
  const redis = makeFakeRedis();
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });

  await shared.mirrorDeltas({
    counters: { 'completionStatus:grounded': 1, 'retrievalMode:hybrid': 2 },
    totals: { requestTotal: 1 },
  });

  assert.deepEqual([...redis.hashes.keys()].sort(), [COUNTERS_KEY, INSTANCES_KEY, TOTALS_KEY].sort());
  for (const key of redis.hashes.keys()) {
    assert.ok(key.startsWith(KEY_PREFIX), `${key} must live under the versioned namespace`);
  }
  // Counter FIELDS come from the metrics store's own bounded enums; nothing
  // here is a symbol, a query, a trace id, or a user.
  for (const field of redis.hashes.get(COUNTERS_KEY).keys()) {
    assert.match(field, /^[a-zA-Z]+:[a-zA-Z0-9+_]+$/, `${field} must be a bounded category:label pair`);
  }
});

test('only the fixed total fields are written -- an unexpected field is never mirrored', async () => {
  const redis = makeFakeRedis();
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });

  await shared.mirrorDeltas({
    totals: { requestTotal: 1, userEmail: 5, promptText: 9, symbol: 3 },
  });

  const fields = [...redis.hashes.get(TOTALS_KEY).keys()];
  assert.ok(fields.includes('requestTotal'));
  assert.equal(fields.includes('userEmail'), false);
  assert.equal(fields.includes('promptText'), false);
  assert.equal(fields.includes('symbol'), false);
});

test('every shared key carries a TTL, so a decommissioned deployment cleans itself up', async () => {
  const redis = makeFakeRedis();
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });
  await shared.mirrorDeltas({ totals: { requestTotal: 1 } });

  for (const key of [COUNTERS_KEY, TOTALS_KEY, INSTANCES_KEY]) {
    assert.ok(redis.expiries.get(key) > 0, `${key} must expire on its own`);
  }
});

test('a zero delta writes nothing -- an idle instance does not chat to Redis every tick', async () => {
  const redis = makeFakeRedis();
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });

  await shared.mirrorDeltas({ counters: { 'completionStatus:grounded': 0 }, totals: { requestTotal: 0 } });

  assert.equal(redis.hashes.has(COUNTERS_KEY), false, 'no counter field is written for a zero delta');
  assert.ok(redis.hashes.has(INSTANCES_KEY), 'but the instance still reports itself alive');
});

test('when the backend is unreachable the mode is degraded, and local numbers are still served', async () => {
  const closedRedis = makeFakeRedis({ isOpen: false });
  const shared = createSharedMetrics({ getClient: () => closedRedis, env: sharedEnv, log: silentLog });

  assert.equal(await shared.readSharedSnapshot(), null, 'no shared view is available');
  const status = shared.getAggregationStatus();
  assert.equal(status.mode, 'degraded');
  assert.equal(status.configured, true);
  assert.equal(status.scope, 'this instance only (fallback)');
  assert.ok(status.reason.includes('unreachable'));
});

test('a Redis client that throws on lookup degrades instead of breaking the caller', async () => {
  const shared = createSharedMetrics({
    getClient: () => { throw new Error('client not initialized'); }, env: sharedEnv, log: silentLog,
  });

  await assert.doesNotReject(() => shared.mirrorDeltas({ totals: { requestTotal: 1 } }));
  assert.equal(await shared.readSharedSnapshot(), null);
  assert.equal(shared.getAggregationStatus().mode, 'degraded');
});

test('a write that fails mid-flight is counted and never throws to the caller', async () => {
  const redis = makeFakeRedis({ failOn: 'exec' });
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });

  const result = await shared.mirrorDeltas({ totals: { requestTotal: 1 } });
  assert.equal(result.mirrored, false);
  assert.equal(result.reason, 'WRITE_FAILED');
  assert.equal(shared.__statsForTests().writeFailures, 1);
  assert.equal(shared.__statsForTests().lastErrorCode, 'ECONNRESET');
});

test('a read that fails mid-flight degrades to local rather than erroring the ops endpoint', async () => {
  const redis = makeFakeRedis({ failOn: 'hGetAll' });
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });

  assert.equal(await shared.readSharedSnapshot(), null);
  assert.equal(shared.getAggregationStatus({ sharedReadSucceeded: false }).mode, 'degraded');
});

test('a healthy shared read reports mode "shared" with deployment-wide scope', async () => {
  const redis = makeFakeRedis();
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });
  await shared.mirrorDeltas({ totals: { requestTotal: 1 } });

  const status = shared.getAggregationStatus({ sharedReadSucceeded: true });
  assert.equal(status.mode, 'shared');
  assert.equal(status.backend, 'redis');
  assert.equal(status.scope, 'all reporting instances');
  assert.equal(status.reason, null);
});

test('instances that stopped reporting are not counted as live, and are pruned', async () => {
  const redis = makeFakeRedis();
  let clock = 1_000_000;
  const shared = createSharedMetrics({
    getClient: () => redis, env: sharedEnv, instanceId: 'live-one', now: () => clock, log: silentLog,
  });

  // A stale instance from an earlier deploy.
  await redis.hSet(INSTANCES_KEY, 'dead-instance', String(clock - INSTANCE_STALE_MS - 1000));
  await shared.mirrorDeltas({ totals: { requestTotal: 1 } });

  const snapshot = await shared.readSharedSnapshot();
  assert.equal(snapshot.instanceCount, 1, 'only the instance still reporting is counted');

  await shared.pruneInstances();
  assert.equal(redis.hashes.get(INSTANCES_KEY).has('dead-instance'), false, 'the registry cannot grow across restarts');
  assert.equal(redis.hashes.get(INSTANCES_KEY).has('live-one'), true);
});

test('computeDeltas reports only what changed since the last successful mirror', () => {
  const previous = snapshotWith({ counters: { 'completionStatus:grounded': 5 }, requestTotal: 5 });
  const current = snapshotWith({ counters: { 'completionStatus:grounded': 8, 'evidence:zero': 2 }, requestTotal: 9 });

  const deltas = computeDeltas(previous, current);
  assert.equal(deltas.counters['completionStatus:grounded'], 3);
  assert.equal(deltas.counters['evidence:zero'], 2, 'a brand-new counter is sent in full');
  assert.equal(deltas.totals.requestTotal, 4);
});

test('the first delta is the whole snapshot, and an unchanged snapshot produces nothing', () => {
  const current = snapshotWith({ counters: { 'completionStatus:grounded': 3 }, requestTotal: 3 });
  assert.equal(computeDeltas(null, current).counters['completionStatus:grounded'], 3);

  const unchanged = computeDeltas(current, current);
  assert.deepEqual(unchanged.counters, {});
  assert.equal(unchanged.totals.requestTotal, 0);
});

test('a counter that resets (process restart) never mirrors a negative delta', () => {
  const previous = snapshotWith({ counters: { 'completionStatus:grounded': 10 }, requestTotal: 10 });
  const afterReset = snapshotWith({ counters: { 'completionStatus:grounded': 1 }, requestTotal: 1 });

  const deltas = computeDeltas(previous, afterReset);
  assert.equal('completionStatus:grounded' in deltas.counters, false, 'a negative counter delta is dropped, never sent');
});

test('mergeSnapshots serves cluster totals but keeps latency local, and says so', () => {
  const local = snapshotWith({
    counters: { 'completionStatus:grounded': 2 },
    requestTotal: 2,
    latencyByStage: { retrieval: { sampleCount: 10, p50: 42 } },
  });
  const shared = {
    counters: { 'completionStatus:grounded': 9 },
    requestTotal: 9,
    tokenTotals: { inputTokens: 900, outputTokens: 90, cachedInputTokens: 0, reasoningTokens: 0 },
    unknownUsageCount: 1,
    costUnknownCount: 2,
    estimatedCostTotal: 0.25,
    instanceCount: 3,
  };

  const merged = mergeSnapshots(local, shared);
  assert.equal(merged.requestTotal, 9, 'the cluster total, not this instance’s');
  assert.equal(merged.counters['completionStatus:grounded'], 9);
  assert.equal(merged.estimatedCostTotal, 0.25);
  assert.equal(merged.instanceCount, 3);
  assert.deepEqual(merged.latencyByStage, local.latencyByStage, 'latency stays this instance’s own');
  assert.ok(merged.latencyScope.includes('this instance only'), 'and the payload says so, rather than implying otherwise');
});

test('with no shared snapshot, the local snapshot is served unchanged', () => {
  const local = snapshotWith({ requestTotal: 4 });
  assert.deepEqual(mergeSnapshots(local, null), local);
});

test('the mirror is a no-op when shared aggregation is disabled', () => {
  const mirror = startMetricsMirror({ env: {}, log: silentLog });
  assert.equal(mirror, null, 'no timer is created and nothing is scheduled');
});

test('the mirror pushes real store activity, and only advances its baseline on success', async () => {
  const redis = makeFakeRedis();
  const store = createMetricsStore();
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });
  const mirror = startMetricsMirror({ shared, store, env: sharedEnv, intervalMs: 60_000, log: silentLog });

  try {
    store.recordRequest({ completionStatus: 'grounded', isResearch: true });
    store.recordRequest({ completionStatus: 'grounded', isResearch: true });
    await mirror.flushNow();

    let snapshot = await shared.readSharedSnapshot();
    assert.equal(snapshot.requestTotal, 2, 'real store activity reached the shared backend');
    assert.equal(snapshot.counters['completionStatus:grounded'], 2);

    // A second tick with no new activity must not double-count what it already sent.
    await mirror.flushNow();
    snapshot = await shared.readSharedSnapshot();
    assert.equal(snapshot.requestTotal, 2, 're-mirroring an unchanged snapshot adds nothing');

    store.recordRequest({ completionStatus: 'grounded', isResearch: false });
    await mirror.flushNow();
    snapshot = await shared.readSharedSnapshot();
    assert.equal(snapshot.requestTotal, 3, 'only the new activity is added');
  } finally {
    mirror.stop();
  }
});

test('a failed tick is not lost: its counts fold into the next successful one', async () => {
  const store = createMetricsStore();
  let failing = true;
  const redis = makeFakeRedis();
  const flakyClient = {
    get isOpen() { return true; },
    hIncrBy: (...args) => redis.hIncrBy(...args),
    hSet: (...args) => redis.hSet(...args),
    hGetAll: (...args) => redis.hGetAll(...args),
    hDel: (...args) => redis.hDel(...args),
    expire: (...args) => redis.expire(...args),
    multi() {
      const real = redis.multi();
      const tx = {
        hIncrBy: (...args) => { real.hIncrBy(...args); return tx; },
        hSet: (...args) => { real.hSet(...args); return tx; },
        expire: (...args) => { real.expire(...args); return tx; },
        exec: async () => {
          if (failing) { const e = new Error('down'); e.code = 'ECONNREFUSED'; throw e; }
          return real.exec();
        },
      };
      return tx;
    },
  };
  const shared = createSharedMetrics({ getClient: () => flakyClient, env: sharedEnv, log: silentLog });
  const mirror = startMetricsMirror({ shared, store, env: sharedEnv, intervalMs: 60_000, log: silentLog });

  try {
    store.recordRequest({ completionStatus: 'grounded', isResearch: true });
    await mirror.flushNow(); // fails
    assert.equal(mirror.__lastMirrored(), null, 'the baseline does not advance past a failed write');

    failing = false;
    store.recordRequest({ completionStatus: 'grounded', isResearch: true });
    await mirror.flushNow(); // succeeds, carrying BOTH requests

    const snapshot = await shared.readSharedSnapshot();
    assert.equal(snapshot.requestTotal, 2, 'the outage lost nothing and double-counted nothing');
  } finally {
    mirror.stop();
  }
});

test('a Redis command that never settles is abandoned, not awaited forever', async () => {
  // A half-open connection: `isOpen` is true, commands are accepted, nothing
  // ever comes back. Without a bound this would hang the ops endpoint an
  // operator is using during an incident.
  const hangingClient = {
    isOpen: true,
    hIncrBy: () => new Promise(() => {}),
    hSet: () => new Promise(() => {}),
    hGetAll: () => new Promise(() => {}),
    hDel: () => new Promise(() => {}),
    expire: () => new Promise(() => {}),
    multi() {
      const tx = { hIncrBy: () => tx, hSet: () => tx, expire: () => tx, exec: () => new Promise(() => {}) };
      return tx;
    },
  };
  const shared = createSharedMetrics({ getClient: () => hangingClient, env: sharedEnv, log: silentLog });

  const startedAt = Date.now();
  const readResult = await shared.readSharedSnapshot();
  const elapsed = Date.now() - startedAt;

  assert.equal(readResult, null, 'the read gives up and the caller falls back to local');
  assert.ok(elapsed < REDIS_OP_TIMEOUT_MS * 4, `gave up in ${elapsed}ms rather than hanging`);
  assert.equal(shared.__statsForTests().lastErrorCode, 'REDIS_TIMEOUT');
});

test('a hung write is abandoned too, so the mirror timer can never wedge permanently', async () => {
  const hangingClient = {
    isOpen: true,
    hIncrBy: () => new Promise(() => {}),
    hSet: () => new Promise(() => {}),
    hGetAll: () => new Promise(() => {}),
    hDel: () => new Promise(() => {}),
    expire: () => new Promise(() => {}),
    multi() {
      const tx = { hIncrBy: () => tx, hSet: () => tx, expire: () => tx, exec: () => new Promise(() => {}) };
      return tx;
    },
  };
  const shared = createSharedMetrics({ getClient: () => hangingClient, env: sharedEnv, log: silentLog });

  const startedAt = Date.now();
  const result = await shared.mirrorDeltas({ totals: { requestTotal: 1 } });

  assert.equal(result.mirrored, false);
  assert.ok(Date.now() - startedAt < REDIS_OP_TIMEOUT_MS * 4, 'the tick completes rather than blocking the next one');
  assert.equal(shared.getAggregationStatus({ sharedReadSucceeded: false }).mode, 'degraded');
});

test('a delta applies all-or-nothing: a failed EXEC leaves the shared state untouched', async () => {
  const redis = makeFakeRedis({ failOn: 'exec' });
  const shared = createSharedMetrics({ getClient: () => redis, env: sharedEnv, log: silentLog });

  const result = await shared.mirrorDeltas({
    counters: { 'completionStatus:grounded': 5 },
    totals: { requestTotal: 5, inputTokens: 900 },
  });

  assert.equal(result.mirrored, false);
  // Without MULTI, some of these increments would have landed while the
  // baseline still counted them as unsent — and the next tick would have
  // double-counted them.
  assert.equal(redis.hashes.has(COUNTERS_KEY), false, 'not one counter was partially applied');
  assert.equal(redis.hashes.has(TOTALS_KEY), false, 'not one total was partially applied');
});

test('a client that LOOKS open but fails every command is reported degraded, not shared', async () => {
  // node-redis keeps isOpen true while it retries a dropped connection, so
  // isOpen alone would claim "shared" while nothing is landing. Verified
  // against a real Redis restart before this was fixed.
  const reconnectingClient = {
    isOpen: true,
    multi() {
      const tx = {
        hIncrBy: () => tx,
        hSet: () => tx,
        expire: () => tx,
        exec: async () => { const e = new Error('socket closed'); e.code = 'ECONNRESET'; throw e; },
      };
      return tx;
    },
    hGetAll: async () => { const e = new Error('socket closed'); e.code = 'ECONNRESET'; throw e; },
    hDel: async () => 1,
  };
  const shared = createSharedMetrics({ getClient: () => reconnectingClient, env: sharedEnv, log: silentLog });

  assert.equal(shared.getAggregationStatus().mode, 'shared', 'before any attempt, an open client is taken at face value');
  await shared.mirrorDeltas({ totals: { requestTotal: 1 } });
  assert.equal(shared.getAggregationStatus().mode, 'degraded', 'once writes start failing, the mode tells the truth');
  assert.equal(shared.__statsForTests().consecutiveFailures, 1);
});

test('health recovers once operations succeed again, without a restart', async () => {
  const redis = makeFakeRedis();
  let broken = true;
  const flaky = {
    get isOpen() { return true; },
    multi() {
      const real = redis.multi();
      const tx = {
        hIncrBy: (...a) => { real.hIncrBy(...a); return tx; },
        hSet: (...a) => { real.hSet(...a); return tx; },
        expire: (...a) => { real.expire(...a); return tx; },
        exec: async () => {
          if (broken) { const e = new Error('down'); e.code = 'ECONNREFUSED'; throw e; }
          return real.exec();
        },
      };
      return tx;
    },
    hGetAll: (...a) => redis.hGetAll(...a),
    hDel: (...a) => redis.hDel(...a),
  };
  const shared = createSharedMetrics({ getClient: () => flaky, env: sharedEnv, log: silentLog });

  await shared.mirrorDeltas({ totals: { requestTotal: 1 } });
  assert.equal(shared.getAggregationStatus().mode, 'degraded');

  broken = false;
  const recovered = await shared.mirrorDeltas({ totals: { requestTotal: 1 } });
  assert.equal(recovered.mirrored, true);
  assert.equal(shared.getAggregationStatus().mode, 'shared', 'a healed connection returns to shared on its own');
  assert.equal(shared.__statsForTests().consecutiveFailures, 0);
});
