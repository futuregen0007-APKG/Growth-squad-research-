import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readTag, parseNseDate, toReportingPeriod, fiscalYearOfPeriod, periodRange, parseXbrlContexts, findTagForPeriod, readTagForPeriod,
  extractFactsFromFiling, selectFilings, toFactDocument, deriveJobOutcome, tagsForMetric, parseStatedPeriods, findTagByStatedPeriod, TAG_MAP, RUPEES_PER_CRORE,
} from '../services/NseXbrlService.js';

/**
 * nseXbrlService.test.js
 * ========================
 * The fixture mirrors the structure of a real NSE quarterly filing (checked
 * live against HINDUNILVR Q4 FY2022): the SAME tag appears once per period the
 * filing carries, each pointing at a context that declares its dates, plus
 * segment-dimensioned contexts that reuse the quarter's dates. Reading "the
 * first occurrence" is wrong here on purpose: the full-year value comes first.
 */

const XBRL = `<?xml version="1.0"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-fin="http://www.bseindia.com/xbrl/fin/2020-03-31/in-bse-fin" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
  <xbrli:context id="FourD"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2021-04-01</xbrli:startDate><xbrli:endDate>2022-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="OneD"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2022-01-01</xbrli:startDate><xbrli:endDate>2022-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="OneReportableSegmentRevenue01D"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="in-bse-fin:ReportableSegmentsAxis">in-bse-fin:FoodsMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2022-01-01</xbrli:startDate><xbrli:endDate>2022-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="Instant"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2022-03-31</xbrli:instant></xbrli:period></xbrli:context>
  <in-bse-fin:RevenueFromOperations contextRef="OneReportableSegmentRevenue01D" unitRef="INR" decimals="-7">999000000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:RevenueFromOperations contextRef="FourD" unitRef="INR" decimals="-7">524460000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:RevenueFromOperations contextRef="OneD" unitRef="INR" decimals="-7">137670000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:ProfitLossForPeriod contextRef="FourD" unitRef="INR" decimals="-7">88920000000.00</in-bse-fin:ProfitLossForPeriod>
  <in-bse-fin:ProfitLossForPeriod contextRef="OneD" unitRef="INR" decimals="-7">23070000000.00</in-bse-fin:ProfitLossForPeriod>
  <in-bse-fin:ProfitLossForPeriodFromContinuingOperations contextRef="OneD" unitRef="INR" decimals="-7">1.00</in-bse-fin:ProfitLossForPeriodFromContinuingOperations>
  <in-bse-fin:BasicEarningsLossPerShare contextRef="FourD" unitRef="INRPerShare" decimals="2">37.84</in-bse-fin:BasicEarningsLossPerShare>
  <in-bse-fin:BasicEarningsLossPerShare contextRef="OneD" unitRef="INRPerShare" decimals="2">9.82</in-bse-fin:BasicEarningsLossPerShare>
  <in-bse-fin:OtherIncome contextRef="Instant" unitRef="INR" decimals="-7">5.00</in-bse-fin:OtherIncome>
</xbrli:xbrl>`;

const Q4 = { start: '2022-01-01', end: '2022-03-31' };
const RECORD = {
  symbol: 'HINDUNILVR', companyName: 'Hindustan Unilever Limited', fromDate: '01-Jan-2022', toDate: '31-Mar-2022', relatingTo: 'Fourth Quarter',
  consolidated: 'Consolidated', audited: 'Audited', filingDate: '28-Apr-2022 15:38', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/x.xml',
};

test('contexts are parsed with their dates, and segment-dimensioned ones are flagged', () => {
  const contexts = parseXbrlContexts(XBRL);
  assert.deepEqual(contexts.get('OneD'), { start: '2022-01-01', end: '2022-03-31', dimensioned: false, source: 'DECLARED' });
  assert.deepEqual(contexts.get('FourD'), { start: '2021-04-01', end: '2022-03-31', dimensioned: false, source: 'DECLARED' });
  assert.equal(contexts.get('OneReportableSegmentRevenue01D').dimensioned, true);
  assert.deepEqual(contexts.get('Instant'), { start: null, end: null, dimensioned: false, source: 'DECLARED' });
});

