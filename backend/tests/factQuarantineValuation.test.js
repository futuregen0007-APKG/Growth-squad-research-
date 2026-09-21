import test from 'node:test';
import assert from 'node:assert/strict';
import { screenFact, screenFacts, FACT_VERDICTS, QUARANTINE_REASONS } from '../services/factQuarantine.js';
import {
  buildTtm, computePriceToEarnings, computePriceToBook, buildValuation,
  bankValuationContext, VALUATION_UNAVAILABLE,
} from '../services/valuationMetrics.js';

/**
 * factQuarantineValuation.test.js
 * ==================================
 * Phase 6B. Two rules, both about refusing to produce a confident wrong
 * number:
 *   - a suspicious fact is QUARANTINED, never silently corrected;
 *   - a multiple is computed only from period-compatible inputs, and
 *     carries its formula and both inputs' provenance.
 */

// --- quarantine ------------------------------------------------------------

test('the real INFY order-book scale error is quarantined, not corrected', () => {
  // INFY's stored ORDER_BOOK = 3.2 USD_MILLION is almost certainly $3.2bn.
  // "Fixing" it would invent a number the filing never stated.
  const verdict = screenFact({ metric: 'ORDER_BOOK', value: 3.2, unit: 'USD_MILLION', title: 'Large deal TCV' });
  assert.equal(verdict.verdict, FACT_VERDICTS.QUARANTINED);
  assert.equal(verdict.reason, QUARANTINE_REASONS.SCALE_IMPLAUSIBLE);
  assert.match(verdict.detail, /not corrected/i, 'the reason says explicitly that nothing was repaired');
  assert.equal(verdict.value, undefined, 'no replacement value is offered');
});

test('a plausible order book at the same metric passes untouched', () => {
  assert.equal(screenFact({ metric: 'ORDER_BOOK', value: 9440, unit: 'USD_MILLION' }).verdict, FACT_VERDICTS.USABLE);
  assert.equal(screenFact({ metric: 'REVENUE', value: 240893, unit: 'INR_CRORE' }).verdict, FACT_VERDICTS.USABLE);
});

test('a unit that contradicts the metric outright is REJECTED, not quarantined', () => {
  // A margin denominated in crore is not ambiguous - it is wrong.
  const verdict = screenFact({ metric: 'OPERATING_MARGIN', value: 65799, unit: 'INR_CRORE' });
  assert.equal(verdict.verdict, FACT_VERDICTS.REJECTED);
});

test('a rate whose title describes a movement is quarantined as possibly a delta', () => {
  const verdict = screenFact({ metric: 'OPERATING_MARGIN', value: 0.7, unit: 'PERCENTAGE', title: 'Impact on Operating Margin from Acquisitions' });
  assert.equal(verdict.verdict, FACT_VERDICTS.QUARANTINED);
  assert.equal(verdict.reason, QUARANTINE_REASONS.LABEL_CONTRADICTS_TEXT);
});

test('a LEVEL under a growth-themed heading is NOT quarantined', () => {
  // Measured: quarantining these withheld 39 genuine TCS facts. A value in
  // crore cannot itself be the percentage change.
  const verdict = screenFact({ metric: 'REVENUE', value: 58229, unit: 'INR_CRORE', title: 'Revenue Growth in Q2 FY2023' });
  assert.equal(verdict.verdict, FACT_VERDICTS.USABLE);
});

test('a value orders of magnitude away from the company\'s own history is quarantined', () => {
  const peers = [
    { metric: 'REVENUE', value: 8564, unit: 'INR_CRORE' },
    { metric: 'REVENUE', value: 9100, unit: 'INR_CRORE' },
    { metric: 'REVENUE', value: 8800, unit: 'INR_CRORE' },
  ];
  const verdict = screenFact({ metric: 'REVENUE', value: 15_588_528, unit: 'INR_CRORE' }, peers);
  assert.equal(verdict.verdict, FACT_VERDICTS.QUARANTINED);
});

test('screening reports its coverage impact so withheld data is visible, not just absent', () => {
  const result = screenFacts([
    { metric: 'REVENUE', value: 8564, unit: 'INR_CRORE' },
    { metric: 'ORDER_BOOK', value: 3.2, unit: 'USD_MILLION' },
    { metric: 'OPERATING_MARGIN', value: 65799, unit: 'INR_CRORE' },
  ]);

  assert.equal(result.usable.length, 1);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.coverage.total, 3);
  assert.equal(result.coverage.withheldRatio, 0.667, 'two thirds withheld, and the number is reported');
  assert.ok(result.coverage.byReason[QUARANTINE_REASONS.SCALE_IMPLAUSIBLE] >= 1);
});

test('screening never mutates the fact it was given', () => {
  const original = { metric: 'ORDER_BOOK', value: 3.2, unit: 'USD_MILLION' };
  const snapshot = JSON.stringify(original);
  screenFact(original);
  assert.equal(JSON.stringify(original), snapshot, 'the source record is preserved for audit');
});

// --- valuation -------------------------------------------------------------

const q = (period, value) => ({ period, value, unit: 'INR', sourceUrl: `https://nsearchives.example/${period}`, asOf: '2025-01-30' });

