import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { clearAliasCacheForTests } from '../services/CompanyAliasResolver.js';
import { searchCompanyFinancials } from '../services/CompanyFinancialsSearchService.js';

// Requires a live Mongo connection (CompanyFinancialsResolver reads
// CompanyResearchProfile) -- run with the project's dnsfix NODE_OPTIONS per
// this repo's Windows/Git-Bash test environment note. Deliberately does
// NOT set UPSTOX_ANALYTICS_TOKEN, matching this environment's real current
// state (no token until tomorrow) -- exercises the exact
// unconfigured-provider degrade path the search endpoint must survive.
dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZFINSEARCH';
const cleanup = async () => { await CompanyResearchProfile.deleteMany({ symbol: new RegExp(`^${TEST_PREFIX}`) }); };
test.beforeEach(async () => { await cleanup(); clearAliasCacheForTests(); });
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

test('required: an ambiguous query returns { ambiguous: true, candidates } without ever calling Upstox', async () => {
  await CompanyResearchProfile.create([
    { symbol: `${TEST_PREFIX}A`, companyName: 'Zzfinsearch Ambiguous Ltd.', isin: 'INEZZFINSEARCH1' },
    { symbol: `${TEST_PREFIX}B`, companyName: 'Zzfinsearch Ambiguous Ltd.', isin: 'INEZZFINSEARCH2' },
  ]);
  clearAliasCacheForTests();
  const result = await searchCompanyFinancials('Zzfinsearch Ambiguous Ltd.');
  assert.equal(result.success, true);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates.sort(), [`${TEST_PREFIX}A`, `${TEST_PREFIX}B`]);
});

test('required: an unresolvable query returns notFound:true, never a 500-shaped error', async () => {
  const result = await searchCompanyFinancials('Completely Fictitious Zzfinsearch Nonexistent Co');
  assert.equal(result.success, true);
  assert.equal(result.notFound, true);
});

test('required: a resolved symbol with no ISIN on file returns isinUnavailable:true, never a fabricated ISIN', async () => {
  await CompanyResearchProfile.create({ symbol: `${TEST_PREFIX}NOISIN`, companyName: 'Zzfinsearch No Isin Ltd.' });
  const result = await searchCompanyFinancials(`${TEST_PREFIX}NOISIN`);
  assert.equal(result.success, true);
  assert.equal(result.isinUnavailable, true);
  assert.equal(result.symbol, `${TEST_PREFIX}NOISIN`);
});

test('required: with no UPSTOX_ANALYTICS_TOKEN configured (this environment\'s real current state), search degrades to 200 with every section UNAVAILABLE/CONFIGURATION_ERROR -- never a crash, never a 500', async () => {
  assert.equal(process.env.UPSTOX_ANALYTICS_TOKEN, undefined, 'sanity: this environment has no real Upstox token yet');
  await CompanyResearchProfile.create({ symbol: `${TEST_PREFIX}OK`, companyName: 'Zzfinsearch Resolvable Ltd.', isin: 'INEZZFINSEARCH3' });

  const result = await searchCompanyFinancials(`${TEST_PREFIX}OK`);
  assert.equal(result.success, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.data.symbol, `${TEST_PREFIX}OK`);
  assert.equal(result.data.isin, 'INEZZFINSEARCH3');
  assert.equal(result.data.configurationError, true);
  assert.equal(result.data.dataCoveragePct, 0);
  assert.equal(result.data.missingSections.length, 7);
  for (const section of Object.values(result.data.sections)) {
    assert.equal(section.available, false);
    assert.equal(section.status, 'UNAVAILABLE');
    assert.equal(section.error.code, 'CONFIGURATION_ERROR');
    assert.equal(section.fromCache, false);
  }
});
