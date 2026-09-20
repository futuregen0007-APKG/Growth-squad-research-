/**
 * otlpExporter.js
 * =================
 * Phase 5B goal 1: ship Phase 5A's telemetry events to any OpenTelemetry
 * collector, over OTLP/HTTP with a JSON payload, through the exporter
 * interface Phase 5A already defined. Registering this is the ONLY change
 * to how events reach a backend — no call site moves, and `emitEvent`'s
 * contract is untouched.
 *
 * WHY OTLP/HTTP JSON, HAND-ROLLED, AND NOT THE OTEL SDK.
 * OTLP is the vendor-neutral choice the goal asks for: a collector, Grafana,
 * Honeycomb, Datadog, and CloudWatch all ingest it, so nothing here is tied
 * to one vendor. The protocol's HTTP/JSON encoding is stable and small
 * enough to emit directly, and doing so adds ZERO new dependencies to a
 * project whose whole telemetry layer is currently dependency-free. Pulling
 * in @opentelemetry/sdk-node for one exporter would add a large transitive
 * tree, a second batching/shutdown lifecycle competing with this one, and a
 * supply-chain surface, in exchange for encoding we can write in a few
 * lines. The tradeoff: no auto-instrumentation and no context propagation —
 * neither of which this layer wants, since its events are deliberately
 * hand-built and allow-listed.
 *
 * Events map to OTLP **logs** (LogRecords with attributes), not spans: they
 * are discrete structured records, not a parent/child timing tree. Where a
 * `traceId` is present it is written into the LogRecord's own trace_id
 * field (a UUID is exactly the 16 bytes OTLP wants), so a collector can
 * correlate these records with real traces.
 *
 * SAFETY, in the order it matters:
 *   1. NON-BLOCKING. `export` returns immediately. Events go into a bounded
 *      in-memory queue and are flushed by a timer on a separate tick. A
 *      collector that is slow, down, or a black hole cannot add a single
 *      millisecond to a chat request.
 *   2. NEVER FAILS A REQUEST. Nothing here throws to its caller, and every
 *      network path is wrapped. Phase 5A's emitEvent already catches
 *      exporter errors; this does not rely on that.
 *   3. BOUNDED. The queue has a hard cap. When it is full the OLDEST events
 *      are dropped (the newest are the ones an operator is looking at
 *      during an incident) and the drop is counted, never hidden.
 *   4. TIMEOUT + LIMITED RETRY. Each POST has an AbortController timeout.
 *      A failed batch is retried a bounded number of times with backoff,
 *      then dropped. Retries never grow the queue.
 *   5. SAFE SHUTDOWN. `shutdown()` stops the timer and flushes what is
 *      queued within a bounded time, so a deploy does not silently lose the
 *      last few seconds of telemetry — and cannot hang the process either.
 *   6. REDACTION. Events arriving here have already been allow-listed and
 *      redacted by ragTelemetry/safeSerialization. This re-applies
 *      `redactDeep` anyway: this is the one component that sends data OFF
 *      this machine, so it does not inherit anyone else's guarantee.
 *
 * UNCONFIGURED = INERT. With no OTEL_EXPORTER_OTLP_ENDPOINT set, nothing is
 * registered, no timer starts, and local behaviour (console + in-memory
 * metrics store) is exactly what Phase 5A shipped.
 */
import { logger } from '../../utils/logger.js';
import { redactDeep } from './safeSerialization.js';
import { registerExporter, unregisterExporter } from './ragTelemetry.js';

export const OTLP_EXPORTER_NAME = 'otlp';

const DEFAULTS = {
  maxQueueSize: 2048,
  maxBatchSize: 256,
  flushIntervalMs: 5000,
  timeoutMs: 10000,
  maxRetries: 2,
  retryBaseDelayMs: 500,
  shutdownTimeoutMs: 3000,
};

const positiveIntFromEnv = (raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

/**
 * parseHeaders - OTEL_EXPORTER_OTLP_HEADERS uses the spec's own
 * `k1=v1,k2=v2` form. Header VALUES are commonly credentials (an API key
 * for a hosted collector), so they are parsed here and never logged, never
 * echoed by the ops endpoint, and never included in this exporter's status.
 */
export const parseHeaders = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const headers = {};
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
};

/**
 * resolveOtlpConfig - the exporter is configured ENTIRELY by environment,
 * with no code change needed to point it at a different collector. Standard
 * OTEL_* names are used wherever the spec defines one.
 */