test('TTM is built only from four CONSECUTIVE quarters', () => {
  const complete = buildTtm([q('Q3 FY2025', 1.79), q('Q2 FY2025', 1.6), q('Q1 FY2025', 1.4), q('Q4 FY2024', 2.1)]);
  assert.ok(complete);
  assert.equal(complete.value, 6.89);
  assert.deepEqual(complete.periods, ['Q3 FY2025', 'Q2 FY2025', 'Q1 FY2025', 'Q4 FY2024']);
  assert.equal(complete.sources.length, 4, 'every contributing quarter keeps its own source');
});

test('a gap in the quarters yields NO trailing figure rather than a scaled guess', () => {
  // Q2 FY2025 missing: three quarters must never be annualised.
  assert.equal(buildTtm([q('Q3 FY2025', 1.79), q('Q1 FY2025', 1.4), q('Q4 FY2024', 2.1)]), null);
  assert.equal(buildTtm([q('Q3 FY2025', 1.79), q('Q2 FY2025', 1.6)]), null, 'two quarters is not a year');
});

test('a computed multiple carries its formula and both inputs with provenance', () => {
  const result = computePriceToEarnings({
    price: { value: 404.35, unit: 'INR', asOf: '2026-09-11', sourceUrl: 'nse-bhavcopy' },
    earningsPerShare: { value: 6.89, unit: 'INR', periods: ['Q3 FY2025', 'Q2 FY2025', 'Q1 FY2025', 'Q4 FY2024'], sources: [{ period: 'Q3 FY2025', sourceUrl: 'https://nsearchives.example/x' }] },
  });

  assert.equal(result.available, true);
  assert.equal(result.value, 58.69);
  assert.match(result.formula, /share price ÷ trailing-twelve-month earnings per share/);
  assert.equal(result.inputs.price.asOf, '2026-09-11', 'the price carries its own as-of date');
  assert.equal(result.inputs.earningsPerShare.periods.length, 4, 'and the earnings carry the periods they came from');
  assert.ok(result.computedAt, 'the computation is timestamped');
});

test('a missing input produces an explicit reason, never a substituted value', () => {
  assert.equal(computePriceToEarnings({ price: null, earningsPerShare: { value: 5 } }).reason, VALUATION_UNAVAILABLE.NO_PRICE);
  assert.equal(computePriceToEarnings({ price: { value: 100 }, earningsPerShare: null }).reason, VALUATION_UNAVAILABLE.NO_EARNINGS);
  assert.equal(computePriceToBook({ price: { value: 100 }, bookValuePerShare: null }).reason, VALUATION_UNAVAILABLE.NO_BOOK_VALUE);

  for (const result of [
    computePriceToEarnings({ price: null, earningsPerShare: { value: 5 } }),
    computePriceToBook({ price: { value: 100 }, bookValuePerShare: null }),
  ]) {
    assert.equal(result.available, false);
    assert.equal(result.value, undefined, 'no number is produced when an input is missing');
  }
});

test('negative or zero earnings make the multiple meaningless, and it says so', () => {
  const result = computePriceToEarnings({ price: { value: 404 }, earningsPerShare: { value: -2.5 } });
  assert.equal(result.available, false);
  assert.equal(result.reason, VALUATION_UNAVAILABLE.NON_POSITIVE_EARNINGS);
});

test('a provider-supplied verified multiple is preferred over computing one', () => {
  const view = { symbol: 'TCS', sectorKind: 'GENERAL', metrics: [], marketMetrics: { lastClose: 2200, dataAsOf: '2026-09-11' } };
  const valuation = buildValuation(view, { providerMultiples: { PE: { value: 24.5, provider: 'indian-api', asOf: '2026-09-11' } } });

  const pe = valuation.available.find((m) => m.metric === 'PE');
  assert.ok(pe);
  assert.equal(pe.source, 'PROVIDER_VERIFIED');
  assert.match(pe.formula, /as published by the data provider/);
});

test('with no EPS held, P/E is reported unavailable with the reason - not omitted', () => {
  const view = { symbol: 'BEL', sectorKind: 'GENERAL', metrics: [], marketMetrics: { lastClose: 404.35, dataAsOf: '2026-09-11' } };
  const valuation = buildValuation(view);

  assert.equal(valuation.hasAny, false);
  const pe = valuation.unavailable.find((m) => m.metric === 'PE');
  assert.ok(pe, 'the gap is named');
  assert.equal(pe.reason, VALUATION_UNAVAILABLE.NO_EARNINGS);
  const pb = valuation.unavailable.find((m) => m.metric === 'PB');
  assert.equal(pb.reason, VALUATION_UNAVAILABLE.NO_BOOK_VALUE);
});

test('a bank is framed on P/B and asset quality rather than P/E alone', () => {
  const view = {
    symbol: 'ICICIBANK', sectorKind: 'BANKING',
    metrics: [
      { metric: 'GNPA', value: 1.58, unit: 'PERCENTAGE', period: 'FY2026' },
      { metric: 'ROA', value: 2.11, unit: 'PERCENTAGE', period: 'FY2022' },
    ],
  };
  const context = bankValuationContext(view);
  assert.equal(context.preferredMultiple, 'PB');
  assert.match(context.rationale, /provisioning/i);
  assert.equal(context.assetQuality.gnpa.value, 1.58);
  assert.equal(context.returns.roa.value, 2.11);
  assert.equal(bankValuationContext({ sectorKind: 'GENERAL' }), null, 'not applied to a non-bank');
});
