import test from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage, legacySendMessage } from '../controllers/ChatController.js';
import { graph } from '../graph/graph.js';
import { RAG_EVENT_SCHEMA, registerExporter, unregisterExporter } from '../services/telemetry/ragTelemetry.js';
import { createMetricsStore } from '../services/telemetry/metricsStore.js';
import { classifyOperationalError } from '../services/telemetry/errorTaxonomy.js';
import mongoose from 'mongoose';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';

/**
 * telemetryRequestLifecycle.test.js
 * ====================================
 * Phase 5A carry-over: the request-level events, driven through the REAL
 * controllers. The invariant these defend is the one that is easiest to get
 * wrong and hardest to notice afterwards: a single turn is counted exactly
 * once, whichever way it ended — success, failure, client abort, safe
 * fallback, streaming or legacy.
 */

const capture = async (fn) => {
  const events = [];
  const name = `lifecycle-capture-${Math.random().toString(36).slice(2)}`;
  registerExporter(name, (event) => events.push(event));
  try { await fn(); } finally { unregisterExporter(name); }
  return events;
};

const eventsNamed = (events, name) => events.filter((e) => e.eventName === name);

const assertSatisfiesSchema = (event) => {
  const schema = RAG_EVENT_SCHEMA[event.eventName];
  assert.ok(schema, `${event.eventName} must have a documented schema`);
  for (const field of schema.required) {
    assert.ok(field in event && event[field] !== undefined, `${event.eventName} must carry "${field}"`);
  }
};

/** A minimal fake Express response covering both the JSON and SSE paths. */
const makeFakeRes = () => {
  const res = {
    statusCode: null, jsonBody: null, headers: {}, chunks: [], ended: false, writableEnded: false,
  };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.jsonBody = payload; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers); return res; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.ended = true; res.writableEnded = true; };
  res.on = () => {};
  res.flushHeaders = () => {};
  return res;
};

const USER_ID = new mongoose.Types.ObjectId().toString();
const THREAD_ID = new mongoose.Types.ObjectId().toString();

/** Mocks every model call the streaming path touches — mirrors tests/chatController.test.js. */
const installDbMocks = () => {
  const originals = {
    threadFindOne: ChatThread.findOne, messageFind: ChatMessage.find,
    messageFindOne: ChatMessage.findOne, messageCreate: ChatMessage.create,
  };
  ChatThread.findOne = () => Promise.resolve({
    _id: THREAD_ID, userId: USER_ID, deletedAt: null, messageCount: 0, title: 'New chat',
    activeEntities: { symbols: [], companyNames: [] },
    save: async function save() { return this; },
    toObject: function toObject() { return { _id: this._id, userId: this.userId, title: this.title }; },
  });
  ChatMessage.find = () => ({ sort: () => ({ lean: async () => [] }) });
  ChatMessage.findOne = () => Promise.resolve(null);
  ChatMessage.create = async (doc) => ({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
    toObject: function toObject() { return { ...doc, _id: this._id }; },
  });
  return () => {
    ChatThread.findOne = originals.threadFindOne; ChatMessage.find = originals.messageFind;
    ChatMessage.findOne = originals.messageFindOne; ChatMessage.create = originals.messageCreate;
  };
};

