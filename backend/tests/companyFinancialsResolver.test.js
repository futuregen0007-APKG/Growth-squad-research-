import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { clearAliasCacheForTests } from '../services/CompanyAliasResolver.js';
import { resolveCompanyForFinancials } from '../services/CompanyFinancialsResolver.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZFINTEST';
const cleanup = async () => { await CompanyResearchProfile.deleteMany({ symbol: new RegExp(`^${TEST_PREFIX}`) }); };
test.beforeEach(async () => { await cleanup(); clearAliasCacheForTests(); });
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

test('required: exact case-insensitive symbol match resolves instantly, without needing the alias index', async () => {
  await CompanyResearchProfile.create({
    symbol: `${TEST_PREFIX}X`, companyName: 'Zzfin Test Exact Ltd.', isin: 'INEZZFINTEST01X',
  });
  const result = await resolveCompanyForFinancials(`${TEST_PREFIX.toLowerCase()}x`);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.symbol, `${TEST_PREFIX}X`);
  assert.equal(result.isin, 'INEZZFINTEST01X');
  assert.equal(result.companyName, 'Zzfin Test Exact Ltd.');
});

test('required: a free-text company-name alias resolves via CompanyAliasResolver when it is not itself a symbol', async () => {
  await CompanyResearchProfile.create({
    symbol: `${TEST_PREFIX}Y`, companyName: 'Zzfin Alias Sample Company Ltd.', isin: 'INEZZFINTEST02Y',
  });
  clearAliasCacheForTests();
  const result = await resolveCompanyForFinancials('Zzfin Alias Sample Company Ltd.');
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.symbol, `${TEST_PREFIX}Y`);
  assert.equal(result.isin, 'INEZZFINTEST02Y');
});

test('required: an ambiguous alias (shared by two real companies) is reported as ambiguous, never guessed', async () => {
  await CompanyResearchProfile.create([
    { symbol: `${TEST_PREFIX}A`, companyName: 'Zzfin Ambiguous Group Ltd.', isin: 'INEZZFINTEST03A' },
    { symbol: `${TEST_PREFIX}B`, companyName: 'Zzfin Ambiguous Group Ltd.', isin: 'INEZZFINTEST03B' },
  ]);
  clearAliasCacheForTests();
  const result = await resolveCompanyForFinancials('Zzfin Ambiguous Group Ltd.');
  assert.equal(result.status, 'AMBIGUOUS');
  assert.deepEqual(result.candidates.sort(), [`${TEST_PREFIX}A`, `${TEST_PREFIX}B`]);
});

test('required: a genuinely unresolvable company name returns NOT_FOUND, never a fabricated match', async () => {
  const result = await resolveCompanyForFinancials('Completely Fictitious Zzfin Nonexistent Enterprises');
  assert.equal(result.status, 'NOT_FOUND');
});

test('required: a resolved symbol with no ISIN on file is reported as ISIN_UNAVAILABLE, never a fabricated identifier', async () => {
  await CompanyResearchProfile.create({
    symbol: `${TEST_PREFIX}NOISIN`, companyName: 'Zzfin No Isin Ltd.', // isin intentionally omitted -> defaults to null
  });
  const result = await resolveCompanyForFinancials(`${TEST_PREFIX}NOISIN`);
  assert.equal(result.status, 'ISIN_UNAVAILABLE');
  assert.equal(result.symbol, `${TEST_PREFIX}NOISIN`);
});

test('required: empty/whitespace-only input never crashes and reports NOT_FOUND', async () => {
  assert.equal((await resolveCompanyForFinancials('')).status, 'NOT_FOUND');
  assert.equal((await resolveCompanyForFinancials('   ')).status, 'NOT_FOUND');
});
