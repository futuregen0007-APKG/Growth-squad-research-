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

test('normalizeCompanyResearch extracts real keyMetrics from the confirmed array-of-line-items shape (regression: a flat-object assumption previously made every category come back empty)', () => {
  // This is IndianAPI's REAL keyMetrics shape (confirmed live against TCS/HDFCBANK,
  // Sep 2026): each category is an ARRAY of {displayName, key, value} objects, the
  // same "line item" convention already used by financials[].stockFinancialMap.
  const result = normalizeCompanyResearch({
    keyMetrics: {
      margins: [
        { displayName: 'Operating margin - trailing 12 month', key: 'operatingMarginTrailing12Month', value: '23.11' },
        { displayName: 'Gross Margin - 5 year average', key: 'grossMargin5YearAverage', value: null },
      ],
      mgmtEffectiveness: [
        { displayName: 'Return on average equity - 5 year average', key: 'returnOnAverageEquity5YearAverage', value: '48.55' },
      ],
    },
  });

  assert.equal(result.keyMetrics.categories.length, 2);
  const margins = result.keyMetrics.categories.find((c) => c.category === 'margins');
  assert.ok(margins, 'margins category should be present');
  assert.equal(margins.label, 'Margins');
  assert.equal(margins.metrics.length, 1); // the null-value entry is dropped, never fabricated
  assert.equal(margins.metrics[0].name, 'Operating margin - trailing 12 month');
  assert.equal(margins.metrics[0].value, 23.11);

  const mgmt = result.keyMetrics.categories.find((c) => c.category === 'mgmtEffectiveness');
  assert.equal(mgmt.metrics[0].value, 48.55);

  // The raw, unprocessed object survives untouched regardless of the above extraction.
  assert.ok(Array.isArray(result.keyMetrics.raw.margins));
});

test('normalizeCompanyResearch keyMetrics falls back safely (never throws) if a category is a flat object instead of the confirmed array shape', () => {
  const result = normalizeCompanyResearch({
    keyMetrics: { margins: { operatingMargin: '23.11' } },
  });
  assert.equal(result.keyMetrics.categories.length, 1);
  assert.equal(result.keyMetrics.categories[0].metrics[0].name, 'operatingMargin');
  assert.equal(result.keyMetrics.categories[0].metrics[0].value, 23.11);
});

test('normalizeCompanyResearch keyMetrics never crashes and returns empty categories for missing/malformed input', () => {
  assert.deepEqual(normalizeCompanyResearch({}).keyMetrics, { categories: [], raw: null });
  assert.deepEqual(normalizeCompanyResearch({ keyMetrics: 'not an object' }).keyMetrics, { categories: [], raw: null });
  assert.deepEqual(normalizeCompanyResearch({ keyMetrics: {} }).keyMetrics.categories, []);
});
