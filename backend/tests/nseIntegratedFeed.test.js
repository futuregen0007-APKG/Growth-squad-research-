import test from 'node:test';
import assert from 'node:assert/strict';
import {
  integratedRowToRecord, toNseDateString, parseNseDate, toReportingPeriod, selectFilings, olderVersionsOf, extractFactsFromFiling, tagsForMetric, hasXbrlLink,
} from '../services/NseXbrlService.js';
import { collectSymbol } from '../scripts/collectNseXbrlFundamentals.js';
import { planBatch, incompleteRows } from '../scripts/earningsXbrlBatch.js';

/**
 * nseIntegratedFeed.test.js
 * ===========================
 * NSE's legacy results index stops at the quarter ended 2024-12-31; its
 * Integrated Filing (Financials) feed carries everything since. These pin how
 * that feed's rows become the records the extractor already understands, how
 * the two feeds merge without double-counting a period, and that a figure is
 * still read only from the context spanning the filing's own quarter.
 */

const integratedRow = (over = {}) => ({
  symbol: 'ACME',
  cmName: 'Acme Limited',
  qe_Date: '31-MAR-2026',
  consolidated: 'Consolidated',
  audited: 'Audited',
  broadcast_Date: '30-Apr-2026 21:06:22',
  creation_Date: '30-Apr-2026 21:06:23',
  revised_Date: null,
  type_Sub: 'Original',
  xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1_ORIGINAL_WEB.xml',
  ...over,
});

const ctx = (id, start, end) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="x">A</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
const num = (tag, contextRef, value) => `<in-capmkt:${tag} contextRef="${contextRef}" decimals="-3" unitRef="INR">${value}</in-capmkt:${tag}>`;

const CORPORATE_XML = `<xbrli:xbrl>${ctx('OneD', '2026-01-01', '2026-03-31')}${ctx('FourD', '2025-04-01', '2026-03-31')}
${num('RevenueFromOperations', 'OneD', 163510000000)}${num('RevenueFromOperations', 'FourD', 644680000000)}
${num('ProfitLossForPeriod', 'OneD', 29940000000)}${num('ProfitLossForPeriod', 'FourD', 150590000000)}
${num('ProfitBeforeTax', 'OneD', 39280000000)}${num('ProfitBeforeTax', 'FourD', 138270000000)}
${num('BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations', 'OneD', 12.73)}${num('BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations', 'FourD', 64.01)}
</xbrli:xbrl>`;

const INSURER_XML = `<xbrli:xbrl>${ctx('OneD', '2026-01-01', '2026-03-31')}${ctx('FourD', '2025-04-01', '2026-03-31')}
${num('Income', 'OneD', 56577468000)}${num('Income', 'FourD', 1129658824000)}
${num('ProfitLossBeforeTax', 'OneD', 8157775000)}${num('ProfitLossAfterTaxAndExtraordinaryItems', 'OneD', 8046397000)}
${num('BasicAndDilutedEPSAfterExtraordinaryItemsNetOfTaxExpenseForThePeriodNotToBeAnnualized', 'OneD', 8.04)}
</xbrli:xbrl>`;

test('an integrated-feed row becomes a quarter record whose period, dates and basis are exact', () => {
  const record = integratedRowToRecord(integratedRow());
  assert.equal(record.fromDate, '01-Jan-2026');
  assert.equal(record.toDate, '31-Mar-2026');
  assert.equal(toReportingPeriod(record), 'Q4 FY2026');
  assert.equal(record.consolidated, 'Consolidated');
  assert.equal(record.xbrl, integratedRow().xbrl);
  assert.equal(parseNseDate(record.filingDate).toISOString().slice(0, 10), '2026-04-30');

  const q1 = integratedRowToRecord(integratedRow({ qe_Date: '30-JUN-2025' }));
  assert.equal(q1.fromDate, '01-Apr-2025');
  assert.equal(toReportingPeriod(q1), 'Q1 FY2026');
  const q3 = integratedRowToRecord(integratedRow({ qe_Date: '31-DEC-2025' }));
  assert.equal(q3.fromDate, '01-Oct-2025');
  assert.equal(toReportingPeriod(q3), 'Q3 FY2026');
});

test('toNseDateString is the inverse of parseNseDate for a whole day', () => {
  assert.equal(toNseDateString(parseNseDate('05-Feb-2024')), '05-Feb-2024');
  assert.equal(toNseDateString(new Date(Date.UTC(2026, 0, 1))), '01-Jan-2026');
});

