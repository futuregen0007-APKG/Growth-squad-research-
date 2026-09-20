import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDeep, isSensitiveKey } from '../services/telemetry/safeSerialization.js';
import { isValidTraceId, resolveTraceId, TRACE_ID_HEADER } from '../services/telemetry/traceContext.js';
import {
  emitEvent, buildSafeEvent, registerExporter, unregisterExporter, listExporterNames, RAG_EVENT_NAMES,
  TELEMETRY_SCHEMA_VERSION,
} from '../services/telemetry/ragTelemetry.js';

/**
 * Phase 5A Part 2/3/12 safety tests. The single invariant every assertion
 * here defends: telemetry may never carry a prompt, a document excerpt, a
 * secret, or unbounded caller-supplied content, and may never break the
 * user's answer by throwing.
 */

test('redactDeep replaces a sensitive value rather than keeping it, at any nesting depth', () => {
  const out = redactDeep({
    model: 'gpt-4o-mini',
    authorization: 'Bearer real-token',
    nested: { apiKey: 'sk-live-123', deeper: { mongo_uri: 'mongodb+srv://user:pw@host' } },
  });
  assert.equal(out.model, 'gpt-4o-mini', 'a harmless field is kept verbatim');
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.nested.apiKey, '[REDACTED]');
  assert.equal(out.nested.deeper.mongo_uri, '[REDACTED]');
});

test('sensitive key matching ignores case, separators, and surrounding punctuation', () => {
  for (const key of ['Authorization', 'authorization-header', 'API_KEY', 'apiKey', 'mongoDBUri', 'Set-Cookie', 'accessToken', 'password']) {
    assert.equal(isSensitiveKey(key), true, `${key} must be treated as sensitive`);
  }
  for (const key of ['model', 'durationMs', 'citationCount', 'stage', 'retrievalMode']) {
    assert.equal(isSensitiveKey(key), false, `${key} is an ordinary telemetry dimension`);
  }
});

test('content-bearing keys (prompt, completion, chunkText, excerpt, embedding) are redacted -- never logged verbatim', () => {
  const out = redactDeep({
    prompt: 'the full system prompt with user data',
    completion: 'the full model answer',
    chunkText: 'a verbatim paragraph from a real filing',
    excerpt: 'management said ...',
    embedding: [0.1, 0.2, 0.3],
    stack: 'Error: at foo (/srv/app.js:1:1)',
  });
  assert.deepEqual(out, {
    prompt: '[REDACTED]', completion: '[REDACTED]', chunkText: '[REDACTED]',
    excerpt: '[REDACTED]', embedding: '[REDACTED]', stack: '[REDACTED]',
  });
});

test('redactDeep truncates an over-long string under an innocuous key instead of passing it through', () => {
  const out = redactDeep({ note: 'x'.repeat(2000) });
  assert.ok(out.note.length < 600, 'a 2000-character value must not survive at full length');
  assert.ok(out.note.endsWith('[TRUNCATED]'), 'truncation is explicit, never silent');
});

test('redactDeep never mutates its input and bounds both recursion depth and array length', () => {
  const input = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } }, list: Array.from({ length: 200 }, (_, i) => i) };
  const snapshot = JSON.stringify(input);
  const out = redactDeep(input);
  assert.equal(JSON.stringify(input), snapshot, 'the original object is never modified');
  assert.equal(out.list.length, 50, 'a long array is capped, never copied wholesale');
  assert.equal(JSON.stringify(out).includes('[MAX_DEPTH_EXCEEDED]'), true, 'runaway nesting stops at an explicit marker');
});

test('a circular structure is bounded rather than hanging telemetry', () => {
  const node = { name: 'root' };
  node.self = node;
  const out = redactDeep(node); // must return, not recurse forever
  assert.equal(out.name, 'root');
});

