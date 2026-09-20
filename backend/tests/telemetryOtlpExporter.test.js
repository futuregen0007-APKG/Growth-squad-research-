import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOtlpExporter, resolveOtlpConfig, parseHeaders, buildPayload, buildLogRecord,
  initializeOtlpExporter, getOtlpStatus, parseRetryAfter, MAX_RETRY_AFTER_MS,
} from '../services/telemetry/otlpExporter.js';
import { listExporterNames } from '../services/telemetry/ragTelemetry.js';

/**
 * telemetryOtlpExporter.test.js
 * ================================
 * Phase 5B goal 1. The invariant every assertion here defends: a telemetry
 * backend that is slow, broken, hostile, or absent must cost the chat
 * request nothing and must never lose more than a bounded amount of data
 * silently.
 *
 * Every test drives the REAL exporter with an injected fetch — never a
 * reimplementation of what it is assumed to do.
 */

const testConfig = (overrides = {}) => ({
  ...resolveOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318' }),
  timeoutMs: 50,
  retryBaseDelayMs: 1,
  shutdownTimeoutMs: 200,
  ...overrides,
});

const okResponse = () => ({ ok: true, status: 200 });

/** A fetch that records every call and answers however the test dictates. */
const recordingFetch = (responder = async () => okResponse()) => {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responder(calls.length, options);
  };
  fn.calls = calls;
  return fn;
};

const anEvent = (overrides = {}) => ({
  schemaVersion: 1,
  eventName: 'rag.request.completed',
  timestamp: '2026-09-20T10:00:00.000Z',
  traceId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: 'req-1',
  durationMs: 120,
  ...overrides,
});

const silentLog = { warn() {}, info() {}, debug() {}, error() {} };

test('with no endpoint configured the exporter is inert and local behaviour is unchanged', () => {
  const config = resolveOtlpConfig({});
  assert.equal(config.enabled, false);

  const before = listExporterNames();
  const exporter = initializeOtlpExporter({ env: {} });
  assert.equal(exporter, null, 'nothing is created when unconfigured');
  assert.deepEqual(listExporterNames(), before, 'no exporter is registered');
  assert.equal(getOtlpStatus().enabled, false);
  assert.equal(getOtlpStatus().endpointConfigured, false);
});

test('OTEL_SDK_DISABLED=true disables export even when an endpoint is set', () => {
  const config = resolveOtlpConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318',
    OTEL_SDK_DISABLED: 'true',
  });
  assert.equal(config.enabled, false);
});

test('configuration comes entirely from the environment, with the standard OTEL names', () => {
  const config = resolveOtlpConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318/',
    OTEL_SERVICE_NAME: 'gs-copilot-test',
    OTEL_DEPLOYMENT_ENVIRONMENT: 'staging',
    OTEL_BSP_MAX_QUEUE_SIZE: '64',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '8',
    OTEL_BSP_SCHEDULE_DELAY: '1500',
    OTEL_EXPORTER_OTLP_TIMEOUT: '2500',
    OTEL_EXPORTER_OTLP_MAX_RETRIES: '4',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.logsUrl, 'http://collector.test:4318/v1/logs', 'the trailing slash never produces a double slash');
  assert.equal(config.serviceName, 'gs-copilot-test');
  assert.equal(config.deploymentEnvironment, 'staging');
  assert.equal(config.maxQueueSize, 64);
  assert.equal(config.maxBatchSize, 8);
  assert.equal(config.flushIntervalMs, 1500);
  assert.equal(config.timeoutMs, 2500);
  assert.equal(config.maxRetries, 4);
});

test('a signal-specific logs endpoint overrides the generic one', () => {
  const config = resolveOtlpConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://generic.test:4318',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://vendor.example/otlp/v1/logs',
  });
  assert.equal(config.logsUrl, 'https://vendor.example/otlp/v1/logs');
});

test('nonsense numeric configuration falls back to a safe default rather than disabling export', () => {
  const config = resolveOtlpConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test:4318',
    OTEL_BSP_MAX_QUEUE_SIZE: 'not-a-number',
    OTEL_EXPORTER_OTLP_TIMEOUT: '-5',
  });
  assert.equal(config.maxQueueSize, 2048);
  assert.ok(config.timeoutMs >= 100, 'a negative timeout is clamped, never used verbatim');
});

