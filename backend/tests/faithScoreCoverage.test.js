import test from 'node:test';
import assert from 'node:assert/strict';

import { computeFaithScoreCoverage } from '../services/CuratedEarningsIntelligenceService.js';

const record = (targetPeriod, status, confidence = 0.9) => ({
  promise: { targetPeriod },
  outcome: { status },
  verification: { evidenceConfidence: confidence },
});

test('zero records and RESEARCH_PENDING coverage status yields scoreStatus RESEARCH_PENDING', () => {
  const result = computeFaithScoreCoverage([], { coverageStatus: 'RESEARCH_PENDING' });
  assert.equal(result.scoreStatus, 'RESEARCH_PENDING');
  assert.equal(result.confidence, 'LOW');
});

test('zero records but coverage is not RESEARCH_PENDING yields NO_OFFICIAL_TRANSCRIPT', () => {
  const result = computeFaithScoreCoverage([], { coverageStatus: 'PARTIAL' });
  assert.equal(result.scoreStatus, 'NO_OFFICIAL_TRANSCRIPT');
});

test('fewer than 3 resolved promises yields INSUFFICIENT_EVIDENCE, never a numeric implication', () => {
  const records = [record('FY2025', 'ACHIEVED'), record('FY2024', 'PENDING')];
  const result = computeFaithScoreCoverage(records, { coverageStatus: 'PARTIAL' });
  assert.equal(result.scoreStatus, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.promisesResolved, 1);
});

test('>=3 resolved promises but fewer than 10 or fewer than 8 quarters yields PROVISIONAL, confidence MEDIUM', () => {
  const records = [record('FY2025', 'ACHIEVED'), record('FY2024', 'PARTIAL'), record('FY2023', 'MISSED')];
  const result = computeFaithScoreCoverage(records, { coverageStatus: 'PARTIAL' });
  assert.equal(result.scoreStatus, 'PROVISIONAL');
  assert.equal(result.confidence, 'MEDIUM');
  assert.equal(result.completedQuarters, 12, 'each full-FY period counts as covering all 4 of its quarters');
});

test('>=10 resolved promises spanning >=8 distinct quarters yields VERIFIED, confidence HIGH', () => {
  const records = [
    record('Q1 FY2022', 'ACHIEVED'), record('Q2 FY2022', 'ACHIEVED'), record('Q3 FY2022', 'ACHIEVED'), record('Q4 FY2022', 'ACHIEVED'),
    record('Q1 FY2023', 'ACHIEVED'), record('Q2 FY2023', 'ACHIEVED'), record('Q3 FY2023', 'ACHIEVED'), record('Q4 FY2023', 'ACHIEVED'),
    record('Q1 FY2024', 'PARTIAL'), record('Q2 FY2024', 'MISSED'),
  ];
  const result = computeFaithScoreCoverage(records, { coverageStatus: 'PARTIAL' });
  assert.equal(result.promisesResolved, 10);
  assert.equal(result.completedQuarters, 10);
  assert.equal(result.scoreStatus, 'VERIFIED');
  assert.equal(result.confidence, 'HIGH');
});

test('a researchFailed signal overrides everything else to RESEARCH_FAILED', () => {
  const records = [record('FY2025', 'ACHIEVED'), record('FY2024', 'ACHIEVED'), record('FY2023', 'ACHIEVED')];
  const result = computeFaithScoreCoverage(records, { coverageStatus: 'PARTIAL', researchFailed: true });
  assert.equal(result.scoreStatus, 'RESEARCH_FAILED');
});

test('PENDING promises count toward promisesTotal and the pending breakdown, but never toward promisesResolved or quarter coverage', () => {
  const records = [record('FY2025', 'ACHIEVED'), record('FY2024', 'ACHIEVED'), record('FY2023', 'ACHIEVED'), record('FY2026', 'PENDING')];
  const result = computeFaithScoreCoverage(records, { coverageStatus: 'PARTIAL' });
  assert.equal(result.promisesTotal, 4);
  assert.equal(result.promisesResolved, 3);
  assert.equal(result.pending, 1);
  assert.equal(result.completedQuarters, 12, 'the PENDING FY2026 record must not contribute any quarter to coverage');
});

test('missingQuarters is the gap to the fixed 20-quarter (5-year) expectation', () => {
  const records = [record('FY2025', 'ACHIEVED'), record('FY2024', 'ACHIEVED'), record('FY2023', 'ACHIEVED')];
  const result = computeFaithScoreCoverage(records, { coverageStatus: 'PARTIAL' });
  assert.equal(result.expectedQuarters, 20);
  assert.equal(result.missingQuarters, 20 - 12);
});