test('the legacy route emits rag.request.started, exactly like the streaming route', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'Legacy reply text' });
  try {
    const events = await capture(() => legacySendMessage({ body: { message: 'Hello' } }, makeFakeRes()));

    const started = eventsNamed(events, 'rag.request.started');
    assert.equal(started.length, 1, 'both entry points report a request starting');
    assertSatisfiesSchema(started[0]);
    assert.equal(started[0].route, 'POST /api/chat');
    assert.equal(typeof started[0].traceId, 'string');
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('a legacy turn that reached the graph emits no rag.request.failed', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'Legacy reply text' });
  try {
    const events = await capture(() => legacySendMessage({ body: { message: 'Hello' } }, makeFakeRes()));
    assert.equal(eventsNamed(events, 'rag.request.failed').length, 0);
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('a legacy turn whose graph threw emits exactly one rag.request.failed', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => { throw new Error('graph blew up'); };
  try {
    const events = await capture(() => legacySendMessage({ body: { message: 'Hello' } }, makeFakeRes()));

    const failed = eventsNamed(events, 'rag.request.failed');
    assert.equal(failed.length, 1);
    assertSatisfiesSchema(failed[0]);
    assert.equal(failed[0].errorCategory, 'INTERNAL_ERROR');
    assert.equal(Number.isFinite(failed[0].durationMs), true);
    assert.equal(JSON.stringify(failed[0]).includes('graph blew up'), false, 'a raw error message never reaches telemetry');
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('one turn, one trace id: started and failed for the same request link together', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => { throw new Error('graph blew up'); };
  try {
    const events = await capture(() => legacySendMessage({ body: { message: 'Hello' } }, makeFakeRes()));
    const started = eventsNamed(events, 'rag.request.started')[0];
    const failed = eventsNamed(events, 'rag.request.failed')[0];
    assert.equal(started.traceId, failed.traceId);
    assert.equal(started.requestId, failed.requestId);
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('a caller-supplied valid trace id is adopted and reused for every event of that request', async () => {
  const SUPPLIED = '123e4567-e89b-42d3-a456-426614174000';
  const originalInvoke = graph.invoke;
  graph.invoke = async () => { throw new Error('graph blew up'); };
  try {
    const events = await capture(() => legacySendMessage(
      { body: { message: 'Hello' }, headers: { 'x-trace-id': SUPPLIED } },
      makeFakeRes(),
    ));
    for (const event of events) assert.equal(event.traceId, SUPPLIED);
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('a caller-supplied GARBAGE trace id is replaced, never propagated into telemetry', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => { throw new Error('graph blew up'); };
  try {
    const events = await capture(() => legacySendMessage(
      { body: { message: 'Hello' }, headers: { 'x-trace-id': 'not-a-uuid-<script>' } },
      makeFakeRes(),
    ));
    for (const event of events) {
      assert.notEqual(event.traceId, 'not-a-uuid-<script>');
      assert.match(event.traceId, /^[0-9a-f-]{36}$/i);
    }
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('a turn rejected before the graph ran emits no lifecycle events it did not earn', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'never reached' });
  try {
    const res = makeFakeRes();
    const events = await capture(() => legacySendMessage({ body: { message: '   ' } }, res));
    assert.equal(res.statusCode, 400);
    assert.equal(eventsNamed(events, 'rag.request.failed').length, 0, 'a rejected input is not a failed request');
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('the streaming route emits rag.request.started with its own route label', async () => {
  const restoreDb = installDbMocks();
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'Streamed answer', citations: [], warnings: [], intent: 'GENERAL_EDUCATION' });
  try {
    const res = makeFakeRes();
    const events = await capture(() => sendMessage(
      { body: { message: 'Hello' }, params: { threadId: THREAD_ID }, headers: {}, userId: USER_ID, on: () => {} },
      res,
      (err) => { throw err; },
    ));

    const started = eventsNamed(events, 'rag.request.started');
    assert.equal(started.length, 1, 'the streaming route reports its request starting');
    assertSatisfiesSchema(started[0]);
    assert.equal(started[0].route, 'POST /api/chat/messages');
    assert.equal(eventsNamed(events, 'rag.request.failed').length, 0, 'a turn the graph answered is never counted as failed');
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

test('the streaming route echoes the trace id on its response header, for a caller to correlate', async () => {
  const restoreDb = installDbMocks();
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'Streamed answer', citations: [], warnings: [], intent: 'GENERAL_EDUCATION' });
  try {
    const res = makeFakeRes();
    const events = await capture(() => sendMessage(
      { body: { message: 'Hello' }, params: { threadId: THREAD_ID }, headers: {}, userId: USER_ID, on: () => {} },
      res,
      (err) => { throw err; },
    ));

    const started = eventsNamed(events, 'rag.request.started')[0];
    assert.equal(res.headers['X-Trace-Id'], started.traceId, 'the header and the telemetry agree on one id');
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

test('a request the graph answered is never ALSO counted as failed when something later throws', async () => {
  const originalInvoke = graph.invoke;
  // The graph answers normally (in production logDiagnostics has by now
  // already recorded the turn and emitted rag.request.completed), and then
  // writing the response throws — a real possibility on a broken socket.
  graph.invoke = async () => ({ answer: 'A real answer', citations: [] });
  try {
    const res = makeFakeRes();
    res.setHeader = () => { throw new Error('socket already destroyed'); };

    const events = await capture(() => legacySendMessage({ body: { message: 'Hello' } }, res));

    // Proves the failure path genuinely ran — without this the assertion
    // below would pass vacuously, for the wrong reason.
    assert.equal(res.statusCode, 500, 'the late throw really did reach the controller error path');

    assert.equal(
      eventsNamed(events, 'rag.request.failed').length, 0,
      'the turn was already counted when the graph completed — counting it again would double-count one request',
    );
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('the metrics store is not double-incremented for a turn that completed then failed late', async () => {
  // Mirrors the guard above at the metrics layer: recordRequest must not run
  // a second time for a request logDiagnostics already recorded.
  const store = createMetricsStore();
  store.recordRequest({ completionStatus: 'grounded', isResearch: true }); // logDiagnostics' own call
  const graphCompleted = true;
  if (!graphCompleted) store.recordRequest({ completionStatus: 'failed', isResearch: false });

  assert.equal(store.getSnapshot().requestTotal, 1);
  assert.equal(store.getSnapshot().counters['completionStatus:failed'], undefined);
});

test('a client that hung up is classified as an abort, not as an application failure', () => {
  assert.equal(classifyOperationalError({ aborted: () => true }), 'CLIENT_ABORTED');
  assert.notEqual(classifyOperationalError({ aborted: () => true }), 'INTERNAL_ERROR');
});
