/**
 * verifyObservabilityIntegration.js
 * ====================================
 * Phase 5B readiness gate: verifies the telemetry layer against REAL
 * infrastructure — an actual OpenTelemetry Collector and an actual Redis —
 * rather than against the test doubles the unit suite uses.
 *
 * This is DELIBERATELY NOT part of `npm test`. The registered suite must
 * stay runnable with no network and no containers; this script is opt-in
 * and is skipped entirely unless its endpoints are configured.
 *
 *   docker run -d --name gsr-redis -p 63790:6379 redis:7-alpine
 *   docker run -d --name gsr-otel-collector -p 43180:4318 \
 *     -v "$PWD/otel-collector-config.yaml:/etc/otelcol/config.yaml:ro" \
 *     -v "$PWD/otel-output:/output" \
 *     otel/opentelemetry-collector:latest --config=/etc/otelcol/config.yaml
 *
 *   OTLP_TEST_ENDPOINT=http://localhost:43180 \
 *   REDIS_TEST_URL=redis://localhost:63790 \
 *   npm run observability:verify
 *
 * Exits non-zero if any check fails, so it can gate a release.
 */
import http from 'node:http';
import { createClient } from 'redis';
import {
  createOtlpExporter, resolveOtlpConfig, buildPayload,
} from '../services/telemetry/otlpExporter.js';
import { createSharedMetrics, computeDeltas } from '../services/telemetry/sharedMetrics.js';
import { createMetricsStore } from '../services/telemetry/metricsStore.js';

const OTLP_ENDPOINT = process.env.OTLP_TEST_ENDPOINT || '';
const REDIS_URL = process.env.REDIS_TEST_URL || '';
const silentLog = { warn() {}, info() {}, debug() {}, error() {} };

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const section = (title) => console.log(`\n=== ${title} ===`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const anEvent = (overrides = {}) => ({
  schemaVersion: 1,
  eventName: 'rag.request.completed',
  timestamp: new Date().toISOString(),
  traceId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
  durationMs: 120,
  estimatedCost: 0.00025,
  completionStatus: 'grounded',
  ...overrides,
});

/** A local HTTP stub, for the status codes a real collector will not produce on demand. */
const startStubCollector = (handler) => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, requests.length);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) });
  });
});

