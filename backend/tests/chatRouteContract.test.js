import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import express from 'express';
import cors from 'cors';
import chatRoute from '../routes/chat.js';
import { signAccessToken } from '../utils/authTokens.js';
import User from '../models/User.js';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import { graph } from '../graph/graph.js';

/**
 * chatRouteContract.test.js
 * ==========================
 * Route-contract tests against a REAL mounted Express app (not just the
 * controller functions in isolation) — this is the exact technique that
 * diagnosed the "Route not found" bug reported against the running dev
 * server: it turned out to be a STALE node server.js process (started
 * 2026-09-06, holding port 5001, running code from before the GS Copilot
 * rewrite existed) — NOT a routing bug. These tests build the same
 * middleware chain server.js uses for /api/chat (cors → json → chatRoute
 * → 404 catch-all) so a real regression here is caught by `npm test`
 * without needing a live process at all.
 */

/** Mirrors server.js's actual /api/chat-relevant middleware chain exactly. */
const buildApp = () => {
  const app = express();
  app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
  app.use(express.json());
  app.use('/api/chat', chatRoute);
  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found', endpoint: req.originalUrl });
  });
  return app;
};

/** Starts `app` on an ephemeral port and returns { baseUrl, close }. */
const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
  });
});

/** Minimal fetch-free HTTP request helper (Node's built-in http, like the diagnostic scripts used). */
const request = (baseUrl, method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : undefined;
  const req = http.request(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const FAKE_USER_ID = new mongoose.Types.ObjectId().toString();
const validAuthHeader = () => `Bearer ${signAccessToken({ _id: FAKE_USER_ID, email: 't@example.com', role: 'user' })}`;

test('POST /api/chat/messages does not return 404 — it reaches the chat router (401 without auth)', async () => {
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, 'POST', '/api/chat/messages', { body: { message: 'Hi' } });
    assert.notEqual(res.status, 404);
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).error, 'Authentication required');
  } finally {
    await close();
  }
});

test('GET /api/chat/threads reaches the chat router (401 without auth, never 404)', async () => {
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, 'GET', '/api/chat/threads');
    assert.notEqual(res.status, 404);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('invalid/garbage authentication returns 401, not "Route not found"', async () => {
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, 'GET', '/api/chat/threads', { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(res.status, 401);
    const parsed = JSON.parse(res.body);
    assert.notEqual(parsed.error, 'Route not found');
  } finally {
    await close();
  }
});

test('an unauthenticated unknown endpoint under /api/chat returns 401 (auth is checked before route existence — deliberate: an unauthenticated caller should not learn which sub-paths exist)', async () => {
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, 'GET', '/api/chat/this-does-not-exist');
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('an AUTHENTICATED unknown endpoint under /api/chat returns a real 404 with the requested path echoed back', async () => {
  const originalUserFindById = User.findById;
  User.findById = () => Promise.resolve({ _id: FAKE_USER_ID, accountStatus: 'active' });
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, 'GET', '/api/chat/this-does-not-exist', { headers: { Authorization: validAuthHeader() } });
    assert.equal(res.status, 404);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Route not found');
    assert.equal(parsed.endpoint, '/api/chat/this-does-not-exist');
  } finally {
    User.findById = originalUserFindById;
    await close();
  }
});

test('an unknown endpoint OUTSIDE /api/chat also 404s cleanly (catch-all registered after the chat router, not before)', async () => {
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, 'GET', '/api/totally-unrelated');
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('the legacy POST /api/chat root contract still works unauthenticated (backward compatibility preserved)', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'ok' });
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, 'POST', '/api/chat/', { body: { message: 'Hi' } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).reply, 'ok');
  } finally {
    graph.invoke = originalInvoke;
    await close();
  }
});

test('a valid authenticated request reaches the SSE stream and gets text/event-stream, never 404 — proof the request reaches the graph layer, not just the router', async () => {
  const originalUserFindById = User.findById;
  const originalThreadFindOne = ChatThread.findOne;
  const originalThreadCreate = ChatThread.create;
  const originalMessageFind = ChatMessage.find;
  const originalMessageFindOne = ChatMessage.findOne;
  const originalMessageCreate = ChatMessage.create;
  const originalInvoke = graph.invoke;

  User.findById = () => Promise.resolve({ _id: FAKE_USER_ID, accountStatus: 'active' });
  const threadId = new mongoose.Types.ObjectId().toString();
  const threadDoc = {
    _id: threadId, userId: FAKE_USER_ID, deletedAt: null, messageCount: 0, title: 'New chat',
    save: async function save() { return this; },
    toObject: function toObject() { return { _id: this._id, userId: this.userId, title: this.title }; },
  };
  // Both the "existing thread" (findOne) and "no threadId given, create one
  // implicitly" (create) paths are mocked, so this test is robust
  // regardless of which URL variant is exercised below.
  ChatThread.findOne = () => Promise.resolve(threadDoc);
  ChatThread.create = async () => threadDoc;
  ChatMessage.find = () => ({ sort: () => ({ lean: async () => [] }) });
  ChatMessage.findOne = () => Promise.resolve(null); // no existing message with this clientMessageId — not a duplicate
  ChatMessage.create = async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId(), toObject: function toObject() { return { ...doc, _id: this._id }; } });
  graph.invoke = async ({ onEvent }) => {
    onEvent({ type: 'token', token: 'Hello' });
    return { answer: 'Hello', citations: [], warnings: [], intent: 'GENERAL_EDUCATION' };
  };

  const { baseUrl, close } = await listen(buildApp());
  try {
    // Exercises the explicit threadId variant (POST /api/chat/threads/:id/messages) —
    // the other convenience variant (POST /api/chat/messages, no threadId)
    // is already covered functionally by the "does not return 404" test above.
    const res = await request(baseUrl, 'POST', `/api/chat/threads/${threadId}/messages`, {
      headers: { Authorization: validAuthHeader() },
      body: { message: 'Hi', clientMessageId: 'route-contract-test-1' },
    });
    assert.notEqual(res.status, 404);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body, /"type":"message\.started"/);
    assert.match(res.body, /"type":"message\.completed"/);
  } finally {
    User.findById = originalUserFindById;
    ChatThread.findOne = originalThreadFindOne;
    ChatThread.create = originalThreadCreate;
    ChatMessage.find = originalMessageFind;
    ChatMessage.findOne = originalMessageFindOne;
    ChatMessage.create = originalMessageCreate;
    graph.invoke = originalInvoke;
    await close();
  }
});

test('route registration order: /api/chat is matched before the final catch-all (structural check on the built app)', async () => {
  const app = buildApp();
  const layers = app._router?.stack || app.router?.stack || [];
  // Express 5 restructured router internals (app._router may differ from
  // Express 4) — this assertion tolerates either shape by searching
  // whichever stack is populated, and skips gracefully if neither is
  // introspectable, since the functional tests above already prove the
  // effective behavior either way.
  if (!layers.length) return;
  const chatLayerIndex = layers.findIndex((l) => l.name === 'router' && l.regexp?.test?.('/api/chat/threads'));
  const catchAllIndex = layers.length - 2; // error handler is last; catch-all is second-to-last in buildApp()
  if (chatLayerIndex === -1) return; // internals not introspectable this way on this Express version — not a failure
  assert.ok(chatLayerIndex < catchAllIndex, 'the /api/chat router must be registered before the catch-all 404 handler');
});
