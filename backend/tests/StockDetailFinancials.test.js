import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBalanceSheet, normalizeCashFlow, normalizeIncomeStatement, normalizeKeyRatios, normalizeProfile,
} from '../providers/upstox/UpstoxNormalizer.js';
import {
  getStockDetailFinancials, buildStockDetailFinancials, selectVerifiedGrowth,
} from '../services/StockDetailFinancials.js';

// Fixtures: REAL raw Upstox responses captured live for TCS (ISIN
// INE467B01029), FY2023-FY2026, run through the real normalizers -- the
// search function itself is stubbed so no network/Mongo/Redis is touched.
const TCS_INCOME_RAW = {
  data: {
    type: 'consolidated',
    time_period: 'yearly',
    units_in: 'crore',
    income_statement: [
      { category: 'revenue', history: [{ value: 271423, period: 'Mar 2026', change: '+4.68%' }, { value: 259286, period: 'Mar 2025', change: '+5.7%' }, { value: 245315, period: 'Mar 2024', change: '+7.17%' }, { value: 228907, period: 'Mar 2023' }] },
      { category: 'operating_profit', history: [{ value: 65487, period: 'Mar 2026', change: '+0.24%' }, { value: 65331, period: 'Mar 2025', change: '+5.38%' }, { value: 61997, period: 'Mar 2024', change: '+8.94%' }, { value: 56907, period: 'Mar 2023' }] },
      { category: 'net_profit', history: [{ value: 49454, period: 'Mar 2026', change: '+1.35%' }, { value: 48797, period: 'Mar 2025', change: '+5.85%' }, { value: 46099, period: 'Mar 2024', change: '+8.97%' }, { value: 42303, period: 'Mar 2023' }] },
    ],
    full_statement: [
      { particular: 'Revenue', history: [{ value: 267021, period: 'Mar 2026' }, { value: 255324, period: 'Mar 2025' }, { value: 240893, period: 'Mar 2024' }, { value: 225458, period: 'Mar 2023' }] },
      { particular: 'Total Revenue', history: [{ value: 271423, period: 'Mar 2026' }, { value: 259286, period: 'Mar 2025' }, { value: 245315, period: 'Mar 2024' }, { value: 228907, period: 'Mar 2023' }] },
      { particular: 'Profit Before Tax', history: [{ value: 65487, period: 'Mar 2026' }, { value: 65331, period: 'Mar 2025' }, { value: 61997, period: 'Mar 2024' }, { value: 56907, period: 'Mar 2023' }] },
      { particular: 'Profit After Tax', history: [{ value: 49454, period: 'Mar 2026' }, { value: 48797, period: 'Mar 2025' }, { value: 46099, period: 'Mar 2024' }, { value: 42303, period: 'Mar 2023' }] },
      { particular: 'EPS - Basic', history: [{ value: 136.01, period: 'Mar 2026' }, { value: 134.19, period: 'Mar 2025' }, { value: 125.88, period: 'Mar 2024' }, { value: 115.19, period: 'Mar 2023' }] },
      { particular: 'EPS - Diluted', history: [{ value: 136.01, period: 'Mar 2026' }, { value: 134.19, period: 'Mar 2025' }, { value: 125.88, period: 'Mar 2024' }, { value: 115.19, period: 'Mar 2023' }] },
    ],
  },
};
const TCS_BALANCE_RAW = {
  data: {
    type: 'consolidated', time_period: 'yearly', units_in: 'crore',
    history: [
      { total_asset: 182372, total_liability: 73894, period: 'Mar 2026' },
      { total_asset: 159629, total_liability: 63858, period: 'Mar 2025' },
      { total_asset: 146449, total_liability: 55130, period: 'Mar 2024' },
      { total_asset: 143651, total_liability: 52445, period: 'Mar 2023' },
    ],
  },
};
const TCS_CASHFLOW_RAW = {
  data: {
    type: 'consolidated', time_period: 'yearly', units_in: 'crore',
    cash_flow: [
      { category: 'operating', history: [{ value: 52094, period: 'Mar 2026', change: '+6.51%' }, { value: 48908, period: 'Mar 2025', change: '+10.31%' }] },
      { category: 'investing', history: [{ value: -12845, period: 'Mar 2026', change: '-454.14%' }, { value: -2318, period: 'Mar 2025', change: '-138.47%' }] },
      { category: 'financing', history: [{ value: -42133, period: 'Mar 2026', change: '+11.18%' }, { value: -47438, period: 'Mar 2025', change: '+2.26%' }] },
    ],
  },
};
const TCS_RATIOS_RAW = {
  data: [
    { name: 'P/E', company_value: '14.82', sector_value: '64.68' },
    { name: 'ROE', company_value: '45.89%', sector_value: '8.65%' },
    { name: 'ROCE', company_value: '40.54%', sector_value: '71.3%' },
  ],
};
const TCS_PROFILE_RAW = {
  data: {
    company_profile: 'Tata Consultancy Services Ltd is an India-based company engaged in providing information technology (IT) services, consulting, and business solutions.',
    sector: 'Information Technology',
    sector_market_cap_inr: { value: 1500000, unit: 'Cr', formatted: '₹15,00,000 Cr' },
  },
};

