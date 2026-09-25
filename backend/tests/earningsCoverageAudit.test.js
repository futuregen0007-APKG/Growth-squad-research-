import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFiscalWindow, fiscalYearOf, isExchangeHosted, classifyCoverage, collectCoverageRows, orderPending, summarize,
  renderMarkdown, PROMISE_ELIGIBLE_TYPES,
} from '../scripts/earningsCoverageAudit.js';
import { describeMongoTarget, assertMongoTarget } from '../utils/mongoTarget.js';
import { EARNINGS_COVERAGE_METRICS } from '../utils/constants.js';

/**
 * earningsCoverageAudit.test.js
 * ================================
 * The audit is what lets anyone claim "coverage is complete" from evidence.
 * These tests pin the rules that stop it over-counting: only REAL_RESEARCH
 * facts with a validated metric, a numeric value and an http(s) source count,
 * and a job marked COMPLETED proves nothing by itself.
 */

const WINDOW = { fromYear: 2022, toYear: 2026, expectedYears: 5 };

test('describeMongoTarget reports host/database and never any credentials', () => {
  const t = describeMongoTarget('mongodb+srv://someuser:somepass@cluster0.abc.mongodb.net/?appName=Cluster0');
  assert.equal(t.label, 'cluster0.abc.mongodb.net/test');
  assert.equal(t.implicitDatabase, true, 'a URI with no database name silently uses "test"');
  assert.ok(!t.label.includes('somepass') && !t.label.includes('someuser'));
  const named = describeMongoTarget('mongodb://127.0.0.1:27017/stock_market_ai');
  assert.equal(named.label, '127.0.0.1:27017/stock_market_ai');
  assert.equal(named.implicitDatabase, false);
});

test('assertMongoTarget refuses a mismatched target without echoing credentials', () => {
  const uri = 'mongodb+srv://someuser:somepass@cluster0.abc.mongodb.net/prod';
  assert.equal(assertMongoTarget(uri, 'cluster0.abc.mongodb.net/prod').label, 'cluster0.abc.mongodb.net/prod');
  assert.equal(assertMongoTarget(uri, null).label, 'cluster0.abc.mongodb.net/prod', 'no expectation means no enforcement');
  assert.throws(
    () => assertMongoTarget(uri, 'cluster0.abc.mongodb.net/test'),
    (error) => /Refusing to run/.test(error.message) && !error.message.includes('somepass') && !error.message.includes('someuser'),
  );
});

test('the fiscal window is the five most recent COMPLETED Indian fiscal years', () => {
  assert.deepEqual(getFiscalWindow(new Date('2026-09-25T00:00:00Z')), { fromYear: 2022, toYear: 2026, expectedYears: 5 });
  assert.deepEqual(getFiscalWindow(new Date('2027-02-10T00:00:00Z')), { fromYear: 2022, toYear: 2026, expectedYears: 5 }, 'FY2027 is still open before April 2027');
  assert.deepEqual(getFiscalWindow(new Date('2027-04-02T00:00:00Z')), { fromYear: 2023, toYear: 2027, expectedYears: 5 });
});

test('fiscalYearOf reads the first four-digit year, as the universe backfill does', () => {
  assert.equal(fiscalYearOf('FY2024'), 2024);
  assert.equal(fiscalYearOf('Q3 FY2025'), 2025);
  assert.equal(fiscalYearOf('no year here'), null);
  assert.equal(fiscalYearOf(null), null);
});

test('only exchange hosts count as exchange-hosted sources', () => {
  assert.equal(isExchangeHosted('https://www.bseindia.com/xml-data/corpfiling/AttachLive/x.pdf'), true);
  assert.equal(isExchangeHosted('https://nsearchives.nseindia.com/corporate/xbrl/x.xml'), true);
  assert.equal(isExchangeHosted('https://example.com/bseindia.com/x.pdf'), false);
  assert.equal(isExchangeHosted('not a url'), false);
});

test('the audit and the pipeline agree on which metrics make a fiscal year covered', () => {
  assert.ok(EARNINGS_COVERAGE_METRICS.includes('REVENUE') && EARNINGS_COVERAGE_METRICS.includes('PAT'));
  assert.ok(!EARNINGS_COVERAGE_METRICS.includes('OTHER_INCOME'), 'a news/other-only metric must never cover a year');
});

