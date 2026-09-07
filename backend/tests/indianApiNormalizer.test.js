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

test('normalizeCompanyResearch preserves fiscal period/date and full raw payload on generic entries', () => {
  const result = normalizeCompanyResearch({
    financials: [{ period: 'FY2025', date: '2025-05-15', revenue: 250000, someUnknownField: 'x' }],
  });
  assert.equal(result.financials[0].period, 'FY2025');
  assert.equal(result.financials[0].date, new Date('2025-05-15').toISOString());
  assert.equal(result.financials[0].raw.revenue, 250000);
  assert.equal(result.financials[0].raw.someUnknownField, 'x');
});
