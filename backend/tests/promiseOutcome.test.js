import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePromiseOutcome, describeTargetPeriod, isTargetPeriodClosed, detectStatedBasis,
  canonicalOutcomeFromStoredStatus, resolveRecordOutcome, EXCEEDED_MINIMUM_RATIO,
} from '../utils/promiseOutcome.js';
import { calculatePromiseStatus } from '../services/ManagementPromiseService.js';
import {
  calculateTargetHitRate, calculateGuidanceSuccessRate, calculateCompanyExecutionScore, EXECUTION_SCORE_BASE_WEIGHTS,
} from '../services/ExecutionScoreService.js';
import {
  OUTCOME_STATUSES, RESOLVED_STATUSES, CANDIDATE_STATUS_MAP, validateManagementPromiseRecord,
} from '../utils/earningsIntelligenceValidation.js';
import { calculateFaithScore } from '../services/CuratedEarningsIntelligenceService.js';

/**
 * promiseOutcome.test.js
 * =======================
 * Pins the met/missed rule set that replaced the percentage-band fallback in
 * calculatePromiseStatus, the single target-hit rate, and the removal of
 * guidance accuracy from the Financial / Execution score.
 */

const AFTER_FY2025_RESULTS = new Date('2025-09-01T00:00:00Z');
const DURING_FY2027 = new Date('2026-10-02T00:00:00Z');

test('₹1,000 Cr AT_LEAST target with a ₹800 Cr actual is MISSED at 80% -- the 80% never implies success', () => {
  const result = calculatePromiseStatus({
    targetValue: 1000, actualValue: 800, operator: 'GTE', targetUnit: 'INR_CRORE', actualUnit: 'INR_CRORE', targetPeriod: 'FY2025', actualPeriod: 'FY2025',
  });
  assert.equal(result.outcome, 'MISSED');
  assert.equal(result.status, 'MISSED');
  assert.equal(result.achievementPercentage, 80);
  assert.deepEqual({ value: result.shortfall.value, percentage: result.shortfall.percentage }, { value: 200, percentage: 20 });
  assert.match(result.calculationExplanation, /MISSED/);
  assert.match(result.calculationExplanation, /context only/);
});

test('the live TCS-FY2026-001 shape (at least 26% margin, actual 25%) is MISSED, not partial; the same holds without an operator', () => {
  const withOperator = calculatePromiseStatus({ targetValue: 26, actualValue: 25, operator: 'AT_LEAST', targetUnit: 'PERCENT', actualUnit: 'PERCENT', targetPeriod: 'FY2026' });
  assert.equal(withOperator.outcome, 'MISSED');
  assert.equal(withOperator.achievementPercentage, 96.15);
  const directionOnly = calculatePromiseStatus({ targetValue: 26, actualValue: 25, direction: 'HIGHER_IS_BETTER', targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' });
  assert.equal(directionOnly.status, 'MISSED');
  for (const pct of [0.8, 0.95, 0.99]) {
    assert.equal(calculatePromiseStatus({ targetValue: 100, actualValue: 100 * pct, direction: 'AT_LEAST' }).status, 'MISSED', `${pct * 100}% of a floor is a miss`);
  }
});

test('the committed curated TCS records recompute to MISSED / QUALITATIVE_ONLY from their own stored fields', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { records } = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'earnings-intelligence', 'promises', 'TCS.json'), 'utf8'));
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  assert.equal(resolveRecordOutcome(byId['TCS-FY2026-001'], { asOf: DURING_FY2027 }).outcome, 'MISSED'); // stored PARTIAL
  assert.equal(resolveRecordOutcome(byId['TCS-FY2025-001'], { asOf: DURING_FY2027 }).outcome, 'MISSED'); // AT_MOST 13 vs 13.3, stored PARTIAL
  assert.equal(resolveRecordOutcome(byId['TCS-FY2026-002'], { asOf: DURING_FY2027 }).outcome, 'QUALITATIVE_ONLY');
});