test('a revision is dated by its revision, and a row that cannot be trusted is refused', () => {
  const revision = integratedRowToRecord(integratedRow({ type_Sub: 'Revision', broadcast_Date: null, revised_Date: '07-MAY-2026 18:28:47' }));
  assert.equal(parseNseDate(revision.filingDate).toISOString().slice(0, 10), '2026-05-07');
  assert.equal(revision.filingKind, 'Revision');

  assert.equal(integratedRowToRecord(integratedRow({ xbrl: null })), null, 'no XBRL link');
  assert.equal(integratedRowToRecord(integratedRow({ qe_Date: '15-MAR-2026' })), null, 'not a month end');
  assert.equal(integratedRowToRecord(integratedRow({ qe_Date: 'garbage' })), null, 'unparseable date');
  assert.equal(integratedRowToRecord(null), null);
});

test('legacy and integrated records merge to one filing per period, a revision supersedes its original, and FY2027 is excluded', () => {
  const legacy = { symbol: 'ACME', fromDate: '01-Oct-2024', toDate: '31-Dec-2024', relatingTo: 'Third Quarter', consolidated: 'Consolidated', cumulative: 'Non-Cumulative', filingDate: '20-Jan-2025 10:00:00', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/LEGACY.xml' };
  const original = integratedRowToRecord(integratedRow());
  const revised = integratedRowToRecord(integratedRow({ type_Sub: 'Revision', broadcast_Date: null, revised_Date: '07-MAY-2026 18:28:47', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/REVISED.xml' }));
  const nextYear = integratedRowToRecord(integratedRow({ qe_Date: '30-JUN-2026', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/Q1FY27.xml' }));
  const index = [legacy, original, revised, nextYear];

  const chosen = selectFilings(index, { symbol: 'ACME', fromYear: 2025, toYear: 2026, maxFilings: 24, preferConsolidated: true });
  assert.deepEqual(chosen.map((f) => f.xbrl), ['https://nsearchives.nseindia.com/corporate/xbrl/REVISED.xml', 'https://nsearchives.nseindia.com/corporate/xbrl/LEGACY.xml']);

  const older = olderVersionsOf(index, revised);
  assert.deepEqual(older.map((f) => f.xbrl), [original.xbrl], 'the original stays reachable as a fallback');
  assert.deepEqual(olderVersionsOf(index, legacy), [], 'a period with one filing has no older versions');
});

test('a Q4 filing yields the March QUARTER figure under its quarter, and the year figure only under the fiscal year', () => {
  const facts = extractFactsFromFiling(CORPORATE_XML, integratedRowToRecord(integratedRow()));
  const byMetric = Object.fromEntries(facts.filter((f) => f.period === 'Q4 FY2026').map((f) => [f.metric, f]));
  const year = Object.fromEntries(facts.filter((f) => f.period === 'FY2026').map((f) => [f.metric, f]));
  assert.equal(year.REVENUE.value, 64468, 'INR 644,680,000,000 = 64,468 crore, labelled FY2026');
  assert.equal(year.PAT.value, 15059);
  assert.equal(year.EPS.value, 64.01);
  assert.equal(year.REVENUE.extraction.contextRef, 'FourD');
  assert.equal(byMetric.REVENUE.period, 'Q4 FY2026');
  assert.equal(byMetric.REVENUE.value, 16351, 'INR 163,510,000,000 = 16,351 crore (the quarter), not the 64,468 crore year');
  assert.equal(byMetric.PAT.value, 2994);
  assert.equal(byMetric.PROFIT_BEFORE_TAX.value, 3928);
  assert.equal(byMetric.EPS.value, 12.73);
  assert.equal(byMetric.REVENUE.extraction.contextRef, 'OneD');
  assert.match(byMetric.REVENUE.sourceUrl, /^https:\/\/nsearchives\.nseindia\.com\/corporate\/xbrl\//);
});

test('a filing whose contexts do not span the derived quarter yields nothing rather than a wrong figure', () => {
  const halfYear = CORPORATE_XML.replace('<xbrli:startDate>2026-01-01</xbrli:startDate>', '<xbrli:startDate>2025-10-01</xbrli:startDate>');
  assert.deepEqual(extractFactsFromFiling(halfYear, integratedRowToRecord(integratedRow()), { includeFullYear: false }), []);
  // The year context is still valid on its own, so the year is read; the quarter is not invented.
  const withYear = extractFactsFromFiling(halfYear, integratedRowToRecord(integratedRow()));
  assert.ok(withYear.length > 0 && withYear.every((f) => f.period === 'FY2026'));
});

test('insurer filings are read through their own profit and EPS tags, only because the standard ones are absent', () => {
  const facts = extractFactsFromFiling(INSURER_XML, integratedRowToRecord(integratedRow({ symbol: 'LIFEINS', consolidated: 'Standalone' })));
  const byMetric = Object.fromEntries(facts.filter((f) => f.period === 'Q4 FY2026').map((f) => [f.metric, f]));
  assert.equal(facts.find((f) => f.period === 'FY2026' && f.metric === 'REVENUE').value, 112965.88, 'the year total income');
  assert.equal(byMetric.REVENUE.value, 5657.75);
  assert.equal(byMetric.PAT.value, 804.64);
  assert.equal(byMetric.PAT.extraction.tag, 'ProfitLossAfterTaxAndExtraordinaryItems');
  assert.equal(byMetric.PROFIT_BEFORE_TAX.value, 815.78);
  assert.equal(byMetric.EPS.value, 8.04);

  // The verifier accepts a stored fact only if its tag is a known source for the metric.
  assert.ok(tagsForMetric('PAT').includes('ProfitLossAfterTaxAndExtraordinaryItems'));
  assert.ok(tagsForMetric('EPS').includes('BasicAndDilutedEPSAfterExtraordinaryItemsNetOfTaxExpenseForThePeriodNotToBeAnnualized'));
});

test('the standard tag wins when a filing carries both', () => {
  const both = CORPORATE_XML.replace('</xbrli:xbrl>', `${num('ProfitLossAfterTaxAndExtraordinaryItems', 'OneD', 1)}</xbrli:xbrl>`);
  const pat = extractFactsFromFiling(both, integratedRowToRecord(integratedRow())).filter((f) => f.metric === 'PAT' && f.period === 'Q4 FY2026');
  assert.equal(pat.length, 1);
  assert.equal(pat[0].extraction.tag, 'ProfitLossForPeriod');
});

// ---------------------------------------------------------------------------
// collectSymbol end to end (dry run, stubbed network)
// ---------------------------------------------------------------------------

const respond = (status, body) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const withStubbedFetch = async (routes, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const match = routes.find(([pattern]) => String(url).includes(pattern));
    return match ? match[1](url) : respond(404, 'not found');
  };
  try { return await run(calls); } finally { globalThis.fetch = original; }
};

const OPTIONS = {
  dryRun: true, fromYear: 2025, toYear: 2026, maxFilings: 24, preferConsolidated: true, delayMs: 0,
};

test('collectSymbol merges both feeds, skips FY2027, and falls back to the original when a revision file is gone', async () => {
  const REVISED_URL = 'https://nsearchives.nseindia.com/corporate/xbrl/REVISED_GONE.xml';
  const feed = {
    data: [
      integratedRow(),
      integratedRow({ type_Sub: 'Revision', broadcast_Date: null, revised_Date: '07-MAY-2026 18:28:47', xbrl: REVISED_URL }),
      integratedRow({ qe_Date: '30-JUN-2026', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/Q1FY27.xml' }),
    ],
    totalCount: 3,
  };
  const result = await withStubbedFetch([
    ['corporates-financial-results', () => respond(200, [])],
    ['integrated-filing-results', () => respond(200, feed)],
    ['REVISED_GONE', () => respond(404, 'gone')],
    ['ORIGINAL_WEB', () => respond(200, CORPORATE_XML)],
  ], () => collectSymbol('ACME', OPTIONS));

  assert.equal(result.error, undefined);
  assert.equal(result.filings, 1, 'one period in the window (Q1 FY2027 is outside it)');
  assert.deepEqual(result.periods, ['FY2026', 'Q4 FY2026'], 'the quarter and the full year from the same Q4 filing');
  assert.deepEqual(result.fiscalYears, [2026]);
  assert.equal(result.stored, 8, 'four metrics for the quarter and four for the year');
  assert.equal(result.unavailable, 1, 'the revision file returned 404');
  assert.equal(result.usedFallbackVersion, 1);
  assert.equal(result.requests, 4, 'two feeds + the missing revision + the original');
  assert.deepEqual(result.feeds, { legacyRows: 0, integratedRows: 3 });
});

test('one feed failing is reported but not fatal; both failing marks the index unavailable', async () => {
  const oneDown = await withStubbedFetch([
    ['corporates-financial-results', () => respond(403, 'denied')],
    ['integrated-filing-results', () => respond(200, { data: [integratedRow()], totalCount: 1 })],
    ['ORIGINAL_WEB', () => respond(200, CORPORATE_XML)],
  ], () => collectSymbol('ACME', OPTIONS));
  assert.equal(oneDown.error, undefined);
  assert.equal(oneDown.stored, 8);
  assert.match(oneDown.feedErrors[0], /legacy results index: HTTP 403/);

  const bothDown = await withStubbedFetch([
    ['corporates-financial-results', () => respond(403, 'denied')],
    ['integrated-filing-results', () => respond(403, 'denied')],
  ], () => collectSymbol('ACME', OPTIONS));
  assert.match(bothDown.error, /legacy results index: HTTP 403 from .*; integrated filing feed: HTTP 403/);
  assert.equal(bothDown.filings, 0);
});

test('a renamed symbol is looked up under its NSE name but stored under the supported one', async () => {
  await withStubbedFetch([
    ['corporates-financial-results', () => respond(200, [])],
    ['integrated-filing-results', () => respond(200, { data: [integratedRow({ symbol: 'ETERNAL' })], totalCount: 1 })],
    ['ORIGINAL_WEB', () => respond(200, CORPORATE_XML)],
  ], async (calls) => {
    const result = await collectSymbol('ZOMATO', OPTIONS);
    assert.ok(calls.some((u) => u.includes('symbol=ETERNAL')), 'NSE is asked for ETERNAL');
    assert.ok(!calls.some((u) => u.includes('symbol=ZOMATO')), 'the old name is never sent');
    assert.equal(result.stored, 8);
  });
});

// ---------------------------------------------------------------------------
// Batch scope
// ---------------------------------------------------------------------------

const scoped = (symbol, category, missing) => ({ symbol, category, facts: { missingYears: missing }, profile: { present: false, researchEnabled: null, marketCapCr: null } });

test("scope 'incomplete' revisits companies missing a year; the default scope never does", () => {
  const rows = [
    scoped('DONE', 'COMPLETE', []),
    scoped('PARTIAL_NEEDS', 'PARTIAL', [2026]),
    scoped('PARTIAL_FINANCIALS_DONE', 'PARTIAL', []),
    scoped('BLOCKED_ALL', 'BLOCKED', [2022, 2023, 2024, 2025, 2026]),
    scoped('FRESH', 'PENDING', [2022, 2023, 2024, 2025, 2026]),
  ];
  assert.deepEqual(incompleteRows(rows).map((r) => r.symbol), ['BLOCKED_ALL', 'FRESH', 'PARTIAL_NEEDS']);
  assert.deepEqual(planBatch(rows, { batchSize: 10, scope: 'incomplete' }), ['BLOCKED_ALL', 'FRESH', 'PARTIAL_NEEDS']);
  assert.deepEqual(planBatch(rows, { batchSize: 10 }), ['FRESH'], 'default scope is unchanged: pending only');
});

test("a legacy row whose XBRL link is a placeholder ('-') is never chosen, so an earlier real filing for the period is used instead", () => {
  const real = { symbol: 'ACME', fromDate: '01-Oct-2021', toDate: '31-Dec-2021', relatingTo: 'Third Quarter', consolidated: 'Consolidated', cumulative: 'Non-Cumulative', filingDate: '20-Jan-2022 10:00:00', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/REAL.xml' };
  const placeholder = { ...real, filingDate: '15-Feb-2022 10:00:00', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/-' };
  assert.equal(hasXbrlLink(placeholder), false);
  assert.equal(hasXbrlLink(real), true);
  assert.equal(hasXbrlLink({ xbrl: null }), false);
  const chosen = selectFilings([real, placeholder], { symbol: 'ACME', maxFilings: 24, preferConsolidated: true });
  assert.deepEqual(chosen.map((f) => f.xbrl), [real.xbrl]);
});

test('a full-year pass reads only the March-quarter filings and stores only their FY figures', async () => {
  const q2 = integratedRow({ qe_Date: '30-SEP-2025', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/Q2_SHOULD_NOT_BE_READ.xml' });
  const q4 = integratedRow();
  const result = await withStubbedFetch([
    ['corporates-financial-results', () => respond(200, [])],
    ['integrated-filing-results', () => respond(200, { data: [q2, q4], totalCount: 2 })],
    ['ORIGINAL_WEB', () => respond(200, CORPORATE_XML)],
    ['Q2_SHOULD_NOT_BE_READ', () => { throw new Error('a non-March filing must not be downloaded in a full-year pass'); }],
  ], () => collectSymbol('ACME', { ...OPTIONS, fullYearOnly: true }));

  assert.equal(result.filings, 1);
  assert.deepEqual(result.periods, ['FY2026']);
  assert.equal(result.stored, 4);
  assert.equal(result.requests, 3, 'two feeds and one March-quarter filing');
});
