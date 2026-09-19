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

// ---------------------------------------------------------------------------
// Phase 4F.1 Part 5: unified canonical metric taxonomy -- normalizeMetric is
// the ONE mapping layer for both free-text (chunk annotation) input and
// ManagementPromise's own UPPERCASE_ENUM `promise.metric` values (Earnings
// Intelligence records). Required test coverage: margin, attrition, revenue
// growth, capex, headcount/hiring, unknown metric, conflicting metric types.
// ---------------------------------------------------------------------------
test('canonical metric taxonomy: margin -- bare "margin" (free text or the MARGIN enum token) is deliberately ambiguous, never guessed', () => {
  assert.equal(normalizeMetric('margin').metricKey, null);
  assert.equal(normalizeMetric('margin').confidence, 'unresolved');
  assert.equal(normalizeMetric('MARGIN').metricKey, null, 'the bare ManagementPromise enum token MARGIN must resolve exactly like free-text "margin" -- ambiguous, not guessed');
});

test('canonical metric taxonomy: margin -- an UNAMBIGUOUS margin phrase/enum resolves to the correct distinct key', () => {
  assert.equal(normalizeMetric('operating margin').metricKey, 'operating_margin');
  assert.equal(normalizeMetric('EBITDA_MARGIN').metricKey, 'ebitda_margin');
  assert.equal(normalizeMetric('ebitda margin').metricKey, 'ebitda_margin');
  assert.notEqual(normalizeMetric('operating margin').metricKey, normalizeMetric('EBITDA_MARGIN').metricKey);
});

test('canonical metric taxonomy: attrition resolves via free text (the only form it currently appears in -- no ManagementPromise enum token exists for it, so an "OTHER"-categorized attrition promise honestly stays unresolved rather than being guessed)', () => {
  assert.equal(normalizeMetric('attrition').metricKey, 'attrition');
  assert.equal(normalizeMetric('Our attrition rate improved').metricKey, 'attrition');
  assert.equal(normalizeMetric('OTHER').metricKey, null, 'a generic OTHER category must never be guessed as attrition just because that is a common OTHER-categorized promise in practice');
});

test('canonical metric taxonomy: revenue growth resolves via both free text and the REVENUE_GROWTH enum token, and is never confused with bare "revenue"', () => {
  assert.equal(normalizeMetric('revenue growth').metricKey, 'revenue_growth');
  assert.equal(normalizeMetric('REVENUE_GROWTH').metricKey, 'revenue_growth');
  assert.equal(normalizeMetric('REVENUE').metricKey, 'revenue');
  assert.notEqual(normalizeMetric('REVENUE_GROWTH').metricKey, normalizeMetric('REVENUE').metricKey);
});

test('canonical metric taxonomy: capex resolves via both free text and the CAPEX enum token (previously had no canonical key at all)', () => {
  assert.equal(normalizeMetric('capex').metricKey, 'capex');
  assert.equal(normalizeMetric('CAPEX').metricKey, 'capex');
  assert.equal(normalizeMetric('planned capital expenditure for FY26').metricKey, 'capex');
});

test('canonical metric taxonomy: headcount/hiring resolves via free text and the EMPLOYEE_COUNT enum token', () => {
  assert.equal(normalizeMetric('headcount').metricKey, 'headcount');
  assert.equal(normalizeMetric('EMPLOYEE_COUNT').metricKey, 'headcount');
  assert.equal(normalizeMetric('planned hiring of 20,000 freshers').metricKey, 'headcount');
});

test('canonical metric taxonomy: an unknown/unsupported metric always resolves UNRESOLVED, never fuzzy-matched to the nearest known key', () => {
  const result = normalizeMetric('SOMETHING_NOBODY_HAS_EVER_ALIASED');
  assert.equal(result.metricKey, null);
  assert.equal(result.confidence, 'unresolved');
  assert.equal(result.reason, 'NO_KNOWN_METRIC_MATCHED');
});

test('canonical metric taxonomy: conflicting metric types in the same text -- two genuinely unrelated metrics both matching leaves the result ambiguous/unresolved rather than picking one', () => {
  const result = normalizeMetric('Both our capex plans and our headcount guidance were discussed on the call.');
  assert.equal(result.metricKey, null);
  assert.equal(result.confidence, 'unresolved');
  assert.match(result.reason, /^AMBIGUOUS_METRIC:/);
});
