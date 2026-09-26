import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCagr,
  calculateYoY,
  getExecutionRatingLabel,
  buildFinancialSnapshot,
  isSubYearPeriod,
  calculateFinancialDeliveryScore,
  calculateGuidanceAccuracyScore,
  calculateStrategicExecutionScore,
  calculateOperationalDeliveryScore,
  calculateCapitalAllocationScore,
  calculateCompanyExecutionScore,
  calculateConfidence
} from '../services/ExecutionScoreService.js';
import { getCompanyResearchProfile, SECTOR_METRICS } from '../research/CompanyResearchProfiles.js';
import { deduplicateFacts } from '../services/ManagementPromiseService.js';

test('calculateCagr computes exact mathematical compound annual growth rate', () => {
  // Example: 800 Cr to 1480 Cr over 4 years (FY22 to FY26) -> 16.63%
  const cagr = calculateCagr(800, 1480, 4);
  assert.ok(cagr !== null);
  assert.equal(cagr, 16.63);

  // 100 to 200 over 1 year -> 100%
  assert.equal(calculateCagr(100, 200, 1), 100);

  // Invalid inputs return null
  assert.equal(calculateCagr(0, 100, 2), null);
  assert.equal(calculateCagr(-10, 100, 2), null);
  assert.equal(calculateCagr(100, 200, 0), null);
});

test('calculateYoY computes exact percentage growth and decline', () => {
  assert.equal(calculateYoY(100, 125), 25);
  assert.equal(calculateYoY(100, 85), -15);
  assert.equal(calculateYoY(0, 50), null);
});

test('getExecutionRatingLabel assigns deterministic rating labels', () => {
  assert.equal(getExecutionRatingLabel(95), 'Exceptional');
  assert.equal(getExecutionRatingLabel(84), 'Strong');
  assert.equal(getExecutionRatingLabel(73), 'Good');
  assert.equal(getExecutionRatingLabel(62), 'Mixed');
  assert.equal(getExecutionRatingLabel(54), 'Weak');
  assert.equal(getExecutionRatingLabel(null), 'Insufficient verified history');
});

test('buildFinancialSnapshot extracts multi-year series and calculates trends mathematically', () => {
  const sampleFacts = [
    { period: 'FY2022', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 800 } },
    { period: 'FY2023', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 940 } },
    { period: 'FY2024', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1080 } },
    { period: 'FY2025', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1270 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1480 } },
    { period: 'FY2022', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'PAT', actualValue: 100 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'PAT', actualValue: 220 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'EBITDA_MARGIN', actualValue: 24.5 } },
    { period: 'FY2022', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'DEBT', actualValue: 50 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'DEBT', actualValue: 0 } },
  ];

  const snapshot = buildFinancialSnapshot(sampleFacts);
  assert.equal(snapshot.revenueCagr, 16.63);
  assert.equal(snapshot.patCagr, 21.79);
  assert.equal(snapshot.latestEbitdaMargin, 24.5);
  assert.ok(snapshot.debtTrend.toLowerCase().includes('decreasing'));
  assert.equal(snapshot.annualSeries.length, 5);
  assert.ok(snapshot.revenueCagrFormula.includes('16.63%'));
});

test('calculateCompanyExecutionScore weights components deterministically', () => {
  const sampleFacts = [
    { period: 'FY2022', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1000 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 2000 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'PAT', actualValue: 300 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'EBITDA_MARGIN', actualValue: 26.0 } },
    { category: 'STRATEGY', title: 'Global expansion delivered', fact: 'Company launched operations in US and Europe' },
    { category: 'EXPANSION', title: 'New facility commissioned', fact: 'Completed cloud development center' },
    { category: 'OPERATIONAL_PERFORMANCE', title: 'Large deal wins', fact: 'Signed 5 major enterprise clients' }
  ];

  const samplePromises = [
    { verification: { status: 'FULFILLED' }, promise: { importance: 'HIGH' } },
    { verification: { status: 'FULFILLED' }, promise: { importance: 'MEDIUM' } },
    { verification: { status: 'PARTIALLY_FULFILLED' }, promise: { importance: 'MEDIUM' } }
  ];

  const result = calculateCompanyExecutionScore({
    facts: sampleFacts,
    promises: samplePromises,
    profile: { sector: 'IT / Software' }
  });

  assert.ok(typeof result.executionScore === 'number');
  assert.ok(result.executionScore >= 75);
  assert.equal(result.ratingLabel, 'Strong');
  assert.equal(result.weightsUsed.financialDelivery, 30);
  assert.equal(result.weightsUsed.guidanceAccuracy, 25);
});

test('calculateCompanyExecutionScore reweights proportionally when guidance is missing without penalizing company', () => {
  const sampleFacts = [
    { period: 'FY2022', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1000 } },
    { period: 'FY2024', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 1500 } },
    { period: 'FY2026', category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 2000 } }
  ];

  const result = calculateCompanyExecutionScore({
    facts: sampleFacts,
    promises: [], // No measurable promises
    profile: { sector: 'IT / Software' }
  });

  assert.ok(result.executionScore > 0);
  assert.equal(result.scoreBreakdown.guidanceAccuracy, null);
  assert.equal(result.weightsUsed.financialDelivery, 40);
  assert.equal(result.weightsUsed.strategicExecution, 25);
});

