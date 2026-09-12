import test from 'node:test';
import assert from 'node:assert/strict';
import { livenessHandler, createReadinessHandler, mongoStateLabel } from '../utils/healthHandlers.js';

/** A minimal fake Express response that records what was sent, without needing a real HTTP server. */
const makeFakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

test('livenessHandler responds 200 immediately, independent of any dependency', () => {
  const res = makeFakeRes();
  livenessHandler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 'ok');
  assert.equal(typeof res.body.uptime, 'number');
});

test('mongoStateLabel maps every mongoose readyState to a human label, and an unknown code to "unknown"', () => {
  assert.equal(mongoStateLabel(0), 'disconnected');
  assert.equal(mongoStateLabel(1), 'connected');
  assert.equal(mongoStateLabel(2), 'connecting');
  assert.equal(mongoStateLabel(3), 'disconnecting');
  assert.equal(mongoStateLabel(99), 'unknown');
});

test('readiness reports 200/ready once Mongo is connected, regardless of Redis', () => {
  const handler = createReadinessHandler({
    getMongoReadyState: () => 1,
    mongoAttempted: () => true,
    getMongoLastError: () => null,
    getRedisClient: () => null,
  });
  const res = makeFakeRes();
  handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 'ready');
  assert.equal(res.body.mongo, 'connected');
  assert.equal(res.body.redis, 'unavailable');
});

test('readiness reports 503/starting while Mongo is still connecting, and surfaces the last error', () => {
  const handler = createReadinessHandler({
    getMongoReadyState: () => 2,
    mongoAttempted: () => true,
    getMongoLastError: () => 'connection timed out',
    getRedisClient: () => null,
  });
  const res = makeFakeRes();
  handler({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.status, 'starting');
  assert.equal(res.body.mongo, 'connecting');
  assert.equal(res.body.mongoLastError, 'connection timed out');
});

test('readiness reports redis "connected" only when the client reports isOpen, and never lets a redis-lookup throw crash the check', () => {
  const handlerOpen = createReadinessHandler({
    getMongoReadyState: () => 1,
    getRedisClient: () => ({ isOpen: true }),
  });
  const resOpen = makeFakeRes();
  handlerOpen({}, resOpen);
  assert.equal(resOpen.body.redis, 'connected');

  const handlerThrows = createReadinessHandler({
    getMongoReadyState: () => 1,
    getRedisClient: () => { throw new Error('client not initialized'); },
  });
  const resThrows = makeFakeRes();
  assert.doesNotThrow(() => handlerThrows({}, resThrows));
  assert.equal(resThrows.statusCode, 200);
  assert.equal(resThrows.body.redis, 'unavailable');
});

test('readiness never reports ready:true when Mongo has never been connected (readyState 0, mongoAttempted false)', () => {
  const handler = createReadinessHandler({
    getMongoReadyState: () => 0,
    mongoAttempted: () => false,
    getRedisClient: () => null,
  });
  const res = makeFakeRes();
  handler({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.mongoAttempted, false);
});
