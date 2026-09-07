import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCompanyExecutionScore } from '../services/ExecutionScoreService.js';
import { calculateReliability, isResearchRunCacheable } from '../services/ManagementPromiseService.js';

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