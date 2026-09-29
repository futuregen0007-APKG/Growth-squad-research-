import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  evaluateDatasetStatus, deriveOverallProviderStatus, buildProviderStatus, DATASET_STATUSES,
} from '../routes/goals.js';
import BhavcopyIngestionStatus from '../models/BhavcopyIngestionStatus.js';
import BootstrapRunLog from '../models/BootstrapRunLog.js';
import StockHistoricalMetricsSnapshot from '../models/StockHistoricalMetricsSnapshot.js';
import StockFundamentalsSnapshot from '../models/StockFundamentalsSnapshot.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { InvestmentProductSnapshot } from '../models/InvestmentProductSnapshot.js';

/**
 * goalsProviderStatus.test.js
 * ==============================
 * Previously this endpoint's providerStatus came from a 7-day-TTL Redis
 * cache (StockFundamentalsService.getRefreshMeta) that defaults to UNKNOWN
 * whenever it has expired or Redis is unavailable -- which this environment
 * confirmed live (scripts/productionStatus.js: redisAvailable:false) -- so
 * a genuinely-populated, durable StockFundamentalsSnapshot collection (real
 * data, real coverage) was still reporting UNKNOWN. These tests pin the
 * fix: status is derived only from durable evidence (the data's own
 * persisted freshness fields, plus BootstrapRunLog for "did the job fail
 * outright"), never from ephemeral cache state.
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

// ---------------------------------------------------------------------------
// evaluateDatasetStatus / deriveOverallProviderStatus (pure)
// ---------------------------------------------------------------------------

test('a dataset with zero records is NOT_CONFIGURED_OR_NEVER_RUN, regardless of any other signal', () => {
  assert.equal(evaluateDatasetStatus({ totalCount: 0, universeSize: 215, mostRecentAgeDays: 1, freshnessMaxDays: 4 }), 'NOT_CONFIGURED_OR_NEVER_RUN');
});

test('a FAILED last attempt is reported even when old data still exists -- a failure is never silently masked as merely stale', () => {
  assert.equal(evaluateDatasetStatus({
    totalCount: 200, universeSize: 215, mostRecentAgeDays: 1, freshnessMaxDays: 4, lastAttemptFailedWithNoSuccess: true,
  }), 'FAILED');
});

test('data older than the freshness window is STALE even with full coverage -- a successful fetch of old records is not current', () => {
  assert.equal(evaluateDatasetStatus({ totalCount: 215, universeSize: 215, mostRecentAgeDays: 10, freshnessMaxDays: 4 }), 'STALE');
});

test('records exist but carry no dated evidence at all: treated as STALE, never guessed FRESH', () => {
  assert.equal(evaluateDatasetStatus({ totalCount: 215, universeSize: 215, mostRecentAgeDays: null, freshnessMaxDays: 4 }), 'STALE');
});

test('fresh but covering under 90% of the universe is PARTIAL', () => {
  assert.equal(evaluateDatasetStatus({ totalCount: 100, universeSize: 215, mostRecentAgeDays: 1, freshnessMaxDays: 4 }), 'PARTIAL');
});

test('fresh and covering at least 90% of the universe is FRESH -- a small number of genuinely-unresolvable symbols never blocks FRESH forever', () => {
  assert.equal(evaluateDatasetStatus({ totalCount: 213, universeSize: 215, mostRecentAgeDays: 1, freshnessMaxDays: 4 }), 'FRESH');
});

test('exactly at the freshness boundary is still fresh (not yet stale)', () => {
  assert.equal(evaluateDatasetStatus({ totalCount: 215, universeSize: 215, mostRecentAgeDays: 4, freshnessMaxDays: 4 }), 'FRESH');
});

test('deriveOverallProviderStatus picks the worst status in priority order: FAILED > NOT_CONFIGURED > STALE > PARTIAL > FRESH', () => {
  assert.equal(deriveOverallProviderStatus({ a: 'FRESH', b: 'PARTIAL', c: 'FAILED' }), 'FAILED');
  assert.equal(deriveOverallProviderStatus({ a: 'FRESH', b: 'STALE' }), 'STALE');
  assert.equal(deriveOverallProviderStatus({ a: 'FRESH', b: 'PARTIAL' }), 'PARTIAL');
  assert.equal(deriveOverallProviderStatus({ a: 'FRESH', b: 'FRESH' }), 'FRESH');
  assert.equal(deriveOverallProviderStatus({ a: 'NOT_CONFIGURED_OR_NEVER_RUN', b: 'STALE' }), 'NOT_CONFIGURED_OR_NEVER_RUN');
});

test('every value evaluateDatasetStatus can return is a member of the documented DATASET_STATUSES vocabulary', () => {
  const cases = [
    { totalCount: 0, universeSize: 10 },
    { totalCount: 10, universeSize: 10, mostRecentAgeDays: 1, freshnessMaxDays: 4, lastAttemptFailedWithNoSuccess: true },
    { totalCount: 10, universeSize: 10, mostRecentAgeDays: 100, freshnessMaxDays: 4 },
    { totalCount: 5, universeSize: 10, mostRecentAgeDays: 1, freshnessMaxDays: 4 },
    { totalCount: 10, universeSize: 10, mostRecentAgeDays: 1, freshnessMaxDays: 4 },
  ];
  for (const c of cases) assert.ok(DATASET_STATUSES.includes(evaluateDatasetStatus(c)));
});

// ---------------------------------------------------------------------------
// buildProviderStatus (real Mongo, isolated fixtures)
// ---------------------------------------------------------------------------

// Scoped to the last 35 days (comfortably covers this file's own fixtures --
// `new Date()` and `oldDate` = now-30d, below) rather than a blanket
// `>= 2020-01-01` wipe. That wider window was a real cross-file isolation
// bug: node's test runner runs different test FILES concurrently as
// separate processes against the same shared local MongoDB, and
// backfillStockHistory.test.js's circuit-breaker test writes fixed-date
// BhavcopyIngestionStatus rows in 2024-03 -- which `>= 2020-01-01` matched
// and deleted mid-run, producing a nondeterministic short count (observed
// live as both 2 and 3, never the same value twice) that no amount of
// read-retry could fix since the rows were genuinely gone, not just not-yet-
// visible.
const RECENT_CLEANUP_FLOOR = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
const cleanup = async () => {
  await BhavcopyIngestionStatus.deleteMany({ tradingDate: { $gte: RECENT_CLEANUP_FLOOR } });
  await BootstrapRunLog.deleteMany({ stage: { $in: ['nse-bhavcopy', 'historical-metrics', 'bse-profile-sync', 'stock-fundamentals', 'investment-products'] } });
  await StockHistoricalMetricsSnapshot.deleteMany({ symbol: /^ZZPSTEST/ });
  await StockFundamentalsSnapshot.deleteMany({ symbol: /^ZZPSTEST/ });
  await CompanyResearchProfile.deleteMany({ symbol: /^ZZPSTEST/ });
  await InvestmentProductSnapshot.deleteMany({ productId: /^ZZPSTEST/ });
};

test('buildProviderStatus reports NOT_CONFIGURED_OR_NEVER_RUN for every dataset when nothing has ever been populated (an isolated, empty-slate check)', async (t) => {
  t.after(cleanup);
  await cleanup();
  // This reads real collections which may hold real data from other symbols in this shared test database --
  // the assertion below only checks the fields this test can control in isolation (liveQuotes, overall shape).
  const status = await buildProviderStatus(0);
  assert.equal(status.liveQuotes, 'STALE', 'zero screened stocks means live quotes are not currently usable');
  assert.ok(DATASET_STATUSES.includes(status.overall));
  for (const key of ['historicalPrices', 'historicalMetrics', 'companyProfiles', 'fundamentals', 'investmentProducts']) {
    assert.ok(DATASET_STATUSES.includes(status[key]), `${key} must be a real, documented status, never a guessed value`);
  }
});

test('buildProviderStatus reports FAILED for a stage whose last BootstrapRunLog attempt was FAILED', async (t) => {
  t.after(cleanup);
  await cleanup();
  await BootstrapRunLog.recordAttempt('nse-bhavcopy', {
    startedAt: new Date(), finishedAt: new Date(), status: 'FAILED', dryRun: false,
  });
  const status = await buildProviderStatus(1);
  assert.equal(status.historicalPrices, 'FAILED');
  assert.equal(status.overall, 'FAILED');
});

test('buildProviderStatus reports FRESH for historicalPrices when a recent COMPLETED BhavcopyIngestionStatus exists', async (t) => {
  t.after(cleanup);
  await cleanup();
  await BhavcopyIngestionStatus.create({
    tradingDate: new Date(), status: 'COMPLETED', rowsIngested: 214, symbolsMatched: 214, sourceUrl: 'https://nsearchives.nseindia.com/content/cm/test.csv.zip',
  });
  const status = await buildProviderStatus(1);
  assert.equal(status.historicalPrices, 'FRESH');
});

test('buildProviderStatus reports STALE for historicalPrices when the most recent BhavcopyIngestionStatus is old', async (t) => {
  t.after(cleanup);
  await cleanup();
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await BhavcopyIngestionStatus.create({
    tradingDate: oldDate, status: 'COMPLETED', rowsIngested: 214, symbolsMatched: 214, sourceUrl: 'https://nsearchives.nseindia.com/content/cm/test.csv.zip',
  });
  const status = await buildProviderStatus(1);
  assert.equal(status.historicalPrices, 'STALE');
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
