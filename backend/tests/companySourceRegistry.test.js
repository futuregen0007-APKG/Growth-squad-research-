import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_RESEARCH_PROFILES,
  getCompanyResearchProfile,
  getRegisteredCompanyProfile,
  getCompanySourceRegistry,
  getSupportedResearchSymbols,
  normalizeResearchSymbol,
  validateCompanyResearchProfile,
} from '../research/CompanyResearchProfiles.js';

const TARGET_SYMBOLS = ['NEWGEN', 'TCS', 'HDFCBANK', 'ICICIBANK', 'BHEL', 'LT', 'HAL'];

const EXPECTED_EXCHANGE_IDS = {
  NEWGEN: { nseSymbol: 'NEWGEN', bseCode: '540900' },
  TCS: { nseSymbol: 'TCS', bseCode: '532540' },
  HDFCBANK: { nseSymbol: 'HDFCBANK', bseCode: '500180' },
  ICICIBANK: { nseSymbol: 'ICICIBANK', bseCode: '532174' },
  BHEL: { nseSymbol: 'BHEL', bseCode: '500103' },
  LT: { nseSymbol: 'LT', bseCode: '500510' },
  HAL: { nseSymbol: 'HAL', bseCode: '541154' },
};

const APPROVED_HOSTNAME_FRAGMENTS = [
  'newgensoft.com',
  'tcs.com',
  'hdfc.bank.in',
  'icici.bank.in',
  'bhel.com',
  'larsentoubro.com',
  'hal-india.co.in',
  'nseindia.com',
  'bseindia.com',
];

// 1 & 2. Every target symbol returns the correct profile with correct NSE/BSE identifiers.
test('every target symbol resolves to a profile with correct NSE/BSE identifiers', () => {
  for (const symbol of TARGET_SYMBOLS) {
    const profile = getCompanyResearchProfile(symbol);
    assert.equal(profile.symbol, symbol, `${symbol}: symbol mismatch`);
    assert.equal(profile.exchangeIdentifiers.nseSymbol, EXPECTED_EXCHANGE_IDS[symbol].nseSymbol, `${symbol}: NSE symbol mismatch`);
    assert.equal(profile.exchangeIdentifiers.bseCode, EXPECTED_EXCHANGE_IDS[symbol].bseCode, `${symbol}: BSE code mismatch`);
    assert.equal(profile.exchangeSymbols.NSE, EXPECTED_EXCHANGE_IDS[symbol].nseSymbol, `${symbol}: legacy NSE field mismatch`);
    assert.equal(profile.exchangeSymbols.BSE, EXPECTED_EXCHANGE_IDS[symbol].bseCode, `${symbol}: legacy BSE field mismatch`);

    const registered = getRegisteredCompanyProfile(symbol);
    assert.ok(registered, `${symbol}: getRegisteredCompanyProfile should not be null`);
    assert.equal(registered.symbol, symbol);
  }
});

// 3 & 13. Aliases normalize correctly, and LT's aliases never collide with another symbol.
test('normalizeResearchSymbol resolves case-insensitive symbols and aliases, including LT/L&T/LARSEN', () => {
  assert.equal(normalizeResearchSymbol('lt'), 'LT');
  assert.equal(normalizeResearchSymbol('L&T'), 'LT');
  assert.equal(normalizeResearchSymbol('L & T'), 'LT');
  assert.equal(normalizeResearchSymbol('Larsen'), 'LT');
  assert.equal(normalizeResearchSymbol('Larsen & Toubro'), 'LT');
  assert.equal(normalizeResearchSymbol('  larsen and toubro  '), 'LT');

  assert.equal(normalizeResearchSymbol('newgen'), 'NEWGEN');
  assert.equal(normalizeResearchSymbol('Newgen Software'), 'NEWGEN');
  assert.equal(normalizeResearchSymbol('hal'), 'HAL');
  assert.equal(normalizeResearchSymbol('Hindustan Aeronautics'), 'HAL');
});

test('LT aliases never resolve unrelated NSE tickers (LTIM, LTTS, LTF) to LT', () => {
  // These are real, distinct NSE symbols; the alias index must never fuzzy-match them.
  assert.notEqual(normalizeResearchSymbol('LTIM'), 'LT');
  assert.notEqual(normalizeResearchSymbol('LTTS'), 'LT');
  assert.notEqual(normalizeResearchSymbol('LTF'), 'LT');
  // None of them are in the curated registry at all, so they should resolve to null.
  assert.equal(normalizeResearchSymbol('LTIM'), null);
  assert.equal(normalizeResearchSymbol('LTTS'), null);
  assert.equal(normalizeResearchSymbol('LTF'), null);
});

// 4. Unknown companies do not produce fake profiles.
test('unknown symbols never produce a fabricated registry profile', () => {
  assert.equal(normalizeResearchSymbol('ZZNOTREAL'), null);
  assert.equal(getRegisteredCompanyProfile('ZZNOTREAL'), null);
  assert.equal(getCompanySourceRegistry('ZZNOTREAL'), null);
});