/**
 * Older exchange filings (checked live: HINDUNILVR Q1-Q4 FY2022) reference
 * contexts "OneD" and "FourD" but never declare them. The filing itself states
 * the period each stands for, as facts.
 */
const UNDECLARED = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-fin="x">
  <in-bse-fin:DateOfStartOfReportingPeriod contextRef="OneD">2022-01-01</in-bse-fin:DateOfStartOfReportingPeriod>
  <in-bse-fin:DateOfEndOfReportingPeriod contextRef="OneD">2022-03-31</in-bse-fin:DateOfEndOfReportingPeriod>
  <in-bse-fin:DateOfStartOfReportingPeriod contextRef="FourD">2021-04-01</in-bse-fin:DateOfStartOfReportingPeriod>
  <in-bse-fin:DateOfEndOfReportingPeriod contextRef="FourD">2022-03-31</in-bse-fin:DateOfEndOfReportingPeriod>
  <in-bse-fin:RevenueFromOperations contextRef="FourD" unitRef="INR" decimals="-7">524460000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:RevenueFromOperations contextRef="OneD" unitRef="INR" decimals="-7">137670000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:RevenueFromOperations contextRef="Mystery" unitRef="INR" decimals="-7">1.00</in-bse-fin:RevenueFromOperations>
</xbrli:xbrl>`;

test('an undeclared context takes its period from what the filing states about itself', () => {
  const contexts = parseXbrlContexts(UNDECLARED);
  assert.deepEqual(contexts.get('OneD'), { start: '2022-01-01', end: '2022-03-31', dimensioned: false, source: 'STATED' });
  assert.deepEqual(contexts.get('FourD'), { start: '2021-04-01', end: '2022-03-31', dimensioned: false, source: 'STATED' });
  assert.equal(readTagForPeriod(UNDECLARED, 'RevenueFromOperations', Q4), 137670000000);
  assert.equal(readTagForPeriod(UNDECLARED, 'RevenueFromOperations', { start: '2021-04-01', end: '2022-03-31' }), 524460000000);
});

test('a context that is neither declared nor stated is unknown, so its figure is never used', () => {
  assert.equal(parseXbrlContexts(UNDECLARED).has('Mystery'), false);
  const onlyUnknown = '<xbrli:xbrl xmlns:xbrli="x"><in-bse-fin:RevenueFromOperations contextRef="Mystery" unitRef="INR">1.00</in-bse-fin:RevenueFromOperations></xbrli:xbrl>';
  assert.equal(readTagForPeriod(onlyUnknown, 'RevenueFromOperations', Q4), null);
});

test('a declared context whose dates disagree with the stated period is refused, not preferred', () => {
  const conflicting = XBRL.replace('</xbrli:xbrl>', `
    <in-bse-fin:DateOfStartOfReportingPeriod contextRef="OneD">2022-01-01</in-bse-fin:DateOfStartOfReportingPeriod>
    <in-bse-fin:DateOfEndOfReportingPeriod contextRef="OneD">2022-02-28</in-bse-fin:DateOfEndOfReportingPeriod></xbrli:xbrl>`);
  assert.equal(parseXbrlContexts(conflicting).get('OneD').conflict, true);
  assert.equal(readTagForPeriod(conflicting, 'RevenueFromOperations', Q4), null);
});

test('facts read from a stated period carry that in their provenance', () => {
  const [revenue] = extractFactsFromFiling(UNDECLARED, RECORD).filter((f) => f.metric === 'REVENUE');
  assert.equal(revenue.value, 13767);
  assert.equal(revenue.extraction.contextSource, 'STATED');
  assert.equal(extractFactsFromFiling(XBRL, RECORD).find((f) => f.metric === 'REVENUE').extraction.contextSource, 'DECLARED');
});

test('the old first-occurrence read returns the wrong number here, which is why it is no longer used for facts', () => {
  assert.equal(readTag(XBRL, 'RevenueFromOperations'), 999000000000, 'first occurrence is a segment figure');
});

test('the quarter figure is found by its context, regardless of where it sits in the document', () => {
  assert.deepEqual(findTagForPeriod(XBRL, 'RevenueFromOperations', Q4), { value: 137670000000, contextRef: 'OneD', source: 'DECLARED' });
  assert.equal(readTagForPeriod(XBRL, 'RevenueFromOperations', { start: '2021-04-01', end: '2022-03-31' }), 524460000000, 'the full-year context is a different, equally exact lookup');
});

test('a segment-dimensioned occurrence with identical dates is never taken', () => {
  assert.notEqual(readTagForPeriod(XBRL, 'RevenueFromOperations', Q4), 999000000000);
});

test('no matching context means no value, never a guess from another period', () => {
  assert.equal(readTagForPeriod(XBRL, 'RevenueFromOperations', { start: '2021-10-01', end: '2021-12-31' }), null);
  assert.equal(readTagForPeriod(XBRL, 'OtherIncome', Q4), null, 'an instant context is not a duration');
  assert.equal(readTagForPeriod(XBRL, 'NoSuchTag', Q4), null);
  assert.equal(readTagForPeriod(XBRL, 'RevenueFromOperations', { start: null, end: null }), null);
});

test('a tag name that merely starts with a mapped tag is not confused with it', () => {
  assert.equal(readTagForPeriod(XBRL, 'ProfitLossForPeriod', Q4), 23070000000, 'not the ...FromContinuingOperations value of 1');
});

test('extractFactsFromFiling reads each mapped metric for the filing\'s own period, with provenance', () => {
  const facts = extractFactsFromFiling(XBRL, RECORD);
  const by = Object.fromEntries(facts.map((f) => [f.metric, f]));
  assert.deepEqual(Object.keys(by).sort(), ['EPS', 'PAT', 'REVENUE']);
  assert.equal(by.REVENUE.value, 13767);
  assert.equal(by.REVENUE.unit, 'INR_CRORE');
  assert.equal(by.PAT.value, 2307);
  assert.equal(by.EPS.value, 9.82);
  assert.equal(by.EPS.unit, 'INR');
  assert.equal(by.REVENUE.period, 'Q4 FY2022');
  assert.deepEqual([by.REVENUE.extraction.contextRef, by.REVENUE.extraction.periodStart, by.REVENUE.extraction.periodEnd], ['OneD', '2022-01-01', '2022-03-31']);
  assert.equal(by.REVENUE.extraction.originalValue, 137670000000);
  assert.equal(by.REVENUE.extraction.originalValue / RUPEES_PER_CRORE, by.REVENUE.value);
  assert.equal(by.EPS.extraction.conversion, 'none');
});

test('a filing whose period cannot be read yields nothing rather than a guess', () => {
  assert.deepEqual(extractFactsFromFiling(XBRL, { ...RECORD, toDate: 'garbage' }), []);
  assert.deepEqual(extractFactsFromFiling(XBRL, { ...RECORD, fromDate: undefined }), []);
  assert.deepEqual(extractFactsFromFiling(XBRL, { ...RECORD, fromDate: '01-Jul-2021', toDate: '30-Sep-2021', relatingTo: 'Second Quarter' }), [], 'the document carries no context for that period');
});

test('the stored fact keeps an exchange source URL, REAL_RESEARCH origin and an auditable excerpt', () => {
  const [revenue] = extractFactsFromFiling(XBRL, RECORD).filter((f) => f.metric === 'REVENUE');
  const doc = toFactDocument(revenue);
  assert.equal(doc.dataOrigin, 'REAL_RESEARCH');
  assert.equal(doc.source.url, RECORD.xbrl);
  assert.equal(doc.metrics.actualValue, 13767);
  assert.equal(doc.title, 'Q4 FY2022 Revenue from operations');
  assert.match(doc.source.excerpt, /RevenueFromOperations, context OneD 2022-01-01\.\.2022-03-31/);
  assert.match(doc.fact, /\(Consolidated, Audited\)/);
});

test('every mapped tag has a metric and a scale', () => {
  for (const mapping of TAG_MAP) assert.ok(mapping.tag && mapping.metric && ['RUPEES', 'PER_SHARE'].includes(mapping.scale));
});

test('reporting periods follow the Indian fiscal year (ends 31 March)', () => {
  assert.equal(toReportingPeriod({ fromDate: '01-Oct-2024', toDate: '31-Dec-2024', relatingTo: 'Third Quarter' }), 'Q3 FY2025');
  assert.equal(toReportingPeriod({ fromDate: '01-Jan-2022', toDate: '31-Mar-2022', relatingTo: 'Fourth Quarter' }), 'Q4 FY2022');
  assert.equal(toReportingPeriod({ fromDate: '01-Apr-2023', toDate: '30-Jun-2023', relatingTo: 'First Quarter' }), 'Q1 FY2024');
  assert.equal(toReportingPeriod({ fromDate: '01-Apr-2021', toDate: '31-Mar-2022' }), 'FY2022');
  assert.equal(toReportingPeriod({ fromDate: '01-Jul-2023', toDate: '30-Sep-2023' }), 'Q2 FY2024', 'a missing label falls back to the end month');
  assert.equal(toReportingPeriod({ toDate: 'nope' }), null);
});

test('periodRange maps a period label back to its calendar dates', () => {
  assert.deepEqual(periodRange('Q4 FY2022'), { start: '2022-01-01', end: '2022-03-31' });
  assert.deepEqual(periodRange('Q1 FY2022'), { start: '2021-04-01', end: '2021-06-30' });
  assert.deepEqual(periodRange('Q3 FY2025'), { start: '2024-10-01', end: '2024-12-31' });
  assert.deepEqual(periodRange('FY2022'), { start: '2021-04-01', end: '2022-03-31' });
  assert.equal(periodRange('nonsense'), null);
  assert.equal(fiscalYearOfPeriod('Q2 FY2024'), 2024);
});

test('parseNseDate reads NSE\'s format explicitly and rejects anything else', () => {
  assert.equal(parseNseDate('30-Jan-2025 15:37:17').toISOString(), '2025-01-30T15:37:17.000Z');
  assert.equal(parseNseDate('31-Mar-2022').toISOString(), '2022-03-31T00:00:00.000Z');
  assert.equal(parseNseDate('2022-03-31'), null);
  assert.equal(parseNseDate('31-Foo-2022'), null);
});

const filing = (toDate, fromDate, relatingTo, consolidated, filingDate, xbrl = `https://nsearchives.nseindia.com/x/${toDate}-${consolidated}-${filingDate}.xml`, symbol = 'AAA') => (
  { symbol, toDate, fromDate, relatingTo, consolidated, filingDate, xbrl }
);
const INDEX = [
  filing('31-Dec-2024', '01-Oct-2024', 'Third Quarter', 'Consolidated', '30-Jan-2025'),
  filing('31-Dec-2024', '01-Oct-2024', 'Third Quarter', 'Non-Consolidated', '30-Jan-2025'),
  filing('30-Sep-2024', '01-Jul-2024', 'Second Quarter', 'Non-Consolidated', '25-Oct-2024'),
  filing('31-Mar-2022', '01-Jan-2022', 'Fourth Quarter', 'Consolidated', '10-May-2022'),
  filing('31-Mar-2022', '01-Jan-2022', 'Fourth Quarter', 'Consolidated', '20-May-2022', 'https://nsearchives.nseindia.com/x/restated.xml'),
  filing('31-Mar-2019', '01-Jan-2019', 'Fourth Quarter', 'Consolidated', '10-May-2019'),
  { ...filing('31-Dec-2023', '01-Oct-2023', 'Third Quarter', 'Consolidated', '05-Feb-2024'), xbrl: null },
  filing('31-Dec-2023', '01-Oct-2023', 'Third Quarter', 'Consolidated', '05-Feb-2024', undefined, 'OTHER'),
];