test('minimum comparisons: MET at the floor, EXCEEDED at the existing 110% threshold, MISSED just below', () => {
  assert.equal(EXCEEDED_MINIMUM_RATIO, 1.1);
  const at = evaluatePromiseOutcome({ targetValue: 500, actualValue: 500, operator: 'AT_LEAST', targetUnit: 'INR_CRORE' });
  assert.equal(at.outcome, 'MET');
  assert.equal(at.achievementPercentage, 100);
  assert.equal(evaluatePromiseOutcome({ targetValue: 500, actualValue: 549, operator: 'AT_LEAST', targetUnit: 'INR_CRORE' }).outcome, 'MET');
  assert.equal(evaluatePromiseOutcome({ targetValue: 500, actualValue: 550, operator: 'AT_LEAST', targetUnit: 'INR_CRORE' }).outcome, 'EXCEEDED');
  assert.equal(evaluatePromiseOutcome({ targetValue: 500, actualValue: 499.9, operator: 'AT_LEAST', targetUnit: 'INR_CRORE' }).outcome, 'MISSED');
  // Units normalize: 50,000 lakh == 500 crore.
  assert.equal(evaluatePromiseOutcome({ targetValue: 500, actualValue: 50000, operator: 'GTE', targetUnit: 'INR_CRORE', actualUnit: 'INR_LAKH' }).outcome, 'MET');
});

test('maximum comparisons: MET at the ceiling, EXCEEDED at 90% of it, MISSED above; achievement reads target/actual', () => {
  const attrition = evaluatePromiseOutcome({ targetValue: 13, actualValue: 13.3, operator: 'AT_MOST', targetUnit: 'PERCENT', actualUnit: 'PERCENT', targetPeriod: 'FY2025' });
  assert.equal(attrition.outcome, 'MISSED');
  assert.equal(attrition.shortfall.direction, 'ABOVE_CEILING');
  assert.equal(attrition.shortfall.value, 0.3);
  assert.equal(attrition.achievementPercentage, 97.74);
  assert.equal(evaluatePromiseOutcome({ targetValue: 13, actualValue: 13, operator: 'AT_MOST', targetUnit: 'PERCENT' }).outcome, 'MET');
  assert.equal(evaluatePromiseOutcome({ targetValue: 13, actualValue: 12, operator: 'AT_MOST', targetUnit: 'PERCENT' }).outcome, 'MET');
  assert.equal(evaluatePromiseOutcome({ targetValue: 13, actualValue: 11.7, operator: 'AT_MOST', targetUnit: 'PERCENT' }).outcome, 'EXCEEDED');
  assert.equal(evaluatePromiseOutcome({ targetValue: 2000, actualValue: 1500, direction: 'LOWER_IS_BETTER', targetUnit: 'INR_CRORE' }).achievementPercentage, 133.33);
});

