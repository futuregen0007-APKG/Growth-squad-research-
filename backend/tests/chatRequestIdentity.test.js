import test from 'node:test';
import assert from 'node:assert/strict';
import { legacySendMessage } from '../controllers/ChatController.js';
import { graph } from '../graph/graph.js';
import { validateInput } from '../graph/nodes/validateInput.js';
import { resolveTotalDeadlineMs } from '../graph/requestBudget.js';

const makeFakeRes = () => ({
  jsonBody: null,
  statusCode: 200,
  json: function json(body) { this.jsonBody = body; return this; },
  status: function status(code) { this.statusCode = code; return this; },
});

/**
 * Phase 0 traced the earliest missing requestId propagation point to
 * legacySendMessage ('/api/chat', unauthenticated): it invoked the graph
 * with no requestId field at all, so GraphState's default (null) survived
 * to logDiagnostics. sendMessage (the authenticated/threaded endpoint)
 * already generated and passed one correctly — these tests cover the
 * fixed path without duplicating that existing coverage.
 */
test('legacySendMessage generates a non-null requestId and passes it into graph.invoke', async () => {
  const originalInvoke = graph.invoke;
  let receivedState = null;
  graph.invoke = async (state) => { receivedState = state; return { answer: 'ok' }; };
  try {
    await legacySendMessage({ body: { message: 'What is a P/E ratio?' } }, makeFakeRes());
    assert.equal(typeof receivedState.requestId, 'string');
    assert.ok(receivedState.requestId.length > 0);
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('legacySendMessage never reuses the same requestId across two separate requests', async () => {
  const originalInvoke = graph.invoke;
  const seen = [];
  graph.invoke = async (state) => { seen.push(state.requestId); return { answer: 'ok' }; };
  try {
    await legacySendMessage({ body: { message: 'Hello' } }, makeFakeRes());
    await legacySendMessage({ body: { message: 'Hello again' } }, makeFakeRes());
    assert.notEqual(seen[0], seen[1]);
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('legacySendMessage passes a deadlineAt and an AbortSignal into graph.invoke (Phase 1 deadline/cancellation wiring)', async () => {
  const originalInvoke = graph.invoke;
  let receivedState = null;
  graph.invoke = async (state) => { receivedState = state; return { answer: 'ok' }; };
  try {
    await legacySendMessage({ body: { message: 'Hello' } }, makeFakeRes());
    assert.equal(typeof receivedState.deadlineAt, 'number');
    assert.ok(receivedState.deadlineAt > Date.now(), 'deadlineAt must be in the future at request start');
    assert.ok(receivedState.abortSignal instanceof AbortSignal);
    assert.equal(receivedState.abortSignal.aborted, false);
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('legacySendMessage tolerates a request object with no .on method (a minimal caller/test double) without hanging or throwing', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'ok' });
  try {
    const res = makeFakeRes();
    await legacySendMessage({ body: { message: 'Hello' } }, res);
    assert.equal(res.jsonBody.reply, 'ok');
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('validateInput sets deadlineAt exactly once -- a state that already has one is never overwritten by a later call', async () => {
  const existingDeadline = Date.now() + 12345;
  const result = await validateInput({ messages: [{ content: 'Hello' }], deadlineAt: existingDeadline });
  assert.equal(result.deadlineAt, existingDeadline);
});

test('validateInput computes a fresh deadlineAt (turnStartedAt + the configured total budget) when none was supplied', async () => {
  const before = Date.now();
  const result = await validateInput({ messages: [{ content: 'Hello' }], deadlineAt: null });
  const after = Date.now();
  const expectedBudget = resolveTotalDeadlineMs();
  assert.ok(result.deadlineAt >= before + expectedBudget && result.deadlineAt <= after + expectedBudget);
});