test('by default every period is kept for each basis, newest period first', () => {
  const selected = selectFilings(INDEX, { symbol: 'AAA' });
  assert.deepEqual(selected.map((f) => `${toReportingPeriod(f)}|${f.consolidated}`), [
    'Q3 FY2025|Consolidated', 'Q3 FY2025|Non-Consolidated', 'Q2 FY2025|Non-Consolidated', 'Q4 FY2022|Consolidated', 'Q4 FY2019|Consolidated',
  ]);
});

test('a restated filing supersedes the original for the same period and basis', () => {
  const selected = selectFilings(INDEX, { symbol: 'AAA' }).filter((f) => toReportingPeriod(f) === 'Q4 FY2022');
  assert.equal(selected.length, 1);
  assert.match(selected[0].xbrl, /restated\.xml$/);
});

test('filings with no XBRL link, or for another symbol, are never selected', () => {
  const selected = selectFilings(INDEX, { symbol: 'AAA' });
  assert.ok(selected.every((f) => f.xbrl && f.symbol === 'AAA'));
});

test('preferConsolidated reports each period once, falling back to standalone only when there is no consolidated filing', () => {
  const selected = selectFilings(INDEX, { symbol: 'AAA', preferConsolidated: true });
  assert.deepEqual(selected.map((f) => `${toReportingPeriod(f)}|${f.consolidated}`), [
    'Q3 FY2025|Consolidated', 'Q2 FY2025|Non-Consolidated', 'Q4 FY2022|Consolidated', 'Q4 FY2019|Consolidated',
  ]);
});

