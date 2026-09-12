import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { selectBatchSymbols, evaluateYearCoverage, FEATURED_SYMBOLS, chunk } from '../scripts/backfillUniverse.js';
import { ResearchJob } from '../models/ResearchJob.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_RANGE = { fromYear: 2090, toYear: 2094 }; // a range no real job ever uses, so tests never collide with real data
const cleanup = async () => {
  await ResearchJob.deleteMany({ ...TEST_RANGE });
  await CompanyResearchProfile.deleteMany({ symbol: { $regex: /^ZZTEST/ } });
  await CompanyHistoricalFact.deleteMany({ symbol: { $regex: /^ZZTEST/ } });
};

test('chunk splits into groups of the requested size, including a partial final group', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('--symbols bypasses all prioritization and is used verbatim', async (t) => {
  t.after(cleanup);
  await cleanup();
  const { symbols, source } = await selectBatchSymbols({ explicitSymbols: ['ZZTESTB', 'ZZTESTA'], ...TEST_RANGE, batchSize: 10 });
  assert.deepEqual(symbols, ['ZZTESTB', 'ZZTESTA'], 'explicit order must be preserved, never re-sorted');
  assert.equal(source, 'EXPLICIT');
});

test('without --symbols, incomplete featured companies come first, then the rest by real market cap descending', async (t) => {
  t.after(cleanup);
  await cleanup();
  // Astronomically-separated fake caps so the two test fixtures' relative
  // order can be asserted regardless of however many real
  // CompanyResearchProfile rows already exist in this database (e.g. from
  // an earlier `syncCompanyResearchProfiles` run) sitting between them.
  await CompanyResearchProfile.create([
    { symbol: 'ZZTESTLOW', companyName: 'Low Cap Co', researchEnabled: true, marketCapCr: 1 },
    { symbol: 'ZZTESTHIGH', companyName: 'High Cap Co', researchEnabled: true, marketCapCr: 99999999999 },
  ]);
  // Mark TCS COMPLETED for this test range -- it must then be excluded from the featured front-of-queue.
  await ResearchJob.create({ symbol: 'TCS', jobType: 'HISTORICAL_FACTS_BACKFILL', ...TEST_RANGE, status: 'COMPLETED' });

  // batchSize large enough to include every profile (real + fixtures) so
  // this only tests ORDER, never truncation.
  const { symbols } = await selectBatchSymbols({ explicitSymbols: null, ...TEST_RANGE, batchSize: 10000 });
  assert.ok(!symbols.includes('TCS'), 'a company already COMPLETED for this exact range must be skipped');
  assert.ok(FEATURED_SYMBOLS.filter((s) => s !== 'TCS').every((s) => symbols.includes(s)), 'every other featured company must still be prioritized first');
  const highIdx = symbols.indexOf('ZZTESTHIGH');
  const lowIdx = symbols.indexOf('ZZTESTLOW');
  const incompleteFeaturedCount = FEATURED_SYMBOLS.length - 1; // TCS excluded (COMPLETED)
  assert.equal(highIdx, incompleteFeaturedCount, 'the highest-market-cap non-featured company must be first in the "rest" segment, right after the featured block');
  assert.ok(highIdx !== -1 && lowIdx !== -1 && highIdx < lowIdx, 'higher real market cap must be prioritized ahead of lower');
});

test('a FAILED_PERMANENT company is excluded unless force is set', async (t) => {
  t.after(cleanup);
  await cleanup();
  await CompanyResearchProfile.create({ symbol: 'ZZTESTPERM', companyName: 'Permanently Failed Co', researchEnabled: true, marketCapCr: 5000000 });
  await ResearchJob.create({ symbol: 'ZZTESTPERM', jobType: 'HISTORICAL_FACTS_BACKFILL', ...TEST_RANGE, status: 'FAILED_PERMANENT' });

  const withoutForce = await selectBatchSymbols({ explicitSymbols: null, ...TEST_RANGE, batchSize: 20, force: false });
  assert.ok(!withoutForce.symbols.includes('ZZTESTPERM'));

  const withForce = await selectBatchSymbols({ explicitSymbols: null, ...TEST_RANGE, batchSize: 20, force: true });
  assert.ok(withForce.symbols.includes('ZZTESTPERM'), '--force must re-include a FAILED_PERMANENT company');
});

test('batch size truncates the prioritized list, never silently processing more than requested', async (t) => {
  t.after(cleanup);
  await cleanup();
  const { symbols } = await selectBatchSymbols({ explicitSymbols: null, ...TEST_RANGE, batchSize: 3 });
  assert.equal(symbols.length, 3);
  assert.deepEqual(symbols, FEATURED_SYMBOLS.slice(0, 3), 'the first 3 slots go to the incomplete featured companies');
});

test('evaluateYearCoverage never counts an OTHER-category/no-metric (news-style) fact as covering a year', async (t) => {
  t.after(cleanup);
  await cleanup();
  await CompanyHistoricalFact.create([
    {
      dataOrigin: 'REAL_RESEARCH', symbol: 'ZZTESTNEWS', companyName: 'News Only Co', date: new Date('2023-05-01'),
      period: 'FY2023', category: 'OTHER', title: 'Signed a partnership', fact: 'Signed a partnership with X.',
      metrics: { metric: null, actualValue: null }, source: { type: 'PRESS_RELEASE', title: 't', url: 'https://www.bseindia.com/x.pdf', excerpt: 'e' },
    },
    {
      dataOrigin: 'REAL_RESEARCH', symbol: 'ZZTESTNEWS', companyName: 'News Only Co', date: new Date('2024-05-01'),
      period: 'FY2024', category: 'FINANCIAL_PERFORMANCE', title: 'Operating margin', fact: 'Operating margin was 20%.',
      metrics: { metric: 'OPERATING_MARGIN', actualValue: 20 }, source: { type: 'QUARTERLY_REPORT', title: 't', url: 'https://www.bseindia.com/y.pdf', excerpt: 'e' },
    },
  ]);

  const coverage = await evaluateYearCoverage('ZZTESTNEWS', 2023, 2024);
  assert.equal(coverage.completedYears, 1, 'only FY2024 (a real validated metric) counts -- the news-only FY2023 fact does not');
  assert.deepEqual(coverage.missingYears, [2023]);
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
