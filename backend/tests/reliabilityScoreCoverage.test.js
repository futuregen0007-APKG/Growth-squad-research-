import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReliability } from '../services/ManagementPromiseService.js';

/**
 * Phase 10: the reliability score must not look misleadingly high when
 * evidence coverage is weak. calculateReliability already enforces a
 * >=3-verified-promises floor before it will produce a numeric score — this
 * test makes that guarantee explicit and regression-tested rather than
 * left implicit, per the instruction to add tests for existing scoring
 * behavior rather than silently trusting it.
 */

const promise = (overrides = {}) => ({
  dataOrigin: 'REAL_RESEARCH',
  promise: { promiseDate: new Date('2025-01-01'), importance: 'MEDIUM' },
  verification: { status: 'FULFILLED', confidence: 0.9 },
  ...overrides,
});

test('one verified promise among many unverified ones does not produce a high (or any) numeric score', () => {
  const promises = [
    promise({ verification: { status: 'FULFILLED', confidence: 0.9 } }),
    promise({ verification: { status: 'PENDING', confidence: null } }),
    promise({ verification: { status: 'PENDING', confidence: null } }),
    promise({ verification: { status: 'PENDING', confidence: null } }),
    promise({ verification: { status: 'PENDING', confidence: null } }),
  ];

  const reliability = calculateReliability(promises);
  assert.equal(reliability.score, null); // must not fabricate a "100% reliable" style score off one data point
  assert.equal(reliability.verifiedPromises, 1);
  assert.equal(reliability.totalPromises, 5);
  assert.equal(reliability.trend, 'INSUFFICIENT_DATA');
});

test('reliability distinguishes total promises, verified promises, and pending promises in its response shape', () => {
  const promises = [
    promise({ verification: { status: 'FULFILLED', confidence: 0.9 } }),
    promise({ verification: { status: 'MISSED', confidence: 0.9 } }),
    promise({ verification: { status: 'PARTIALLY_FULFILLED', confidence: 0.9 } }),
    promise({ verification: { status: 'PENDING', confidence: null } }),
    promise({ verification: { status: 'INSUFFICIENT_EVIDENCE', confidence: null } }),
  ];

  const reliability = calculateReliability(promises);
  assert.equal(reliability.totalPromises, 5);
  assert.equal(reliability.verifiedPromises, 3); // FULFILLED + MISSED + PARTIALLY_FULFILLED
  assert.equal(reliability.pending, 1);
  assert.ok(Number.isFinite(reliability.score));
});

test('a low-confidence verified promise (below 0.8) is excluded from the historical scoring pool', () => {
  const promises = [
    promise({ verification: { status: 'FULFILLED', confidence: 0.5 } }), // excluded — low confidence
    promise({ verification: { status: 'FULFILLED', confidence: 0.9 } }),
    promise({ verification: { status: 'MISSED', confidence: 0.9 } }),
    promise({ verification: { status: 'PARTIALLY_FULFILLED', confidence: 0.9 } }),
  ];

  const reliability = calculateReliability(promises);
  assert.equal(reliability.verifiedPromises, 3);
});
