import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  calculatePromiseStatus, 
  calculateReliability,
  recencyWeight,
  normalizeFinancialValue,
  periodsMatch,
  IMPORTANCE_WEIGHTS,
  STATUS_SCORE
} from '../services/ManagementPromiseService.js';
import { getCompanyResearchProfile } from '../research/CompanyResearchProfiles.js';
import ManagementPromise from '../models/ManagementPromise.js';
import { extractPromisesFromDocument } from '../services/PromiseExtractionService.js';

test('Phase 5C extracts the TCS employee percentage promise with page evidence', () => {
  const promises = extractPromisesFromDocument({
    title: 'TCS Q1 FY27 Earnings Call',
    sourceUrl: 'https://www.tcs.com/q1-fy27-earnings-call.pdf',
    sourceDate: '2026-07-09',
    pages: [
      { pageNumber: 4, text: 'Revenue grew 4% in Q1.' },
      { pageNumber: 13, text: 'We expect at least 1% of our employee base to be in the new operating model going forward.' },
      { pageNumber: 14, text: 'We expect demand to improve.' }
    ]
  });

  assert.equal(promises.length, 1);
  assert.equal(promises[0].metric, 'EMPLOYEE_PERCENTAGE');
  assert.equal(promises[0].targetValue, 1);
  assert.equal(promises[0].targetUnit, 'PERCENTAGE');
  assert.equal(promises[0].direction, 'AT_LEAST');
  assert.equal(promises[0].period, 'GOING_FORWARD');
  assert.equal(promises[0].evidence.page, 13);
  assert.match(promises[0].evidence.excerpt, /at least 1% of our employee base/i);
  assert.equal(promises[0].evidence.sourceUrl, 'https://www.tcs.com/q1-fy27-earnings-call.pdf');
});

test('Phase 5C rejects historical metrics and unquantified outlook', () => {
  const promises = extractPromisesFromDocument({
    title: 'TCS Q1 FY27 Earnings Call',
    sourceUrl: 'https://www.tcs.com/q1-fy27-earnings-call.pdf',
    pages: [{ pageNumber: 4, text: 'Revenue grew 4% in Q1. We expect demand to improve.' }]
  });
  assert.deepEqual(promises, []);
});

test('GTE operator fulfills values at or above the target', () => {
  assert.equal(calculatePromiseStatus({ targetValue: 1, actualValue: 1.2, targetUnit: 'PERCENTAGE', operator: 'GTE' }).status, 'FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 1, actualValue: 0.8, targetUnit: 'PERCENTAGE', operator: 'GTE' }).status, 'MISSED');
});

test('LTE operator fulfills values at or below the target', () => {
  assert.equal(calculatePromiseStatus({ targetValue: 10, actualValue: 9, operator: 'LTE' }).status, 'FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 10, actualValue: 11, operator: 'LTE' }).status, 'MISSED');
});

test('EQ operator requires exact equality', () => {
  assert.equal(calculatePromiseStatus({ targetValue: 10, actualValue: 10, operator: 'EQ' }).status, 'FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 10, actualValue: 10.01, operator: 'EQ' }).status, 'MISSED');
});

test('schema accepts employee percentage metrics and evidence pages', () => {
  const promise = new ManagementPromise({
    companyId: 'TCS',
    symbol: 'TCS',
    companyName: 'Tata Consultancy Services Limited',
    promise: {
      statement: 'Target at least 1% of the employee base in the new operating model.',
      metric: 'EMPLOYEE_PERCENTAGE',
      targetValue: 1,
      targetUnit: 'PERCENTAGE',
      targetPeriod: 'GOING_FORWARD',
      promiseDate: new Date('2026-07-09'),
      operator: 'GTE',
      importance: 'MEDIUM'
    },
    evidence: {
      promiseSource: {
        sourceUrl: 'https://www.tcs.com/example.pdf',
        sourceDate: new Date('2026-07-09'),
        title: 'TCS Q1 FY27 Earnings Conference Call',
        excerpt: 'Target to have at least 1% of our employee base.',
        page: 13
      }
    }
  });

  assert.equal(promise.validateSync(), undefined);
  assert.equal(promise.promise.metric, 'EMPLOYEE_PERCENTAGE');
  assert.equal(promise.promise.targetPeriod, 'GOING_FORWARD');
  assert.equal(promise.evidence.promiseSource.page, 13);
});

test('existing promises without an operator retain direction-based verification', () => {
  const result = calculatePromiseStatus({ targetValue: 100, actualValue: 120, metricType: 'REVENUE_GROWTH' });
  assert.equal(result.status, 'EXCEEDED');
});

test('importance defaults to MEDIUM when extraction provides none', () => {
  const promise = new ManagementPromise({
    companyId: 'TCS',
    symbol: 'TCS',
    companyName: 'Tata Consultancy Services Limited',
    promise: {
      statement: 'Target at least 1% of the employee base.',
      metric: 'EMPLOYEE_PERCENTAGE',
      targetValue: 1,
      targetUnit: 'PERCENTAGE',
      targetPeriod: 'GOING_FORWARD',
      promiseDate: new Date('2026-07-09'),
      direction: 'HIGHER_IS_BETTER',
      operator: 'GTE'
    },
    evidence: {
      promiseSource: {
        sourceUrl: 'https://www.tcs.com/example.pdf',
        sourceDate: new Date('2026-07-09'),
        title: 'TCS Q1 FY27 Earnings Conference Call',
        excerpt: 'Target to have at least 1% of our employee base.'
      }
    }
  });

  assert.equal(promise.promise.importance, 'MEDIUM');
  assert.equal(promise.validateSync(), undefined);
});

test('quantitative promise status uses metric thresholds', () => {
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 21, metricType: 'REVENUE_GROWTH' }).status, 'FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 18, metricType: 'REVENUE_GROWTH' }).status, 'FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 15, metricType: 'REVENUE_GROWTH' }).status, 'PARTIALLY_FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 6, metricType: 'REVENUE_GROWTH' }).status, 'MISSED');
});

