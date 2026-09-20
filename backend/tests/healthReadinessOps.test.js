import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import {
  livenessHandler, createReadinessHandler, readinessVerdict, publicErrorDetail,
} from '../utils/healthHandlers.js';
import opsRoute from '../routes/ops.js';
import { getDependencySnapshot } from '../services/telemetry/dependencyState.js';

/**
 * healthReadinessOps.test.js
 * =============================
 * Phase 5B goal 5, plus the Phase 5B additions to the protected ops
 * endpoint. Driven through REAL mounted Express apps, not by calling the
 * handlers' internals.
 *
 * The distinction these defend: /health is liveness (is this process
 * alive?) and /ready is serveability (should traffic come here?). Blurring
 * them is a classic production outage — a dependency check on the liveness
 * probe gets healthy pods KILLED during a dependency blip instead of merely
 * drained.
 */

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
  });
});

const request = (baseUrl, path) => new Promise((resolve, reject) => {
  const req = http.request(`${baseUrl}${path}`, { method: 'GET' }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

const withMongoReadyState = async (readyState, fn) => {
  Object.defineProperty(mongoose.connection, 'readyState', { value: readyState, configurable: true });
  try { return await fn(); } finally { delete mongoose.connection.readyState; }
};

const buildHealthApp = (deps = {}) => {
  const app = express();
  app.get('/health', livenessHandler);
  app.get('/ready', createReadinessHandler({
    getMongoReadyState: () => 1,
    mongoAttempted: () => true,
    getMongoLastError: () => null,
    getRedisClient: () => null,
    ...deps,
  }));
  return app;
};

test('/health is pure liveness: 200 regardless of every dependency being down', async () => {
  const { baseUrl, close } = await listen(buildHealthApp({
    getMongoReadyState: () => 0,
    getRedisClient: () => null,
  }));
  try {
    const res = await request(baseUrl, '/health');
    assert.equal(res.status, 200, 'a dependency outage must never get this process killed');
    const body = JSON.parse(res.raw);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
  } finally {
    await close();
  }
});

test('/health reports nothing about dependencies at all -- it has no opinion to leak', async () => {
  const { baseUrl, close } = await listen(buildHealthApp());
  try {
    const body = JSON.parse((await request(baseUrl, '/health')).raw);
    assert.deepEqual(Object.keys(body).sort(), ['status', 'success', 'uptime']);
  } finally {
    await close();
  }
});

test('/ready serves traffic only when its required dependency is connected', async () => {
  const { baseUrl, close } = await listen(buildHealthApp({ getMongoReadyState: () => 1 }));
  try {
    const res = await request(baseUrl, '/ready');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.raw);
    assert.equal(body.status, 'ready');
    assert.equal(body.readiness, 'ready');
  } finally {
    await close();
  }
});

test('/ready distinguishes DEGRADED (still connecting) from UNAVAILABLE (gone)', async () => {
  const connecting = await listen(buildHealthApp({ getMongoReadyState: () => 2 }));
  try {
    const body = JSON.parse((await request(connecting.baseUrl, '/ready')).raw);
    assert.equal(body.readiness, 'degraded', 'mid-transition is not the same as broken');
    assert.equal(body.status, 'starting', 'the pre-existing label is preserved');
  } finally {
    await connecting.close();
  }

  const down = await listen(buildHealthApp({ getMongoReadyState: () => 0 }));
  try {
    const res = await request(down.baseUrl, '/ready');
    assert.equal(res.status, 503);
    assert.equal(JSON.parse(res.raw).readiness, 'unavailable');
  } finally {
    await down.close();
  }
});

test('both degraded and unavailable are taken out of rotation -- only ready serves', async () => {
  for (const [state, expected] of [[1, 200], [2, 503], [3, 503], [0, 503]]) {
    const { baseUrl, close } = await listen(buildHealthApp({ getMongoReadyState: () => state }));
    try {
      assert.equal((await request(baseUrl, '/ready')).status, expected, `readyState ${state}`);
    } finally {
      await close();
    }
  }
});

test('readinessVerdict maps every mongoose state, including unknown ones', () => {
  assert.equal(readinessVerdict(1), 'ready');
  assert.equal(readinessVerdict(2), 'degraded');
  assert.equal(readinessVerdict(3), 'degraded');
  assert.equal(readinessVerdict(0), 'unavailable');
  assert.equal(readinessVerdict(99), 'unavailable', 'an uninterpretable state is never optimistically "ready"');
});

test('/ready carries the per-dependency snapshot, with statuses only', async () => {
  const { baseUrl, close } = await listen(buildHealthApp({
    getMongoReadyState: () => 1,
    getDependencies: getDependencySnapshot,
  }));
  try {
    const body = JSON.parse((await request(baseUrl, '/ready')).raw);
    assert.ok(body.dependencies, 'the breakdown is present');
    assert.equal(typeof body.dependencies.mongodb.status, 'string');
    assert.equal(typeof body.dependencies.openai.status, 'string');
    assert.equal(typeof body.dependencies.openai.required, 'boolean');
  } finally {
    await close();
  }
});

test('an optional dependency being down never takes an instance out of rotation', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY; // a required-for-chat dependency is absent
  const { baseUrl, close } = await listen(buildHealthApp({
    getMongoReadyState: () => 1,
    getRedisClient: () => null, // redis down too
    getDependencies: getDependencySnapshot,
  }));
  try {
    const res = await request(baseUrl, '/ready');
    assert.equal(res.status, 200, 'one missing env var must not become a total outage for every other route');
    const body = JSON.parse(res.raw);
    assert.equal(body.redis, 'unavailable');
    assert.equal(body.dependencies.openai.status, 'unavailable', 'but it IS reported, not hidden');
  } finally {
    await close();
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
  }
});

test('a dependency snapshot that throws never breaks the health check it is part of', async () => {
  const { baseUrl, close } = await listen(buildHealthApp({
    getMongoReadyState: () => 1,
    getDependencies: () => { throw new Error('snapshot exploded'); },
  }));
  try {
    const res = await request(baseUrl, '/ready');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.raw).dependencies, undefined, 'the extra is omitted, the check still answers');
    assert.equal(res.raw.includes('snapshot exploded'), false);
  } finally {
    await close();
  }
});

