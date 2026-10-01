import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFiscalYearLabel, normalizeBalanceSheet, normalizeCashFlow, normalizeIncomeStatement,
  normalizeProfile, normalizeKeyRatios, normalizeShareholding, normalizeCorporateActions,
} from '../providers/upstox/UpstoxNormalizer.js';

// FIXTURE data below is hand-authored to match the documented Upstox v2
// fundamentals response shapes -- never live-verified data (no real
// UPSTOX_ANALYTICS_TOKEN exists in this environment yet).

test('deriveFiscalYearLabel: a period ending March YYYY is FY YYYY (matches NseXbrlService fiscal-year convention)', () => {
  assert.equal(deriveFiscalYearLabel('Mar 2026'), 'FY2026');
  assert.equal(deriveFiscalYearLabel('Mar 2025'), 'FY2025');
});

test('deriveFiscalYearLabel: a period ending Apr-Dec rolls into the FOLLOWING fiscal year', () => {
  assert.equal(deriveFiscalYearLabel('Dec 2025'), 'FY2026');
  assert.equal(deriveFiscalYearLabel('Apr 2025'), 'FY2026');
  assert.equal(deriveFiscalYearLabel('Jan 2026'), 'FY2026');
});

test('deriveFiscalYearLabel: never guesses on an unparseable label', () => {
  assert.equal(deriveFiscalYearLabel('Q1 2026'), null);
  assert.equal(deriveFiscalYearLabel(''), null);
  assert.equal(deriveFiscalYearLabel(null), null);
  assert.equal(deriveFiscalYearLabel(undefined), null);
});

test('normalizeIncomeStatement: nested category/history shape maps to explicit metrics, FY-labeled, never merging consolidated/standalone or yearly/quarterly ambiguously', () => {
  // `change` is a formatted percentage STRING in Upstox's real responses
  // (confirmed live: "+12.5%", "-454.14%"), not a plain number -- this
  // fixture was fixed to match after that mismatch let a real bug through
  // (toNumberOrNull("+12.5%") is NaN because of the trailing "%", so every
  // changePct silently came back null against live data despite this
  // test, with a plain-number fixture, passing throughout).
  const raw = {
    data: {
      income_statement: [
        { category: 'revenue', history: [{ value: 250000, period: 'Mar 2026', change: '+12.5%' }, { value: 222000, period: 'Mar 2025', change: '+8.1%' }] },
        { category: 'net_profit', history: [{ value: 45000, period: 'Mar 2026', change: '-15.2%' }] },
      ],
    },
  };
  const result = normalizeIncomeStatement(raw, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });

  assert.equal(result.symbol, 'TCS');
  assert.equal(result.isin, 'INE467B01029');
  assert.equal(result.statementType, 'CONSOLIDATED');
  assert.equal(result.period, 'YEARLY');
  assert.equal(result.units, 'INR_CRORE');
  assert.equal(result.provider, 'UPSTOX');
  assert.equal(result.fetchedAt, '2026-09-29T00:00:00.000Z');

  const revenueFY2026 = result.metrics.find((m) => m.label === 'revenue' && m.financialYear === 'FY2026');
  assert.ok(revenueFY2026);
  assert.equal(revenueFY2026.value, 250000);
  assert.equal(revenueFY2026.changePct, 12.5);

  const netProfitFY2026 = result.metrics.find((m) => m.label === 'net_profit' && m.financialYear === 'FY2026');
  assert.ok(netProfitFY2026);
  assert.equal(netProfitFY2026.value, 45000);
  assert.equal(netProfitFY2026.changePct, -15.2, 'a negative percentage string parses correctly too');

  assert.ok(result.raw, 'raw response preserved for debugging');
});

