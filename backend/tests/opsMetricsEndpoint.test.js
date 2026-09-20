import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-with-at-least-32-characters';

const { requireOpsAccess } = await import('../middleware/requireOpsAccess.js');
const { default: opsRoute } = await import('../routes/ops.js');
const { signAccessToken } = await import('../utils/authTokens.js');
const { default: User } = await import('../models/User.js');
const { getDependencySnapshot, summarizeReadiness } = await import('../services/telemetry/dependencyState.js');

/**
 * Phase 5A Part 9/10/11 tests. Two invariants: the diagnostics endpoint is
 * never reachable by anyone who should not reach it (and never confirms it
 * exists to them), and the payload it does return carries only aggregates
 * -- never a secret, a prompt, an evidence excerpt, or a user identity.
 */

const FAKE_USER_ID = new mongoose.Types.ObjectId().toString();

/** Runs requireOpsAccess against a fake req/res and reports what it decided. */
const runGate = async ({ env = {}, headers = {} } = {}) => {
  const originalEnv = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
  }

  const outcome = { status: null, body: null, nextCalled: false, nextError: null };
  const res = {
    status(code) { outcome.status = code; return res; },
    json(payload) { outcome.body = payload; return res; },
  };
  const req = { headers };

  try {
    await requireOpsAccess(req, res, (err) => { outcome.nextCalled = true; outcome.nextError = err || null; });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
  return outcome;
};

const withStubbedUser = async (user, fn) => {
  const originalFindById = User.findById;
  User.findById = () => Promise.resolve(user);
  try { return await fn(); } finally { User.findById = originalFindById; }
};

const adminHeader = () => ({ authorization: `Bearer ${signAccessToken({ _id: FAKE_USER_ID, email: 'ops@example.com', role: 'admin' })}` });
const userHeader = () => ({ authorization: `Bearer ${signAccessToken({ _id: FAKE_USER_ID, email: 'someone@example.com', role: 'user' })}` });

test('in production the endpoint is off by default -- 404, never a hint that it exists', async () => {
  const outcome = await runGate({ env: { NODE_ENV: 'production', RAG_METRICS_ENDPOINT_ENABLED: undefined } });
  assert.equal(outcome.status, 404);
  assert.equal(outcome.nextCalled, false, 'the handler must never run');
  assert.equal(outcome.body.error, 'Route not found');
  assert.equal(JSON.stringify(outcome.body).toLowerCase().includes('metric'), false, 'the refusal never names what it is hiding');
});

test('in production an UNAUTHENTICATED caller gets 404, not 401 -- a 401 would confirm the route exists', async () => {
  const outcome = await runGate({ env: { NODE_ENV: 'production', RAG_METRICS_ENDPOINT_ENABLED: 'true' }, headers: {} });
  assert.equal(outcome.status, 404);
  assert.notEqual(outcome.status, 401);
  assert.equal(outcome.nextCalled, false);
});

test('in production a malformed or forged token also yields 404, never an auth-specific error', async () => {
  const outcome = await runGate({
    env: { NODE_ENV: 'production', RAG_METRICS_ENDPOINT_ENABLED: 'true' },
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(outcome.status, 404);
  assert.equal(outcome.nextCalled, false);
});

test('in production an authenticated NON-admin is refused with the same indistinguishable 404', async () => {
  const outcome = await withStubbedUser({ _id: FAKE_USER_ID, accountStatus: 'active', role: 'user' }, () => runGate({
    env: { NODE_ENV: 'production', RAG_METRICS_ENDPOINT_ENABLED: 'true' },
    headers: userHeader(),
  }));
  assert.equal(outcome.status, 404);
  assert.equal(outcome.nextCalled, false, 'an ordinary signed-in user never reaches operational diagnostics');
});

test('in production an authenticated admin, with the endpoint explicitly enabled, is allowed through', async () => {
  const outcome = await withStubbedUser({ _id: FAKE_USER_ID, accountStatus: 'active', role: 'admin' }, () => runGate({
    env: { NODE_ENV: 'production', RAG_METRICS_ENDPOINT_ENABLED: 'true' },
    headers: adminHeader(),
  }));
  assert.equal(outcome.nextCalled, true);
  assert.equal(outcome.status, null, 'nothing is written to the response -- the route handler owns it');
});

test('an admin is still refused in production when the endpoint was never explicitly enabled', async () => {
  const outcome = await withStubbedUser({ _id: FAKE_USER_ID, accountStatus: 'active', role: 'admin' }, () => runGate({
    env: { NODE_ENV: 'production', RAG_METRICS_ENDPOINT_ENABLED: undefined },
    headers: adminHeader(),
  }));
  assert.equal(outcome.status, 404, 'the explicit opt-in is required regardless of who is asking');
  assert.equal(outcome.nextCalled, false);
});

test('a deactivated admin account is refused even with a validly signed token', async () => {
  const outcome = await withStubbedUser(null, () => runGate({
    env: { NODE_ENV: 'production', RAG_METRICS_ENDPOINT_ENABLED: 'true' },
    headers: adminHeader(),
  }));
  assert.equal(outcome.status, 404);
  assert.equal(outcome.nextCalled, false);
});

test('in development the endpoint is reachable directly, so an operator can use it locally', async () => {
  const outcome = await runGate({ env: { NODE_ENV: 'development', RAG_METRICS_REQUIRE_AUTH: undefined } });
  assert.equal(outcome.nextCalled, true);
  assert.equal(outcome.status, null);
});

test('a developer can opt into the production-like gate locally, and then gets the same 404', async () => {
  const outcome = await runGate({ env: { NODE_ENV: 'development', RAG_METRICS_REQUIRE_AUTH: 'true' }, headers: {} });
  assert.equal(outcome.status, 404);
  assert.equal(outcome.nextCalled, false);
});

/** Mounts the real ops router the same way server.js does. */
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
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

test('GET /api/ops/rag-metrics returns aggregates only -- and leaks no secret, prompt, or identity', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.OPENAI_API_KEY = 'sk-test-SENTINEL-VALUE-must-never-appear';
  process.env.NODE_ENV = 'development';

  const app = express();
  app.use('/api/ops', opsRoute);
  const { baseUrl, close } = await listen(app);

  try {
    const res = await request(baseUrl, '/api/ops/rag-metrics');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.success, true);

    assert.equal(typeof payload.data.requestTotal, 'number');
    assert.equal(payload.data.resetsOnRestart, true, 'the endpoint is explicit that this is not durable');
    assert.equal(typeof payload.data.counters, 'object');
    assert.equal(typeof payload.data.latencyByStage, 'object');
    assert.equal(typeof payload.data.costTable.version, 'string');
    assert.equal(typeof payload.data.dependencies.mongodb.status, 'string');
    assert.equal(payload.data.configuration.openAiConfigured, true, 'configuration reports only WHETHER a key exists');

    assert.equal(res.body.includes('SENTINEL'), false, 'the API key value itself must never be serialized');
    assert.equal(res.body.includes('sk-test'), false);
  } finally {
    await close();
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
  }
});