test('cumulative (year-to-date) filings are never selected: their span would not match the quarter they are labelled with', () => {
  const index = [
    { ...filing('31-Dec-2023', '01-Oct-2023', 'Third Quarter', 'Consolidated', '05-Feb-2024'), cumulative: 'Non-cumulative' },
    { ...filing('31-Dec-2023', '01-Apr-2023', 'Third Quarter', 'Consolidated', '06-Feb-2024', 'https://nsearchives.nseindia.com/x/ytd.xml'), cumulative: 'Cumulative' },
  ];
  const selected = selectFilings(index, { symbol: 'AAA' });
  assert.equal(selected.length, 1);
  assert.notEqual(selected[0].xbrl, 'https://nsearchives.nseindia.com/x/ytd.xml');
});

test('the recorded job outcome says why a company is complete, partial, retryable or permanently empty', () => {
  const base = { expectedYears: 5, attempt: 1 };
  assert.deepEqual(deriveJobOutcome({ ...base, filings: 20, factsStored: 90, coveredYears: 5 }), { status: 'COMPLETED', lastError: null });
  const partial = deriveJobOutcome({ ...base, filings: 15, factsStored: 50, coveredYears: 4, latestPeriod: 'Q3 FY2025' });
  assert.equal(partial.status, 'PARTIAL');
  assert.match(partial.lastError, /Covered 4\/5 fiscal years.*Q3 FY2025/);
  assert.equal(deriveJobOutcome({ ...base, indexError: 'HTTP 403' }).status, 'FAILED_RETRYABLE');
  assert.equal(deriveJobOutcome({ ...base, attempt: 3, indexError: 'HTTP 403' }).status, 'FAILED_PERMANENT');
  const none = deriveJobOutcome({ ...base, filings: 0 });
  assert.equal(none.status, 'FAILED_PERMANENT', 'an index that lists nothing is not going to list something on a retry');
  assert.match(none.lastError, /no XBRL filings/);
  assert.equal(deriveJobOutcome({ ...base, filings: 8, factsStored: 0, coveredYears: 0 }).status, 'FAILED_RETRYABLE');
  assert.equal(deriveJobOutcome({ ...base, attempt: 3, filings: 8, factsStored: 0, coveredYears: 0 }).status, 'FAILED_PERMANENT');
});

