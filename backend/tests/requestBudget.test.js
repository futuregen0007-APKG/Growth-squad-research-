import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTotalDeadlineMs, remainingMs, hasBudgetFor, boundedTimeout, MIN_DEADLINE_MS, MAX_DEADLINE_MS, DEFAULT_DEADLINE_MS,
} from '../graph/requestBudget.js';

test('resolveTotalDeadlineMs falls back to the default when CHAT_TOTAL_DEADLINE_MS is unset', () => {
  assert.equal(resolveTotalDeadlineMs({}), DEFAULT_DEADLINE_MS);
});

test('resolveTotalDeadlineMs falls back to the default for an invalid (non-numeric, zero, negative) value -- never throws', () => {
  assert.equal(resolveTotalDeadlineMs({ CHAT_TOTAL_DEADLINE_MS: 'not-a-number' }), DEFAULT_DEADLINE_MS);
  assert.equal(resolveTotalDeadlineMs({ CHAT_TOTAL_DEADLINE_MS: '0' }), DEFAULT_DEADLINE_MS);
  assert.equal(resolveTotalDeadlineMs({ CHAT_TOTAL_DEADLINE_MS: '-500' }), DEFAULT_DEADLINE_MS);
});

test('resolveTotalDeadlineMs clamps a too-low configured value up to MIN_DEADLINE_MS', () => {
  assert.equal(resolveTotalDeadlineMs({ CHAT_TOTAL_DEADLINE_MS: '100' }), MIN_DEADLINE_MS);
});

test('resolveTotalDeadlineMs clamps a too-high configured value down to MAX_DEADLINE_MS', () => {
  assert.equal(resolveTotalDeadlineMs({ CHAT_TOTAL_DEADLINE_MS: '999999' }), MAX_DEADLINE_MS);
});

test('resolveTotalDeadlineMs accepts a valid in-range value unchanged', () => {
  assert.equal(resolveTotalDeadlineMs({ CHAT_TOTAL_DEADLINE_MS: '30000' }), 30000);
});

test('remainingMs is Infinity when no deadline has been set (deadlineAt null) -- "no budget enforced" rather than "no budget at all"', () => {
  assert.equal(remainingMs(null), Infinity);
});

test('remainingMs computes wall-clock time left and never goes negative', () => {
  const now = 1_000_000;
  assert.equal(remainingMs(now + 5000, now), 5000);
  assert.equal(remainingMs(now - 5000, now), 0); // already past the deadline
});

test('hasBudgetFor is true only when at least the requested amount remains', () => {
  const now = 1_000_000;
  assert.equal(hasBudgetFor(now + 1000, 500, now), true);
  assert.equal(hasBudgetFor(now + 200, 500, now), false);
  assert.equal(hasBudgetFor(null, 500, now), true); // no deadline set at all
});

test('boundedTimeout never exceeds the natural ceiling, and shrinks to the remaining budget when that is smaller', () => {
  const now = 1_000_000;
  assert.equal(boundedTimeout(10000, now + 60000, now), 10000); // plenty of budget -- natural ceiling wins
  assert.equal(boundedTimeout(10000, now + 3000, now), 3000); // budget is the tighter constraint
  assert.equal(boundedTimeout(10000, now - 100, now), 0); // deadline already passed -- never negative
  assert.equal(boundedTimeout(10000, null, now), 10000); // no deadline set -- natural ceiling applies
});
