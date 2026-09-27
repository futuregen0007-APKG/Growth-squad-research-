import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { checkKeyFor, persistReconciliationChecks } from '../scripts/verifyNseXbrlFacts.js';
import ReconciliationCheck from '../models/ReconciliationCheck.js';

/**
 * verifyNseXbrlFacts.test.js
 * ============================
 * Reconciliation differences must be visible in the data-quality status, not
 * only in a one-off JSON report that a Render Cron Job's ephemeral disk loses
 * the moment the process exits. These tests pin the persistence layer: a
 * mismatch is upserted (never duplicated on a re-run), and a check that later
 * comes back MATCH/SUM_MATCH flips back to OK in place rather than leaving a
 * stale mismatch on record forever.
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZVERIFYTEST';
const cleanup = async () => { await ReconciliationCheck.deleteMany({ symbol: TEST_SYMBOL }); };

test('checkKeyFor is a stable identity independent of run label or timestamp', () => {
  const check = {
    type: 'SOURCE_VALUE', period: 'FY2025', metric: 'REVENUE', basis: 'Consolidated',
  };
  assert.equal(checkKeyFor('TCS', check), checkKeyFor('TCS', { ...check, detail: 'anything' }));
  assert.notEqual(checkKeyFor('TCS', check), checkKeyFor('INFY', check));
  assert.notEqual(checkKeyFor('TCS', check), checkKeyFor('TCS', { ...check, period: 'FY2026' }));
});

test('persistReconciliationChecks upserts a mismatch, and a re-run with the same result never duplicates it', async (t) => {
  t.after(cleanup);
  await cleanup();
  const results = [{
    symbol: TEST_SYMBOL,
    checks: [{
      type: 'SOURCE_VALUE', period: 'FY2025', metric: 'REVENUE', basis: 'Consolidated', status: 'VALUE_MISMATCH', detail: 'stored 100, filing says 105',
    }],
  }];

  await persistReconciliationChecks(results, { label: 'run-1' });
  let docs = await ReconciliationCheck.find({ symbol: TEST_SYMBOL }).lean();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].status, 'VALUE_MISMATCH');
  assert.equal(docs[0].label, 'run-1');

  await persistReconciliationChecks(results, { label: 'run-2' });
  docs = await ReconciliationCheck.find({ symbol: TEST_SYMBOL }).lean();
  assert.equal(docs.length, 1, 'the same check identity must never be duplicated on a re-run');
  assert.equal(docs[0].label, 'run-2', 'the latest run label/verdict wins');
});

test('a check that later comes back MATCH flips the persisted record back to OK, in place', async (t) => {
  t.after(cleanup);
  await cleanup();
  const mismatching = [{
    symbol: TEST_SYMBOL,
    checks: [{
      type: 'SOURCE_VALUE', period: 'FY2025', metric: 'REVENUE', basis: 'Consolidated', status: 'VALUE_MISMATCH', detail: 'stored 100, filing says 105',
    }],
  }];
  await persistReconciliationChecks(mismatching, { label: 'run-1' });
  let doc = await ReconciliationCheck.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(doc.status, 'VALUE_MISMATCH');

  const nowMatching = [{
    symbol: TEST_SYMBOL,
    checks: [{
      type: 'SOURCE_VALUE', period: 'FY2025', metric: 'REVENUE', basis: 'Consolidated', status: 'MATCH', detail: null,
    }],
  }];
  await persistReconciliationChecks(nowMatching, { label: 'run-2' });
  doc = await ReconciliationCheck.findOne({ symbol: TEST_SYMBOL }).lean();
  assert.equal(doc.status, 'MATCH', 'a corrected/re-verified figure must resolve the persisted mismatch, not leave it stale');

  const count = await ReconciliationCheck.countDocuments({ symbol: TEST_SYMBOL });
  assert.equal(count, 1, 'still the same one record, flipped in place, not a second one');
});

test('independent checks for the same symbol (different period/metric/basis) are tracked separately', async (t) => {
  t.after(cleanup);
  await cleanup();
  const results = [{
    symbol: TEST_SYMBOL,
    checks: [
      {
        type: 'SOURCE_VALUE', period: 'FY2025', metric: 'REVENUE', basis: 'Consolidated', status: 'MATCH', detail: null,
      },
      {
        type: 'QUARTER_SUM', period: 'FY2025', metric: 'PAT', basis: 'Standalone', status: 'SUM_MISMATCH', detail: 'sum=100 vs fullYear=110',
      },
    ],
  }];
  await persistReconciliationChecks(results, { label: 'run-1' });
  const docs = await ReconciliationCheck.find({ symbol: TEST_SYMBOL }).sort({ checkType: 1 }).lean();
  assert.equal(docs.length, 2);
  assert.ok(docs.some((d) => d.checkType === 'SOURCE_VALUE' && d.status === 'MATCH'));
  assert.ok(docs.some((d) => d.checkType === 'QUARTER_SUM' && d.status === 'SUM_MISMATCH'));
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