test('fromYear drops earlier fiscal years and maxFilings caps the newest ones', () => {
  assert.deepEqual(selectFilings(INDEX, { symbol: 'AAA', fromYear: 2022, preferConsolidated: true }).map(toReportingPeriod), ['Q3 FY2025', 'Q2 FY2025', 'Q4 FY2022']);
  assert.deepEqual(selectFilings(INDEX, { symbol: 'AAA', maxFilings: 2 }).map(toReportingPeriod), ['Q3 FY2025', 'Q3 FY2025']);
  assert.deepEqual(selectFilings(null), []);
});

/** A bank-format filing: total income, `ProfitLossForThePeriod` and the post-extraordinary EPS tag; no RevenueFromOperations. */
const BANK = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-fin="x">
  ${['OneD'].map((id) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2024-10-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>`).join('')}
  <in-bse-fin:Income contextRef="OneD" unitRef="INR" decimals="-5">1678535700000.00</in-bse-fin:Income>
  <in-bse-fin:OtherIncome contextRef="OneD" unitRef="INR" decimals="-5">431999100000.00</in-bse-fin:OtherIncome>
  <in-bse-fin:ProfitLossForThePeriod contextRef="OneD" unitRef="INR" decimals="-5">191753500000.00</in-bse-fin:ProfitLossForThePeriod>
  <in-bse-fin:BasicEarningsPerShareAfterExtraordinaryItems contextRef="OneD" unitRef="INRPerShare" decimals="2">21.12</in-bse-fin:BasicEarningsPerShareAfterExtraordinaryItems>
</xbrli:xbrl>`;
const BANK_RECORD = { ...RECORD, symbol: 'BANKX', fromDate: '01-Oct-2024', toDate: '31-Dec-2024', relatingTo: 'Third Quarter', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/bank.xml' };

test('a bank-format filing yields revenue, profit and EPS from the fallback tags, each labelled with what it is', () => {
  const by = Object.fromEntries(extractFactsFromFiling(BANK, BANK_RECORD).map((f) => [f.metric, f]));
  assert.equal(by.REVENUE.label, 'Total income');
  assert.equal(by.REVENUE.value, 167853.57);
  assert.equal(by.REVENUE.extraction.tag, 'Income');
  assert.equal(by.PAT.value, 19175.35);
  assert.equal(by.PAT.extraction.tag, 'ProfitLossForThePeriod');
  assert.equal(by.EPS.value, 21.12);
  assert.equal(by.EPS.extraction.tag, 'BasicEarningsPerShareAfterExtraordinaryItems');
  assert.equal(toFactDocument(by.REVENUE).title, 'Q3 FY2025 Total income');
});

test('a fallback tag is never used when the primary tag produced that metric, so a metric is not reported twice', () => {
  const both = XBRL.replace('</xbrli:xbrl>', '<in-bse-fin:Income contextRef="OneD" unitRef="INR" decimals="-7">999999999999.00</in-bse-fin:Income><in-bse-fin:ProfitLossForThePeriod contextRef="OneD" unitRef="INR">1.00</in-bse-fin:ProfitLossForThePeriod></xbrli:xbrl>');
  const facts = extractFactsFromFiling(both, RECORD);
  assert.equal(facts.filter((f) => f.metric === 'REVENUE').length, 1);
  assert.equal(facts.find((f) => f.metric === 'REVENUE').extraction.tag, 'RevenueFromOperations');
  assert.equal(facts.filter((f) => f.metric === 'PAT').length, 1);
  assert.equal(facts.find((f) => f.metric === 'PAT').extraction.tag, 'ProfitLossForPeriod');
});

test('the corporate EPS variant is used only when the plain EPS tag is absent', () => {
  const corporate = XBRL.replace(/BasicEarningsLossPerShare/g, 'BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations');
  const eps = extractFactsFromFiling(corporate, RECORD).filter((f) => f.metric === 'EPS');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].extraction.tag, 'BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations');
  assert.equal(eps[0].value, 9.82);
});

test('tagsForMetric lists every tag a metric may be read from', () => {
  assert.deepEqual(tagsForMetric('REVENUE'), ['RevenueFromOperations', 'Income']);
  assert.deepEqual(tagsForMetric('NOPE'), []);
});

/** Real quirk (HINDUNILVR Q4 FY2023/FY2024): FourD is DECLARED with the quarter's dates but STATED as the full year, and its value is the annual figure. */
const CONFLICTED = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-fin="x">
  <xbrli:context id="OneD"><xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2023-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="FourD"><xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2023-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <in-bse-fin:DateOfStartOfReportingPeriod contextRef="OneD">2023-01-01</in-bse-fin:DateOfStartOfReportingPeriod>
  <in-bse-fin:DateOfEndOfReportingPeriod contextRef="OneD">2023-03-31</in-bse-fin:DateOfEndOfReportingPeriod>
  <in-bse-fin:DateOfStartOfReportingPeriod contextRef="FourD">2022-04-01</in-bse-fin:DateOfStartOfReportingPeriod>
  <in-bse-fin:DateOfEndOfReportingPeriod contextRef="FourD">2023-03-31</in-bse-fin:DateOfEndOfReportingPeriod>
  <in-bse-fin:RevenueFromOperations contextRef="OneD" unitRef="INR">152150000000.00</in-bse-fin:RevenueFromOperations>
  <in-bse-fin:RevenueFromOperations contextRef="FourD" unitRef="INR">605800000000.00</in-bse-fin:RevenueFromOperations>
</xbrli:xbrl>`;

test('a context whose declaration contradicts the filing\'s own statement is refused for facts', () => {
  assert.equal(parseXbrlContexts(CONFLICTED).get('FourD').conflict, true);
  assert.equal(parseXbrlContexts(CONFLICTED).get('OneD').conflict, undefined);
  assert.equal(readTagForPeriod(CONFLICTED, 'RevenueFromOperations', { start: '2022-04-01', end: '2023-03-31' }), null);
  assert.equal(readTagForPeriod(CONFLICTED, 'RevenueFromOperations', { start: '2023-01-01', end: '2023-03-31' }), 152150000000, 'the unconflicted quarter context is still read');
  const facts = extractFactsFromFiling(CONFLICTED, { ...RECORD, fromDate: '01-Jan-2023', toDate: '31-Mar-2023' });
  assert.equal(facts.find((f) => f.metric === 'REVENUE').value, 15215, 'a fact takes the quarter, never the conflicted full-year context');
});

test('the stated-period lookup, used only for corroboration, finds the full-year figure that the declaration hides', () => {
  assert.deepEqual(parseStatedPeriods(CONFLICTED).get('FourD'), { start: '2022-04-01', end: '2023-03-31' });
  assert.deepEqual(findTagByStatedPeriod(CONFLICTED, 'RevenueFromOperations', { start: '2022-04-01', end: '2023-03-31' }), { value: 605800000000, contextRef: 'FourD', source: 'STATED' });
  assert.equal(findTagByStatedPeriod(CONFLICTED, 'RevenueFromOperations', { start: '2021-04-01', end: '2022-03-31' }), null);
  assert.equal(parseStatedPeriods('<a/>').size, 0);
});
