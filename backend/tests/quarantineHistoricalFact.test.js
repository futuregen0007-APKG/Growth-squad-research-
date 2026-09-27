import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import { quarantineFact, unquarantineFact } from '../scripts/quarantineHistoricalFact.js';

/**
 * quarantineHistoricalFact.test.js
 * ===================================
 * A quarantined fact was read correctly from its source but is excluded
 * from coverage/answers because the value itself is implausible. These pin
 * that quarantining never touches the stored value, matches only the exact
 * fact identified, requires a reason, and that it reverses cleanly.
 *
 * Requires a local MongoDB (same convention as the rest of the DB-touching
 * suite); skips if one is not reachable.
 */

const FACT = {
  dataOrigin: 'REAL_RESEARCH',
  symbol: 'ZZQTEST',
  companyName: 'ZZ Quarantine Test Ltd',
  date: new Date('2022-05-27T00:00:00Z'),
  period: 'Q4 FY2022',
  category: 'FINANCIAL_PERFORMANCE',
  title: 'Q4 FY2022 Revenue from operations',
  fact: 'ZZ Quarantine Test Ltd reported Revenue from operations of 29.53 INR_CRORE for Q4 FY2022 (Consolidated, Un-Audited).',
  metrics: {
    metric: 'REVENUE', actualValue: 29.53, unit: 'INR_CRORE', currency: 'INR',
  },
  source: {
    type: 'QUARTERLY_REPORT', title: 'ZZQTEST Q4 FY2022 results (NSE XBRL filing)', url: 'https://nsearchives.nseindia.com/corporate/xbrl/ZZQTEST_TEST_ONLY.xml', publishedAt: new Date('2022-05-27T00:00:00Z'), excerpt: 'Revenue from operations: 295300000 INR (XBRL tag RevenueFromOperations, context OneD 2022-01-01..2022-03-31)',
  },
  confidence: 0.99,
  verified: true,
};

test('quarantineFact marks the exact fact and never touches its stored value; unquarantineFact reverses it', async (t) => {
  try { await mongoose.connect('mongodb://127.0.0.1:27017/stock_market_ai', { serverSelectionTimeoutMS: 3000 }); } catch (err) { t.skip(`local MongoDB unavailable: ${err.message}`); return; }
  await CompanyHistoricalFact.deleteMany({ symbol: 'ZZQTEST' });
  try {
    const saved = await CompanyHistoricalFact.create(FACT);
    assert.equal(saved.quarantine.quarantined, false, 'a freshly stored fact is not quarantined by default');

    const modified = await quarantineFact({
      symbol: 'ZZQTEST', period: 'Q4 FY2022', metric: 'REVENUE', sourceUrl: FACT.source.url, reason: 'Test: filer-side XBRL scale error, confirmed against sibling quarters.',
    });
    assert.equal(modified, 1);

    const after = await CompanyHistoricalFact.findOne({ symbol: 'ZZQTEST' }).lean();
    assert.equal(after.quarantine.quarantined, true);
    assert.match(after.quarantine.reason, /filer-side XBRL scale error/);
    assert.ok(after.quarantine.quarantinedAt instanceof Date);
    assert.equal(after.metrics.actualValue, 29.53, 'the stored value itself is never modified by quarantining');
    assert.equal(after.fact, FACT.fact, 'the narrative text is never modified either');

    const restored = await unquarantineFact({
      symbol: 'ZZQTEST', period: 'Q4 FY2022', metric: 'REVENUE', sourceUrl: FACT.source.url,
    });
    assert.equal(restored, 1);
    const final = await CompanyHistoricalFact.findOne({ symbol: 'ZZQTEST' }).lean();
    assert.equal(final.quarantine.quarantined, false);
    assert.equal(final.quarantine.reason, null);
  } finally {
    await CompanyHistoricalFact.deleteMany({ symbol: 'ZZQTEST' });
    await mongoose.disconnect();
  }
});

test('quarantineFact refuses to run without a reason', async (t) => {
  try { await mongoose.connect('mongodb://127.0.0.1:27017/stock_market_ai', { serverSelectionTimeoutMS: 3000 }); } catch (err) { t.skip(`local MongoDB unavailable: ${err.message}`); return; }
  try {
    await assert.rejects(
      () => quarantineFact({
        symbol: 'ZZQTEST', period: 'Q4 FY2022', metric: 'REVENUE', sourceUrl: FACT.source.url, reason: '',
      }),
      /reason is required/,
    );
  } finally {
    await mongoose.disconnect();
  }
});

test('quarantineFact matches only the exact fact key, never a different period or metric for the same symbol/url', async (t) => {
  try { await mongoose.connect('mongodb://127.0.0.1:27017/stock_market_ai', { serverSelectionTimeoutMS: 3000 }); } catch (err) { t.skip(`local MongoDB unavailable: ${err.message}`); return; }
  await CompanyHistoricalFact.deleteMany({ symbol: 'ZZQTEST' });
  try {
    await CompanyHistoricalFact.create(FACT); // REVENUE, Q4 FY2022
    await CompanyHistoricalFact.create({
      ...FACT, title: 'Q4 FY2022 Profit for the period', metrics: { ...FACT.metrics, metric: 'PAT', actualValue: 2.42 }, fact: 'ZZ Quarantine Test Ltd reported Profit for the period of 2.42 INR_CRORE for Q4 FY2022 (Consolidated, Un-Audited).',
    }); // PAT, same period/url -- a sibling fact that must be untouched

    await quarantineFact({
      symbol: 'ZZQTEST', period: 'Q4 FY2022', metric: 'REVENUE', sourceUrl: FACT.source.url, reason: 'Test.',
    });

    const revenue = await CompanyHistoricalFact.findOne({ symbol: 'ZZQTEST', 'metrics.metric': 'REVENUE' }).lean();
    const pat = await CompanyHistoricalFact.findOne({ symbol: 'ZZQTEST', 'metrics.metric': 'PAT' }).lean();
    assert.equal(revenue.quarantine.quarantined, true);
    assert.equal(pat.quarantine.quarantined, false, 'a sibling metric from the same document is not quarantined unless done so explicitly');
  } finally {
    await CompanyHistoricalFact.deleteMany({ symbol: 'ZZQTEST' });
    await mongoose.disconnect();
  }
});