test('promise-eligible source types stay in lockstep with the extraction service', async (t) => {
  let service;
  try { ({ PROMISE_ELIGIBLE_SOURCE_TYPES: service } = await import('../services/PromiseExtractionService.js')); } catch (error) { t.skip(`service not importable here: ${error.message}`); return; }
  assert.deepEqual([...PROMISE_ELIGIBLE_TYPES].sort(), [...service].sort());
});

const baseRow = (over = {}) => ({
  symbol: 'AAA',
  profile: { present: true, researchEnabled: true, bseScripCode: '500001', marketCapCr: 100 },
  facts: { real: 0, financial: 0, nonReal: 0, uniqueSourceDocs: 0, exchangeSourceDocs: 0, coveredYears: [], missingYears: [2022, 2023, 2024, 2025, 2026], byYear: {} },
  promises: { real: 0, publicSafe: 0, curatedFile: 0, candidates: { pending: 0, accepted: 0, rejected: 0 } },
  registry: { total: 0, extracted: 0, failed: 0, inFlight: 0, eligible: 0, promiseExtracted: 0, promiseFailed: 0, promisePending: 0, topErrors: [] },
  job: null,
  run: null,
  ...over,
});
const fullYears = { real: 40, financial: 30, nonReal: 0, uniqueSourceDocs: 12, exchangeSourceDocs: 12, coveredYears: [2022, 2023, 2024, 2025, 2026], missingYears: [], byYear: {} };

test('COMPLETE needs every year covered from an exchange source AND proven promise processing', () => {
  const row = baseRow({ facts: fullYears, registry: { ...baseRow().registry, total: 10, extracted: 10, eligible: 8, promiseExtracted: 8 } });
  assert.equal(classifyCoverage(row, WINDOW).category, 'COMPLETE');
  assert.equal(classifyCoverage(row, WINDOW).promiseStage, 'EXTRACTED_NONE_FOUND', 'zero candidates from processed documents is a legitimate, honest result');
});

test('all five years but no proof promise extraction ran is only PARTIAL', () => {
  const result = classifyCoverage(baseRow({ facts: fullYears }), WINDOW);
  assert.equal(result.category, 'PARTIAL');
  assert.equal(result.promiseStage, 'NOT_RUN');
  assert.ok(result.reasons.some((r) => /Promise extraction has not run/.test(r)));
});

test('missing years are named, and accepted promises alone do not make a company complete', () => {
  const row = baseRow({
    facts: { ...fullYears, coveredYears: [2022, 2023, 2024], missingYears: [2025, 2026] },
    promises: { real: 0, publicSafe: 2, curatedFile: 0, candidates: { pending: 0, accepted: 0, rejected: 0 } },
  });
  const result = classifyCoverage(row, WINDOW);
  assert.equal(result.category, 'PARTIAL');
  assert.ok(result.reasons.some((r) => /3\/5 years \(missing FY2025, FY2026\)/.test(r)));
});

test('pending-review candidates count as processed promise work but never as accepted', () => {
  const row = baseRow({ facts: fullYears, promises: { real: 0, publicSafe: 0, curatedFile: 0, candidates: { pending: 4, accepted: 0, rejected: 0 } } });
  const result = classifyCoverage(row, WINDOW);
  assert.equal(result.promiseStage, 'CANDIDATES_PENDING_REVIEW');
  assert.equal(result.category, 'COMPLETE');
  assert.equal(summarize([{ ...row, ...result }]).acceptedPromises, 0, 'a pending candidate must never be counted as an accepted promise');
});

test('a company with nothing stored is PENDING, and an attempted-but-empty one says so', () => {
  assert.deepEqual(classifyCoverage(baseRow(), WINDOW).reasons, ['Never attempted']);
  const attempted = classifyCoverage(baseRow({ job: { status: 'FAILED_RETRYABLE', attempt: 1, lastError: 'No exchange filings found for any fiscal year in the range' } }), WINDOW);
  assert.equal(attempted.category, 'PENDING');
  assert.match(attempted.reasons[0], /Attempted but nothing stored.*FAILED_RETRYABLE.*No exchange filings found/);
});

test('a job marked COMPLETED with no facts behind it proves nothing', () => {
  const result = classifyCoverage(baseRow({ job: { status: 'COMPLETED', attempt: 1, lastError: null } }), WINDOW);
  assert.notEqual(result.category, 'COMPLETE');
  assert.equal(result.category, 'PENDING');
});