test('verification normalizes compatible units and distinguishes an exceeded target', () => {
  assert.equal(normalizeFinancialValue(1000, 'INR_MILLION'), 100);
  assert.equal(normalizeFinancialValue(2, 'USD_BILLION'), 2000);
  assert.equal(periodsMatch('Q1 FY2027', 'q1 fy2027'), true);
  assert.equal(periodsMatch('FY2027', 'Q1 FY2027'), false);
  assert.equal(calculatePromiseStatus({
    targetValue: 100,
    actualValue: 120,
    targetUnit: 'INR_CRORE',
    actualUnit: 'INR_CRORE',
    targetPeriod: 'FY2027',
    actualPeriod: 'FY2027',
  }).status, 'EXCEEDED');
});

test('debt metrics use lower-is-better comparison', () => {
  const result = calculatePromiseStatus({ targetValue: 60, actualValue: 60, metricType: 'DEBT' });
  assert.equal(result.achievementPercentage, 100);
  assert.equal(result.status, 'FULFILLED');
  assert.match(result.calculationExplanation, /lower-is-better/i);
});

test('debt reduction target exceeding expectation calculates properly', () => {
  // Target: reduce debt to 500 Cr, Actual debt reduced to 300 Cr (target 500 / actual 300 * 100 = 166.67%)
  const result = calculatePromiseStatus({ targetValue: 500, actualValue: 300, direction: 'LOWER_IS_BETTER' });
  assert.equal(result.status, 'FULFILLED');
  assert.ok(result.achievementPercentage >= 100);
});

test('pending promises do not reduce weighted reliability and are tracked accurately', () => {
  const result = calculateReliability([
    { status: 'FULFILLED', importance: 'HIGH', achievementPercentage: 100, announcementDate: new Date() },
    { status: 'MISSED', importance: 'LOW', achievementPercentage: 0, announcementDate: new Date() },
    { status: 'PARTIALLY_FULFILLED', importance: 'MEDIUM', achievementPercentage: 90, announcementDate: new Date() },
    { status: 'PENDING', importance: 'HIGH', achievementPercentage: null, announcementDate: new Date() },
  ]);
  assert.equal(result.totalPromises, 4);
  assert.equal(result.verifiedPromises, 3);
  assert.equal(result.pending, 1);
  assert.equal(result.fulfilled, 1);
  assert.equal(result.missed, 1);
  assert.equal(result.partiallyFulfilled, 1);
  assert.ok(result.score > 5);
});

test('reliability returns null score if fewer than 3 verified promises exist', () => {
  const result = calculateReliability([
    { status: 'FULFILLED', importance: 'HIGH', achievementPercentage: 100, announcementDate: new Date() },
    { status: 'PENDING', importance: 'MEDIUM', achievementPercentage: null, announcementDate: new Date() }
  ]);
  assert.equal(result.score, null);
  assert.equal(result.totalPromises, 2);
  assert.equal(result.verifiedPromises, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.trend, 'INSUFFICIENT_DATA');
});

test('future target periods are marked as PENDING when actual value is not yet available', () => {
  const result = calculatePromiseStatus({
    targetValue: 1000,
    actualValue: null,
    targetPeriod: 'FY2026',
    metric: 'ORDER_BOOK'
  });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.achievementPercentage, null);
  assert.match(result.calculationExplanation, /pending/i);
});

test('NEWGEN research profile contains complete aliases, symbols, and management keywords', () => {
  const profile = getCompanyResearchProfile('NEWGEN');
  assert.equal(profile.symbol, 'NEWGEN');
  assert.equal(profile.companyName, 'Newgen Software Technologies');
  assert.ok(profile.aliases.includes('Newgen Software'));
  assert.ok(profile.aliases.includes('Newgen Software Technologies'));
  assert.ok(profile.commonManagementTerms.includes('order book'));
  assert.ok(profile.commonManagementTerms.includes('revenue guidance'));
  assert.ok(profile.investorRelationsUrls.length > 0);
  assert.equal(profile.exchangeSymbols.NSE, 'NEWGEN');
});

test('recency weight gives 1.0 to current year and decays gracefully to 0.7 for older years', () => {
  const now = new Date();
  const currentWeight = recencyWeight(now);
  assert.equal(currentWeight, 1.0);

  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const oldWeight = recencyWeight(fiveYearsAgo);
  assert.equal(oldWeight, 0.7);
});

test('research-debug endpoint returns required schema structure for NEWGEN', async () => {
  const { getCompanyResearchDebug } = await import('../services/ManagementPromiseService.js');
  const debug = await getCompanyResearchDebug('NEWGEN');
  assert.equal(debug.symbol, 'NEWGEN');
  assert.equal(debug.companyName, 'Newgen Software Technologies');
  assert.ok(Array.isArray(debug.aliases));
  assert.ok(typeof debug.sourcesFound === 'number');
  assert.ok(typeof debug.documentsByProvider === 'object');
  assert.ok(typeof debug.promisesExtracted === 'number');
  assert.ok(typeof debug.promisesRejected === 'number');
  assert.ok(typeof debug.rejectionReasons === 'object');
  assert.ok(typeof debug.outcomesFound === 'number');
  assert.ok(typeof debug.explanationsFound === 'number');
  assert.ok(Array.isArray(debug.promiseRecords));
});