const FETCHED_AT = '2026-10-01T07:40:44.314Z';
const ctx = { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: FETCHED_AT, statementType: 'consolidated', period: 'YEARLY' };
const section = (data, { fromCache = false } = {}) => ({
  available: true, data, status: 'AVAILABLE', error: null, asOf: data.fetchedAt, fromCache,
});
const failedSection = (code = 'UPSTREAM_UNAVAILABLE', message = 'Upstox request failed') => ({
  available: false, data: null, status: 'PROVIDER_ERROR', error: { code, message }, asOf: null, fromCache: false,
});

const tcsSearchResult = ({ fromCache = false, overrides = {} } = {}) => ({
  success: true,
  ambiguous: false,
  data: {
    symbol: 'TCS',
    companyName: 'Tata Consultancy Services Ltd.',
    isin: 'INE467B01029',
    provider: 'UPSTOX',
    sections: {
      profile: section(normalizeProfile(TCS_PROFILE_RAW, ctx), { fromCache }),
      incomeStatement: section(normalizeIncomeStatement(TCS_INCOME_RAW, ctx), { fromCache }),
      balanceSheet: section(normalizeBalanceSheet(TCS_BALANCE_RAW, ctx), { fromCache }),
      cashFlow: section(normalizeCashFlow(TCS_CASHFLOW_RAW, ctx), { fromCache }),
      keyRatios: section(normalizeKeyRatios(TCS_RATIOS_RAW, ctx), { fromCache }),
      shareholding: failedSection(),
      corporateActions: failedSection(),
      ...overrides,
    },
    missingSections: [],
    dataCoveragePct: 100,
  },
});

const findRow = (block, label, fy) => block.rows.find((r) => r.label === label && r.financialYear === fy);

test('mapping: income statement rows carry verified labels, INR_CRORE unit, financial year and changePct; operating_profit is labeled Profit before tax, never EBITDA/operating profit', async () => {
  const result = await getStockDetailFinancials('TCS', { search: async () => tcsSearchResult() });
  assert.equal(result.provider, 'UPSTOX');
  assert.equal(result.status, 'AVAILABLE');
  const income = result.annualFinancials.incomeStatement;

  const revenue = findRow(income, 'revenue', 'FY2026');
  assert.equal(revenue.value, 271423);
  assert.equal(revenue.changePct, 4.68);
  assert.equal(revenue.unit, 'INR_CRORE');
  assert.equal(revenue.verifiedDefinition, 'TOTAL_INCOME');
  assert.equal(revenue.verifiedLabel, 'Total income');

  const pbt = findRow(income, 'operating_profit', 'FY2025');
  assert.equal(pbt.value, 65331);
  assert.equal(pbt.verifiedDefinition, 'PROFIT_BEFORE_TAX');
  assert.equal(pbt.displayLabel, 'Profit before tax');
  assert.ok(!income.rows.some((r) => /ebitda|operating profit/i.test(r.displayLabel)));

  const pat = findRow(income, 'net_profit', 'FY2024');
  assert.equal(pat.value, 46099);
  assert.equal(pat.verifiedLabel, 'Profit after tax (consolidated)');

  const unavailable = Object.fromEntries(income.unavailableMetrics.map((m) => [m.key, m]));
  assert.match(unavailable.ebitda.reason, /not provided by this data source/i);
  assert.match(unavailable.adjusted_pat.reason, /no verified adjusted-PAT definition from this provider/i);
});