/** Stubs mongoose's own readyState without opening a connection. */
const withMongoReadyState = (readyState, fn) => {
  Object.defineProperty(mongoose.connection, 'readyState', { value: readyState, configurable: true });
  try { return fn(); } finally { delete mongoose.connection.readyState; }
};

test('dependency state reads already-tracked in-memory state -- never a live billable probe', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key';
  try {
    const snapshot = withMongoReadyState(1, () => getDependencySnapshot());
    assert.equal(snapshot.mongodb.status, 'ready');
    assert.equal(snapshot.mongodb.detail, 'connected');
    assert.equal(snapshot.openai.status, 'ready');
    assert.equal(snapshot.localRetrieval.status, 'ready');
    assert.equal(summarizeReadiness(snapshot), 'ready');
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('a connecting MongoDB is degraded, and a disconnected one unavailable -- both propagate to retrieval', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-key';
  try {
    const connecting = withMongoReadyState(2, () => getDependencySnapshot());
    assert.equal(connecting.mongodb.status, 'degraded');
    assert.equal(summarizeReadiness(connecting), 'degraded');

    const down = withMongoReadyState(0, () => getDependencySnapshot());
    assert.equal(down.mongodb.status, 'unavailable');
    assert.equal(down.localRetrieval.status, 'unavailable', 'retrieval reads chunks through MongoDB, so it cannot be ready without it');
    assert.equal(summarizeReadiness(down), 'unavailable');
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('a missing OpenAI key is reported as unavailable without ever calling the provider', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const snapshot = withMongoReadyState(1, () => getDependencySnapshot());
    assert.equal(snapshot.openai.status, 'unavailable');
    assert.equal(snapshot.openai.required, true);
    assert.equal(summarizeReadiness(snapshot), 'unavailable');
  } finally {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
  }
});

test('an unconfigured OPTIONAL dependency never drags the overall verdict down', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalVector = process.env.VECTOR_SEARCH_ENABLED;
  process.env.OPENAI_API_KEY = 'sk-test-key';
  delete process.env.VECTOR_SEARCH_ENABLED;
  try {
    const snapshot = withMongoReadyState(1, () => getDependencySnapshot());
    assert.equal(snapshot.atlasVectorSearch.status, 'not_configured');
    assert.equal(snapshot.atlasVectorSearch.required, false);
    assert.equal(summarizeReadiness(snapshot), 'ready', 'Atlas being unconfigured must never make the system look unready');
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalVector === undefined) delete process.env.VECTOR_SEARCH_ENABLED; else process.env.VECTOR_SEARCH_ENABLED = originalVector;
  }
});

test('every dependency declares a status from the published vocabulary and whether it is required', () => {
  const snapshot = withMongoReadyState(1, () => getDependencySnapshot());
  for (const [name, dependency] of Object.entries(snapshot)) {
    assert.equal(['ready', 'degraded', 'unavailable', 'not_configured'].includes(dependency.status), true, `${name} has a known status`);
    assert.equal(typeof dependency.required, 'boolean', `${name} declares whether it is required`);
    assert.equal(typeof dependency.detail, 'string');
  }
});
