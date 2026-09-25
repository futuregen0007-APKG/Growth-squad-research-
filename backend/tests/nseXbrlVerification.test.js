import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFactAgainstXml, checkQuarterSums, basisOf, expectedStoredValue, verifySymbol } from '../scripts/verifyNseXbrlFacts.js';
import { TAG_MAP, extractFactsFromFiling, toFactDocument } from '../services/NseXbrlService.js';

/**
 * nseXbrlVerification.test.js
 * =============================
 * The verifier is what allows "these stored figures match their source" to be
 * said from the filings themselves. These tests pin what it accepts and, more
 * importantly, what it refuses: a wrong figure, a wrong period, a non-exchange
 * source, or four quarters that do not add up to the year.
 */

const ctx = (id, start, end) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period></xbrli:context>`;
const rev = (contextRef, rupees) => `<in-bse-fin:RevenueFromOperations contextRef="${contextRef}" unitRef="INR" decimals="-7">${rupees}.00</in-bse-fin:RevenueFromOperations>`;
const doc = (...parts) => `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-fin="x">${parts.join('')}</xbrli:xbrl>`;
const cr = (n) => n * 10_000_000;

const Q4_XML = doc(ctx('FourD', '2021-04-01', '2022-03-31'), ctx('OneD', '2022-01-01', '2022-03-31'), rev('FourD', cr(52446)), rev('OneD', cr(13767)));
const RECORD = {
  symbol: 'AAA', companyName: 'AAA Ltd', fromDate: '01-Jan-2022', toDate: '31-Mar-2022', relatingTo: 'Fourth Quarter', consolidated: 'Consolidated', audited: 'Audited',
  filingDate: '28-Apr-2022', xbrl: 'https://nsearchives.nseindia.com/corporate/xbrl/q4.xml',
};
const storedRevenue = () => ({ ...toFactDocument(extractFactsFromFiling(Q4_XML, RECORD).find((f) => f.metric === 'REVENUE')), _id: 'x' });

test('a fact stored by the collector verifies against its own filing', () => {
  const verdict = verifyFactAgainstXml(storedRevenue(), Q4_XML);
  assert.equal(verdict.status, 'MATCH');
});

test('a wrong stored figure is caught', () => {
  const fact = storedRevenue();
  fact.metrics.actualValue = 52446; // the full-year figure mistaken for the quarter
  const verdict = verifyFactAgainstXml(fact, Q4_XML);
  assert.equal(verdict.status, 'VALUE_MISMATCH');
  assert.match(verdict.detail, /stored 52446, filing says 13767/);
});

test('a wrong period label is caught because the filing has no context for it', () => {
  const fact = { ...storedRevenue(), period: 'Q3 FY2022' };
  assert.equal(verifyFactAgainstXml(fact, Q4_XML).status, 'NO_CONTEXT_FOR_PERIOD');
});

test('an excerpt that does not quote the filing\'s raw value is caught', () => {
  const fact = storedRevenue();
  fact.source.excerpt = 'Revenue from operations: 1 INR (XBRL tag RevenueFromOperations)';
  assert.equal(verifyFactAgainstXml(fact, Q4_XML).status, 'EXCERPT_MISMATCH');
});

test('a fact whose source is not an exchange host, or whose metric or period is unsupported, is never called a match', () => {
  assert.equal(verifyFactAgainstXml({ ...storedRevenue(), source: { url: 'https://example.com/x.xml', excerpt: '' } }, Q4_XML).status, 'SOURCE_NOT_EXCHANGE');
  assert.equal(verifyFactAgainstXml({ ...storedRevenue(), metrics: { metric: 'ORDER_BOOK', actualValue: 1 } }, Q4_XML).status, 'UNSUPPORTED_METRIC');
  assert.equal(verifyFactAgainstXml({ ...storedRevenue(), period: 'garbage' }, Q4_XML).status, 'PERIOD_UNREADABLE');
});

test('expectedStoredValue mirrors the collector: crore to two decimals, per-share unchanged', () => {
  const revenue = TAG_MAP.find((m) => m.metric === 'REVENUE');
  const eps = TAG_MAP.find((m) => m.metric === 'EPS');
  assert.equal(expectedStoredValue(revenue, cr(13767)), 13767);
  assert.equal(expectedStoredValue(revenue, 137671234567), 13767.12);
  assert.equal(expectedStoredValue(eps, 9.82), 9.82);
});

test('checkQuarterSums accepts rounding but rejects a real gap', () => {
  assert.equal(checkQuarterSums([11000.01, 12500.02, 13000.0, 15945.97], 52446).status, 'SUM_MATCH');
  const bad = checkQuarterSums([11000, 12500, 13000, 13767], 52446);
  assert.equal(bad.status, 'SUM_MISMATCH');
  assert.equal(bad.difference, -2179);
});

test('basisOf reads the basis recorded in the stored fact text', () => {
  assert.equal(basisOf({ fact: 'X reported Revenue of 1 INR_CRORE for Q1 FY2022 (Consolidated, Audited).' }), 'Consolidated');
  assert.equal(basisOf({ fact: 'X reported Revenue of 1 INR_CRORE for Q1 FY2022 (Non-Consolidated, Unaudited).' }), 'Non-Consolidated');
  assert.equal(basisOf({ fact: 'no basis here' }), null);
});

/** Four quarterly filings for FY2022 plus a Q4 filing that carries the full year. */
const buildYear = (quarterCr, fullYearCr) => {
  const spec = [
    ['Q1', '2021-04-01', '2021-06-30', '01-Apr-2021', '30-Jun-2021', 'First Quarter'],
    ['Q2', '2021-07-01', '2021-09-30', '01-Jul-2021', '30-Sep-2021', 'Second Quarter'],
    ['Q3', '2021-10-01', '2021-12-31', '01-Oct-2021', '31-Dec-2021', 'Third Quarter'],
    ['Q4', '2022-01-01', '2022-03-31', '01-Jan-2022', '31-Mar-2022', 'Fourth Quarter'],
  ];
  const facts = [];
  const xmlCache = new Map();
  spec.forEach(([q, s, e, from, to, label], i) => {
    const url = `https://nsearchives.nseindia.com/corporate/xbrl/${q}.xml`;
    const parts = [ctx('OneD', s, e), rev('OneD', cr(quarterCr[i]))];
    if (q === 'Q4') parts.push(ctx('FourD', '2021-04-01', '2022-03-31'), rev('FourD', cr(fullYearCr)));
    const xml = doc(...parts);
    xmlCache.set(url, { xml });
    const record = { ...RECORD, fromDate: from, toDate: to, relatingTo: label, xbrl: url };
    facts.push(toFactDocument(extractFactsFromFiling(xml, record).find((f) => f.metric === 'REVENUE')));
  });
  const db = { collection: () => ({ find: () => ({ toArray: async () => facts }) }) };
  return { db, xmlCache };
};