test('in production /ready never exposes a raw internal driver error', async () => {
  const leakyError = 'connect ECONNREFUSED 10.0.3.14:27017 replicaSet=rs0-prod';
  const { baseUrl, close } = await listen(buildHealthApp({
    getMongoReadyState: () => 0,
    getMongoLastError: () => leakyError,
    isProduction: () => true,
  }));
  try {
    const res = await request(baseUrl, '/ready');
    assert.equal(res.raw.includes('10.0.3.14'), false, 'no host or port is disclosed');
    assert.equal(res.raw.includes('rs0-prod'), false, 'no replica-set topology is disclosed');
    assert.equal(JSON.parse(res.raw).mongoLastError, 'dependency unavailable — see server logs');
  } finally {
    await close();
  }
});

test('outside production the real error is kept, where it is the fastest way to debug', async () => {
  const { baseUrl, close } = await listen(buildHealthApp({
    getMongoReadyState: () => 0,
    getMongoLastError: () => 'connection timed out',
    isProduction: () => false,
  }));
  try {
    assert.equal(JSON.parse((await request(baseUrl, '/ready')).raw).mongoLastError, 'connection timed out');
  } finally {
    await close();
  }
});

test('publicErrorDetail passes null through and never invents a reason', () => {
  assert.equal(publicErrorDetail(null, { isProduction: true }), null);
  assert.equal(publicErrorDetail(null, { isProduction: false }), null);
  assert.equal(publicErrorDetail('boom', { isProduction: false }), 'boom');
  assert.ok(publicErrorDetail('boom', { isProduction: true }).includes('server logs'));
});

test('/ready never carries a credential, whatever is configured', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-READY-SENTINEL';
  const { baseUrl, close } = await listen(buildHealthApp({
    getMongoReadyState: () => 1,
    getDependencies: getDependencySnapshot,
  }));
  try {
    const res = await request(baseUrl, '/ready');
    assert.equal(res.raw.includes('READY-SENTINEL'), false);
    assert.equal(res.raw.includes('sk-test'), false);
  } finally {
    await close();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

/** Mounts the real ops router, in development mode where it is reachable. */
const buildOpsApp = () => {
  const app = express();
  app.use('/api/ops', opsRoute);
  return app;
};

test('the ops endpoint reports which aggregation mode its numbers came from', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalShared = process.env.RAG_METRICS_SHARED_AGGREGATION;
  process.env.NODE_ENV = 'development';
  delete process.env.RAG_METRICS_SHARED_AGGREGATION;

  const { baseUrl, close } = await listen(buildOpsApp());
  try {
    const res = await request(baseUrl, '/api/ops/rag-metrics');
    assert.equal(res.status, 200);
    const { data } = JSON.parse(res.raw);

    assert.equal(data.aggregation.mode, 'local');
    assert.equal(data.aggregation.configured, false);
    assert.equal(data.aggregation.backend, 'in-process');
    assert.ok(data.aggregation.scope.includes('this instance'), 'an operator is told the numbers are partial');
  } finally {
    await close();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalShared !== undefined) process.env.RAG_METRICS_SHARED_AGGREGATION = originalShared;
  }
});