test('headers parse from the spec k=v,k=v form, and credentials never appear in status', () => {
  assert.deepEqual(parseHeaders('api-key=secret-value,x-tenant=acme'), { 'api-key': 'secret-value', 'x-tenant': 'acme' });
  assert.deepEqual(parseHeaders(''), {});
  assert.deepEqual(parseHeaders(undefined), {});
  assert.deepEqual(parseHeaders('malformed'), {}, 'a pair with no = is skipped, never half-parsed');

  const exporter = createOtlpExporter({
    config: testConfig({ headers: { 'api-key': 'super-secret-token' } }),
    fetchImpl: recordingFetch(),
    log: silentLog,
  });
  const status = JSON.stringify(exporter.getStatus());
  assert.equal(status.includes('super-secret-token'), false, 'the exporter status must never carry collector credentials');
  assert.equal(status.includes('api-key'), false);
});

test('export() is non-blocking: it enqueues and returns without touching the network', () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig(), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  exporter.export(anEvent());

  assert.equal(fetchImpl.calls.length, 0, 'no network call happens on the caller’s tick');
  assert.equal(exporter.__queueDepth(), 2, 'both events are buffered');
});

test('a flush posts one OTLP/HTTP JSON batch with the documented shape', async () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig(), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await exporter.forceFlush();

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options, body } = fetchImpl.calls[0];
  assert.equal(url, 'http://collector.test:4318/v1/logs');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');

  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.body.stringValue, 'rag.request.completed');
  assert.equal(record.traceId, '123e4567e89b42d3a456426614174000', 'a UUID becomes a valid 16-byte OTLP trace id');
  assert.ok(record.attributes.some((a) => a.key === 'durationMs' && a.value.intValue === '120'));
  assert.equal(exporter.__queueDepth(), 0, 'the queue drains on a successful flush');
});

test('resource attributes identify the service and environment for a collector', () => {
  const payload = buildPayload([anEvent()], testConfig({ serviceName: 'svc', deploymentEnvironment: 'prod' }));
  const attributes = payload.resourceLogs[0].resource.attributes;
  assert.ok(attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'svc'));
  assert.ok(attributes.some((a) => a.key === 'deployment.environment' && a.value.stringValue === 'prod'));
});

test('failure events are exported at ERROR severity, so a collector can alert on them', () => {
  assert.equal(buildLogRecord(anEvent({ eventName: 'rag.request.failed' })).severityText, 'ERROR');
  assert.equal(buildLogRecord(anEvent({ eventName: 'dependency.timeout' })).severityText, 'ERROR');
  assert.equal(buildLogRecord(anEvent({ eventName: 'rag.request.completed' })).severityText, 'INFO');
});

test('redaction is re-applied at the boundary where data leaves the process', async () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig(), fetchImpl, log: silentLog });

  // A malformed event that somehow bypassed the allow-list must still not
  // ship a secret or a prompt off the machine.
  exporter.export(anEvent({ authorization: 'Bearer real-token', prompt: 'the user question' }));
  await exporter.forceFlush();

  const serialized = JSON.stringify(fetchImpl.calls[0].body);
  assert.equal(serialized.includes('Bearer real-token'), false);
  assert.equal(serialized.includes('the user question'), false);
  assert.ok(serialized.includes('[REDACTED]'), 'the field is redacted, not silently dropped');
});

test('the queue is bounded: the oldest events are dropped and the loss is counted', async () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig({ maxQueueSize: 3 }), fetchImpl, log: silentLog });

  for (let i = 0; i < 10; i += 1) exporter.export(anEvent({ requestId: `req-${i}` }));

  assert.equal(exporter.__queueDepth(), 3, 'memory can never grow past the cap');
  assert.equal(exporter.getStatus().dropped, 7, 'every dropped event is accounted for, never hidden');

  await exporter.forceFlush();
  const shipped = fetchImpl.calls[0].body.resourceLogs[0].scopeLogs[0].logRecords
    .map((r) => r.attributes.find((a) => a.key === 'requestId').value.stringValue);
  assert.deepEqual(shipped, ['req-7', 'req-8', 'req-9'], 'the newest events survive, which is what an incident needs');
});

test('a large backlog is sent in bounded batches, never one unbounded request', async () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig({ maxBatchSize: 4, maxQueueSize: 100 }), fetchImpl, log: silentLog });

  for (let i = 0; i < 10; i += 1) exporter.export(anEvent());
  await exporter.forceFlush();

  assert.equal(fetchImpl.calls.length, 3, '10 events at batch size 4 is 4 + 4 + 2');
  for (const call of fetchImpl.calls) {
    assert.ok(call.body.resourceLogs[0].scopeLogs[0].logRecords.length <= 4);
  }
});

