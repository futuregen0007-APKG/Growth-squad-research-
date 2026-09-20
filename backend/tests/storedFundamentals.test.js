import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStoredFact, isDeltaFact, classifySector, resolveFactMetric,
  SECTOR_METRICS, SECTOR_KINDS, UNAVAILABLE_REASONS,
} from '../services/storedFundamentals.js';

/**
 * storedFundamentals.test.js
 * =============================
 * Phase 6A. These pin the guards that decide whether a stored number is
 * safe to show a user. Each one exists because the Phase 6A baseline audit
 * found a REAL fact in the live corpus that would have been displayed as
 * something it is not.
 *
 * The rule throughout: a fact that fails its contract is DROPPED, never
 * corrected, rescaled, or guessed at. "Not reported" is always safer than a
 * confident wrong number.
 */

test('a margin reported in crore is rejected -- it is an absolute figure, not a margin', () => {
  // Real: TCS "OPERATING_MARGIN" = 65799 INR_CRORE. Shown as a margin this
  // reads as a 65,799% operating margin.
  assert.equal(
    validateStoredFact({ metric: 'OPERATING_MARGIN', value: 65799, unit: 'INR_CRORE' }),
    'UNIT_NOT_PERCENTAGE',
  );
});

test('a revenue reported as a percentage is rejected -- it is a growth rate, not revenue', () => {
  // Real: INFY "REVENUE" = 4.4 PERCENTAGE.
  assert.equal(
    validateStoredFact({ metric: 'REVENUE', value: 4.4, unit: 'PERCENTAGE' }),
    'MAGNITUDE_REPORTED_AS_PERCENTAGE',
  );
});

test('EPS reported as a percentage is rejected -- EPS is a per-share amount', () => {
  // Real: TCS "EPS" = 11.2 PERCENTAGE.
  assert.equal(validateStoredFact({ metric: 'EPS', value: 11.2, unit: 'PERCENTAGE' }), 'UNIT_NOT_PERCENTAGE_EXPECTED');
  assert.equal(validateStoredFact({ metric: 'EPS', value: 29.64, unit: 'INR' }), null);
});

test('a genuine percentage metric in a plausible range is accepted', () => {
  assert.equal(validateStoredFact({ metric: 'NIM', value: 4.78, unit: 'PERCENTAGE' }), null);
  assert.equal(validateStoredFact({ metric: 'GNPA', value: 1.58, unit: 'PERCENTAGE' }), null);
  assert.equal(validateStoredFact({ metric: 'OPERATING_MARGIN', value: 24.5, unit: 'PERCENTAGE' }), null);
});

test('an implausible percentage is rejected even when the unit is right', () => {
  assert.equal(validateStoredFact({ metric: 'NIM', value: 87, unit: 'PERCENTAGE' }), 'VALUE_OUT_OF_PLAUSIBLE_RANGE');
  assert.equal(validateStoredFact({ metric: 'GNPA', value: -4, unit: 'PERCENTAGE' }), 'VALUE_OUT_OF_PLAUSIBLE_RANGE');
});

test('a genuine magnitude in a currency unit is accepted', () => {
  assert.equal(validateStoredFact({ metric: 'REVENUE', value: 240893, unit: 'INR_CRORE' }), null);
  assert.equal(validateStoredFact({ metric: 'PAT', value: 3030, unit: 'USD_MILLION' }), null);
});

test('a magnitude in a non-currency unit is rejected rather than displayed', () => {
  // Real: RELIANCE "ORDER_BOOK" = 0.2 COUNT.
  assert.equal(validateStoredFact({ metric: 'ORDER_BOOK', value: 0.2, unit: 'COUNT' }), 'UNIT_NOT_A_CURRENCY_MAGNITUDE');
});

test('a non-numeric value is never shown', () => {
  assert.equal(validateStoredFact({ metric: 'NIM', value: null, unit: 'PERCENTAGE' }), 'VALUE_NOT_NUMERIC');
  assert.equal(validateStoredFact({ metric: 'NIM', value: 'four', unit: 'PERCENTAGE' }), 'VALUE_NOT_NUMERIC');
});

test('a metric with no contract is left alone rather than blocked', () => {
  assert.equal(validateStoredFact({ metric: 'SOME_NEW_METRIC', value: 12, unit: 'WIDGETS' }), null);
});