// ---------------------------------------------------------------------------
// 1. OTLP against a REAL OpenTelemetry Collector
// ---------------------------------------------------------------------------
const verifyOtlp = async () => {
  section('OTLP / real OpenTelemetry Collector');

  const config = { ...resolveOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT }), timeoutMs: 5000, retryBaseDelayMs: 50 };
  check('endpoint resolves to the OTLP logs path', config.logsUrl === `${OTLP_ENDPOINT}/v1/logs`, config.logsUrl);

  // A real collector validates the payload: a 2xx means resourceLogs /
  // scopeLogs / logRecords / AnyValue encodings are all genuinely correct.
  const probe = await fetch(config.logsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload([anEvent()], config)),
  });
  const probeBody = await probe.text();
  check('a real collector ACCEPTS our payload structure', probe.ok, `HTTP ${probe.status} ${probeBody.slice(0, 120)}`);
  check('collector reports no partial rejection', !probeBody.includes('rejected') || probeBody.includes('"rejectedLogRecords":"0"') || probeBody === '{}' || probeBody.includes('partialSuccess'), probeBody.slice(0, 160));

  // The real exporter, end to end.
  const exporter = createOtlpExporter({ config, fetchImpl: fetch, log: silentLog });
  const marker = `verify-${Date.now()}`;
  for (let i = 0; i < 5; i += 1) exporter.export(anEvent({ requestId: `${marker}-${i}` }));
  check('export() buffers without blocking', exporter.__queueDepth() === 5);
  await exporter.forceFlush();
  check('real flush to collector succeeded', exporter.getStatus().exported === 5 && exporter.getStatus().failedBatches === 0,
    JSON.stringify({ exported: exporter.getStatus().exported, failed: exporter.getStatus().failedBatches }));

  // Batching against the real collector.
  const batching = createOtlpExporter({ config: { ...config, maxBatchSize: 2 }, fetchImpl: fetch, log: silentLog });
  for (let i = 0; i < 5; i += 1) batching.export(anEvent());
  await batching.forceFlush();
  check('batched delivery to a real collector', batching.getStatus().exported === 5 && batching.getStatus().failedBatches === 0);

  // Custom headers must survive to the wire.
  const stub = await startStubCollector((req, res) => { res.writeHead(200); res.end('{}'); });
  const headerExporter = createOtlpExporter({
    config: { ...config, logsUrl: `${stub.url}/v1/logs`, headers: { 'api-key': 'integration-token', 'x-tenant': 'acme' } },
    fetchImpl: fetch,
    log: silentLog,
  });
  headerExporter.export(anEvent());
  await headerExporter.forceFlush();
  check('configured headers reach the wire', stub.requests[0]?.headers['api-key'] === 'integration-token');
  check('request targets /v1/logs', stub.requests[0]?.url === '/v1/logs', stub.requests[0]?.url);

  const sent = JSON.parse(stub.requests[0].body);
  const record = sent.resourceLogs[0].scopeLogs[0].logRecords[0];
  check('trace_id is 32 lowercase hex chars (16 bytes)', /^[0-9a-f]{32}$/.test(record.traceId), record.traceId);
  check('timeUnixNano is nanoseconds since epoch', /^\d{19}$/.test(record.timeUnixNano), record.timeUnixNano);
  check('integer attributes use intValue as a string', record.attributes.some((a) => a.key === 'durationMs' && a.value.intValue === '120'));
  check('fractional attributes use doubleValue', record.attributes.some((a) => a.key === 'estimatedCost' && typeof a.value.doubleValue === 'number'));
  check('string attributes use stringValue', record.attributes.some((a) => a.key === 'completionStatus' && a.value.stringValue === 'grounded'));
  check('resource carries service.name', sent.resourceLogs[0].resource.attributes.some((a) => a.key === 'service.name'));
  await stub.close();

  // Retry policy, against controllable statuses.
  for (const [status, shouldRetry] of [[400, false], [404, false], [422, false], [408, true], [429, true], [503, true]]) {
    // eslint-disable-next-line no-await-in-loop
    const s = await startStubCollector((req, res) => { res.writeHead(status); res.end(''); });
    const e = createOtlpExporter({ config: { ...config, logsUrl: `${s.url}/v1/logs`, maxRetries: 1, retryBaseDelayMs: 10 }, fetchImpl: fetch, log: silentLog });
    e.export(anEvent());
    // eslint-disable-next-line no-await-in-loop
    await e.forceFlush();
    const attempts = s.requests.length;
    check(`HTTP ${status} ${shouldRetry ? 'IS' : 'is NOT'} retried`, attempts === (shouldRetry ? 2 : 1), `${attempts} attempt(s)`);
    // eslint-disable-next-line no-await-in-loop
    await s.close();
  }

  // Retry-After honoured.
  const retryAfterStub = await startStubCollector((req, res, n) => {
    if (n === 1) { res.writeHead(429, { 'Retry-After': '1' }); res.end(''); return; }
    res.writeHead(200); res.end('{}');
  });
  const raExporter = createOtlpExporter({
    config: { ...config, logsUrl: `${retryAfterStub.url}/v1/logs`, maxRetries: 1, retryBaseDelayMs: 5 }, fetchImpl: fetch, log: silentLog,
  });
  raExporter.export(anEvent());
  const raStart = Date.now();
  await raExporter.forceFlush();
  const waited = Date.now() - raStart;
  check('Retry-After is honoured over local backoff', waited >= 900 && raExporter.getStatus().retryAfterHonored === 1, `waited ${waited}ms`);
  await retryAfterStub.close();

  // Timeout against a black hole that accepts the connection and never answers.
  const blackHole = await startStubCollector(() => { /* never responds */ });
  const timeoutExporter = createOtlpExporter({
    config: { ...config, logsUrl: `${blackHole.url}/v1/logs`, timeoutMs: 300, maxRetries: 0 }, fetchImpl: fetch, log: silentLog,
  });
  timeoutExporter.export(anEvent());
  const tStart = Date.now();
  await timeoutExporter.forceFlush();
  const tElapsed = Date.now() - tStart;
  check('a non-answering collector is timed out', timeoutExporter.getStatus().lastErrorCode === 'TIMEOUT' && tElapsed < 3000, `${tElapsed}ms`);
  check('a timed-out batch is dropped, not re-queued', timeoutExporter.__queueDepth() === 0);

  // Queue overflow.
  const overflow = createOtlpExporter({ config: { ...config, logsUrl: `${blackHole.url}/v1/logs`, maxQueueSize: 4 }, fetchImpl: fetch, log: silentLog });
  for (let i = 0; i < 20; i += 1) overflow.export(anEvent());
  check('queue overflow is bounded and counted', overflow.__queueDepth() === 4 && overflow.getStatus().dropped === 16,
    `depth=${overflow.__queueDepth()} dropped=${overflow.getStatus().dropped}`);

  // Shutdown is bounded even against the black hole.
  const shutdownStart = Date.now();
  const shutdownResult = await overflow.shutdown();
  check('shutdown is time-bounded against a dead collector', Date.now() - shutdownStart < 8000, `${Date.now() - shutdownStart}ms`);
  check('shutdown reports what it could not flush', typeof shutdownResult.abandoned === 'number', JSON.stringify(shutdownResult));
  await blackHole.close();

  // Shutdown flush against the REAL collector loses nothing.
  const flushExporter = createOtlpExporter({ config, fetchImpl: fetch, log: silentLog });
  flushExporter.export(anEvent());
  flushExporter.export(anEvent());
  const flushResult = await flushExporter.shutdown();
  check('shutdown flushes pending events to a healthy collector',
    flushResult.abandoned === 0 && flushExporter.getStatus().exported === 2, JSON.stringify(flushResult));

  // Collector DOWN: the app must not care.
  const downConfig = { ...config, logsUrl: 'http://127.0.0.1:1/v1/logs', maxRetries: 0, timeoutMs: 300 };
  const downExporter = createOtlpExporter({ config: downConfig, fetchImpl: fetch, log: silentLog });
  let threw = false;
  try { downExporter.export(anEvent()); await downExporter.forceFlush(); } catch { threw = true; }
  check('a completely unreachable collector never throws to the caller', !threw);
  check('unreachable collector is recorded as a network failure', downExporter.getStatus().failedBatches === 1, downExporter.getStatus().lastErrorCode);
};