test('a request that never answers is aborted by the timeout, not left hanging', async () => {
  const fetchImpl = async (url, options) => new Promise((resolve, reject) => {
    // Mirrors fetch: rejects with AbortError when the caller's signal fires.
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const exporter = createOtlpExporter({
    config: testConfig({ timeoutMs: 30, maxRetries: 0 }), fetchImpl, log: silentLog,
  });

  exporter.export(anEvent());
  await exporter.forceFlush();

  const status = exporter.getStatus();
  assert.equal(status.lastErrorCode, 'TIMEOUT');
  assert.equal(status.failedBatches, 1);
  assert.equal(exporter.__queueDepth(), 0, 'a timed-out batch is dropped, never re-queued into unbounded growth');
});

test('a retryable failure is retried a bounded number of times, then dropped', async () => {
  const fetchImpl = recordingFetch(async () => ({ ok: false, status: 503 }));
  const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 2 }), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await exporter.forceFlush();

  assert.equal(fetchImpl.calls.length, 3, 'the initial attempt plus exactly maxRetries retries — never unbounded');
  assert.equal(exporter.getStatus().retries, 2);
  assert.equal(exporter.getStatus().failedBatches, 1);
  assert.equal(exporter.getStatus().lastErrorCode, 'HTTP_503');
});

test('a rejected payload (4xx) is not retried, because an identical body would fail identically', async () => {
  const fetchImpl = recordingFetch(async () => ({ ok: false, status: 400 }));
  const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 3 }), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await exporter.forceFlush();

  assert.equal(fetchImpl.calls.length, 1, 'no point retrying a permanent rejection');
  assert.equal(exporter.getStatus().retries, 0);
});

test('429 IS retried, since it means "slow down", not "never send this again"', async () => {
  const fetchImpl = recordingFetch(async () => ({ ok: false, status: 429 }));
  const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 1 }), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await exporter.forceFlush();
  assert.equal(fetchImpl.calls.length, 2);
});

test('a retry that succeeds reports the batch as exported, not as failed', async () => {
  const fetchImpl = recordingFetch(async (callNumber) => (callNumber === 1 ? { ok: false, status: 503 } : okResponse()));
  const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 2 }), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await exporter.forceFlush();

  const status = exporter.getStatus();
  assert.equal(status.exported, 1);
  assert.equal(status.failedBatches, 0);
  assert.equal(status.retries, 1);
  assert.ok(status.lastExportAt, 'a successful export records when it happened');
});

test('a fetch that throws synchronously never escapes the exporter', async () => {
  const fetchImpl = () => { throw new Error('connection refused'); };
  const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 0 }), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await assert.doesNotReject(() => exporter.forceFlush());
  assert.equal(exporter.getStatus().lastErrorCode, 'NETWORK_ERROR');
});

test('shutdown flushes what is queued and reports what it could not send', async () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig(), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  exporter.export(anEvent());
  const result = await exporter.shutdown();

  assert.equal(result.pendingAtShutdown, 2);
  assert.equal(result.abandoned, 0, 'a healthy collector loses nothing on a deploy');
  assert.equal(fetchImpl.calls.length, 1);
});

test('shutdown is time-bounded: a dead collector cannot stall the process from exiting', async () => {
  const fetchImpl = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const exporter = createOtlpExporter({
    config: testConfig({ timeoutMs: 20, maxRetries: 0, shutdownTimeoutMs: 100 }), fetchImpl, log: silentLog,
  });

  exporter.export(anEvent());
  const startedAt = Date.now();
  const result = await exporter.shutdown();

  assert.ok(Date.now() - startedAt < 2000, 'shutdown returns promptly even when the collector never answers');
  assert.equal(typeof result.pendingAtShutdown, 'number');
});

test('after shutdown, further events are discarded rather than buffered forever', async () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig(), fetchImpl, log: silentLog });

  await exporter.shutdown();
  exporter.export(anEvent());
  assert.equal(exporter.__queueDepth(), 0, 'a shut-down exporter never accumulates a queue nobody will drain');
});

test('exporting an empty queue is a no-op, not an empty request to the collector', async () => {
  const fetchImpl = recordingFetch();
  const exporter = createOtlpExporter({ config: testConfig(), fetchImpl, log: silentLog });
  await exporter.forceFlush();
  assert.equal(fetchImpl.calls.length, 0);
});

