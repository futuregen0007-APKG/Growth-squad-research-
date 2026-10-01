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

// The fixtures below copy the REAL `particular`/`category` names and values
// captured live from Upstox's income-statement endpoint with fs=true for
// TCS (ISIN INE467B01029) and INFY (ISIN INE009A01021), FY2023-FY2026 --
// not hand-invented shapes. This is what proved Upstox's summary `revenue`
// category is actually Total Income (revenue from operations + other
// income), not revenue from operations, for both companies.
const TCS_FS_TRUE_FIXTURE = {
  data: {
    type: 'consolidated',
    time_period: 'yearly',
    units_in: 'crore',
    income_statement: [
      {
        category: 'revenue',
        history: [
          { value: 271423, period: 'Mar 2026', change: '+4.68%' },
          { value: 259286, period: 'Mar 2025', change: '+5.7%' },
          { value: 245315, period: 'Mar 2024', change: '+7.17%' },
          { value: 228907, period: 'Mar 2023' },
        ],
      },
      {
        category: 'operating_profit',
        history: [
          { value: 65487, period: 'Mar 2026', change: '+0.24%' },
          { value: 65331, period: 'Mar 2025', change: '+5.38%' },
          { value: 61997, period: 'Mar 2024', change: '+8.94%' },
          { value: 56907, period: 'Mar 2023' },
        ],
      },
      {
        category: 'net_profit',
        history: [
          { value: 49454, period: 'Mar 2026', change: '+1.35%' },
          { value: 48797, period: 'Mar 2025', change: '+5.85%' },
          { value: 46099, period: 'Mar 2024', change: '+8.97%' },
          { value: 42303, period: 'Mar 2023' },
        ],
      },
    ],
    full_statement: [
      {
        particular: 'Revenue',
        history: [
          { value: 267021, period: 'Mar 2026' },
          { value: 255324, period: 'Mar 2025' },
          { value: 240893, period: 'Mar 2024' },
          { value: 225458, period: 'Mar 2023' },
        ],
      },
      {
        particular: 'Other Income',
        history: [
          { value: 4402, period: 'Mar 2026' },
          { value: 3962, period: 'Mar 2025' },
          { value: 4422, period: 'Mar 2024' },
          { value: 3449, period: 'Mar 2023' },
        ],
      },
      {
        particular: 'Total Revenue',
        history: [
          { value: 271423, period: 'Mar 2026' },
          { value: 259286, period: 'Mar 2025' },
          { value: 245315, period: 'Mar 2024' },
          { value: 228907, period: 'Mar 2023' },
        ],
      },
      {
        particular: 'Profit Before Tax',
        history: [
          { value: 65487, period: 'Mar 2026' },
          { value: 65331, period: 'Mar 2025' },
          { value: 61997, period: 'Mar 2024' },
          { value: 56907, period: 'Mar 2023' },
        ],
      },
      {
        particular: 'Tax',
        history: [
          { value: 16033, period: 'Mar 2026' },
          { value: 16534, period: 'Mar 2025' },
          { value: 15898, period: 'Mar 2024' },
          { value: 14604, period: 'Mar 2023' },
        ],
      },
      {
        particular: 'Profit After Tax',
        history: [
          { value: 49454, period: 'Mar 2026' },
          { value: 48797, period: 'Mar 2025' },
          { value: 46099, period: 'Mar 2024' },
          { value: 42303, period: 'Mar 2023' },
        ],
      },
    ],
  },
};

test('normalizeIncomeStatement: real TCS fixture (fs=true) -- revenue verifies as TOTAL_INCOME (not Revenue from operations), across every period, not just the latest', () => {
  const result = normalizeIncomeStatement(TCS_FS_TRUE_FIXTURE, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });

  for (const fy of ['FY2026', 'FY2025', 'FY2024', 'FY2023']) {
    const revenue = result.metrics.find((m) => m.label === 'revenue' && m.financialYear === fy);
    assert.ok(revenue, `revenue metric must exist for ${fy}`);
    assert.equal(revenue.verifiedDefinition, 'TOTAL_INCOME', `${fy}: summary revenue matches full_statement Total Revenue, not Revenue, for TCS`);
    assert.equal(revenue.verifiedLabel, 'Total income');
    assert.equal(revenue.providerLabel, 'revenue', 'providerLabel is the raw Upstox category name as-is');

    const operatingProfit = result.metrics.find((m) => m.label === 'operating_profit' && m.financialYear === fy);
    assert.equal(operatingProfit.verifiedDefinition, 'PROFIT_BEFORE_TAX');
    assert.equal(operatingProfit.verifiedLabel, 'Profit before tax');

    const netProfit = result.metrics.find((m) => m.label === 'net_profit' && m.financialYear === fy);
    assert.equal(netProfit.verifiedDefinition, 'PROFIT_AFTER_TAX');
    assert.equal(netProfit.verifiedLabel, 'Profit after tax (consolidated)');
  }
});