test('verifySymbol confirms every fact against its filing and that four quarters sum to the year', async () => {
  const { db, xmlCache } = buildYear([11000, 12500, 13000, 15946], 52446);
  const result = await verifySymbol(db, 'AAA', { sample: null, delayMs: 0, xmlCache });
  assert.equal(result.storedFacts, 4);
  assert.equal(result.urlsChecked, 4);
  assert.deepEqual(result.statuses, { MATCH: 4 });
  assert.deepEqual([result.sums.checked, result.sums.ok, result.sums.mismatches.length], [1, 1, 0]);
});

test('verifySymbol flags quarters that do not add up to the filing\'s full year', async () => {
  const { db, xmlCache } = buildYear([11000, 12500, 13000, 13767], 52446);
  const result = await verifySymbol(db, 'AAA', { sample: null, delayMs: 0, xmlCache });
  assert.deepEqual(result.statuses, { MATCH: 4 }, 'each quarter still matches its own filing');
  assert.equal(result.sums.ok, 0);
  assert.equal(result.sums.mismatches[0].status, 'SUM_MISMATCH');
  assert.equal(result.sums.mismatches[0].metric, 'REVENUE');
});

test('an unreachable source is reported as a fetch failure, never as a match', async () => {
  const { db } = buildYear([1, 2, 3, 4], 10);
  const xmlCache = new Map([...['Q1', 'Q2', 'Q3', 'Q4'].map((q) => [`https://nsearchives.nseindia.com/corporate/xbrl/${q}.xml`, { error: 'HTTP 403' }])]);
  const result = await verifySymbol(db, 'AAA', { sample: null, delayMs: 0, xmlCache });
  assert.equal(result.urlsChecked, 0);
  assert.equal(result.fetchFailures.length, 4);
  assert.deepEqual(result.statuses, {});
});

test('sampling checks fewer filings but never invents results for the ones it skips', async () => {
  const { db, xmlCache } = buildYear([11000, 12500, 13000, 15946], 52446);
  const result = await verifySymbol(db, 'AAA', { sample: 2, delayMs: 0, xmlCache });
  assert.equal(result.urlsStored, 4);
  assert.equal(result.urlsChecked, 2);
  assert.equal(result.factsChecked, 2);
});
