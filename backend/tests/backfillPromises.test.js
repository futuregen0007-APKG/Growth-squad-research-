import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { resetPromiseExtractionStatus } from '../scripts/backfillPromises.js';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZTESTRESETSCOPE';

const seedDoc = (fiscalYear, suffix) => ({
  symbol: TEST_SYMBOL,
  companyName: 'ZZ Test Reset Scope Co',
  fiscalYear,
  sourceType: 'EARNINGS_CALL_TRANSCRIPT',
  url: `https://example.com/${TEST_SYMBOL}-${fiscalYear}-${suffix}.pdf`,
  publicationDate: new Date('2024-01-01'),
  extractionStatus: 'EXTRACTED',
  promiseExtractionStatus: 'EXTRACTED',
});

const cleanup = async () => { await CompanyDocumentRegistry.deleteMany({ symbol: TEST_SYMBOL }); };

test('resetPromiseExtractionStatus scoped to fromYear/toYear resets only documents in that range, never the whole symbol', async (t) => {
  t.after(cleanup);
  await cleanup();
  await CompanyDocumentRegistry.create([
    seedDoc('FY2023', 'a'),
    seedDoc('FY2024', 'a'),
    seedDoc('FY2026', 'a'), // outside the reset range -- must stay EXTRACTED
    seedDoc('FY2027', 'a'), // outside the reset range -- must stay EXTRACTED
  ]);

  const result = await resetPromiseExtractionStatus(TEST_SYMBOL, { fromYear: 2022, toYear: 2025 });
  assert.equal(result.scoped, true);
  assert.equal(result.modifiedCount, 2, 'only the FY2023 and FY2024 documents should be reset');

  const docs = await CompanyDocumentRegistry.find({ symbol: TEST_SYMBOL }).sort({ fiscalYear: 1 }).lean();
  const byFY = Object.fromEntries(docs.map((d) => [d.fiscalYear, d.promiseExtractionStatus]));
  assert.equal(byFY.FY2023, 'PENDING');
  assert.equal(byFY.FY2024, 'PENDING');
  assert.equal(byFY.FY2026, 'EXTRACTED', 'a document outside the requested range must never be reset');
  assert.equal(byFY.FY2027, 'EXTRACTED', 'a document outside the requested range must never be reset');
});

test('resetPromiseExtractionStatus without fromYear/toYear resets every document for the symbol (explicit, unscoped opt-in)', async (t) => {
  t.after(cleanup);
  await cleanup();
  await CompanyDocumentRegistry.create([seedDoc('FY2023', 'a'), seedDoc('FY2026', 'a')]);

  const result = await resetPromiseExtractionStatus(TEST_SYMBOL, {});
  assert.equal(result.scoped, false);
  assert.equal(result.modifiedCount, 2);
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
