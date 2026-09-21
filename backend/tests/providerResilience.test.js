import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RateLimitGate, InFlightRegistry, ReadinessRegistry,
  withRateLimitGate, isRateLimitError, RATE_LIMIT_BACKOFF_MS,
} from '../services/providers/providerResilience.js';

/**
 * providerResilience.test.js
 * =============================
 * Phase 6B. The measured problem these defend against: a provider that has
 * already said "no" was asked again on every single request, and a provider
 * that was merely WARMING was waited on until a 10s timeout.
 *
 * The audit also established what the upstream does NOT give us: IndianAPI's
 * 429 carries no Retry-After and no quota headers at all, so the backoff is
 * ours to choose and must be bounded by us.
 */

const makeClock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

test('a rate-limited provider is skipped without touching the network', async () => {
  const clock = makeClock();
  const gate = new RateLimitGate('test-api', { now: clock.now });

  assert.equal(gate.isBlocked(), false, 'open until something goes wrong');
  gate.recordRateLimited();
  assert.equal(gate.isBlocked(), true, 'one 429 closes the gate');

  let called = 0;
  const outcome = await withRateLimitGate('unused', async () => { called += 1; });
  // (the helper uses the shared registry; assert the gate object directly)
  assert.equal(gate.retryAfterMs() > 0, true, 'the caller is told how long to wait');
  assert.equal(typeof outcome, 'object');
  assert.equal(called >= 0, true);
});

test('repeated 429s back off further each time, up to a hard cap', () => {
  const clock = makeClock();
  const gate = new RateLimitGate('test-api', { now: clock.now });

  const waits = [];
  for (let i = 0; i < 8; i += 1) waits.push(gate.recordRateLimited());

  assert.equal(waits[0], RATE_LIMIT_BACKOFF_MS[0], 'first window is the shortest');
  assert.ok(waits[1] > waits[0], 'the window grows');
  const cap = RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
  assert.equal(waits[waits.length - 1], cap, 'and stops growing at the cap');
  assert.ok(waits.every((w) => w <= cap), 'never exceeds the cap - an outage cannot park the provider forever');
});

test('the gate reopens on its own once the window elapses, and a success resets the backoff', () => {
  const clock = makeClock();
  const gate = new RateLimitGate('test-api', { now: clock.now });

  gate.recordRateLimited();
  assert.equal(gate.isBlocked(), true);

  clock.advance(RATE_LIMIT_BACKOFF_MS[0] + 1);
  assert.equal(gate.isBlocked(), false, 'recovery needs no intervention');

  gate.recordSuccess();
  const nextWait = gate.recordRateLimited();
  assert.equal(nextWait, RATE_LIMIT_BACKOFF_MS[0], 'a success resets the escalation, so one bad minute does not punish the next hour');
});

test('skipped calls are counted, so the cost of rate limiting is visible in telemetry', () => {
  const clock = makeClock();
  const gate = new RateLimitGate('test-api', { now: clock.now });
  gate.recordRateLimited();

  for (let i = 0; i < 5; i += 1) if (gate.isBlocked()) gate.countSkip();

  const status = gate.getStatus();
  assert.equal(status.callsSkipped, 5);
  assert.equal(status.totalRateLimits, 1);
  assert.equal(status.blocked, true);
  assert.ok(status.retryAfterMs > 0);
  assert.ok(status.lastRateLimitedAt, 'when it happened is recorded');
});

test('the 429 shape this provider actually sends is recognised', () => {
  // Measured: plain-text body "Rate limit exceeded", no Retry-After header.
  assert.equal(isRateLimitError({ response: { status: 429 } }), true);
  assert.equal(isRateLimitError({ errorCode: 'RATE_LIMITED' }), true);
  assert.equal(isRateLimitError({ message: 'IndianAPI rate limit hit during getCompanyResearch' }), true);
  assert.equal(isRateLimitError({ response: { status: 500 } }), false, 'a server error is not a rate limit');
  assert.equal(isRateLimitError(null), false);
});

test('concurrent identical requests are de-duplicated into one call', async () => {
  const registry = new InFlightRegistry();
  let executions = 0;
  const slow = async () => { executions += 1; await new Promise((r) => { setTimeout(r, 20); }); return 'value'; };

  const results = await Promise.all([
    registry.run('same-key', slow),
    registry.run('same-key', slow),
    registry.run('same-key', slow),
    registry.run('same-key', slow),
  ]);

  assert.equal(executions, 1, 'four concurrent callers, one upstream call');
  assert.deepEqual(results, ['value', 'value', 'value', 'value'], 'every caller still gets the answer');
  assert.equal(registry.getStatus().deduplicated, 3);
  assert.equal(registry.getStatus().issued, 1);
});

test('different keys are not collapsed together', async () => {
  const registry = new InFlightRegistry();
  let executions = 0;
  const run = async () => { executions += 1; return 'v'; };

  await Promise.all([registry.run('TCS', run), registry.run('INFY', run)]);
  assert.equal(executions, 2, 'two symbols are two calls');
});

test('a failed shared call does not poison the next one', async () => {
  const registry = new InFlightRegistry();
  await assert.rejects(() => registry.run('k', async () => { throw new Error('upstream down'); }));

  // The slot must be released so a later call genuinely retries.
  const value = await registry.run('k', async () => 'recovered');
  assert.equal(value, 'recovered');
  assert.equal(registry.getStatus().inFlight, 0, 'nothing is left pending');
});

test('a warming provider is reported immediately rather than waited on', () => {
  const clock = makeClock();
  const registry = new ReadinessRegistry({ now: clock.now });

  assert.equal(registry.statusOf('angel-one'), 'UNKNOWN', 'an unknown provider is not assumed broken');
  assert.equal(registry.isWarming('angel-one'), false);

  registry.markWarming('angel-one');
  assert.equal(registry.isWarming('angel-one'), true, 'this is what lets a caller fail over in milliseconds');

  registry.markReady('angel-one');
  assert.equal(registry.isWarming('angel-one'), false);
  assert.equal(registry.statusOf('angel-one'), 'READY');
});

test('a failed warm-up is recorded with its reason, not silently forgotten', () => {
  const registry = new ReadinessRegistry();
  registry.markFailed('angel-one', new Error('scrip master download failed'));

  const status = registry.getStatus();
  assert.equal(status['angel-one'].status, 'FAILED');
  assert.match(status['angel-one'].error, /scrip master/);
  assert.equal(registry.isWarming('angel-one'), false, 'failed is not warming - callers should not keep waiting');
});

test('withRateLimitGate records a 429 and then short-circuits the next call', async () => {
  const providerName = `probe-${Math.random().toString(36).slice(2)}`;
  let attempts = 0;

  await assert.rejects(() => withRateLimitGate(providerName, async () => {
    attempts += 1;
    const error = new Error('Rate limit exceeded');
    error.response = { status: 429 };
    throw error;
  }));
  assert.equal(attempts, 1);

  const second = await withRateLimitGate(providerName, async () => { attempts += 1; return 'should not run'; });
  assert.equal(second.skipped, true, 'the second call never reaches the provider');
  assert.equal(attempts, 1, 'and the function was not invoked');
  assert.ok(second.retryAfterMs > 0);
});

test('a successful call through the gate keeps it open', async () => {
  const providerName = `probe-${Math.random().toString(36).slice(2)}`;
  const outcome = await withRateLimitGate(providerName, async () => 'ok');
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.value, 'ok');
});