test('status reports queue depth and limits, so a collector outage is visible to an operator', () => {
  const exporter = createOtlpExporter({ config: testConfig({ maxQueueSize: 10 }), fetchImpl: recordingFetch(), log: silentLog });
  exporter.export(anEvent());

  const status = exporter.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.protocol, 'otlp-http/json');
  assert.equal(status.signal, 'logs');
  assert.equal(status.queueDepth, 1);
  assert.equal(status.maxQueueSize, 10);
  assert.equal(status.accepted, 1);
});

test('408 Request Timeout IS retried -- the collector gave up waiting, the body is fine', async () => {
  const fetchImpl = recordingFetch(async () => ({ ok: false, status: 408 }));
  const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 1 }), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await exporter.forceFlush();
  assert.equal(fetchImpl.calls.length, 2, 'initial attempt plus one retry');
});

test('every other 4xx is still permanent and dropped on the first attempt', async () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const fetchImpl = recordingFetch(async () => ({ ok: false, status }));
    const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 3 }), fetchImpl, log: silentLog });
    exporter.export(anEvent());
    // eslint-disable-next-line no-await-in-loop
    await exporter.forceFlush();
    assert.equal(fetchImpl.calls.length, 1, `HTTP ${status} must not be retried`);
  }
});

test('parseRetryAfter reads both forms the spec allows, and refuses nonsense', () => {
  assert.equal(parseRetryAfter({ 'retry-after': '2' }), 2000);
  assert.equal(parseRetryAfter({ 'retry-after': '0' }), 0);
  assert.equal(parseRetryAfter({ 'retry-after': '-5' }), null, 'a negative delay is nonsense');
  assert.equal(parseRetryAfter({ 'retry-after': 'not-a-delay' }), null);
  assert.equal(parseRetryAfter({}), null);
  assert.equal(parseRetryAfter(null), null);

  const now = Date.parse('2026-09-20T10:00:00Z');
  assert.equal(parseRetryAfter({ 'retry-after': 'Sun, 20 Sep 2026 10:00:03 GMT' }, now), 3000, 'HTTP-date form');
  assert.equal(parseRetryAfter({ 'retry-after': 'Sun, 20 Sep 2026 09:00:00 GMT' }, now), 0, 'a past date means retry now');
});

test('an absurd Retry-After is capped -- a collector cannot stall the flush loop indefinitely', () => {
  assert.equal(parseRetryAfter({ 'retry-after': '86400' }), MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter({ 'retry-after': String(MAX_RETRY_AFTER_MS / 1000 + 60) }), MAX_RETRY_AFTER_MS);
});

test('a real Headers object is read as readily as a plain object', () => {
  const headers = new Headers({ 'Retry-After': '3' });
  assert.equal(parseRetryAfter(headers), 3000);
});

test('a 429 with Retry-After waits as instructed, and records that it obeyed', async () => {
  let firstCallAt = 0;
  let secondCallAt = 0;
  const fetchImpl = recordingFetch(async (callNumber) => {
    if (callNumber === 1) {
      firstCallAt = Date.now();
      return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '0.12' }) };
    }
    secondCallAt = Date.now();
    return okResponse();
  });
  const exporter = createOtlpExporter({
    // A retryBaseDelayMs far shorter than the server's instruction, so the
    // wait observed can only have come from Retry-After.
    config: testConfig({ maxRetries: 1, retryBaseDelayMs: 1 }), fetchImpl, log: silentLog,
  });

  exporter.export(anEvent());
  await exporter.forceFlush();

  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(secondCallAt - firstCallAt >= 100, `waited ${secondCallAt - firstCallAt}ms, honouring the server instruction`);
  assert.equal(exporter.getStatus().retryAfterHonored, 1);
  assert.equal(exporter.getStatus().exported, 1);
});

test('without Retry-After the exporter falls back to its own bounded backoff', async () => {
  const fetchImpl = recordingFetch(async (callNumber) => (callNumber === 1 ? { ok: false, status: 503 } : okResponse()));
  const exporter = createOtlpExporter({ config: testConfig({ maxRetries: 1 }), fetchImpl, log: silentLog });

  exporter.export(anEvent());
  await exporter.forceFlush();
  assert.equal(exporter.getStatus().retryAfterHonored, 0);
  assert.equal(exporter.getStatus().exported, 1);
});