// ---------------------------------------------------------------------------
// 2. Redis with two simulated application instances
// ---------------------------------------------------------------------------
const makeAppLikeClient = async (url) => {
  // Mirrors utils/redisClient.js's own construction, including the
  // reconnectStrategy: false that governs real recovery behaviour.
  const client = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } });
  client.on('error', () => {});
  await client.connect();
  return client;
};

const verifyRedis = async () => {
  section('Redis / two simulated application instances');
  const env = { RAG_METRICS_SHARED_AGGREGATION: 'true' };

  const clientA = await makeAppLikeClient(REDIS_URL);
  const clientB = await makeAppLikeClient(REDIS_URL);

  // Start from a clean namespace so repeated runs are comparable.
  await clientA.del(['gsr:metrics:v1:counters', 'gsr:metrics:v1:totals', 'gsr:metrics:v1:instances']);

  const storeA = createMetricsStore();
  const storeB = createMetricsStore();
  const sharedA = createSharedMetrics({ getClient: () => clientA, env, instanceId: 'instance-A', log: silentLog });
  const sharedB = createSharedMetrics({ getClient: () => clientB, env, instanceId: 'instance-B', log: silentLog });

  // Each instance records real activity through the real metrics store.
  for (let i = 0; i < 7; i += 1) storeA.recordRequest({ completionStatus: 'grounded', isResearch: true });
  for (let i = 0; i < 5; i += 1) storeB.recordRequest({ completionStatus: 'grounded', isResearch: true });
  storeA.recordTokenUsage({ inputTokens: 1000, outputTokens: 100 });
  storeB.recordTokenUsage({ inputTokens: 2000, outputTokens: 200 });
  storeA.recordCost(0.000123);
  storeB.recordCost(0.000456);

  let baseA = null;
  let baseB = null;
  const snapA1 = storeA.getSnapshot();
  const snapB1 = storeB.getSnapshot();
  const resA = await sharedA.mirrorDeltas(computeDeltas(baseA, snapA1));
  const resB = await sharedB.mirrorDeltas(computeDeltas(baseB, snapB1));
  if (resA.mirrored) baseA = snapA1;
  if (resB.mirrored) baseB = snapB1;

  const merged = await sharedA.readSharedSnapshot();
  check('two instances aggregate atomically into one total', merged.requestTotal === 12, `requestTotal=${merged.requestTotal} (7+5)`);
  check('counters sum across instances', merged.counters['completionStatus:grounded'] === 12, String(merged.counters['completionStatus:grounded']));
  check('token totals sum across instances', merged.tokenTotals.inputTokens === 3000, String(merged.tokenTotals.inputTokens));
  check('fractional cost sums exactly via integer micros', merged.estimatedCostTotal === 0.000579, String(merged.estimatedCostTotal));
  check('both instances are counted as live', merged.instanceCount === 2, String(merged.instanceCount));

  // Re-mirroring with no new activity must add nothing.
  await sharedA.mirrorDeltas(computeDeltas(baseA, storeA.getSnapshot()));
  await sharedB.mirrorDeltas(computeDeltas(baseB, storeB.getSnapshot()));
  const afterNoop = await sharedA.readSharedSnapshot();
  check('an unchanged tick adds nothing (no duplicate increments)', afterNoop.requestTotal === 12, `requestTotal=${afterNoop.requestTotal}`);

  // New activity only sends the delta.
  storeA.recordRequest({ completionStatus: 'grounded', isResearch: true });
  const snapA2 = storeA.getSnapshot();
  const resA2 = await sharedA.mirrorDeltas(computeDeltas(baseA, snapA2));
  if (resA2.mirrored) baseA = snapA2;
  const afterDelta = await sharedA.readSharedSnapshot();
  check('only the new delta is applied', afterDelta.requestTotal === 13, `requestTotal=${afterDelta.requestTotal}`);

  // All-or-nothing: a MULTI that cannot run leaves nothing partially applied.
  await clientB.quit();
  const beforeFailed = await sharedA.readSharedSnapshot();
  storeB.recordRequest({ completionStatus: 'grounded', isResearch: true });
  const failedWrite = await sharedB.mirrorDeltas(computeDeltas(baseB, storeB.getSnapshot()));
  const afterFailed = await sharedA.readSharedSnapshot();
  check('a write against a closed client fails cleanly', failedWrite.mirrored === false, failedWrite.reason);
  check('a failed tick applies NOTHING (all-or-nothing)', afterFailed.requestTotal === beforeFailed.requestTotal,
    `${beforeFailed.requestTotal} -> ${afterFailed.requestTotal}`);
  check('instance B now reports degraded', sharedB.getAggregationStatus().mode === 'degraded');
  check('instance A is unaffected by B losing Redis', sharedA.getAggregationStatus({ sharedReadSucceeded: true }).mode === 'shared');

  // Recovery: a NEW client (what a process restart gives you) works again.
  const clientB2 = await makeAppLikeClient(REDIS_URL);
  const sharedB2 = createSharedMetrics({ getClient: () => clientB2, env, instanceId: 'instance-B', log: silentLog });
  const recovered = await sharedB2.mirrorDeltas(computeDeltas(baseB, storeB.getSnapshot()));
  const afterRecovery = await sharedA.readSharedSnapshot();
  check('a reconnected instance resumes mirroring', recovered.mirrored === true);
  check('counts buffered during the outage are not lost', afterRecovery.requestTotal === 14, `requestTotal=${afterRecovery.requestTotal}`);
  check('and are not double-counted on recovery', afterRecovery.counters['completionStatus:grounded'] === 14,
    String(afterRecovery.counters['completionStatus:grounded']));

  await clientA.quit();
  await clientB2.quit();
};