test('normalizeBalanceSheet: flat per-period shape extracts every real field as its own metric, no fabrication', () => {
  const raw = {
    data: {
      type: 'consolidated',
      time_period: 'yearly',
      units_in: 'crore',
      history: [
        { period: 'Mar 2026', total_asset: 500000, total_liability: 300000 },
        { period: 'Mar 2025', total_asset: 450000, total_liability: 280000 },
      ],
    },
  };
  const result = normalizeBalanceSheet(raw, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });

  const totalAssetFY2026 = result.metrics.find((m) => m.label === 'total_asset' && m.financialYear === 'FY2026');
  assert.equal(totalAssetFY2026.value, 500000);
  const totalLiabilityFY2025 = result.metrics.find((m) => m.label === 'total_liability' && m.financialYear === 'FY2025');
  assert.equal(totalLiabilityFY2025.value, 280000);
  // The flat shape carries no per-field change value -- never fabricated as a number.
  assert.equal(totalAssetFY2026.changePct, null);
});

test('normalizeCashFlow: a missing/null value from Upstox stays null, never substituted with 0', () => {
  const raw = {
    data: {
      cash_flow: [
        { category: 'Operating', history: [{ value: 60000, period: 'Mar 2026', change: 5 }] },
        { category: 'Investing', history: [{ value: null, period: 'Mar 2026', change: null }] },
        { category: 'Financing', history: [{ value: 'NA', period: 'Mar 2026', change: 'NA' }] },
      ],
    },
  };
  const result = normalizeCashFlow(raw, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });

  const operating = result.metrics.find((m) => m.label === 'operating');
  assert.equal(operating.value, 60000);

  const investing = result.metrics.find((m) => m.label === 'investing');
  assert.equal(investing.value, null, 'a null upstream value must stay null');

  const financing = result.metrics.find((m) => m.label === 'financing');
  assert.equal(financing.value, null, 'a non-numeric "NA" value must stay null, never 0');
});

test('normalizeProfile: sector market cap is labeled as SECTOR market cap, never company market cap', () => {
  const raw = {
    data: {
      company_profile: 'A leading IT services company.',
      sector: 'Information Technology',
      sector_market_cap_inr: { value: 1500000, unit: 'Cr', formatted: '₹15,00,000 Cr' },
      sector_market_cap_usd: { value: 180000, unit: 'Mn', formatted: '$180,000 Mn' },
    },
  };
  const result = normalizeProfile(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z' });

  assert.equal(result.sector, 'Information Technology');
  assert.equal(result.sectorMarketCapInr.value, 1500000);
  // Field name itself must never claim to be the company's market cap.
  assert.ok('sectorMarketCapInr' in result);
  assert.ok(!('marketCapInr' in result));
  assert.ok(!('companyMarketCapInr' in result));
});

test('normalizeKeyRatios: company_value and sector_value stay clearly separate fields', () => {
  const raw = { data: [{ name: 'P/E', company_value: 28.4, sector_value: 24.1 }, { name: 'ROE', company_value: 32.5, sector_value: null }] };
  const result = normalizeKeyRatios(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z' });

  const pe = result.ratios.find((r) => r.name === 'P/E');
  assert.equal(pe.companyValue, 28.4);
  assert.equal(pe.sectorValue, 24.1);
  const roe = result.ratios.find((r) => r.name === 'ROE');
  assert.equal(roe.sectorValue, null);
});

test('normalizeShareholding: ownership % preserved per category and period', () => {
  const raw = { data: [{ category: 'promoters', history: [{ period: 'Sep 2025', value: 72.3 }] }] };
  const result = normalizeShareholding(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z' });
  assert.equal(result.categories[0].category, 'promoters');
  assert.equal(result.categories[0].history[0].valuePct, 72.3);
});

test('normalizeCorporateActions: rejects entries without a name, never fabricates one', () => {
  const raw = { data: [{ name: 'Final Dividend', expiry_date: '2026-06-01', amount: 28, ratio: null, event_details: [] }, { amount: 10 }] };
  const result = normalizeCorporateActions(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z' });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].name, 'Final Dividend');
});

test('normalizeIncomeStatement: consolidated and standalone are kept as distinct top-level tags, never merged', () => {
  const raw = { data: { income_statement: [{ category: 'revenue', history: [{ value: 100, period: 'Mar 2026', change: 1 }] }] } };
  const consolidated = normalizeIncomeStatement(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated' });
  const standalone = normalizeIncomeStatement(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'standalone' });
  assert.equal(consolidated.statementType, 'CONSOLIDATED');
  assert.equal(standalone.statementType, 'STANDALONE');
});