export const resolveOtlpConfig = (env = process.env) => {
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim();
  const enabled = Boolean(endpoint) && env.OTEL_SDK_DISABLED !== 'true';

  return {
    enabled,
    endpoint,
    // The spec's own convention: the logs signal lives at <endpoint>/v1/logs
    // unless a full signal-specific URL is given.
    logsUrl: (env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || '').trim()
      || (endpoint ? `${endpoint.replace(/\/+$/, '')}/v1/logs` : ''),
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: (env.OTEL_SERVICE_NAME || 'gs-copilot-backend').trim(),
    deploymentEnvironment: (env.OTEL_DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'development').trim(),
    maxQueueSize: positiveIntFromEnv(env.OTEL_BSP_MAX_QUEUE_SIZE, DEFAULTS.maxQueueSize, { min: 1, max: 100_000 }),
    maxBatchSize: positiveIntFromEnv(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, DEFAULTS.maxBatchSize, { min: 1, max: 10_000 }),
    flushIntervalMs: positiveIntFromEnv(env.OTEL_BSP_SCHEDULE_DELAY, DEFAULTS.flushIntervalMs, { min: 100, max: 300_000 }),
    timeoutMs: positiveIntFromEnv(env.OTEL_EXPORTER_OTLP_TIMEOUT, DEFAULTS.timeoutMs, { min: 100, max: 120_000 }),
    maxRetries: positiveIntFromEnv(env.OTEL_EXPORTER_OTLP_MAX_RETRIES, DEFAULTS.maxRetries, { min: 0, max: 10 }),
    retryBaseDelayMs: positiveIntFromEnv(env.OTEL_EXPORTER_OTLP_RETRY_DELAY_MS, DEFAULTS.retryBaseDelayMs, { min: 10, max: 60_000 }),
    shutdownTimeoutMs: positiveIntFromEnv(env.OTEL_EXPORTER_OTLP_SHUTDOWN_TIMEOUT_MS, DEFAULTS.shutdownTimeoutMs, { min: 100, max: 60_000 }),
  };
};

/** OTLP AnyValue encoding for the primitive types an allow-listed event can hold. */
const toAnyValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: String(value) };
};

/** A UUID is 16 bytes of hex — exactly what OTLP's trace_id wants, once the dashes come off. */
const toOtlpTraceId = (traceId) => {
  if (typeof traceId !== 'string') return undefined;
  const hex = traceId.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : undefined;
};

// The only 4xx statuses worth retrying: everything else in that range is a
// permanent rejection of this exact payload.
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

// A collector may answer 429/503 with Retry-After, as either a delay in
// seconds or an HTTP date. Honoured, but always bounded: a hostile or
// mis-configured collector must not be able to stall the flush loop for
// minutes, and a batch that waits too long is better dropped than hoarded.
export const MAX_RETRY_AFTER_MS = 30_000;

export const parseRetryAfter = (headers, now = Date.now()) => {
  if (!headers) return null;
  const raw = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  if (raw === null || raw === undefined || raw === '') return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const asDate = Date.parse(raw);
  if (!Number.isFinite(asDate)) return null;
  return Math.min(Math.max(0, asDate - now), MAX_RETRY_AFTER_MS);
};

const SEVERITY = { failure: { number: 17, text: 'ERROR' }, normal: { number: 9, text: 'INFO' } };

/**
 * buildLogRecord - one telemetry event as an OTLP LogRecord. The event's
 * own name becomes the record body; every other field becomes an attribute.
 * Redacted again here (see the module note): this is the boundary where
 * data leaves the process.
 */
export const buildLogRecord = (event, nowMs = Date.now()) => {
  const safe = redactDeep(event);
  const isFailure = safe.eventName === 'rag.request.failed'
    || safe.eventName === 'dependency.failure'
    || safe.eventName === 'dependency.timeout';
  const severity = isFailure ? SEVERITY.failure : SEVERITY.normal;

  const attributes = [];
  for (const [key, value] of Object.entries(safe)) {
    if (key === 'eventName') continue;
    const anyValue = toAnyValue(value);
    if (anyValue) attributes.push({ key, value: anyValue });
  }

  const timeUnixNano = String(
    (Date.parse(safe.timestamp) || nowMs) * 1_000_000,
  );

  const record = {
    timeUnixNano,
    observedTimeUnixNano: String(nowMs * 1_000_000),
    severityNumber: severity.number,
    severityText: severity.text,
    body: { stringValue: String(safe.eventName || 'rag.event') },
    attributes,
  };

  const traceId = toOtlpTraceId(safe.traceId);
  if (traceId) record.traceId = traceId;

  return record;
};

