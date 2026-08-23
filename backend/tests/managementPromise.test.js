import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  calculatePromiseStatus, 
  calculateReliability,
  recencyWeight,
  IMPORTANCE_WEIGHTS,
  STATUS_SCORE
} from '../services/ManagementPromiseService.js';
import { getCompanyResearchProfile } from '../research/CompanyResearchProfiles.js';

test('quantitative promise status uses metric thresholds', () => {
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 21, metricType: 'REVENUE_GROWTH' }).status, 'FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 18, metricType: 'REVENUE_GROWTH' }).status, 'FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 15, metricType: 'REVENUE_GROWTH' }).status, 'PARTIALLY_FULFILLED');
  assert.equal(calculatePromiseStatus({ targetValue: 20, actualValue: 6, metricType: 'REVENUE_GROWTH' }).status, 'MISSED');
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