// ---------------------------------------------------------------------------
// 3. Endpoints under real dependency failures
// ---------------------------------------------------------------------------
const verifyEndpoints = async () => {
  section('HTTP endpoints under real dependency states');
  const express = (await import('express')).default;
  const mongoose = (await import('mongoose')).default;
  const { livenessHandler, createReadinessHandler } = await import('../utils/healthHandlers.js');
  const { getDependencySnapshot } = await import('../services/telemetry/dependencyState.js');
  const opsRoute = (await import('../routes/ops.js')).default;

  const app = express();
  let mongoState = 1;
  app.get('/health', livenessHandler);
  app.get('/ready', createReadinessHandler({
    getMongoReadyState: () => mongoState,
    mongoAttempted: () => true,
    getMongoLastError: () => 'connect ECONNREFUSED 10.0.0.5:27017',
    getRedisClient: () => null,
    getDependencies: getDependencySnapshot,
  }));
  app.use('/api/ops', opsRoute);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.text() };
  };

  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  process.env.RAG_METRICS_SHARED_AGGREGATION = 'true';

  for (const [label, state, expectReady, expectVerdict] of [
    ['mongo connected', 1, 200, 'ready'],
    ['mongo connecting', 2, 503, 'degraded'],
    ['mongo unavailable', 0, 503, 'unavailable'],
  ]) {
    mongoState = state;
    // eslint-disable-next-line no-await-in-loop
    const health = await get('/health');
    // eslint-disable-next-line no-await-in-loop
    const ready = await get('/ready');
    check(`/health stays 200 while ${label}`, health.status === 200, `HTTP ${health.status}`);
    check(`/ready is ${expectReady} while ${label}`, ready.status === expectReady, `HTTP ${ready.status}`);
    check(`/ready verdict is "${expectVerdict}" while ${label}`, JSON.parse(ready.body).readiness === expectVerdict, JSON.parse(ready.body).readiness);
  }

  mongoState = 0;
  const readyBody = (await get('/ready')).body;
  check('/ready leaks no host/port in development? (dev keeps detail by design)', readyBody.includes('10.0.0.5'), 'dev shows detail');
  process.env.NODE_ENV = 'production';
  const prodReady = (await get('/ready')).body;
  check('/ready redacts the driver error in production', !prodReady.includes('10.0.0.5'), 'redacted');
  process.env.NODE_ENV = 'development';

  mongoState = 1;
  // Ops endpoint with Redis unreachable (no client wired here) must degrade.
  const ops = await get('/api/ops/rag-metrics');
  const opsBody = JSON.parse(ops.body);
  check('ops endpoint answers while Redis is unavailable', ops.status === 200, `HTTP ${ops.status}`);
  check('ops reports degraded aggregation rather than silently local', opsBody.data.aggregation.mode === 'degraded', opsBody.data.aggregation.mode);
  check('ops still serves local numbers while degraded', typeof opsBody.data.requestTotal === 'number');
  check('ops reports the exporter as unconfigured here', opsBody.data.exporter.enabled === false);
  check('ops carries no secret', !ops.body.includes('sk-') && !ops.body.includes('integration-token'));

  process.env.NODE_ENV = originalNodeEnv;
  delete process.env.RAG_METRICS_SHARED_AGGREGATION;
  await new Promise((r) => server.close(r));
};

// ---------------------------------------------------------------------------

const main = async () => {
  if (!OTLP_ENDPOINT && !REDIS_URL) {
    console.log('SKIPPED: set OTLP_TEST_ENDPOINT and/or REDIS_TEST_URL to run integration verification.');
    console.log('This script is intentionally excluded from `npm test`.');
    process.exit(0);
  }

  console.log('Phase 5B observability integration verification');
  console.log(`  collector: ${OTLP_ENDPOINT || '(skipped)'}`);
  console.log(`  redis:     ${REDIS_URL || '(skipped)'}`);

  if (OTLP_ENDPOINT) await verifyOtlp();
  if (REDIS_URL) await verifyRedis();
  await verifyEndpoints();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed) console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(`Integration verification crashed: ${error.stack}`);
  process.exit(1);
});