test('normalizeIncomeStatement: the algorithm is genuinely comparative, not hardcoded to always say Total Income -- a company whose summary revenue matches full_statement Revenue directly (no other income) verifies as REVENUE_FROM_OPERATIONS', () => {
  // Hypothetical company fixture (not real data): summary `revenue` equals
  // full_statement `Revenue` exactly, proving the algorithm picks whichever
  // particular the value actually matches, never a fixed answer.
  const raw = {
    data: {
      income_statement: [
        { category: 'revenue', history: [{ value: 100000, period: 'Mar 2026' }] },
      ],
      full_statement: [
        { particular: 'Revenue', history: [{ value: 100000, period: 'Mar 2026' }] },
        { particular: 'Other Income', history: [{ value: 0, period: 'Mar 2026' }] },
        { particular: 'Total Revenue', history: [{ value: 100000, period: 'Mar 2026' }] },
      ],
    },
  };
  const result = normalizeIncomeStatement(raw, {
    symbol: 'HYPOCO', isin: 'INE000000000', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });
  const revenue = result.metrics.find((m) => m.label === 'revenue' && m.financialYear === 'FY2026');
  assert.equal(revenue.verifiedDefinition, 'REVENUE_FROM_OPERATIONS', 'Revenue is checked BEFORE Total Revenue -- when both match, the more specific definition wins');
  assert.equal(revenue.verifiedLabel, 'Revenue from operations');
});

test('normalizeIncomeStatement: a metric with no full_statement present (fs absent, or the particular is missing) gets verifiedDefinition/verifiedLabel null, never a guess', () => {
  const rawNoFullStatement = {
    data: {
      income_statement: [{ category: 'revenue', history: [{ value: 100000, period: 'Mar 2026' }] }],
      // no full_statement key at all -- fs wasn't honored, or this company has none
    },
  };
  const resultNoFullStatement = normalizeIncomeStatement(rawNoFullStatement, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });
  const revenueNoFS = resultNoFullStatement.metrics.find((m) => m.label === 'revenue');
  assert.equal(revenueNoFS.verifiedDefinition, null);
  assert.equal(revenueNoFS.verifiedLabel, null);
  assert.equal(revenueNoFS.providerLabel, 'revenue');

  const rawMissingParticular = {
    data: {
      income_statement: [{ category: 'revenue', history: [{ value: 100000, period: 'Mar 2026' }] }],
      full_statement: [{ particular: 'Tax', history: [{ value: 5000, period: 'Mar 2026' }] }], // Revenue/Total Revenue absent
    },
  };
  const resultMissingParticular = normalizeIncomeStatement(rawMissingParticular, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });
  const revenueMissingParticular = resultMissingParticular.metrics.find((m) => m.label === 'revenue');
  assert.equal(revenueMissingParticular.verifiedDefinition, null, 'no matching particular for this label -- never guess');
  assert.equal(revenueMissingParticular.verifiedLabel, null);
});

test('normalizeIncomeStatement: a label that is neither revenue/operating_profit/net_profit never gets a verified definition', () => {
  const raw = {
    data: {
      income_statement: [{ category: 'some_other_metric', history: [{ value: 42, period: 'Mar 2026' }] }],
      full_statement: [{ particular: 'Revenue', history: [{ value: 42, period: 'Mar 2026' }] }],
    },
  };
  const result = normalizeIncomeStatement(raw, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });
  const metric = result.metrics.find((m) => m.label === 'some_other_metric');
  assert.equal(metric.verifiedDefinition, null, 'an unrecognized label is never guessed at, even if its value happens to match a particular');
});

test('normalizeBalanceSheet/normalizeCashFlow: never annotated with providerLabel/verifiedDefinition -- scope is income-statement only', () => {
  const balanceSheetRaw = { data: { history: [{ period: 'Mar 2026', total_asset: 500000 }] } };
  const balanceSheetResult = normalizeBalanceSheet(balanceSheetRaw, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });
  const totalAsset = balanceSheetResult.metrics.find((m) => m.label === 'total_asset');
  assert.ok(!('providerLabel' in totalAsset));
  assert.ok(!('verifiedDefinition' in totalAsset));
  assert.ok(!('verifiedLabel' in totalAsset));

  const cashFlowRaw = { data: { cash_flow: [{ category: 'Operating', history: [{ value: 60000, period: 'Mar 2026' }] }] } };
  const cashFlowResult = normalizeCashFlow(cashFlowRaw, {
    symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated', period: 'YEARLY',
  });
  const operating = cashFlowResult.metrics.find((m) => m.label === 'operating');
  assert.ok(!('providerLabel' in operating));
  assert.ok(!('verifiedDefinition' in operating));
  assert.ok(!('verifiedLabel' in operating));
});

test('normalizeIncomeStatement: consolidated and standalone are kept as distinct top-level tags, never merged', () => {
  const raw = { data: { income_statement: [{ category: 'revenue', history: [{ value: 100, period: 'Mar 2026', change: 1 }] }] } };
  const consolidated = normalizeIncomeStatement(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'consolidated' });
  const standalone = normalizeIncomeStatement(raw, { symbol: 'TCS', isin: 'INE467B01029', fetchedAt: '2026-09-29T00:00:00.000Z', statementType: 'standalone' });
  assert.equal(consolidated.statementType, 'CONSOLIDATED');
  assert.equal(standalone.statementType, 'STANDALONE');
});