/** buildPayload - a complete OTLP/HTTP JSON logs request for one batch. */
export const buildPayload = (events, config, nowMs = Date.now()) => ({
  resourceLogs: [{
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: config.serviceName } },
        { key: 'deployment.environment', value: { stringValue: config.deploymentEnvironment } },
      ],
    },
    scopeLogs: [{
      scope: { name: 'gs-copilot.rag-telemetry', version: '1' },
      logRecords: events.map((event) => buildLogRecord(event, nowMs)),
    }],
  }],
});

/**
 * sleep - a plain awaited delay. Deliberately NOT unref'd: an unref'd timer
 * lets the event loop finish while a retry backoff is still pending, which
 * would abandon an in-flight export (and, in a test runner, resolve the
 * loop out from under the awaiting promise). The only long-lived timer here
 * is the flush interval, which IS unref'd — see startTimer.
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * deadline - like sleep, but cancellable, so the shutdown race does not
 * hold the process open for the full timeout after the flush has already
 * finished.
 */
const deadline = (ms) => {
  let handle = null;
  const promise = new Promise((resolve) => { handle = setTimeout(resolve, ms); });
  return { promise, cancel: () => { if (handle) clearTimeout(handle); } };
};

/**
 * createOtlpExporter - the exporter itself. `fetchImpl`, `now`, and
 * `scheduler` are injectable so tests drive real buffering, timeout, retry,
 * and shutdown behaviour without a network or a wall clock.
 */
export const createOtlpExporter = ({ config, fetchImpl = globalThis.fetch, log = logger } = {}) => {
  const queue = [];
  const stats = {
    accepted: 0, dropped: 0, exported: 0, failedBatches: 0, retries: 0, retryAfterHonored: 0,
    lastErrorCode: null, lastExportAt: null,
  };
  let timer = null;
  let flushing = false;
  let shuttingDown = false;

  /** postBatch - one POST with a hard timeout. Returns a result, never throws. */
  const postBatch = async (events) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(config.logsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...config.headers },
        body: JSON.stringify(buildPayload(events, config)),
        signal: controller.signal,
      });
      if (!response?.ok) {
        // A 4xx means the collector rejected the PAYLOAD itself, so retrying
        // an identical body would fail identically — with exactly two
        // exceptions the OTLP spec calls out as transient:
        //   408 Request Timeout  — the collector gave up waiting, not a bad body
        //   429 Too Many Requests — "slow down", not "never send this again"
        // Everything else in 4xx is dropped; 5xx and transport failures retry.
        const status = response?.status ?? 0;
        const retryable = RETRYABLE_CLIENT_STATUSES.has(status) || status >= 500 || status === 0;
        return {
          ok: false,
          retryable,
          code: `HTTP_${status}`,
          // A collector that tells us how long to wait is obeyed in
          // preference to our own backoff (bounded — see parseRetryAfter).
          retryAfterMs: retryable ? parseRetryAfter(response?.headers) : null,
        };
      }
      return { ok: true };
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      return { ok: false, retryable: true, code };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  /** sendWithRetry - bounded retries with linear backoff; gives up and drops. */
  const sendWithRetry = async (events) => {
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const result = await postBatch(events);
      if (result.ok) {
        stats.exported += events.length;
        stats.lastExportAt = new Date().toISOString();
        return true;
      }

      stats.lastErrorCode = result.code;
      if (!result.retryable || attempt === config.maxRetries) break;

      stats.retries += 1;
      // A server-supplied Retry-After wins over our own linear backoff; it is
      // the collector telling us what it can actually absorb. Backoff never
      // blocks the request path — this runs on the flush timer.
      const backoffMs = Number.isFinite(result.retryAfterMs)
        ? result.retryAfterMs
        : config.retryBaseDelayMs * (attempt + 1);
      if (Number.isFinite(result.retryAfterMs)) stats.retryAfterHonored += 1;
      await sleep(backoffMs);
    }

    stats.failedBatches += 1;
    stats.dropped += events.length; // bounded: a failed batch is never re-queued
    return false;
  };

  const flush = async () => {
    if (flushing || !queue.length) return;
    flushing = true;
    try {
      // Drain in bounded batches; each batch leaves the queue before it is
      // sent, so a slow collector can never make the queue grow.
      while (queue.length) {
        const batch = queue.splice(0, config.maxBatchSize);
        await sendWithRetry(batch);
        if (shuttingDown && !queue.length) break;
      }
    } catch (error) {
      log.warn(`[otlp-exporter] flush failed: ${error.message}`);
    } finally {
      flushing = false;
    }
  };

  const startTimer = () => {
    if (timer) return;
    timer = setInterval(() => { flush().catch(() => {}); }, config.flushIntervalMs);
    // Never hold the event loop open: a queued event must not stop the
    // process from exiting.
    timer.unref?.();
  };

  return {
    name: OTLP_EXPORTER_NAME,

    /**
     * export - what ragTelemetry calls. SYNCHRONOUS and O(1): it enqueues
     * and returns. It must never await, never throw, and never touch the
     * network on this tick.
     */
    export(event) {
      if (shuttingDown) return;
      if (queue.length >= config.maxQueueSize) {
        // Drop the OLDEST: during an incident the newest events are the ones
        // being looked at. Counted, never silent.
        queue.shift();
        stats.dropped += 1;
      }
      queue.push(event);
      stats.accepted += 1;
      startTimer();
    },

    /** Bounded, awaited flush — used by shutdown and by tests. */
    async forceFlush() { await flush(); },

    /**
     * shutdown - stop accepting, flush what is queued within a bounded time,
     * and return. A collector that never answers delays shutdown by at most
     * shutdownTimeoutMs.
     */
    async shutdown() {
      shuttingDown = true;
      if (timer) { clearInterval(timer); timer = null; }
      const pending = queue.length;
      const shutdownDeadline = deadline(config.shutdownTimeoutMs);
      try {
        await Promise.race([flush(), shutdownDeadline.promise]);
      } finally {
        shutdownDeadline.cancel(); // never outlive the race it bounded
      }
      const abandoned = queue.length;
      if (abandoned) {
        stats.dropped += abandoned;
        queue.length = 0;
        log.warn(`[otlp-exporter] shutdown dropped ${abandoned} event(s) that could not be flushed in time`);
      }
      return { pendingAtShutdown: pending, abandoned };
    },

    /** Status for the ops endpoint. Carries no endpoint credentials, ever. */
    getStatus() {
      return {
        enabled: true,
        protocol: 'otlp-http/json',
        signal: 'logs',
        endpointConfigured: true,
        queueDepth: queue.length,
        maxQueueSize: config.maxQueueSize,
        ...stats,
      };
    },

    /** Test-only visibility into the buffer, never used by app code. */
    __queueDepth() { return queue.length; },
  };
};