test('BLOCKED needs a concrete recorded reason', () => {
  assert.match(classifyCoverage(baseRow({ profile: { present: true, researchEnabled: false, bseScripCode: null, marketCapCr: null } }), WINDOW).reasons[0], /No resolvable BSE scrip code/);
  assert.equal(classifyCoverage(baseRow({ job: { status: 'FAILED_PERMANENT', attempt: 3, lastError: 'boom' } }), WINDOW).category, 'BLOCKED');
  const allFailed = classifyCoverage(baseRow({ registry: { ...baseRow().registry, total: 3, failed: 3, topErrors: [{ error: 'HTTP 404', count: 3 }] } }), WINDOW);
  assert.equal(allFailed.category, 'BLOCKED');
  assert.match(allFailed.reasons[0], /All 3 registered filing\(s\) failed.*HTTP 404/);
});

test('documents still in flight keep a company from being complete', () => {
  const row = baseRow({ facts: fullYears, registry: { ...baseRow().registry, total: 5, extracted: 4, inFlight: 1, eligible: 4, promiseExtracted: 4 } });
  const result = classifyCoverage(row, WINDOW);
  assert.equal(result.category, 'PARTIAL');
  assert.ok(result.reasons.some((r) => /still FETCHED\/PENDING/.test(r)));
});

/** A minimal in-memory stand-in for the read-only slice of the Mongo driver the audit uses. */
const fakeDb = (data) => ({
  collection: (name) => {
    const rows = data[name] || [];
    return {
      find: (filter = {}) => ({
        toArray: async () => rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)),
      }),
      aggregate: (pipeline) => ({
        toArray: async () => {
          const match = pipeline[0].$match;
          const source = match ? rows.filter((r) => r.dataOrigin !== match.dataOrigin.$ne) : rows;
          const key = pipeline[pipeline.length - 1].$group._id;
          const groups = new Map();
          for (const r of source) {
            const id = typeof key === 'string' ? r[key.slice(1)] : { symbol: r.symbol, status: r.reviewStatus };
            const k = JSON.stringify(id);
            groups.set(k, { _id: id, n: (groups.get(k)?.n || 0) + 1 });
          }
          return [...groups.values()];
        },
      }),
    };
  },
});

const fact = (symbol, period, over = {}) => ({
  symbol, period, dataOrigin: 'REAL_RESEARCH', metrics: { metric: 'REVENUE', actualValue: 100 }, source: { url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/a.pdf' }, ...over,
});

test('collectCoverageRows counts only real, validated, sourced facts and reports the excluded ones', async () => {
  const db = fakeDb({
    companyhistoricalfacts: [
      fact('TCS', 'FY2022'), fact('TCS', 'FY2023'), fact('TCS', 'Q1 FY2024'),
      fact('TCS', 'FY2025', { dataOrigin: 'SEEDED_DEMO' }),
      fact('TCS', 'FY2026', { dataOrigin: undefined }),
      fact('INFY', 'FY2022', { metrics: { metric: 'OTHER_INCOME', actualValue: 5 } }),
      fact('INFY', 'FY2023', { metrics: { metric: 'REVENUE', actualValue: null } }),
      fact('INFY', 'FY2024', { source: { url: 'not-a-url' } }),
      fact('WIPRO', 'FY2010'),
    ],
    researchjobs: [{ symbol: 'ICICIBANK', status: 'COMPLETED', attempt: 1, updatedAt: new Date() }],
  });
  const { window, rows } = await collectCoverageRows(db, { symbols: ['TCS', 'INFY', 'ICICIBANK', 'WIPRO'], now: new Date('2026-09-25T00:00:00Z') });
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));

  assert.deepEqual(window, { fromYear: 2022, toYear: 2026, expectedYears: 5 });
  assert.deepEqual(by.TCS.facts.coveredYears, [2022, 2023, 2024], 'a quarter of FY2024 covers FY2024; demo and origin-less facts cover nothing');
  assert.equal(by.TCS.facts.real, 3);
  assert.equal(by.TCS.facts.nonReal, 2, 'the demo and origin-less facts are reported as excluded, not silently dropped');
  assert.deepEqual(by.INFY.facts.coveredYears, [], 'a non-coverage metric, a null value, or a non-http source never covers a year');
  assert.equal(by.INFY.facts.real, 3, 'they are still real facts, just not coverage');
  assert.deepEqual(by.WIPRO.facts.coveredYears, [], 'a year outside the fiscal window is not counted');
  assert.equal(by.ICICIBANK.category, 'PENDING', 'a COMPLETED job with no facts is not coverage');
});

