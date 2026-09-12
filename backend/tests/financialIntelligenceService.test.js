import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinancialIntelligenceSnapshot } from '../services/FinancialIntelligenceService.js';

const annualEntry = (period, date, { revenue, netIncome, eps, longTermDebt } = {}) => ({
  period,
  date,
  statementType: 'Annual',
  lineItems: [
    ...(revenue != null ? [{ statementType: 'INC', displayName: 'Total Revenue', value: revenue }] : []),
    ...(netIncome != null ? [{ statementType: 'INC', displayName: 'Net Income', value: netIncome }] : []),
    ...(eps != null ? [{ statementType: 'INC', displayName: 'Diluted Normalized EPS', value: eps }] : []),
    ...(longTermDebt != null ? [{ statementType: 'BAL', displayName: 'Long Term Debt', value: longTermDebt }] : []),
  ],
});

test('buildFinancialIntelligenceSnapshot computes real CAGR/YoY growth from two real annual periods (TCS-shaped fixture)', () => {
  const financials = [
    annualEntry('2026', '2026-03-31', { revenue: 267021, netIncome: 49210, eps: 144.79, longTermDebt: 126 }),
    annualEntry('2025', '2025-03-31', { revenue: 255324, netIncome: 46099, eps: 136.05, longTermDebt: 150 }),
  ];
  const keyMetricsCategories = [
    { category: 'margins', metrics: [{ name: 'Operating margin - trailing 12 month', value: 23.11 }] },
  ];

  const snapshot = buildFinancialIntelligenceSnapshot({ financials, keyMetricsCategories, provider: 'indian-api', fetchedAt: '2026-09-11T00:00:00.000Z' });

  assert.equal(snapshot.dataMode, 'PROVIDER_FINANCIAL');
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.latestPeriod, 'FY2026');
  assert.equal(snapshot.revenue, 267021);
  assert.equal(snapshot.netProfit, 49210);
  assert.equal(snapshot.eps, 144.79);
  assert.equal(snapshot.operatingMargin, 23.11);
  assert.equal(snapshot.sourceProvider, 'indian-api');
  assert.equal(snapshot.fetchedAt, '2026-09-11T00:00:00.000Z');

  // revenueGrowth = (267021 - 255324) / 255324 * 100
  const expectedRevenueGrowth = Math.round(((267021 - 255324) / 255324) * 10000) / 100;
  assert.equal(snapshot.revenueGrowth, expectedRevenueGrowth);
  const expectedProfitGrowth = Math.round(((49210 - 46099) / 46099) * 10000) / 100;
  assert.equal(snapshot.netProfitGrowth, expectedProfitGrowth);
  assert.equal(snapshot.debtTrend, 'Decreasing (16%)'); // (126-150)/150 = -16%
});

test('buildFinancialIntelligenceSnapshot returns null growth fields (never fabricated) with only one annual period', () => {
  const financials = [annualEntry('2026', '2026-03-31', { revenue: 267021, netIncome: 49210 })];
  const snapshot = buildFinancialIntelligenceSnapshot({ financials });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.revenue, 267021);
  assert.equal(snapshot.revenueGrowth, null);
  assert.equal(snapshot.netProfitGrowth, null);
  assert.equal(snapshot.debtTrend, null); // no debt line item present at all
});

test('buildFinancialIntelligenceSnapshot returns all nulls (never 0) for completely empty input, and available is false', () => {
  const snapshot = buildFinancialIntelligenceSnapshot({});
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.latestPeriod, null);
  assert.equal(snapshot.revenue, null);
  assert.equal(snapshot.revenueGrowth, null);
  assert.equal(snapshot.netProfit, null);
  assert.equal(snapshot.netProfitGrowth, null);
  assert.equal(snapshot.operatingMargin, null);
  assert.equal(snapshot.eps, null);
  assert.equal(snapshot.debtTrend, null);
});

test('buildFinancialIntelligenceSnapshot never crashes on malformed/partial input and never invents a missing line item', () => {
  assert.doesNotThrow(() => buildFinancialIntelligenceSnapshot({ financials: null }));
  assert.doesNotThrow(() => buildFinancialIntelligenceSnapshot({ financials: 'not an array' }));
  assert.doesNotThrow(() => buildFinancialIntelligenceSnapshot({ financials: [{}] }));

  // A quarterly (Interim) entry, even the most recent one, must never be
  // used as "the latest period" for this year-over-year snapshot.
  const financials = [
    { period: '2027', date: '2026-06-30', statementType: 'Interim', lineItems: [{ statementType: 'INC', displayName: 'Total Revenue', value: 999999 }] },
  ];
  const snapshot = buildFinancialIntelligenceSnapshot({ financials });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.revenue, null);
});

test('buildFinancialIntelligenceSnapshot picks up Zero Debt honestly when both periods report zero', () => {
  const financials = [
    annualEntry('2026', '2026-03-31', { revenue: 100, longTermDebt: 0 }),
    annualEntry('2025', '2025-03-31', { revenue: 90, longTermDebt: 0 }),
  ];
  const snapshot = buildFinancialIntelligenceSnapshot({ financials });
  assert.equal(snapshot.debtTrend, 'Zero Debt');
});

test('buildFinancialIntelligenceSnapshot matches displayNames despite IndianAPI\'s real stray trailing whitespace (regression: an untrimmed exact match silently returned null for every field despite the data being present)', () => {
  // Confirmed live against a real TCS response: IndianAPI's raw displayName
  // strings sometimes carry a trailing space -- "Total Revenue ", "Net Income ",
  // "Diluted Normalized EPS " -- not the clean "Total Revenue" etc. used by the
  // other fixtures in this file. An untrimmed exact match against those
  // constants matched nothing at all, so this fixture deliberately reproduces
  // the real (untrimmed) shape rather than the clean one.
  const financials = [
    {
      period: '2026', date: '2026-03-31', statementType: 'Annual',
      lineItems: [
        { statementType: 'INC', displayName: 'Total Revenue ', value: 267021 },
        { statementType: 'INC', displayName: 'Net Income ', value: 49210 },
        { statementType: 'INC', displayName: 'Diluted Normalized EPS ', value: 144.79 },
        { statementType: 'BAL', displayName: 'Long Term Debt ', value: 126 },
      ],
    },
  ];
  const snapshot = buildFinancialIntelligenceSnapshot({ financials });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.revenue, 267021);
  assert.equal(snapshot.netProfit, 49210);
  assert.equal(snapshot.eps, 144.79);
});

test('buildFinancialIntelligenceSnapshot correctly reads banking-shaped line items (HDFCBANK-shaped fixture)', () => {
  const financials = [
    annualEntry('2026', '2026-03-31', { netIncome: 76025.97, eps: 49.62, longTermDebt: 588484.55 }),
    annualEntry('2025', '2025-03-31', { netIncome: 67000, eps: 44.1, longTermDebt: 500000 }),
  ];
  const snapshot = buildFinancialIntelligenceSnapshot({ financials });
  assert.equal(snapshot.netProfit, 76025.97);
  assert.equal(snapshot.eps, 49.62);
  assert.equal(snapshot.debtTrend, 'Increasing (17.7%)');
});
