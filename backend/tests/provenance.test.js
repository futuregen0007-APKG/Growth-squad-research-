import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCompanyExecutionScore } from '../services/ExecutionScoreService.js';
import { calculateReliability, isResearchRunCacheable, isResearchRunStale } from '../services/ManagementPromiseService.js';

const verifiedPromise = (dataOrigin = 'REAL_RESEARCH') => ({
  dataOrigin,
  verification: { status: 'FULFILLED', achievementPercentage: 100, confidence: 0.95 },
  promise: { importance: 'HIGH', promiseDate: new Date() },
});

const verifiedFact = (dataOrigin = 'REAL_RESEARCH') => ({
  dataOrigin,
  period: 'FY2026',
  category: 'FINANCIAL_PERFORMANCE',
  metrics: { metric: 'REVENUE', actualValue: 1000 },
  title: 'Revenue',
  fact: 'Revenue was reported at 1000 Cr.',
});

test('seeded demo promises cannot contribute to reliability', () => {
  const result = calculateReliability([verifiedPromise('SEEDED_DEMO'), verifiedPromise('SEEDED_DEMO')]);
  assert.equal(result.verifiedPromises, 0);
  assert.equal(result.score, null);
});

test('seeded demo facts cannot contribute to execution score', () => {
  const result = calculateCompanyExecutionScore({
    facts: new Array(10).fill(null).map(() => verifiedFact('SEEDED_DEMO')),
    promises: [],
    profile: { sector: 'IT / Software' },
  });
  assert.equal(result.executionScore, null);
});

test('insufficient and seeded research runs are not cacheable', () => {
  const base = { status: 'COMPLETED', state: 'HISTORICAL_DATA_AVAILABLE', promisesVerified: 3, sourceStats: { documentsFound: 2 }, completedAt: new Date() };
  assert.equal(isResearchRunCacheable({ ...base, dataOrigin: 'SEEDED_DEMO' }), false);
  assert.equal(isResearchRunCacheable({ ...base, dataOrigin: 'REAL_RESEARCH', state: 'INSUFFICIENT_EVIDENCE' }), false);
  assert.equal(isResearchRunCacheable({ ...base, dataOrigin: 'REAL_RESEARCH' }), true);
});

// Regression: a real ResearchRun for HDFCBANK was found stuck at
// status:'RUNNING' since 2026-09-05 with no staleness detection anywhere,
// permanently blocking that company's Refresh button (createResearchJob
// unconditionally returned the same dead jobId forever). isResearchRunStale
// is the pure predicate that fixes this.
test('a fresh RUNNING research run is never treated as stale', () => {
  const now = Date.now();
  assert.equal(isResearchRunStale({ status: 'RUNNING', startedAt: new Date(now) }, now), false);
  assert.equal(isResearchRunStale({ status: 'RUNNING', startedAt: new Date(now - 5 * 60 * 1000) }, now), false); // 5 min ago
  assert.equal(isResearchRunStale({ status: 'RUNNING', startedAt: new Date(now - 29 * 60 * 1000) }, now), false); // just under the 30-min threshold
});

test('a RUNNING research run older than the staleness threshold is treated as orphaned', () => {
  const now = Date.now();
  assert.equal(isResearchRunStale({ status: 'RUNNING', startedAt: new Date(now - 31 * 60 * 1000) }, now), true); // just over 30 min
  assert.equal(isResearchRunStale({ status: 'RUNNING', startedAt: new Date(now - 6 * 24 * 60 * 60 * 1000) }, now), true); // the actual 6-day-old stuck run observed live
});

test('isResearchRunStale never flags a non-RUNNING run, regardless of age', () => {
  const now = Date.now();
  const ancientStartedAt = new Date(now - 10 * 24 * 60 * 60 * 1000);
  assert.equal(isResearchRunStale({ status: 'COMPLETED', startedAt: ancientStartedAt }, now), false);
  assert.equal(isResearchRunStale({ status: 'FAILED', startedAt: ancientStartedAt }, now), false);
  assert.equal(isResearchRunStale(null, now), false);
  assert.equal(isResearchRunStale({ status: 'RUNNING' }, now), false); // no startedAt at all -- never fabricate an age
});