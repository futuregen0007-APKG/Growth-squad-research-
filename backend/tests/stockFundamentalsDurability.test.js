import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { getFundamentals, fetchAndCacheFundamentals } from '../services/StockFundamentalsService.js';
import StockFundamentalsSnapshot from '../models/StockFundamentalsSnapshot.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import { deriveFundamentalsFromHistoricalFacts } from '../services/HistoricalFundamentalsDerivationService.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZTESTFUNDDURABILITY';
const cleanup = async () => {
  await StockFundamentalsSnapshot.deleteMany({ symbol: TEST_SYMBOL });
  await CompanyHistoricalFact.deleteMany({ symbol: TEST_SYMBOL });
};

test('getFundamentals falls back to a fresh MongoDB snapshot when Redis is empty (a Redis miss must never mean "no fundamentals")', async (t) => {
  t.after(cleanup);
  await cleanup();
  await StockFundamentalsSnapshot.create({
    symbol: TEST_SYMBOL, peRatio: 24.5, roe: 18.2, source: 'INDIAN_API', sourceUrl: 'indian-api',
    dataAsOf: new Date(), lastSuccessfulRefresh: new Date(), missingMetrics: [],
  });

  const getCacheFn = async () => null; // simulates an empty/unavailable Redis
  const result = await getFundamentals(TEST_SYMBOL, { getCacheFn });
  assert.ok(result, 'a Redis miss must fall through to the durable Mongo snapshot, not return null');
  assert.equal(result.pe, 24.5);
  assert.equal(result.roe, 18.2);
  assert.equal(result.isStale, false);
  assert.equal(result.source, 'INDIAN_API');
});

test('getFundamentals marks an old snapshot isStale but still returns it (stale-but-verified beats nothing)', async (t) => {
  t.after(cleanup);
  await cleanup();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days old
  await StockFundamentalsSnapshot.create({
    symbol: TEST_SYMBOL, peRatio: 19, roe: 12, source: 'INDIAN_API', sourceUrl: 'indian-api',
    dataAsOf: old, lastSuccessfulRefresh: old, missingMetrics: [],
  });

  const result = await getFundamentals(TEST_SYMBOL, { getCacheFn: async () => null });
  assert.ok(result);
  assert.equal(result.isStale, true, 'a 30-day-old snapshot must be flagged stale');
  assert.equal(result.pe, 19, 'the stale value is still real and still returned, never discarded');
});

test('getFundamentals derives from REAL_RESEARCH CompanyHistoricalFact when IndianAPI is rate-limited and no Mongo snapshot exists yet', async (t) => {
  t.after(cleanup);
  await cleanup();
  await CompanyHistoricalFact.create([
    {
      dataOrigin: 'REAL_RESEARCH', symbol: TEST_SYMBOL, companyName: 'ZZ Test Co',
      date: new Date('2023-04-10'), period: 'FY2023', category: 'FINANCIAL_PERFORMANCE',
      title: 'FY2023 revenue', fact: 'Revenue was 1000 crore.',
      metrics: { metric: 'REVENUE', actualValue: 1000, unit: 'INR_CRORE' },
      source: { type: 'EARNINGS_CALL_TRANSCRIPT', title: 'FY23 call', url: 'https://example.com/fy23.pdf', publishedAt: new Date('2023-04-10'), excerpt: 'Revenue was 1000 crore.' },
      confidence: 0.9,
    },
    {
      dataOrigin: 'REAL_RESEARCH', symbol: TEST_SYMBOL, companyName: 'ZZ Test Co',
      date: new Date('2024-04-10'), period: 'FY2024', category: 'FINANCIAL_PERFORMANCE',
      title: 'FY2024 revenue', fact: 'Revenue was 1300 crore.',
      metrics: { metric: 'REVENUE', actualValue: 1300, unit: 'INR_CRORE' },
      source: { type: 'EARNINGS_CALL_TRANSCRIPT', title: 'FY24 call', url: 'https://example.com/fy24.pdf', publishedAt: new Date('2024-04-10'), excerpt: 'Revenue was 1300 crore.' },
      confidence: 0.9,
    },
  ]);

  // IndianAPI itself is simulated as rate-limited by never providing a getCacheFn hit and
  // relying purely on the real deriveFundamentalsFromHistoricalFacts fallback.
  const result = await getFundamentals(TEST_SYMBOL, { getCacheFn: async () => null });
  assert.ok(result, 'REAL_RESEARCH facts must produce usable fundamentals when IndianAPI has nothing');
  assert.equal(result.source, 'REAL_RESEARCH_DERIVED');
  assert.equal(result.pe, null, 'P/E must never be derived from facts alone');
  assert.equal(result.roe, null, 'ROE must never be invented');
  assert.equal(result.revenueGrowth, 30, '(1300/1000 - 1) * 100 = 30% growth over one year');
  assert.ok(result.provenance.sourceUrls.includes('https://example.com/fy23.pdf'));
  assert.ok(result.provenance.sourceUrls.includes('https://example.com/fy24.pdf'));

  // The derivation is also persisted durably so a second call doesn't need to re-derive.
  const persisted = await StockFundamentalsSnapshot.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.ok(persisted, 'a successful derivation must be saved to Mongo for future reads');
  assert.equal(persisted.revenueGrowth, 30);
});

