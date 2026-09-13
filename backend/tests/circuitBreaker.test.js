import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderCircuitBreaker, isBreakerCountedFailure, CIRCUIT_STATE, getProviderBreaker, __resetAllBreakersForTests } from '../graph/tools/circuitBreaker.js';

test('isBreakerCountedFailure counts timeout, rate-limiting, network failure, and upstream 5xx/unavailable', () => {
  assert.equal(isBreakerCountedFailure({ errorCode: 'TIMEOUT' }), true);
  assert.equal(isBreakerCountedFailure({ errorCode: 'RATE_LIMITED' }), true);
  assert.equal(isBreakerCountedFailure({ errorCode: 'NETWORK_ERROR' }), true);
  assert.equal(isBreakerCountedFailure({ errorCode: 'UPSTREAM_UNAVAILABLE' }), true);
  assert.equal(isBreakerCountedFailure({ httpStatus: 503 }), true);
  assert.equal(isBreakerCountedFailure({ httpStatus: 500 }), true);
});

test('isBreakerCountedFailure never counts cancellation, invalid symbol, empty result, auth rejection, validation error, or unsupported capability', () => {
  assert.equal(isBreakerCountedFailure({ cancelled: true, errorCode: 'TIMEOUT' }), false, 'a cancellation is never counted, even if the underlying error also looks like a timeout');
  assert.equal(isBreakerCountedFailure({ errorCode: 'NOT_FOUND' }), false, 'invalid/unknown symbol');
  assert.equal(isBreakerCountedFailure({ errorCode: null }), false, 'empty result (no error at all)');
  assert.equal(isBreakerCountedFailure({ errorCode: 'AUTHENTICATION_ERROR' }), false);
  assert.equal(isBreakerCountedFailure({ errorCode: 'VALIDATION_ERROR' }), false);
  assert.equal(isBreakerCountedFailure({ errorCode: 'UNSUPPORTED_CAPABILITY' }), false);
  assert.equal(isBreakerCountedFailure({ httpStatus: 401 }), false);
  assert.equal(isBreakerCountedFailure({ httpStatus: 404 }), false);
});

test('CLOSED -> OPEN after the failure threshold is reached', () => {
  let now = 0;
  const breaker = new ProviderCircuitBreaker('test-provider', { failureThreshold: 3, cooldownMs: 10000, now: () => now });
  assert.equal(breaker.getState(), CIRCUIT_STATE.CLOSED);
  breaker.recordOutcome({ errorCode: 'TIMEOUT' });
  breaker.recordOutcome({ errorCode: 'TIMEOUT' });
  assert.equal(breaker.getState(), CIRCUIT_STATE.CLOSED, 'below threshold, still closed');
  breaker.recordOutcome({ errorCode: 'TIMEOUT' });
  assert.equal(breaker.getState(), CIRCUIT_STATE.OPEN);
});

test('a non-counted failure (e.g. an invalid symbol) never moves the breaker toward OPEN', () => {
  let now = 0;
  const breaker = new ProviderCircuitBreaker('test-provider', { failureThreshold: 2, cooldownMs: 10000, now: () => now });
  breaker.recordOutcome({ errorCode: 'NOT_FOUND' });
  breaker.recordOutcome({ errorCode: 'NOT_FOUND' });
  breaker.recordOutcome({ errorCode: 'NOT_FOUND' });
  assert.equal(breaker.getState(), CIRCUIT_STATE.CLOSED);
});

test('OPEN blocks canAttempt() until the cooldown elapses, then becomes HALF_OPEN', () => {
  let now = 0;
  const breaker = new ProviderCircuitBreaker('test-provider', { failureThreshold: 1, cooldownMs: 5000, now: () => now });
  breaker.recordOutcome({ errorCode: 'TIMEOUT' });
  assert.equal(breaker.getState(), CIRCUIT_STATE.OPEN);
  assert.equal(breaker.canAttempt(), false);

  now = 4999;
  assert.equal(breaker.getState(), CIRCUIT_STATE.OPEN, 'cooldown not yet elapsed');

  now = 5000;
  assert.equal(breaker.getState(), CIRCUIT_STATE.HALF_OPEN);
  assert.equal(breaker.canAttempt(), true);
});

test('a successful HALF_OPEN trial closes the breaker and resets the failure counter', () => {
  let now = 0;
  const breaker = new ProviderCircuitBreaker('test-provider', { failureThreshold: 1, cooldownMs: 1000, now: () => now });
  breaker.recordOutcome({ errorCode: 'TIMEOUT' });
  now = 1000;
  assert.equal(breaker.getState(), CIRCUIT_STATE.HALF_OPEN);
  breaker.recordSuccess();
  assert.equal(breaker.getState(), CIRCUIT_STATE.CLOSED);
  assert.equal(breaker.getDiagnostics().consecutiveFailures, 0);
});

test('a failed HALF_OPEN trial re-opens the breaker immediately (does not need to re-accumulate the threshold)', () => {
  let now = 0;
  const breaker = new ProviderCircuitBreaker('test-provider', { failureThreshold: 5, cooldownMs: 1000, now: () => now });
  for (let i = 0; i < 5; i += 1) breaker.recordOutcome({ errorCode: 'TIMEOUT' });
  assert.equal(breaker.getState(), CIRCUIT_STATE.OPEN);
  now = 1000;
  assert.equal(breaker.getState(), CIRCUIT_STATE.HALF_OPEN);
  breaker.recordOutcome({ errorCode: 'TIMEOUT' });
  assert.equal(breaker.getState(), CIRCUIT_STATE.OPEN, 're-opened on the very next failure, not after 5 more');
});

test('getDiagnostics never includes a secret or raw payload -- only provider name, state, and a count', () => {
  const breaker = new ProviderCircuitBreaker('angel-one');
  const diag = breaker.getDiagnostics();
  assert.deepEqual(Object.keys(diag).sort(), ['consecutiveFailures', 'provider', 'state']);
});

test('getProviderBreaker returns the SAME instance for the same provider name (one breaker per provider, not per call)', () => {
  __resetAllBreakersForTests();
  const a = getProviderBreaker('indian-api');
  const b = getProviderBreaker('indian-api');
  assert.equal(a, b);
});

test('one provider opening does not affect a different provider\'s breaker', () => {
  __resetAllBreakersForTests();
  const angelOne = getProviderBreaker('angel-one', { failureThreshold: 1, cooldownMs: 10000 });
  const indianApi = getProviderBreaker('indian-api', { failureThreshold: 1, cooldownMs: 10000 });
  angelOne.recordOutcome({ errorCode: 'TIMEOUT' });
  assert.equal(angelOne.getState(), CIRCUIT_STATE.OPEN);
  assert.equal(indianApi.getState(), CIRCUIT_STATE.CLOSED, 'an unrelated provider must never be disabled by this one opening');
});