test('calculateConfidence classifies HIGH, MEDIUM, LOW coverage correctly', () => {
  const high = calculateConfidence({
    facts: new Array(25).fill({}),
    promises: new Array(5).fill({ verification: { status: 'FULFILLED' } }),
    sources: new Array(8).fill({}),
    coverageYears: ['FY2022', 'FY2023', 'FY2024', 'FY2025']
  });
  assert.equal(high.level, 'HIGH');

  const med = calculateConfidence({
    facts: new Array(10).fill({}),
    promises: [],
    sources: new Array(4).fill({}),
    coverageYears: ['FY2024', 'FY2025', 'FY2026']
  });
  assert.equal(med.level, 'MEDIUM');

  const low = calculateConfidence({
    facts: [{}],
    promises: [],
    sources: [{}],
    coverageYears: ['FY2025']
  });
  assert.equal(low.level, 'LOW');
});

test('SECTOR_METRICS returns sector-specific metric sets for IT, Banking, and Manufacturing', () => {
  const itProfile = getCompanyResearchProfile('TCS');
  assert.equal(itProfile.sector, 'IT / Software');
  assert.ok(itProfile.sectorMetrics.some(m => m.key === 'EBIT_MARGIN'));
  assert.ok(itProfile.sectorMetrics.some(m => m.key === 'DEAL_WINS'));

  const bankProfile = getCompanyResearchProfile('HDFCBANK');
  assert.equal(bankProfile.sector, 'Banking');
  assert.ok(bankProfile.sectorMetrics.some(m => m.key === 'NIM'));
  assert.ok(bankProfile.sectorMetrics.some(m => m.key === 'GNPA'));

  const mfgProfile = getCompanyResearchProfile('BHEL');
  assert.equal(mfgProfile.sector, 'Capital Goods');
  assert.ok(mfgProfile.sectorMetrics.some(m => m.key === 'ORDER_BOOK'));
});

test('deduplicateFacts removes duplicate entries across identical period and titles', () => {
  const duplicateFacts = [
    { period: 'FY2025', title: 'FY25 Revenue', fact: 'Revenue reached 1480 Cr' },
    { period: 'FY2025', title: 'FY25 Revenue', fact: 'Duplicate text' },
    { period: 'FY2024', title: 'FY24 Revenue', fact: 'Revenue reached 1244 Cr' }
  ];

  const unique = deduplicateFacts(duplicateFacts);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].period, 'FY2025');
  assert.equal(unique[1].period, 'FY2024');
});

test('a quarterly fact never becomes the fiscal year in the annual series', () => {
  const facts = [
    // Real shape from an exchange filing set: four quarters plus the full year, all labelled with the same fiscal year.
    { period: 'Q1 FY2026', metrics: { metric: 'REVENUE', actualValue: 1000 } },
    { period: 'Q2 FY2026', metrics: { metric: 'REVENUE', actualValue: 1100 } },
    { period: 'Q3 FY2026', metrics: { metric: 'REVENUE', actualValue: 1200 } },
    { period: 'Q4 FY2026', metrics: { metric: 'REVENUE', actualValue: 1300 } },
    { period: 'FY2026', metrics: { metric: 'REVENUE', actualValue: 4600 } },
    { period: 'Q4 FY2025', metrics: { metric: 'REVENUE', actualValue: 999 } },
    { period: 'FY2022', metrics: { metric: 'REVENUE', actualValue: 2300 } },
  ];
  const snapshot = buildFinancialSnapshot(facts);
  const byYear = Object.fromEntries(snapshot.annualSeries.map((row) => [row.year, row.revenue]));
  assert.equal(byYear[2026], 4600, 'the year is the full-year figure, whatever order the facts arrive in');
  assert.equal(byYear[2025], undefined, 'a year that has only a quarter has no annual value, rather than that quarter shown as the year');
  assert.deepEqual(snapshot.coveredYears, ['FY2022', 'FY2026']);
  assert.equal(snapshot.revenueCagr, calculateCagr(2300, 4600, 4), 'growth is measured between full years');

  const reversed = buildFinancialSnapshot([...facts].reverse());
  assert.equal(reversed.annualSeries.find((row) => row.year === 2026).revenue, 4600, 'order does not matter');
});

test('sub-year period labels are recognised, and full-year labels are not mistaken for them', () => {
  for (const label of ['Q1 FY2026', 'Q4FY25', 'q3 fy2024', 'H1 FY2025', '9M FY2025', 'FY2026 Q2']) assert.equal(isSubYearPeriod(label), true, label);
  for (const label of ['FY2026', 'FY25', 'FY2026 (12M)', '2025', 'FY2024-25', '', null, undefined]) assert.equal(isSubYearPeriod(label), false, String(label));
});

test('a company with only quarterly facts has no annual series, so no growth rate or score is invented from them', () => {
  const quarterly = ['Q1', 'Q2', 'Q3', 'Q4'].flatMap((q) => [2024, 2025, 2026].map((y) => ({ period: `${q} FY${y}`, category: 'FINANCIAL_PERFORMANCE', metrics: { metric: 'REVENUE', actualValue: 100 + y } })));
  const snapshot = buildFinancialSnapshot(quarterly);
  assert.equal(snapshot.annualSeries.length, 0);
  assert.equal(snapshot.revenueCagr, null);
  const result = calculateCompanyExecutionScore({ facts: quarterly, promises: [], profile: {} });
  assert.equal(result.executionScore, null);
  assert.equal(result.isInsufficient, true);
});