test('with shared aggregation configured but no backend reachable, the endpoint says DEGRADED', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalShared = process.env.RAG_METRICS_SHARED_AGGREGATION;
  process.env.NODE_ENV = 'development';
  process.env.RAG_METRICS_SHARED_AGGREGATION = 'true'; // no Redis is running in tests

  const { baseUrl, close } = await listen(buildOpsApp());
  try {
    const { data } = JSON.parse((await request(baseUrl, '/api/ops/rag-metrics')).raw);
    assert.equal(data.aggregation.mode, 'degraded');
    assert.equal(data.aggregation.configured, true);
    assert.ok(data.aggregation.reason.includes('unreachable'));
    assert.equal(typeof data.requestTotal, 'number', 'local numbers are still served throughout');
  } finally {
    await close();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalShared === undefined) delete process.env.RAG_METRICS_SHARED_AGGREGATION;
    else process.env.RAG_METRICS_SHARED_AGGREGATION = originalShared;
  }
});

test('the ops endpoint reports exporter status, pricing provenance, and ledger counts', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';

  const { baseUrl, close } = await listen(buildOpsApp());
  try {
    const { data } = JSON.parse((await request(baseUrl, '/api/ops/rag-metrics')).raw);

    assert.equal(typeof data.exporter.enabled, 'boolean');
    assert.equal(data.exporter.enabled, false, 'no OTLP endpoint is configured in tests');
    assert.equal(typeof data.pricing.version, 'string');
    assert.equal(typeof data.pricing.stale, 'boolean');
    assert.equal(typeof data.pricing.lastUpdated, 'string');
    assert.equal(typeof data.costLedger.recordedCallCount, 'number');
    assert.equal(typeof data.costLedger.duplicateCallCount, 'number');
    assert.equal(typeof data.readiness, 'string');
    assert.equal(data.configuration.sharedAggregationConfigured !== undefined, true);
    assert.equal(data.configuration.otlpExportConfigured, false);
  } finally {
    await close();
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('the ops endpoint still leaks no secret after the Phase 5B additions', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.NODE_ENV = 'development';
  process.env.OPENAI_API_KEY = 'sk-test-OPS-SENTINEL';
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'api-key=COLLECTOR-SENTINEL';

  const { baseUrl, close } = await listen(buildOpsApp());
  try {
    const res = await request(baseUrl, '/api/ops/rag-metrics');
    assert.equal(res.raw.includes('OPS-SENTINEL'), false, 'the model API key never appears');
    assert.equal(res.raw.includes('COLLECTOR-SENTINEL'), false, 'the collector credential never appears');
    assert.equal(JSON.parse(res.raw).data.configuration.openAiConfigured, true, 'only WHETHER it is set');
  } finally {
    await close();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = originalHeaders;
  }
});

test('the ops endpoint stays protected in production after the Phase 5B additions', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  delete process.env.RAG_METRICS_ENDPOINT_ENABLED;

  const { baseUrl, close } = await listen(buildOpsApp());
  try {
    const res = await request(baseUrl, '/api/ops/rag-metrics');
    assert.equal(res.status, 404, 'the Phase 5A access gate is untouched');
    assert.equal(res.raw.toLowerCase().includes('aggregation'), false, 'and nothing new leaks through it');
  } finally {
    await close();
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('the dependency snapshot reflects real mongoose state on both endpoints', async () => {
  await withMongoReadyState(1, async () => {
    const snapshot = getDependencySnapshot();
    assert.equal(snapshot.mongodb.status, 'ready');
  });
  await withMongoReadyState(2, async () => {
    assert.equal(getDependencySnapshot().mongodb.status, 'degraded');
  });
});
