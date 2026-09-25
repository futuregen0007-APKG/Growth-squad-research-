import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import {
  buildRedisClientOptions,
  describeRedisTarget,
  redisReconnectStrategy,
  initializeRedis,
  getRedisClient,
  getCache,
  setCache,
  closeRedis,
} from '../utils/redisClient.js';

/**
 * redisClientOptions.test.js
 * ============================
 * Production bug: Render's REDIS_URL was never read, and the old top-level
 * host/port/db options are ignored by node-redis v4, so every deployment
 * connected to localhost:6379 and /ready reported redis: unavailable. These
 * tests build REAL createClient instances (construction does no network
 * I/O) and assert on the options node-redis actually resolved, not just on
 * what this module intended to pass.
 */

const resolve = (env) => createClient(buildRedisClientOptions(env)).options;

const REDIS_ENV_KEYS = ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_DB'];
const withRedisEnv = async (env, fn) => {
  const saved = Object.fromEntries(REDIS_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of REDIS_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of REDIS_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

const captureConsole = async (fn) => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const lines = [];
  for (const m of methods) console[m] = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    for (const m of methods) console[m] = originals[m];
  }
  return lines.join('\n');
};

test('a Render-style internal REDIS_URL resolves to that host and port, not localhost', () => {
  const o = resolve({ REDIS_URL: 'redis://red-abc123xyz:6379' });
  assert.equal(o.socket.host, 'red-abc123xyz');
  assert.equal(o.socket.port, 6379);
  assert.ok(!o.socket.tls, 'a redis:// url must not enable TLS');
});

test('the URL path keeps the bounded reconnect strategy and the connect timeout', () => {
  const o = resolve({ REDIS_URL: 'redis://red-abc123xyz:6379' });
  assert.equal(o.socket.connectTimeout, 2000);
  assert.equal(o.socket.reconnectStrategy, redisReconnectStrategy);
});

test('rediss:// enables TLS and its username, password and database are honored', () => {
  const o = resolve({ REDIS_URL: 'rediss://default:test-secret-pw@kv.example.com:6380/2' });
  assert.equal(o.socket.host, 'kv.example.com');
  assert.equal(o.socket.port, 6380);
  assert.equal(o.socket.tls, true);
  assert.equal(o.username, 'default');
  assert.equal(o.password, 'test-secret-pw');
  assert.equal(o.database, 2);
});

test('REDIS_URL takes precedence over REDIS_HOST / REDIS_PORT', () => {
  const o = resolve({ REDIS_URL: 'redis://red-abc123xyz:6379', REDIS_HOST: 'other-host', REDIS_PORT: '1111' });
  assert.equal(o.socket.host, 'red-abc123xyz');
  assert.equal(o.socket.port, 6379);
});

test('with nothing configured it falls back to a local Docker Redis: localhost:6379, no password, database 0', () => {
  const o = resolve({});
  assert.equal(o.socket.host, 'localhost');
  assert.equal(o.socket.port, 6379);
  assert.equal(o.password, undefined);
  assert.ok(!o.database);
});

test('a blank REDIS_URL (an empty variable on a host) falls back instead of failing', () => {
  const o = resolve({ REDIS_URL: '   ' });
  assert.equal(o.socket.host, 'localhost');
  assert.equal(o.socket.port, 6379);
});

test('REDIS_HOST / PORT / PASSWORD / DB are applied where node-redis v4 actually reads them', () => {
  const o = resolve({ REDIS_HOST: 'cache.internal', REDIS_PORT: '6390', REDIS_PASSWORD: 'test-legacy-pw', REDIS_DB: '3' });
  assert.equal(o.socket.host, 'cache.internal');
  assert.equal(o.socket.port, 6390);
  assert.equal(o.password, 'test-legacy-pw');
  assert.equal(o.database, 3);
});

test('an invalid REDIS_URL is rejected with a message that never echoes the value', () => {
  for (const bad of ['not a url test-secret-pw', 'http://user:test-secret-pw@host:6379', 'redis//user:test-secret-pw@host']) {
    assert.throws(
      () => buildRedisClientOptions({ REDIS_URL: bad }),
      (error) => /REDIS_URL/.test(error.message) && !error.message.includes('test-secret-pw'),
    );
  }
});

test('describeRedisTarget never includes credentials', () => {
  const described = describeRedisTarget(buildRedisClientOptions({ REDIS_URL: 'rediss://default:test-secret-pw@kv.example.com:6380/2' }));
  assert.equal(described, 'rediss://kv.example.com:6380');
  assert.ok(!described.includes('test-secret-pw') && !described.includes('default'));
  assert.equal(describeRedisTarget(buildRedisClientOptions({ REDIS_HOST: 'cache.internal', REDIS_PORT: '6390', REDIS_PASSWORD: 'test-legacy-pw' })), 'redis://cache.internal:6390');
});

test('reconnection is bounded: increasing delays capped at 3s, then it gives up with an Error', () => {
  const delays = [];
  for (let retries = 0; retries < 10; retries += 1) delays.push(redisReconnectStrategy(retries));
  assert.deepEqual(delays, [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]);
  assert.ok(delays.every((d) => d <= 3000));
  assert.ok(redisReconnectStrategy(10) instanceof Error, 'must stop retrying after the bound');
  assert.ok(redisReconnectStrategy(500) instanceof Error);
});

test('with no Redis reachable, startup degrades to a null client and cache calls are harmless no-ops', async () => {
  await withRedisEnv({ REDIS_URL: 'redis://127.0.0.1:1' }, async () => {
    const client = await initializeRedis();
    assert.equal(client, null);
    assert.equal(getRedisClient(), null);
    assert.equal(await getCache('stock:TEST'), null);
    await assert.doesNotReject(setCache('stock:TEST', { price: 1 }, 20));
  });
  await closeRedis();
});

test('an invalid REDIS_URL also degrades gracefully and no log line contains the URL credentials', async () => {
  await withRedisEnv({ REDIS_URL: 'http://user:test-secret-pw@host:6379' }, async () => {
    let client;
    const output = await captureConsole(async () => { client = await initializeRedis(); });
    assert.equal(client, null);
    assert.equal(getRedisClient(), null);
    assert.ok(!output.includes('test-secret-pw'), 'credentials must never be logged');
    assert.match(output, /REDIS_URL is not a valid/);
  });
});

test('a failed connect to a credentialed URL never logs the credentials, and reports the real socket error', async () => {
  await withRedisEnv({ REDIS_URL: 'redis://default:test-secret-pw@127.0.0.1:1' }, async () => {
    let client;
    const output = await captureConsole(async () => { client = await initializeRedis(); });
    assert.equal(client, null);
    assert.ok(!output.includes('test-secret-pw'), 'credentials must never be logged');
    assert.match(output, /Redis: connecting to redis:\/\/127\.0\.0\.1:1\b/);
    assert.match(output, /Redis not available: Redis connection timed out \(last socket error: .+\)/);
  });
  await closeRedis();
});
