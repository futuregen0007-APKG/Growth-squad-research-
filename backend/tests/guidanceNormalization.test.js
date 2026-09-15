import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMetric, normalizeValue, inferGuidanceKind, normalizeGuidanceEvidence,
} from '../services/guidanceNormalization.js';

test('normalizeMetric maps "operating margin" and explicitly-aliased "EBIT margin" to the SAME metricKey', () => {
  assert.equal(normalizeMetric('operating margin guidance').metricKey, 'operating_margin');
  assert.equal(normalizeMetric('EBIT margin guidance').metricKey, 'operating_margin');
});

test('normalizeMetric NEVER equates EBITDA margin with operating margin', () => {
  assert.equal(normalizeMetric('ebitda margin guidance').metricKey, 'ebitda_margin');
  assert.notEqual(normalizeMetric('ebitda margin guidance').metricKey, normalizeMetric('operating margin guidance').metricKey);
});

test('normalizeMetric NEVER equates revenue with constant-currency revenue growth', () => {
  const revenue = normalizeMetric('revenue guidance for the year');
  const ccRevenue = normalizeMetric('constant currency revenue growth guidance');
  assert.notEqual(revenue.metricKey, ccRevenue.metricKey);
});

test('normalizeMetric returns unresolved for unknown/ambiguous metric text -- never guessed', () => {
  const result = normalizeMetric('something about the weather');
  assert.equal(result.metricKey, null);
  assert.equal(result.confidence, 'unresolved');
});

test('normalizeValue treats "21%-23%" and "21% to 23%" as the SAME safe range', () => {
  const a = normalizeValue('Guidance of 21%-23%.');
  const b = normalizeValue('Guidance of 21% to 23%.');
  assert.deepEqual({ lowerBound: a.lowerBound, upperBound: a.upperBound, unit: a.unit }, { lowerBound: b.lowerBound, upperBound: b.upperBound, unit: b.unit });
});

test('normalizeValue NEVER equates a percentage with a bare currency-magnitude figure', () => {
  const percent = normalizeValue('Guidance of 21%.');
  const crore = normalizeValue('Profit of ₹500 crore.');
  assert.notEqual(percent.unit, crore.unit);
});

test('normalizeValue returns unresolved for a number with no recognizable unit at all', () => {
  const result = normalizeValue('The number is 42.');
  assert.equal(result.confidence, 'unresolved');
});

test('inferGuidanceKind: a PROMISE_OUTCOME item is always "outcome", regardless of text', () => {
  assert.equal(inferGuidanceKind({ documentType: 'PROMISE_OUTCOME', text: 'nothing special here' }), 'outcome');
});

test('inferGuidanceKind: explicit revision language sets "revised"', () => {
  assert.equal(inferGuidanceKind({ documentType: 'MANAGEMENT_PROMISE', text: 'Management revised its FY2024 guidance downward.' }), 'revised');
});

test('inferGuidanceKind: plain guidance language with no revision marker is "original"', () => {
  assert.equal(inferGuidanceKind({ documentType: 'EARNINGS_CALL_TRANSCRIPT', text: 'We are targeting 21-23% operating margin.' }), 'original');
});

test('normalizeGuidanceEvidence never guesses a missing target fiscal year', () => {
  const record = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: null, fiscalQuarter: null, documentType: 'ANNUAL_REPORT', text: 'Operating margin guidance of 21%-23%.', publishedAt: '2023-01-01',
  });
  assert.equal(record.targetFiscalYear, null);
  assert.equal(record.confidence, 'unresolved');
  assert.match(record.reason, /MISSING_TARGET_FISCAL_YEAR/);
});

test('normalizeGuidanceEvidence NEVER treats a quarterly figure and an annual figure as the same target period', () => {
  const quarterly = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2023', fiscalQuarter: 'Q4', documentType: 'EARNINGS_CALL_TRANSCRIPT', text: 'Operating margin guidance of 21%-23%.', publishedAt: '2023-01-01',
  });
  const annual = normalizeGuidanceEvidence({
    evidenceId: 'E2', symbol: 'TCS', fiscalYear: 'FY2023', fiscalQuarter: null, documentType: 'EARNINGS_CALL_TRANSCRIPT', text: 'Operating margin guidance of 21%-23%.', publishedAt: '2023-02-01',
  });
  assert.notEqual(quarterly.targetQuarter, annual.targetQuarter);
});

test('normalizeGuidanceEvidence uses REAL structured Earnings Intelligence fields directly, never re-parsing text', () => {
  const record = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'INFY', fiscalYear: 'FY2023', fiscalQuarter: null, documentType: 'MANAGEMENT_PROMISE', text: 'some unrelated excerpt text', publishedAt: '2023-06-01',
  }, { structured: { metric: 'operating margin', targetValue: 22, targetUnit: 'PERCENTAGE', operator: 'EQ' } });
  assert.equal(record.metricKey, 'operating_margin');
  assert.equal(record.exactValue, 22);
  assert.equal(record.unit, 'PERCENTAGE');
  assert.equal(record.confidence, 'high');
});

test('normalizeGuidanceEvidence preserves the original evidence text unchanged', () => {
  const originalText = 'Operating margin guidance of 21%-23% for FY2023.';
  const record = normalizeGuidanceEvidence({
    evidenceId: 'E1', symbol: 'TCS', fiscalYear: 'FY2023', fiscalQuarter: null, documentType: 'ANNUAL_REPORT', text: originalText, publishedAt: '2023-01-01',
  });
  assert.equal(record.originalText, originalText);
});
