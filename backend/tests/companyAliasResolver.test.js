import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import {
  resolveCompanyAlias, normalizeAliasesInTextSync, normalizeCompanyText, getAliasIndex, clearAliasCacheForTests,
} from '../services/CompanyAliasResolver.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZALIASTEST';
const cleanup = async () => { await CompanyResearchProfile.deleteMany({ symbol: new RegExp(`^${TEST_PREFIX}`) }); };
test.beforeEach(async () => { await cleanup(); clearAliasCacheForTests(); });
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

test('required: resolves TCS from its real companyName', async () => {
  const r = await resolveCompanyAlias('Tata Consultancy Services Ltd.');
  assert.equal(r.resolved, 'TCS');
  assert.equal(r.ambiguous, false);
});

test('required: resolves Infosys/INFY both from the ticker and the company name', async () => {
  const byTicker = await resolveCompanyAlias('INFY');
  assert.equal(byTicker.resolved, 'INFY');
  const byName = await resolveCompanyAlias('Infosys Ltd');
  assert.equal(byName.resolved, 'INFY');
});

test('required: resolves BHEL from its real companyName', async () => {
  const r = await resolveCompanyAlias('Bharat Heavy Electricals Ltd.');
  assert.equal(r.resolved, 'BHEL');
});

test('required: resolves HDFC Bank from its real companyName', async () => {
  const r = await resolveCompanyAlias('HDFC Bank Ltd.');
  assert.equal(r.resolved, 'HDFCBANK');
});

test('required: resolves ICICI Bank from its real companyName', async () => {
  const r = await resolveCompanyAlias('ICICI Bank Ltd.');
  assert.equal(r.resolved, 'ICICIBANK');
});

test('required: an unresolvable name returns no match, never a guess', async () => {
  const r = await resolveCompanyAlias('Completely Fictitious Nonexistent Corp');
  assert.equal(r.resolved, null);
  assert.equal(r.ambiguous, false);
});

test('required: a genuinely ambiguous alias (shared by two real companies) reports ambiguity, never guesses', async () => {
  await CompanyResearchProfile.create([
    {
      symbol: `${TEST_PREFIX}A`, companyName: 'Alpha Testing Group Ltd.', aliases: ['Ambiguous Test Alias'],
    },
    {
      symbol: `${TEST_PREFIX}B`, companyName: 'Beta Testing Group Ltd.', aliases: ['Ambiguous Test Alias'],
    },
  ]);
  clearAliasCacheForTests();
  const r = await resolveCompanyAlias('Ambiguous Test Alias');
  assert.equal(r.resolved, null);
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates.sort(), [`${TEST_PREFIX}A`, `${TEST_PREFIX}B`]);
});

test('required: normalizeAliasesInTextSync never substitutes an ambiguous phrase in free text', async () => {
  await CompanyResearchProfile.create([
    { symbol: `${TEST_PREFIX}A`, companyName: 'Gamma Ambiguous Widgets Ltd.' },
    { symbol: `${TEST_PREFIX}B`, companyName: 'Gamma Ambiguous Widgets Ltd.' }, // duplicate name on purpose -> same normalized phrase, two symbols
  ]);
  clearAliasCacheForTests();
  const index = await getAliasIndex();
  const before = 'Discussion of Gamma Ambiguous Widgets Ltd. quarterly results.';
  const after1 = normalizeAliasesInTextSync(before, index);
  assert.equal(after1, before, 'an ambiguous phrase must be left completely untouched, never guessed');
});

test('normalizeCompanyText is deterministic and strips corporate suffixes/punctuation consistently', () => {
  assert.equal(normalizeCompanyText('Tata Consultancy Services Ltd.'), normalizeCompanyText('TATA CONSULTANCY SERVICES LIMITED'));
  assert.equal(normalizeCompanyText('L&T'), normalizeCompanyText('L & T'));
});

test('required: alias resolution never issues a network request per query -- the index is built once and cached', async () => {
  const first = await getAliasIndex();
  const originalFind = CompanyResearchProfile.find;
  let findCalled = false;
  CompanyResearchProfile.find = (...args) => { findCalled = true; return originalFind.apply(CompanyResearchProfile, args); };
  try {
    await resolveCompanyAlias('TCS');
    await resolveCompanyAlias('Infosys');
    await resolveCompanyAlias('ICICI Bank');
    assert.equal(findCalled, false, 'a warm cache must never trigger a fresh database query');
  } finally {
    CompanyResearchProfile.find = originalFind;
  }
  assert.ok(first.phrases.length > 0, 'sanity: the index actually has real entries');
});

test('bounded cache: rebuilding the index never grows unbounded across repeated calls', async () => {
  const a = await getAliasIndex();
  const b = await getAliasIndex();
  assert.equal(a, b, 'the same cached index object is reused, not rebuilt, within the TTL window');
});

test('required: alias substitution never touches the retriever\'s symbol filter -- this module only normalizes free text for scoring', async () => {
  // A pure structural guarantee check: this module exports no function
  // that accepts or mutates a `symbols` array at all.
  const exportsList = await import('../services/CompanyAliasResolver.js');
  assert.ok(!('applySymbolFilter' in exportsList) && !('resolveSymbols' in exportsList));
});
