import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStockUniverseSummary } from '../routes/goals.js';

const baseRecommendation = (overrides = {}) => ({
  universeCount: 205,
  evaluatedCount: 200,
  eligibleCount: 0,
  rejectionCounts: {
    INSUFFICIENT_HISTORY: 0, AWAITING_FUNDAMENTALS: 0, STALE_DATA: 0, RISK_MISMATCH: 0, HORIZON_MISMATCH: 0, INVALID_METRICS: 0, PROVIDER_UNAVAILABLE: 0,
  },
  recommendations: [],
  ...overrides,
});

test('status is UNAVAILABLE when no stock passes eligibility, with explicit missingDataReasons', () => {
  const recommendation = baseRecommendation({
    rejectionCounts: {
      INSUFFICIENT_HISTORY: 150, AWAITING_FUNDAMENTALS: 40, STALE_DATA: 0, RISK_MISMATCH: 10, HORIZON_MISMATCH: 0, INVALID_METRICS: 0, PROVIDER_UNAVAILABLE: 0,
    },
  });
  const contract = buildStockUniverseSummary(recommendation, 205);
  assert.equal(contract.status, 'UNAVAILABLE');
  assert.equal(contract.stocks.length, 0);
  assert.deepEqual(contract.missingDataReasons, [
    { reasonCode: 'INSUFFICIENT_HISTORY', count: 150 },
    { reasonCode: 'AWAITING_FUNDAMENTALS', count: 40 },
    { reasonCode: 'RISK_MISMATCH', count: 10 },
  ]);
});

test('status is PARTIAL when some stocks are eligible but not the whole universe was evaluated', () => {
  const recommendation = baseRecommendation({
    universeCount: 205,
    evaluatedCount: 180, // 25 stocks never got evaluated (e.g. provider errors)
    eligibleCount: 3,
    recommendations: [
      {
        symbol: 'TCS', companyName: 'Tata Consultancy Services', goalFitScore: 82, price: 3100, risk: 'MODERATE',
        availableMetrics: ['volatility', 'revenueGrowth', 'operatingMargin'], missingMetrics: ['oneYearReturn', 'maxDrawdown', 'valuation', 'quality', 'profitGrowth', 'debtTrend'],
        fundamentals: { source: 'REAL_RESEARCH_DERIVED', sourceUrl: null, dataAsOf: '2026-04-09T00:00:00.000Z', isStale: false, provenance: { sourceType: 'REAL_RESEARCH CompanyHistoricalFact' } },
        historical: { source: 'Angel One historical candles' },
        reasons: ['18.5% measured annualized volatility was included.', 'Data coverage: 33% of verified metrics available.'],
      },
    ],
  });
  const contract = buildStockUniverseSummary(recommendation, 205);
  assert.equal(contract.status, 'PARTIAL');
  assert.equal(contract.stocks.length, 1);
  assert.equal(contract.stocks[0].symbol, 'TCS');
  assert.equal(contract.stocks[0].score, 82);
  assert.equal(contract.stocks[0].goalFit, 82);
  assert.equal(contract.stocks[0].currentPrice, 3100);
  assert.equal(contract.stocks[0].riskLevel, 'MODERATE');
  assert.deepEqual(contract.stocks[0].metricsUsed, ['volatility', 'revenueGrowth', 'operatingMargin']);
  assert.equal(contract.stocks[0].source.fundamentalSource, 'REAL_RESEARCH_DERIVED');
  assert.equal(contract.dataAsOf, '2026-04-09T00:00:00.000Z');
});

test('status is AVAILABLE when eligible stocks exist and the full universe was evaluated', () => {
  const recommendation = baseRecommendation({
    universeCount: 10, evaluatedCount: 10, eligibleCount: 2,
    recommendations: [
      { symbol: 'A', companyName: 'A Ltd', goalFitScore: 90, price: 0, risk: 'LOW', availableMetrics: [], missingMetrics: [], fundamentals: {}, historical: {}, reasons: [] },
      { symbol: 'B', companyName: 'B Ltd', goalFitScore: 70, price: 50, risk: 'MODERATE', availableMetrics: [], missingMetrics: [], fundamentals: {}, historical: {}, reasons: [] },
    ],
  });
  const contract = buildStockUniverseSummary(recommendation, 10);
  assert.equal(contract.status, 'AVAILABLE');
  assert.equal(contract.stocks.length, 2);
  // currentPrice is omitted (not just null) when the price is not a real
  // verified positive number -- "currentPrice when verified".
  assert.equal('currentPrice' in contract.stocks[0], false);
  assert.equal(contract.stocks[1].currentPrice, 50);
});

test('reasons are capped at 3 and falsy entries are filtered out', () => {
  const recommendation = baseRecommendation({
    universeCount: 1, evaluatedCount: 1, eligibleCount: 1,
    recommendations: [{
      symbol: 'X', companyName: 'X Ltd', goalFitScore: 80, price: 10, risk: 'LOW',
      availableMetrics: [], missingMetrics: [], fundamentals: {}, historical: {},
      reasons: ['r1', null, 'r2', 'r3', 'r4'],
    }],
  });
  const contract = buildStockUniverseSummary(recommendation, 1);
  assert.deepEqual(contract.stocks[0].reasons, ['r1', 'r2', 'r3']);
});