test('getFundamentals returns null (never a fabricated object) when nothing is available in any tier', async (t) => {
  t.after(cleanup);
  await cleanup();
  const result = await getFundamentals(TEST_SYMBOL, { getCacheFn: async () => null });
  assert.equal(result, null);
});

test('deriveFundamentalsFromHistoricalFacts never invents pe/roe and returns null when the symbol has no annual facts at all', async (t) => {
  t.after(cleanup);
  await cleanup();
  const result = await deriveFundamentalsFromHistoricalFacts(TEST_SYMBOL);
  assert.equal(result, null);
});

test('a real existing fundamentals metric is never overwritten by a later fetch that returns null for it', async (t) => {
  t.after(cleanup);
  await cleanup();
  const setCacheFn = async () => {}; // Redis irrelevant to this test -- only the durable snapshot matters here

  await fetchAndCacheFundamentals(TEST_SYMBOL, {
    getKeyMetricsFn: async () => ({ data: { categories: [{ category: 'valuation', metrics: [{ name: 'P/E', value: 22 }] }, { category: 'mgmtEffectiveness', metrics: [{ name: 'Return on average equity', value: 15 }] }] } }),
    skipDelay: true,
    setCacheFn,
  });
  let snapshot = await StockFundamentalsSnapshot.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(snapshot.peRatio, 22);
  assert.equal(snapshot.roe, 15);

  // A later refresh only returns P/E this time (ROE line item temporarily
  // absent from the provider's payload) -- ROE must survive untouched.
  await fetchAndCacheFundamentals(TEST_SYMBOL, {
    getKeyMetricsFn: async () => ({ data: { categories: [{ category: 'valuation', metrics: [{ name: 'P/E', value: 23.5 }] }] } }),
    skipDelay: true,
    setCacheFn,
  });
  snapshot = await StockFundamentalsSnapshot.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(snapshot.peRatio, 23.5, 'P/E updates to the newly fetched real value');
  assert.equal(snapshot.roe, 15, 'ROE must never be reset to null just because this refresh omitted it');
});

test('null/undefined fundamentals are never converted to zero when persisted', async (t) => {
  t.after(cleanup);
  await cleanup();
  await fetchAndCacheFundamentals(TEST_SYMBOL, {
    getKeyMetricsFn: async () => ({ data: { categories: [] } }), // no matching P/E or ROE line items at all
    skipDelay: true,
    setCacheFn: async () => {},
  });
  // Nothing extracted (pe/roe both null) -- extractFundamentalsFromKeyMetrics
  // returning null for both means fetchAndCacheFundamentals's own guard
  // (`extracted.pe != null || extracted.roe != null`) never calls
  // persistSnapshotFn at all, so no snapshot should exist yet.
  const snapshot = await StockFundamentalsSnapshot.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(snapshot, null, 'a fetch with nothing real to report must never create a snapshot with zeroed-out fields');
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