test('getCompanyResearchProfile no longer fabricates IR URLs for symbols outside the curated registry', () => {
  // WIPRO is a real SUPPORTED_STOCKS ticker but has no curated CompanyResearchProfiles entry.
  const profile = getCompanyResearchProfile('WIPRO', 'Wipro', 'IT / Software');
  assert.equal(profile.symbol, 'WIPRO');
  assert.equal(profile.sourceRegistryVerified, false);
  assert.deepEqual(profile.investorRelationsUrls, []);
  assert.deepEqual(profile.annualReportUrls, []);
  assert.deepEqual(profile.sourceRegistry.investorRelations, []);
  assert.deepEqual(profile.sourceRegistry.annualReports, []);
  // The NSE exchange-filing URL pattern is deterministic/official, so it is still populated.
  assert.ok(profile.sourceRegistry.exchangeFilings.nse.length > 0);
  assert.ok(profile.sourceRegistry.exchangeFilings.nse[0].startsWith('https://www.nseindia.com/'));
});

// 5. Every configured URL is valid and uses an approved official domain.
test('every URL configured for the seven target companies is a valid, approved-domain HTTPS URL', () => {
  for (const symbol of TARGET_SYMBOLS) {
    const profile = COMPANY_RESEARCH_PROFILES[symbol];
    const result = validateCompanyResearchProfile(profile);
    assert.deepEqual(result.errors, [], `${symbol}: unexpected validation errors: ${result.errors.join('; ')}`);

    const allUrls = [
      ...profile.sourceRegistry.investorRelations,
      ...profile.sourceRegistry.financialResults,
      ...profile.sourceRegistry.annualReports,
      ...profile.sourceRegistry.earningsPresentations,
      ...profile.sourceRegistry.earningsTranscripts,
      ...profile.sourceRegistry.exchangeFilings.nse,
      ...profile.sourceRegistry.exchangeFilings.bse,
    ];
    assert.ok(allUrls.length > 0, `${symbol}: should have at least one configured source URL`);

    for (const url of allUrls) {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, 'https:', `${symbol}: ${url} should be HTTPS`);
      const isApproved = APPROVED_HOSTNAME_FRAGMENTS.some((fragment) => parsed.hostname.endsWith(fragment));
      assert.ok(isApproved, `${symbol}: ${url} is not on an approved official domain`);
    }
  }
});

test('validateCompanyResearchProfile rejects aggregator/news domains and non-HTTP(S) URLs', () => {
  const badProfile = {
    symbol: 'TEST',
    companyName: 'Test Co',
    sourceRegistry: {
      investorRelations: ['https://www.moneycontrol.com/test'],
      financialResults: ['ftp://example.com/file.pdf'],
      annualReports: [],
      earningsPresentations: [],
      earningsTranscripts: [],
      exchangeFilings: { nse: [], bse: [] },
    },
  };
  const result = validateCompanyResearchProfile(badProfile);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('moneycontrol.com')));
  assert.ok(result.errors.some((e) => e.includes('ftp://example.com/file.pdf')));
});

// 6. Duplicate URLs are removed.
test('sourceRegistry URLs are deduplicated and normalized for each target company', () => {
  for (const symbol of TARGET_SYMBOLS) {
    const registry = getCompanySourceRegistry(symbol);
    for (const field of ['investorRelations', 'financialResults', 'annualReports', 'earningsPresentations', 'earningsTranscripts']) {
      const list = registry[field];
      assert.equal(new Set(list).size, list.length, `${symbol}.${field}: contains duplicates`);
    }
  }
});

test('getCompanyResearchProfile derives deduplicated flat URL lists from sourceRegistry', () => {
  const profile = getCompanyResearchProfile('NEWGEN');
  assert.equal(new Set(profile.investorRelationsUrls).size, profile.investorRelationsUrls.length);
  assert.equal(new Set(profile.annualReportUrls).size, profile.annualReportUrls.length);
});

// 12. Bank profiles use banking-specific metrics, not generic/manufacturing metrics.
test('bank profiles use banking-specific sector metrics, not generic or capital-goods metrics', () => {
  for (const symbol of ['HDFCBANK', 'ICICIBANK']) {
    const profile = getCompanyResearchProfile(symbol);
    assert.equal(profile.sector, 'Banking');
    const keys = profile.sectorMetrics.map((m) => m.key);
    assert.ok(keys.includes('NIM'), `${symbol}: missing NIM metric`);
    assert.ok(keys.includes('GNPA'), `${symbol}: missing GNPA metric`);
    assert.ok(!keys.includes('ORDER_BOOK'), `${symbol}: should not use capital-goods order-book metric`);
  }
});

test('getSupportedResearchSymbols includes all seven target companies', () => {
  const symbols = getSupportedResearchSymbols();
  for (const symbol of TARGET_SYMBOLS) {
    assert.ok(symbols.includes(symbol), `${symbol} missing from getSupportedResearchSymbols()`);
  }
});

test('getRegisteredCompanyProfile returns a defensive copy that cannot mutate the stored profile', () => {
  const profile = getRegisteredCompanyProfile('NEWGEN');
  const originalCount = COMPANY_RESEARCH_PROFILES.NEWGEN.sourceRegistry.investorRelations.length;

  profile.sourceRegistry.investorRelations.push('https://example.com/should-not-persist.pdf');
  profile.aliases.push('Should Not Persist');

  assert.equal(COMPANY_RESEARCH_PROFILES.NEWGEN.sourceRegistry.investorRelations.length, originalCount);
  assert.ok(!COMPANY_RESEARCH_PROFILES.NEWGEN.aliases.includes('Should Not Persist'));
});