test('range comparisons: inside is MET, either side is MISSED, a missing upper bound is never guessed', () => {
  const band = { targetValue: 26, targetValueMax: 28, operator: 'RANGE', targetUnit: 'PERCENT' };
  assert.equal(evaluatePromiseOutcome({ ...band, actualValue: 27 }).outcome, 'MET');
  assert.equal(evaluatePromiseOutcome({ ...band, actualValue: 26 }).outcome, 'MET');
  assert.equal(evaluatePromiseOutcome({ ...band, actualValue: 28 }).outcome, 'MET');
  const below = evaluatePromiseOutcome({ ...band, actualValue: 25 });
  assert.equal(below.outcome, 'MISSED');
  assert.equal(below.shortfall.direction, 'BELOW_RANGE');
  const above = evaluatePromiseOutcome({ ...band, actualValue: 29 });
  assert.equal(above.outcome, 'MISSED', 'above a range is not assumed to be favourable');
  assert.equal(above.shortfall.direction, 'ABOVE_RANGE');
  const noMax = evaluatePromiseOutcome({ targetValue: 26, operator: 'RANGE', targetUnit: 'PERCENT', actualValue: 27 });
  assert.equal(noMax.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(noMax.reason, /upper bound/);
  assert.equal(evaluatePromiseOutcome({ targetValue: 26, operator: 'RANGE', targetUnit: 'PERCENT', actualValue: 24 }).outcome, 'MISSED');
});

test('exact comparisons use a 0.5% tolerance and never report EXCEEDED', () => {
  const exact = { targetValue: 55000, operator: 'EXACT', targetUnit: 'COUNT' };
  assert.equal(evaluatePromiseOutcome({ ...exact, actualValue: 55200 }).outcome, 'MET');
  const over = evaluatePromiseOutcome({ ...exact, actualValue: 70000 });
  assert.equal(over.outcome, 'MISSED');
  assert.equal(over.achievementPercentage, 127.27);
  assert.match(over.calculationExplanation, /MISSED/);
});

test('a target period that has not closed is PENDING with no actual required', () => {
  const result = calculatePromiseStatus({ targetValue: 1000, actualValue: null, operator: 'GTE', targetPeriod: 'FY2027', asOf: DURING_FY2027 });
  assert.equal(result.outcome, 'PENDING');
  assert.equal(result.status, 'PENDING');
  assert.match(result.reason, /2027-03-31/);
  // FY2026 closed on 31 Mar 2026, but its 60-day reporting window was still open on 15 May 2026.
  assert.equal(calculatePromiseStatus({ targetValue: 1, actualValue: null, targetPeriod: 'FY2026', asOf: new Date('2026-05-15T00:00:00Z') }).outcome, 'PENDING');
  assert.equal(calculatePromiseStatus({ targetValue: 1, actualValue: null, targetPeriod: 'GOING_FORWARD', asOf: DURING_FY2027 }).outcome, 'PENDING');
});

test('a closed period with no actual evidence is INSUFFICIENT_EVIDENCE with a reason, never MISSED', () => {
  const result = calculatePromiseStatus({ targetValue: 1000, actualValue: null, operator: 'GTE', targetPeriod: 'FY2025', asOf: AFTER_FY2025_RESULTS });
  assert.equal(result.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.match(result.reason, /FY2025 closed on 2025-03-31/);
  assert.equal(result.achievementPercentage, null);
});

test('wrong statement basis (standalone target vs consolidated actual, and vice versa) is INSUFFICIENT_EVIDENCE, never compared', () => {
  const targetBasis = detectStatedBasis('We expect standalone revenue from operations of at least Rs 1,000 crore in FY2025.');
  const actualBasis = detectStatedBasis('Consolidated revenue from operations for FY2025 stood at Rs 1,240 crore.');
  assert.equal(targetBasis.statementBasis, 'STANDALONE');
  assert.equal(actualBasis.statementBasis, 'CONSOLIDATED');
  const result = calculatePromiseStatus({ targetValue: 1000, actualValue: 1240, operator: 'GTE', targetPeriod: 'FY2025', actualPeriod: 'FY2025', targetBasis, actualBasis });
  assert.equal(result.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(result.reason, /Statement-basis mismatch/);
  assert.equal(calculatePromiseStatus({ targetValue: 1000, actualValue: 800, operator: 'GTE', targetBasis: actualBasis, actualBasis: targetBasis }).outcome, 'INSUFFICIENT_EVIDENCE');
});

test('wrong period granularity (quarterly actual vs annual target) is INSUFFICIENT_EVIDENCE', () => {
  const result = calculatePromiseStatus({ targetValue: 4000, actualValue: 1100, operator: 'GTE', targetPeriod: 'FY2025', actualPeriod: 'Q4 FY2025' });
  assert.equal(result.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(result.reason, /granularity mismatch/);
  assert.equal(calculatePromiseStatus({ targetValue: 4000, actualValue: 4100, operator: 'GTE', targetPeriod: 'FY2025', actualPeriod: 'FY2024' }).outcome, 'INSUFFICIENT_EVIDENCE');
  assert.equal(calculatePromiseStatus({ targetValue: 4000, actualValue: 4100, operator: 'GTE', targetPeriod: 'FY2025', actualPeriod: 'FY25' }).outcome, 'MET');
});

test('definition, currency-basis and unit mismatches are never forced into a comparison', () => {
  const definition = evaluatePromiseOutcome({ targetValue: 1000, actualValue: 1200, operator: 'GTE', targetBasis: { metricDefinition: 'REVENUE_FROM_OPERATIONS' }, actualBasis: { metricDefinition: 'TOTAL_INCOME' } });
  assert.equal(definition.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(definition.reason, /total income/);
  const attribution = evaluatePromiseOutcome({ targetValue: 100, actualValue: 120, operator: 'GTE', targetBasis: { metricDefinition: 'PROFIT_FOR_PERIOD' }, actualBasis: { metricDefinition: 'PROFIT_ATTRIBUTABLE_TO_OWNERS' } });
  assert.equal(attribution.outcome, 'INSUFFICIENT_EVIDENCE');
  // Two spellings of the same line are not a mismatch.
  assert.equal(evaluatePromiseOutcome({ targetValue: 100, actualValue: 104, operator: 'GTE', targetBasis: { metricDefinition: 'PROFIT_FOR_PERIOD' }, actualBasis: { metricDefinition: 'PROFIT_AFTER_TAX' } }).outcome, 'MET');
  const currency = evaluatePromiseOutcome({ targetValue: 8, actualValue: 9, operator: 'GTE', targetUnit: 'PERCENT', targetBasis: detectStatedBasis('8% growth in constant currency'), actualBasis: detectStatedBasis('revenue grew 9% in reported currency') });
  assert.equal(currency.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(currency.reason, /Currency-basis mismatch/);
  assert.equal(evaluatePromiseOutcome({ targetValue: 100, actualValue: 90, operator: 'GTE', targetUnit: 'INR_CRORE', actualUnit: 'USD_MILLION' }).outcome, 'INSUFFICIENT_EVIDENCE');
  assert.equal(evaluatePromiseOutcome({ targetValue: 10, actualValue: 12, operator: 'GTE', targetUnit: 'PERCENT', actualUnit: 'INR_CRORE' }).outcome, 'INSUFFICIENT_EVIDENCE');
});

test('zero and negative targets withhold the achievement percentage with a reason but still decide MET / MISSED directly', () => {
  const zeroMet = evaluatePromiseOutcome({ targetValue: 0, actualValue: 0, operator: 'AT_MOST', targetUnit: 'INR_CRORE' });
  assert.equal(zeroMet.outcome, 'MET');
  assert.equal(zeroMet.achievementPercentage, null);
  assert.match(zeroMet.achievementReason, /zero/);
  const zeroDebtMissed = evaluatePromiseOutcome({ targetValue: 0, actualValue: 50, operator: 'AT_MOST', targetUnit: 'INR_CRORE' });
  assert.equal(zeroDebtMissed.outcome, 'MISSED');
  assert.equal(zeroDebtMissed.achievementPercentage, null);
  const lossCap = evaluatePromiseOutcome({ targetValue: -100, actualValue: -80, operator: 'AT_LEAST', targetUnit: 'INR_CRORE' });
  assert.equal(lossCap.outcome, 'MET', 'a loss of 80 beats a floor of -100');
  assert.equal(lossCap.achievementPercentage, null);
  assert.match(lossCap.achievementReason, /negative target/);
  const deeperLoss = evaluatePromiseOutcome({ targetValue: -100, actualValue: -150, operator: 'AT_LEAST', targetUnit: 'INR_CRORE' });
  assert.equal(deeperLoss.outcome, 'MISSED');
  const signCross = evaluatePromiseOutcome({ targetValue: 100, actualValue: -20, operator: 'AT_LEAST', targetUnit: 'INR_CRORE' });
  assert.equal(signCross.outcome, 'MISSED');
  assert.equal(signCross.achievementPercentage, null);
  assert.match(signCross.achievementReason, /sign-crossing/);
});

test('a promise with no numeric target is QUALITATIVE_ONLY -- never MISSED or INSUFFICIENT_EVIDENCE', () => {
  assert.equal(evaluatePromiseOutcome({ targetValue: null, operator: 'QUALITATIVE', actualValue: 0.6 }).outcome, 'QUALITATIVE_ONLY');
  assert.equal(calculatePromiseStatus({ targetValue: undefined, actualValue: null, targetPeriod: 'FY2020', asOf: DURING_FY2027 }).status, 'QUALITATIVE_ONLY');
});

test('period descriptions follow the April-March fiscal year and SEBI reporting windows', () => {
  const q1 = describeTargetPeriod('Q1 FY2026');
  assert.equal(q1.granularity, 'QUARTER');
  assert.equal(q1.periodEnd.toISOString().slice(0, 10), '2025-06-30');
  assert.equal(q1.reportingDeadline.toISOString().slice(0, 10), '2025-08-14');
  assert.equal(describeTargetPeriod('FY2024-25').fiscalYear, 2025);
  assert.equal(describeTargetPeriod('H1 FY2026').periodEnd.toISOString().slice(0, 10), '2025-09-30');
  assert.equal(describeTargetPeriod('9M FY2026').granularity, 'NINE_MONTH');
  assert.equal(describeTargetPeriod('nonsense'), null);
  assert.equal(isTargetPeriodClosed('FY2025', AFTER_FY2025_RESULTS), true);
  assert.equal(isTargetPeriodClosed('FY2027', DURING_FY2027), false);
});

test('target-hit rate: (met + exceeded) / completed, with pending / insufficient / qualitative excluded from both sides', () => {
  const outcomes = ['MET', 'EXCEEDED', 'MISSED', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE', 'QUALITATIVE_ONLY'].map((canonicalOutcome) => ({ canonicalOutcome }));
  const result = calculateTargetHitRate(outcomes);
  assert.equal(result.targetHitRate, 50);
  assert.equal(result.completed, 4);
  assert.equal(result.hits, 2);
  assert.deepEqual([result.pending, result.insufficientEvidence, result.qualitativeOnly], [1, 1, 1]);
  assert.equal(calculateGuidanceSuccessRate(outcomes), 50, 'one authoritative number under both names');
});

test('target-hit rate is null (never 0) with no evaluable targets, and an EXCEEDED promise counts as a hit (regression: it used to score 0)', () => {
  assert.equal(calculateTargetHitRate([]).targetHitRate, null);
  assert.equal(calculateTargetHitRate([{ canonicalOutcome: 'PENDING' }, { canonicalOutcome: 'QUALITATIVE_ONLY' }, { canonicalOutcome: 'INSUFFICIENT_EVIDENCE' }]).targetHitRate, null);
  assert.equal(calculateGuidanceSuccessRate([{ verification: { status: 'EXCEEDED' } }]), 100);
  // Legacy stored verdicts: PARTIALLY_FULFILLED was a sub-target result, i.e. a miss.
  assert.equal(calculateGuidanceSuccessRate([{ verification: { status: 'FULFILLED' } }, { verification: { status: 'PARTIALLY_FULFILLED' } }]), 50);
  // A pre-fix FULFILLED stored for a 92%-of-floor result is recomputed from the stored numbers.
  assert.equal(calculateGuidanceSuccessRate([{ promise: { targetValue: 100, targetUnit: 'INR_CRORE', direction: 'HIGHER_IS_BETTER', targetPeriod: 'FY2024' }, outcome: { actualValue: 92, actualUnit: 'INR_CRORE' }, verification: { status: 'FULFILLED' } }]), 0);
});

test('canonical mapping of every stored status vocabulary', () => {
  assert.equal(canonicalOutcomeFromStoredStatus('ACHIEVED'), 'MET');
  assert.equal(canonicalOutcomeFromStoredStatus('FULFILLED'), 'MET');
  assert.equal(canonicalOutcomeFromStoredStatus('PARTIAL'), 'MISSED');
  assert.equal(canonicalOutcomeFromStoredStatus('CONFLICTING_EVIDENCE'), 'INSUFFICIENT_EVIDENCE');
  assert.equal(canonicalOutcomeFromStoredStatus('SOMETHING'), null);
});

test('enum extensions are additive: EXCEEDED and QUALITATIVE_ONLY are valid, PARTIAL still reads, EXCEEDED is no longer folded into ACHIEVED', () => {
  for (const status of ['ACHIEVED', 'PARTIAL', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE', 'EXCEEDED', 'QUALITATIVE_ONLY']) assert.ok(OUTCOME_STATUSES.includes(status), status);
  assert.ok(RESOLVED_STATUSES.includes('EXCEEDED'));
  assert.ok(!RESOLVED_STATUSES.includes('QUALITATIVE_ONLY'));
  assert.equal(CANDIDATE_STATUS_MAP.EXCEEDED, 'EXCEEDED');
  assert.equal(CANDIDATE_STATUS_MAP.FULFILLED, 'ACHIEVED');
  const record = {
    id: 'TCS-FY2027-901', symbol: 'TCS', dataMode: 'CURATED_VERIFIED',
    promise: { statement: 's', category: 'MARGIN', promiseDate: '2026-04-09', targetPeriod: 'FY2027', targetType: 'PERCENTAGE', targetValue: 26, targetValueMax: 28, targetUnit: 'PERCENT', operator: 'RANGE', metric: 'MARGIN', revisesPromiseId: null },
    outcome: { status: 'PENDING', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null },
    promiseEvidence: { sourceTitle: 't', sourceType: 'EARNINGS_TRANSCRIPT', sourceUrl: 'https://www.bseindia.com/x.pdf', publishedAt: '2026-04-09', pageNumber: 3, excerpt: 'e' },
    outcomeEvidence: null,
    verification: { verifiedAt: '2026-04-10', verifiedBy: 'TEST', evidenceConfidence: 0.8 },
  };
  assert.deepEqual(validateManagementPromiseRecord(record, { symbol: 'TCS' }).errors, []);
  assert.match(validateManagementPromiseRecord({ ...record, promise: { ...record.promise, targetValueMax: 20 } }, { symbol: 'TCS' }).errors.join(), /upper bound/);
});

test('the Faith Score counts EXCEEDED like ACHIEVED (additive STATUS_VALUE)', () => {
  const rec = (status) => ({ id: status, outcome: { status }, verification: { evidenceConfidence: 1 }, promise: { targetPeriod: 'FY2025' } });
  assert.equal(calculateFaithScore([rec('EXCEEDED'), rec('ACHIEVED'), rec('MISSED')]).faithScore, 67);
});

test('calculateCompanyExecutionScore no longer weights guidance accuracy; its weight is redistributed', () => {
  const facts = [
    { period: 'FY2022', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1000 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 2000 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'EBITDA_MARGIN', actualValue: 26.0 } },
    { category: 'STRATEGY', title: 'Expansion', fact: 'Launched in Europe' },
  ];
  const goodGuidance = [{ verification: { status: 'FULFILLED' } }, { verification: { status: 'EXCEEDED' } }, { verification: { status: 'FULFILLED' } }];
  const badGuidance = [{ verification: { status: 'MISSED', achievementPercentage: 10 } }, { verification: { status: 'MISSED', achievementPercentage: 5 } }, { verification: { status: 'MISSED', achievementPercentage: 0 } }];
  const good = calculateCompanyExecutionScore({ facts, promises: goodGuidance });
  const bad = calculateCompanyExecutionScore({ facts, promises: badGuidance });
  const none = calculateCompanyExecutionScore({ facts, promises: [] });
  assert.equal(good.executionScore, bad.executionScore, 'guidance delivery no longer moves the financial/execution score');
  assert.equal(good.executionScore, none.executionScore);
  assert.deepEqual(good.weightsUsed, { ...EXECUTION_SCORE_BASE_WEIGHTS });
  assert.equal(Object.values(good.weightsUsed).reduce((a, b) => a + b, 0), 100);
  assert.ok(!('guidanceAccuracy' in good.weightsUsed));
  assert.ok(!('guidanceAccuracy' in (good.scoreMissingReasons || {})));
  // Still reported, separately.
  assert.equal(good.guidanceAccuracyScore, 100);
  assert.equal(good.guidanceSuccessRate, 100);
  assert.equal(bad.guidanceSuccessRate, 0);
  assert.match(good.methodology, /does NOT include guidance-delivery accuracy/);
  const { breakdown } = { breakdown: good.scoreBreakdown };
  const expected = Math.round((breakdown.financialDelivery * 40 + breakdown.strategicExecution * 25 + breakdown.operationalDelivery * 20 + breakdown.capitalAllocation * 15) / 100);
  assert.equal(good.executionScore, expected);
});

test('with provider annual financials, a null component is still dropped and weights redistribute over the rest (summing to 100)', () => {
  const financialFacts = [2022, 2023, 2024, 2025, 2026].map((y, i) => ({ period: `FY${y}`, category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1000 + i * 100, unit: 'INR_CRORE' } }));
  const result = calculateCompanyExecutionScore({ facts: financialFacts, promises: [{ verification: { status: 'FULFILLED' } }], financialFacts });
  assert.ok(!('guidanceAccuracy' in result.weightsUsed));
  const total = Object.values(result.weightsUsed).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 100) < 0.05, `weights sum to ${total}`);
  assert.equal(result.weightsUsed.strategicExecution, 0, 'no strategy evidence -> excluded');
});