test('accepted promises come from curated files and public-safe records, never from pending candidates', async () => {
  const db = fakeDb({
    companyhistoricalfacts: [fact('TCS', 'FY2022')],
    managementpromises: [
      { symbol: 'TCS', dataOrigin: 'REAL_RESEARCH', evidenceIntegrity: { status: 'VERIFIED_PRIMARY' } },
      { symbol: 'TCS', dataOrigin: 'REAL_RESEARCH', evidenceIntegrity: { status: 'UNVERIFIED' } },
    ],
    promisecandidates: [
      { symbol: 'TCS', reviewStatus: 'PENDING_REVIEW' }, { symbol: 'TCS', reviewStatus: 'PENDING_REVIEW' },
      { symbol: 'TCS', reviewStatus: 'REJECTED' }, { symbol: 'TCS', reviewStatus: 'ACCEPTED' },
    ],
  });
  const { rows } = await collectCoverageRows(db, { symbols: ['TCS'], now: new Date('2026-09-25T00:00:00Z') });
  const tcs = rows[0];
  assert.equal(tcs.promises.real, 2);
  assert.equal(tcs.promises.publicSafe, 1, 'only VERIFIED_* evidence is public-safe');
  assert.deepEqual(tcs.promises.candidates, { pending: 2, accepted: 1, rejected: 1 });
});

test('registry rows drive promise-stage state and the top failure reasons', async () => {
  const db = fakeDb({
    companyhistoricalfacts: [fact('AAA', 'FY2022')],
    companydocumentregistries: [
      { symbol: 'AAA', sourceType: 'FINANCIAL_RESULTS', extractionStatus: 'EXTRACTED', promiseExtractionStatus: 'EXTRACTED' },
      { symbol: 'AAA', sourceType: 'EARNINGS_CALL_TRANSCRIPT', extractionStatus: 'EXTRACTED', promiseExtractionStatus: 'PENDING' },
      { symbol: 'AAA', sourceType: 'ANNUAL_REPORT', extractionStatus: 'EXTRACTED', promiseExtractionStatus: 'PENDING' },
      { symbol: 'AAA', sourceType: 'FINANCIAL_RESULTS', extractionStatus: 'FAILED', error: 'HTTP 404' },
      { symbol: 'AAA', sourceType: 'FINANCIAL_RESULTS', extractionStatus: 'FAILED', error: 'HTTP 404' },
    ],
  });
  const { rows } = await collectCoverageRows(db, { symbols: ['AAA'], now: new Date('2026-09-25T00:00:00Z') });
  const reg = rows[0].registry;
  assert.equal(reg.total, 5);
  assert.equal(reg.eligible, 2, 'an annual report is not promise-eligible');
  assert.equal(reg.promiseExtracted, 1);
  assert.equal(reg.promisePending, 1);
  assert.deepEqual(reg.topErrors, [{ error: 'HTTP 404', count: 2 }]);
  assert.equal(rows[0].promiseStage, 'NOT_RUN', 'a pending eligible document means promise extraction is not finished');
});

test('orderPending sorts by real market cap, skips disabled profiles, and never lists non-pending symbols', () => {
  const mk = (symbol, category, marketCapCr, researchEnabled = true) => ({ symbol, category, profile: { present: true, researchEnabled, bseScripCode: '1', marketCapCr } });
  const ordered = orderPending([mk('SMALL', 'PENDING', 10), mk('BIG', 'PENDING', 900), mk('OFF', 'PENDING', 5000, false), mk('DONE', 'COMPLETE', 7000), mk('NOCAP', 'PENDING', null)]);
  assert.deepEqual(ordered.map((r) => r.symbol), ['BIG', 'SMALL', 'NOCAP']);
});

test('the markdown report states the target, the window and every symbol', () => {
  const row = { ...baseRow({ symbol: 'AAA', facts: fullYears }), category: 'PARTIAL', promiseStage: 'NOT_RUN', reasons: ['x | y'] };
  const md = renderMarkdown({ label: 'unit', target: describeMongoTarget('mongodb://h/db1'), window: WINDOW, rows: [row], summary: summarize([row]), api: null });
  assert.match(md, /Target database: `h\/db1`/);
  assert.match(md, /FY2022-FY2026/);
  assert.match(md, /\| AAA \| PARTIAL \| 5\/5 \|/);
  assert.ok(!/x \| y/.test(md), 'a pipe inside a reason must not break the table');
});
