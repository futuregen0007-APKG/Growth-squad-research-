import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompanyResearch } from '../providers/indian-api/IndianApiNormalizer.js';

test('normalizeCompanyResearch never crashes and returns the full shape for a completely empty payload', () => {
  const result = normalizeCompanyResearch({});
  assert.equal(result.identity.companyName, null);
  assert.equal(result.marketSnapshot.nsePrice, null);
  assert.deepEqual(result.financials, []);
  assert.deepEqual(result.shareholding, []);
  assert.deepEqual(result.corporateActions, []);
  assert.deepEqual(result.news, []);
  assert.equal(result.profile, null);
  assert.equal(result.analystData, null);
  assert.equal(result.provenance.provider, 'indian-api');
});

test('normalizeCompanyResearch is defensive against malformed nested shapes (never throws)', () => {
  assert.doesNotThrow(() => normalizeCompanyResearch(null));
  assert.doesNotThrow(() => normalizeCompanyResearch({ companyProfile: 'not an object', financials: 'not an array', currentPrice: null }));
  const result = normalizeCompanyResearch({ companyProfile: 'not an object', financials: 'not an array' });
  assert.equal(result.profile, null);
  assert.deepEqual(result.financials, []);
});

test('normalizeCompanyResearch preserves a legitimate zero value and does not substitute it with null', () => {
  const result = normalizeCompanyResearch({ currentPrice: { BSE: 0, NSE: 0 }, percentChange: 0 });
  assert.equal(result.marketSnapshot.bsePrice, 0);
  assert.equal(result.marketSnapshot.nsePrice, 0);
  assert.equal(result.marketSnapshot.percentChange, 0);
});

test('normalizeCompanyResearch normalizes numeric strings with thousand separators', () => {
  const result = normalizeCompanyResearch({ currentPrice: { NSE: '4,120.50' } });
  assert.equal(result.marketSnapshot.nsePrice, 4120.5);
});

test('normalizeCompanyResearch drops a news entry with no title or no usable URL rather than presenting an unsourced claim', () => {
  const result = normalizeCompanyResearch({
    recentNews: [
      { title: 'Real article', url: 'https://example.com/a' },
      { title: 'No URL' },
      { url: 'https://example.com/b' }, // no title
      { title: 'Bad URL', url: 'javascript:alert(1)' },
    ],
  });
  assert.equal(result.news.length, 1);
  assert.equal(result.news[0].title, 'Real article');
});

test('normalizeCompanyResearch preserves fiscal period/date and real financial line items (IndianAPI\'s confirmed FiscalYear/EndDate/stockFinancialMap shape)', () => {
  // Field names here (FiscalYear/EndDate/StatementDate/stockFinancialMap
  // with {displayName,key,value} line items) are the REAL shape confirmed
  // against a live /stock response — not guessed. A prior version of the
  // normalizer used lower-camelCase field-name guesses (period/date/
  // fiscalYear) that never matched this real shape, so every financial
  // record's period/line-items silently came back empty — this test
  // guards against that regression.
  const result = normalizeCompanyResearch({
    financials: [{
      FiscalYear: 2025, EndDate: '2025-05-15', StatementDate: '2025-05-20', Type: 'Annual', fiscalPeriodNumber: 4,
      stockFinancialMap: { INC: [{ displayName: 'Total Revenue', key: 'TotalRevenue', value: '250000' }] },
    }],
  });
  assert.equal(result.financials[0].period, '2025');
  assert.equal(result.financials[0].date, new Date('2025-05-15').toISOString());
  assert.equal(result.financials[0].lineItems[0].displayName, 'Total Revenue');
  assert.equal(result.financials[0].lineItems[0].value, 250000);
  assert.equal(result.financials[0].raw.FiscalYear, 2025);
});