let activeExporter = null;

/**
 * initializeOtlpExporter - called once at startup. Registers the exporter
 * only when an endpoint is configured; otherwise does nothing at all and
 * local behaviour stays exactly as Phase 5A shipped.
 */
export const initializeOtlpExporter = ({ env = process.env, fetchImpl = globalThis.fetch } = {}) => {
  const config = resolveOtlpConfig(env);
  if (!config.enabled) {
    logger.info('[otlp-exporter] no OTEL_EXPORTER_OTLP_ENDPOINT configured — telemetry stays local (console + in-memory metrics)');
    return null;
  }
  if (typeof fetchImpl !== 'function') {
    logger.warn('[otlp-exporter] no fetch implementation available — OTLP export disabled');
    return null;
  }

  activeExporter = createOtlpExporter({ config, fetchImpl });
  registerExporter(OTLP_EXPORTER_NAME, (event) => activeExporter.export(event));
  logger.info(`[otlp-exporter] enabled → ${config.logsUrl} (queue ${config.maxQueueSize}, batch ${config.maxBatchSize}, flush ${config.flushIntervalMs}ms)`);
  return activeExporter;
};

export const getOtlpExporter = () => activeExporter;

export const getOtlpStatus = () => (activeExporter
  ? activeExporter.getStatus()
  : { enabled: false, reason: 'no OTEL_EXPORTER_OTLP_ENDPOINT configured', endpointConfigured: false });

/** shutdownOtlpExporter - wired into server.js's existing graceful shutdown. */
export const shutdownOtlpExporter = async () => {
  if (!activeExporter) return null;
  const result = await activeExporter.shutdown();
  unregisterExporter(OTLP_EXPORTER_NAME);
  activeExporter = null;
  return result;
};

export default {
  createOtlpExporter, initializeOtlpExporter, shutdownOtlpExporter, getOtlpStatus, resolveOtlpConfig,
  buildLogRecord, buildPayload, parseHeaders, parseRetryAfter, OTLP_EXPORTER_NAME,
};