test('mapping: balance sheet -> Total Assets / Total Liabilities (never "Debt"); cash flow -> Operating/Investing/Financing cash flow (never CapEx); Debt/Deposits/CapEx withheld with reasons', async () => {
  const result = await getStockDetailFinancials('TCS', { search: async () => tcsSearchResult() });
  const bs = result.annualFinancials.balanceSheet;
  assert.equal(findRow(bs, 'total_asset', 'FY2026').displayLabel, 'Total Assets');
  assert.equal(findRow(bs, 'total_asset', 'FY2026').value, 182372);
  assert.equal(findRow(bs, 'total_liability', 'FY2023').displayLabel, 'Total Liabilities');
  assert.equal(findRow(bs, 'total_liability', 'FY2023').value, 52445);
  assert.ok(bs.rows.every((r) => r.unit === 'INR_CRORE'));
  assert.ok(!bs.rows.some((r) => /debt|borrow/i.test(r.displayLabel)));
  const bsUnavailable = bs.unavailableMetrics.map((m) => m.key);
  assert.deepEqual(bsUnavailable.sort(), ['debt', 'deposits']);
  assert.ok(bs.unavailableMetrics.every((m) => m.reason.length > 20));

  const cf = result.annualFinancials.cashFlow;
  assert.equal(findRow(cf, 'investing', 'FY2026').displayLabel, 'Investing cash flow');
  assert.equal(findRow(cf, 'investing', 'FY2026').value, -12845);
  assert.equal(findRow(cf, 'financing', 'FY2025').displayLabel, 'Financing cash flow');
  assert.equal(findRow(cf, 'financing', 'FY2025').value, -47438);
  assert.equal(findRow(cf, 'operating', 'FY2026').displayLabel, 'Operating cash flow');
  assert.ok(!cf.rows.some((r) => /capex/i.test(r.displayLabel)));
  assert.match(cf.unavailableMetrics.find((m) => m.key === 'capex').reason, /not provided by this data source/i);
});

test('mapping: perShareFinancials carries real TCS EPS as INR_PER_SHARE, separate from the crore rows', async () => {
  const result = await getStockDetailFinancials('TCS', { search: async () => tcsSearchResult() });
  const basic = result.perShareFinancials.find((m) => m.label === 'eps_basic' && m.financialYear === 'FY2026');
  assert.equal(basic.value, 136.01);
  assert.equal(basic.unit, 'INR_PER_SHARE');
  assert.equal(result.perShareFinancials.length, 8);
  for (const block of Object.values(result.annualFinancials)) {
    assert.ok(!block.rows.some((r) => /eps/i.test(r.label)));
    assert.ok(block.rows.every((r) => r.unit === 'INR_CRORE'));
  }
});

test('currentRatios: point-in-time only -- never carries a financialYear, and ROE/ROCE never appear in the annual rows', async () => {
  const result = await getStockDetailFinancials('TCS', { search: async () => tcsSearchResult() });
  assert.equal(result.currentRatios.pointInTime, true);
  assert.equal(result.currentRatios.asOf, FETCHED_AT);
  assert.ok(result.currentRatios.ratios.length === 3);
  for (const ratio of result.currentRatios.ratios) {
    assert.ok(!('financialYear' in ratio), `${ratio.name} must not carry a financialYear`);
  }
  assert.ok(!('financialYear' in result.currentRatios));
  const roe = result.currentRatios.ratios.find((r) => r.name === 'ROE');
  assert.equal(roe.companyValue, 45.89);
  assert.equal(roe.companyValueUnit, 'PERCENT');
  for (const block of Object.values(result.annualFinancials)) {
    assert.ok(!block.rows.some((r) => /^(roe|roce|nim|net_npa|casa)$/i.test(r.label)));
  }
  assert.equal(result.valuation.pe, 14.82);
});

test('profile: description and sector from Upstox; sector market cap is never surfaced as company data', async () => {
  const result = await getStockDetailFinancials('TCS', { search: async () => tcsSearchResult() });
  assert.match(result.profile.description, /^Tata Consultancy Services Ltd is an India-based company/);
  assert.equal(result.profile.sector, 'Information Technology');
  assert.ok(!JSON.stringify(result).includes('sectorMarketCap'));
  assert.ok(!JSON.stringify(result).includes('1500000'));
});

test('growthInputs: most recent verified changePct whose prior year shares the same definition (TCS FY2026: revenue +4.68, PAT +1.35)', async () => {
  const result = await getStockDetailFinancials('TCS', { search: async () => tcsSearchResult() });
  assert.equal(result.growthInputs.revenueGrowth.value, 4.68);
  assert.equal(result.growthInputs.revenueGrowth.financialYear, 'FY2026');
  assert.equal(result.growthInputs.revenueGrowth.verifiedDefinition, 'TOTAL_INCOME');
  assert.equal(result.growthInputs.profitGrowth.value, 1.35);
});