test('isValidTraceId accepts only a syntactically real UUID -- never arbitrary caller text', () => {
  assert.equal(isValidTraceId('123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(isValidTraceId('not-a-uuid'), false);
  assert.equal(isValidTraceId(''), false);
  assert.equal(isValidTraceId(null), false);
  assert.equal(isValidTraceId(42), false);
  assert.equal(isValidTraceId('a'.repeat(500)), false, 'an unbounded string can never become a metrics dimension');
  assert.equal(isValidTraceId('<script>alert(1)</script>'), false);
});

test('resolveTraceId passes a valid caller id through, and mints a fresh one otherwise -- never throws', () => {
  const supplied = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(resolveTraceId(supplied), supplied);

  const minted = resolveTraceId('garbage-from-a-client');
  assert.equal(isValidTraceId(minted), true);
  assert.notEqual(minted, 'garbage-from-a-client');
  assert.equal(isValidTraceId(resolveTraceId(undefined)), true);
  assert.notEqual(resolveTraceId(undefined), resolveTraceId(undefined), 'each minted id is distinct');
  assert.equal(TRACE_ID_HEADER, 'X-Trace-Id');
});

test('buildSafeEvent forwards only allow-listed keys -- an unexpected field is dropped, not redacted-and-kept', () => {
  const event = buildSafeEvent('rag.request.completed', {
    traceId: '123e4567-e89b-42d3-a456-426614174000',
    durationMs: 120,
    userQuestion: 'what did TCS management promise?', // not allow-listed
    evidenceChunk: 'a verbatim paragraph',            // not allow-listed
    authorization: 'Bearer token',                    // not allow-listed
  });
  assert.equal(event.durationMs, 120);
  assert.equal('userQuestion' in event, false);
  assert.equal('evidenceChunk' in event, false);
  assert.equal('authorization' in event, false);
  assert.equal(event.schemaVersion, TELEMETRY_SCHEMA_VERSION);
  assert.equal(event.eventName, 'rag.request.completed');
  assert.equal(typeof event.timestamp, 'string');
});

test('emitEvent delivers an allow-listed event to a registered exporter', () => {
  const seen = [];
  registerExporter('test-capture', (event) => seen.push(event));
  try {
    emitEvent('rag.retrieval.completed', { traceId: '123e4567-e89b-42d3-a456-426614174000', evidenceCount: 4, retrievalMode: 'hybrid' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].evidenceCount, 4);
    assert.equal(seen[0].retrievalMode, 'hybrid');
  } finally {
    unregisterExporter('test-capture');
  }
  assert.equal(listExporterNames().includes('test-capture'), false);
});

test('an unrecognized event name is dropped -- an exporter never receives an unbounded caller-named event', () => {
  const seen = [];
  registerExporter('test-capture', (event) => seen.push(event));
  try {
    emitEvent('attacker.supplied.name', { durationMs: 1 });
    emitEvent('', { durationMs: 1 });
    assert.equal(seen.length, 0);
  } finally {
    unregisterExporter('test-capture');
  }
});

test('Part 12: an exporter that throws never propagates to the caller', () => {
  registerExporter('test-broken', () => { throw new Error('exporter is down'); });
  const seen = [];
  registerExporter('test-healthy', (event) => seen.push(event));
  try {
    assert.doesNotThrow(() => emitEvent('rag.request.completed', { durationMs: 5 }));
    assert.equal(seen.length, 1, 'a healthy exporter still receives the event after a sibling threw');
  } finally {
    unregisterExporter('test-broken');
    unregisterExporter('test-healthy');
  }
});

test('Part 12: an async exporter that rejects never produces an unhandled rejection', async () => {
  registerExporter('test-async-broken', async () => { throw new Error('async exporter is down'); });
  try {
    assert.doesNotThrow(() => emitEvent('rag.request.completed', { durationMs: 5 }));
    await new Promise((resolve) => setImmediate(resolve)); // let the rejection settle
  } finally {
    unregisterExporter('test-async-broken');
  }
});

test('the default console + metricsStore exporters are registered, and the event vocabulary is frozen', () => {
  const names = listExporterNames();
  assert.equal(names.includes('console'), true);
  assert.equal(names.includes('metricsStore'), true);
  assert.equal(Object.isFrozen(RAG_EVENT_NAMES), true);
  assert.equal(RAG_EVENT_NAMES.includes('rag.request.completed'), true);
  assert.equal(RAG_EVENT_NAMES.includes('rag.request.failed'), true);
});
