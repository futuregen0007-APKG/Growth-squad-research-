import test from 'node:test';
import assert from 'node:assert/strict';
import { routeAfterValidation } from '../graph/graph.js';

const VALID_NODES = new Set(['publishFinalAnswer', 'repairAnswer', 'buildSafeFallback']);

// Required test 25: all graph routes terminate (every combination this
// router can see maps to a real, valid next node — never undefined,
// never a value that isn't one of the three real node names).
test('required test 25: every validationStatus x repairCount combination routes to a real node', () => {
  const statuses = ['PASSED', 'REPAIR_REQUIRED', 'FAILED_SAFE', 'SKIPPED_GENERAL_EDUCATION', 'ABSTAINED', null, undefined];
  const repairCounts = [0, 1, 2, undefined];
  for (const validationStatus of statuses) {
    for (const repairCount of repairCounts) {
      const next = routeAfterValidation({ validationStatus, repairCount });
      assert.ok(VALID_NODES.has(next), `validationStatus=${validationStatus}, repairCount=${repairCount} routed to invalid node "${next}"`);
    }
  }
});

test('PASSED always routes to publishFinalAnswer regardless of repairCount', () => {
  assert.equal(routeAfterValidation({ validationStatus: 'PASSED', repairCount: 0 }), 'publishFinalAnswer');
  assert.equal(routeAfterValidation({ validationStatus: 'PASSED', repairCount: 1 }), 'publishFinalAnswer');
});

test('SKIPPED_GENERAL_EDUCATION always routes to publishFinalAnswer', () => {
  assert.equal(routeAfterValidation({ validationStatus: 'SKIPPED_GENERAL_EDUCATION', repairCount: 0 }), 'publishFinalAnswer');
});

test('REPAIR_REQUIRED with no repair spent yet routes to repairAnswer', () => {
  assert.equal(routeAfterValidation({ validationStatus: 'REPAIR_REQUIRED', repairCount: 0 }), 'repairAnswer');
});

// Required test 14: second repair is impossible
test('required test 14: REPAIR_REQUIRED with a repair already spent (repairCount >= 1) NEVER routes to repairAnswer again', () => {
  assert.equal(routeAfterValidation({ validationStatus: 'REPAIR_REQUIRED', repairCount: 1 }), 'buildSafeFallback');
  assert.equal(routeAfterValidation({ validationStatus: 'REPAIR_REQUIRED', repairCount: 2 }), 'buildSafeFallback');
});

test('FAILED_SAFE always routes to buildSafeFallback, regardless of repairCount', () => {
  assert.equal(routeAfterValidation({ validationStatus: 'FAILED_SAFE', repairCount: 0 }), 'buildSafeFallback');
  assert.equal(routeAfterValidation({ validationStatus: 'FAILED_SAFE', repairCount: 1 }), 'buildSafeFallback');
});

test('an unrecognized/missing validationStatus fails closed to buildSafeFallback, never publishes by default', () => {
  assert.equal(routeAfterValidation({ validationStatus: undefined, repairCount: 0 }), 'buildSafeFallback');
  assert.equal(routeAfterValidation({}), 'buildSafeFallback');
});