test('a title describing a MOVEMENT is recognised as a delta, not a level', () => {
  // Real: INFY "Impact on Operating Margin from Acquisitions" = 0.7%, which
  // displayed beside TCS's genuine 24.5% reads as a 0.7% operating margin.
  assert.equal(isDeltaFact('Impact on Operating Margin from Acquisitions'), true);
  assert.equal(isDeltaFact('Change in NIM from repricing'), true);
  assert.equal(isDeltaFact('Operating margin expansion of 120 bps'), true);
  assert.equal(isDeltaFact('YoY margin movement'), true);
});

test('a title describing a LEVEL is not treated as a delta', () => {
  assert.equal(isDeltaFact('Q1 FY2026 operating margin'), false);
  assert.equal(isDeltaFact('FY2026 operating margin'), false);
  assert.equal(isDeltaFact('Net Interest Margin'), false);
  assert.equal(isDeltaFact(''), false);
  assert.equal(isDeltaFact(null), false);
});

test('a bank is classified from its stored sector, and gets bank metrics', () => {
  assert.equal(classifySector({ sector: 'Banking' }, 'HDFCBANK'), SECTOR_KINDS.BANKING);
  assert.equal(classifySector({ sector: 'Financial Services' }, 'X'), SECTOR_KINDS.BANKING);
  assert.equal(classifySector(null, 'ICICIBANK'), SECTOR_KINDS.BANKING, 'symbol backstop when no profile exists');

  const spec = SECTOR_METRICS.BANKING;
  assert.deepEqual(spec.primary, ['NIM', 'ROA', 'ROE', 'GNPA', 'NNPA']);
  assert.ok(spec.notMeaningful.includes('OPERATING_MARGIN'), 'operating margin is explicitly not meaningful for a bank');
  assert.equal(spec.marginLabel, 'net interest margin (NIM)');
});

test('a non-financial company keeps the operating-margin frame', () => {
  assert.equal(classifySector({ sector: 'IT / Software' }, 'TCS'), SECTOR_KINDS.GENERAL);
  assert.equal(classifySector({ sector: 'Defence' }, 'BEL'), SECTOR_KINDS.GENERAL);
  assert.equal(classifySector({ sector: 'Energy' }, 'RELIANCE'), SECTOR_KINDS.GENERAL);
  assert.ok(SECTOR_METRICS.GENERAL.primary.includes('OPERATING_MARGIN'));
  assert.deepEqual(SECTOR_METRICS.GENERAL.notMeaningful, []);
});

test('a metric stored as OTHER is recovered from its own title, not guessed', () => {
  assert.equal(resolveFactMetric({ metrics: { metric: 'OTHER' }, title: 'Net Interest Margin' }), 'NIM');
  assert.equal(resolveFactMetric({ metrics: { metric: 'OTHER' }, title: 'Gross NPA ratio' }), 'GNPA');
  assert.equal(resolveFactMetric({ metrics: { metric: 'OTHER' }, title: 'Return on Assets' }), 'ROA');
  assert.equal(resolveFactMetric({ metrics: { metric: 'PAT' }, title: 'anything' }), 'PAT', 'a declared metric wins');
  assert.equal(resolveFactMetric({ metrics: { metric: 'OTHER' }, title: 'Accounts Receivable DSO' }), 'OTHER', 'no pattern match stays OTHER');
});

test('the unavailability reasons distinguish a missing company from a missing metric', () => {
  assert.notEqual(UNAVAILABLE_REASONS.NOT_COLLECTED, UNAVAILABLE_REASONS.METRIC_NOT_REPORTED);
  assert.match(UNAVAILABLE_REASONS.NOT_COLLECTED, /no verified filing data/i);
  assert.match(UNAVAILABLE_REASONS.METRIC_NOT_REPORTED, /not reported/i);
  // Neither promises the gap is temporary — the baseline's "temporarily
  // unavailable" implied a retry would help when often it would not.
  for (const reason of [UNAVAILABLE_REASONS.NOT_COLLECTED, UNAVAILABLE_REASONS.METRIC_NOT_REPORTED]) {
    assert.equal(/temporar/i.test(reason), false);
  }
});