test('growthInputs: an unverified revenue definition is never used as growth', () => {
  const rows = [
    { label: 'revenue', financialYear: 'FY2026', verifiedDefinition: null, changePct: 10 },
    { label: 'revenue', financialYear: 'FY2025', verifiedDefinition: null, changePct: 5 },
  ];
  assert.equal(selectVerifiedGrowth(rows, 'revenue'), null);
  // Definition changed year-over-year -> the change compares unlike figures; skipped.
  const mixed = [
    { label: 'revenue', financialYear: 'FY2026', verifiedDefinition: 'TOTAL_INCOME', changePct: 10 },
    { label: 'revenue', financialYear: 'FY2025', verifiedDefinition: 'REVENUE_FROM_OPERATIONS', changePct: 5 },
  ];
  assert.equal(selectVerifiedGrowth(mixed, 'revenue'), null);
});

test('provider failure: a thrown/failed Upstox search yields every section UNAVAILABLE with the error, no rows, no P/E, no growth -- never stale data', async () => {
  const result = await getStockDetailFinancials('TCS', {
    search: async () => { const e = new Error('Upstox 503'); e.errorCode = 'UPSTREAM_UNAVAILABLE'; throw e; },
  });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.error.code, 'UPSTREAM_UNAVAILABLE');
  for (const block of Object.values(result.annualFinancials)) {
    assert.equal(block.status, 'UNAVAILABLE');
    assert.equal(block.error.code, 'UPSTREAM_UNAVAILABLE');
    assert.deepEqual(block.rows, []);
  }
  assert.deepEqual(result.perShareFinancials, []);
  assert.deepEqual(result.currentRatios.ratios, []);
  assert.equal(result.profile.description, null);
  assert.equal(result.valuation.pe, null);
  assert.equal(result.growthInputs.revenueGrowth, null);
  assert.equal(result.growthInputs.profitGrowth, null);
});

test('provider failure: a timeout is reported as TIMEOUT, never waited on indefinitely', async () => {
  const result = await getStockDetailFinancials('TCS', { search: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(result.annualFinancials.incomeStatement.status, 'UNAVAILABLE');
  assert.equal(result.growthInputs.revenueGrowth, null);
});

test('provider failure: one failed section (income statement) blanks only that section and its growth/EPS, other sections stay', async () => {
  const result = await getStockDetailFinancials('TCS', {
    search: async () => tcsSearchResult({ overrides: { incomeStatement: failedSection('RATE_LIMITED', 'Upstox rate limited') } }),
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.annualFinancials.incomeStatement.status, 'PROVIDER_ERROR');
  assert.equal(result.annualFinancials.incomeStatement.error.code, 'RATE_LIMITED');
  assert.deepEqual(result.annualFinancials.incomeStatement.rows, []);
  assert.deepEqual(result.perShareFinancials, []);
  assert.equal(result.growthInputs.revenueGrowth, null);
  assert.equal(result.annualFinancials.balanceSheet.status, 'AVAILABLE');
  assert.equal(result.valuation.pe, 14.82);
});

test('unconfigured / unresolved: configuration error and ISIN-unavailable both degrade to UNAVAILABLE with a specific error', () => {
  const unresolved = buildStockDetailFinancials({ success: true, isinUnavailable: true, symbol: 'ZZZ' });
  assert.equal(unresolved.status, 'UNAVAILABLE');
  assert.equal(unresolved.annualFinancials.balanceSheet.error.code, 'ISIN_UNAVAILABLE');
  const notFound = buildStockDetailFinancials({ success: true, notFound: true });
  assert.equal(notFound.currentRatios.error.code, 'NOT_RESOLVED');
});

test('cache hit: fromCache:true is preserved per section along with the ORIGINAL asOf (never relabeled as a fresh fetch)', async () => {
  const result = await getStockDetailFinancials('TCS', { search: async () => tcsSearchResult({ fromCache: true }) });
  for (const block of [result.profile, result.currentRatios, ...Object.values(result.annualFinancials)]) {
    assert.equal(block.fromCache, true);
    assert.equal(block.asOf, FETCHED_AT);
  }
  // Data still identical on a cache hit.
  assert.equal(findRow(result.annualFinancials.incomeStatement, 'revenue', 'FY2026').value, 271423);
});

test('unit gate: a statement whose units are not INR_CRORE is withheld rather than mislabeled', () => {
  const sr = tcsSearchResult();
  sr.data.sections.balanceSheet.data = { ...sr.data.sections.balanceSheet.data, units: 'INR_LAKH' };
  const result = buildStockDetailFinancials(sr);
  assert.equal(result.annualFinancials.balanceSheet.status, 'UNAVAILABLE');
  assert.equal(result.annualFinancials.balanceSheet.error.code, 'UNIT_MISMATCH');
  assert.deepEqual(result.annualFinancials.balanceSheet.rows, []);
});
