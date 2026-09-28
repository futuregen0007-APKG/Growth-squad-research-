import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { runStockHistoryBackfill } from '../scripts/backfillStockHistory.js';
import StockPriceHistorySnapshot from '../models/StockPriceHistorySnapshot.js';
import BhavcopyIngestionStatus from '../models/BhavcopyIngestionStatus.js';

/**
 * backfillStockHistory.test.js
 * ==============================
 * This is the bounded, resumable, idempotent backfill that was written but
 * never actually run against production -- StockPriceHistorySnapshot and
 * StockHistoricalMetricsSnapshot were both completely empty, which is the
 * real root cause of "205 of 205 stocks lack sufficient verified historical
 * price data". These tests pin the three properties the fix depends on:
 * resuming skips completed dates without re-fetching, a re-run never
 * duplicates a row, and a run of consecutive provider failures stops itself
 * (a circuit breaker) rather than hammering a source that is down.
 *
 * Network is mocked by monkey-patching axios.get -- the same convention
 * already used elsewhere in this suite (documentDiscovery.test.js) --
 * because NseBhavcopyHistoricalProvider imports the shared axios singleton
 * directly, so reassigning its .get method here is visible to the module
 * under test without needing module-mocking machinery.
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

// A fixed, all-weekday Monday-Friday test week, far from any real date this
// suite or production data would ever use.
const RANGE = { from: '2024-03-04', to: '2024-03-08' }; // Mon 3/4 .. Fri 3/8, 2024 -- 5 weekdays, no weekend in between
const RANGE_DATES = ['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08'];

// Covers every date any test in this file touches (the circuit-breaker and
// streak-reset tests range up to 2024-03-13) -- a narrower window here was a
// real isolation gap: 2024-03-11..13 were never cleared between runs, so a
// leftover COMPLETED/FAILED_RETRYABLE status document from an earlier
// invocation of this same file (e.g. one interrupted by an external kill,
// or simply run twice) could silently satisfy runStockHistoryBackfill's
// --resume-unaware upsert and be miscounted by a later test's own query
// over the same range.
const TEST_DATE_FLOOR = new Date('2024-03-01');
const TEST_DATE_CEILING = new Date('2024-03-14');
const cleanup = async () => {
  await StockPriceHistorySnapshot.deleteMany({ tradingDate: { $gte: TEST_DATE_FLOOR, $lte: TEST_DATE_CEILING } });
  await BhavcopyIngestionStatus.deleteMany({ tradingDate: { $gte: TEST_DATE_FLOOR, $lte: TEST_DATE_CEILING } });
};

const zipOf = (csvText) => {
  const zip = new AdmZip();
  zip.addFile('bhavcopy.csv', Buffer.from(csvText));
  return zip.toBuffer();
};

const HEADER = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal';
const tcsRow = (dateStr, close = 100) => [dateStr, dateStr, 'CM', 'NSE', 'STK', '1', 'INE467B01029', 'TCS', 'EQ', close, close + 2, close - 2, close, close, close - 1, 1000, close * 1000].join(',');

const originalGet = axios.get;
/** Installs a fake axios.get keyed by the YYYYMMDD embedded in the request URL. `byDate[yyyymmdd]` is either a CSV string (200 OK), 'NOT_FOUND' (404), or 'TRANSIENT' (503). */
const installFakeAxios = (byDate) => {
  axios.get = async (url) => {
    const match = String(url).match(/(\d{8})_F_0000\.csv\.zip$/);
    const key = match ? match[1] : null;
    const outcome = key ? byDate[key] : undefined;
    if (outcome === undefined || outcome === 'NOT_FOUND') {
      const error = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      throw error;
    }
    if (outcome === 'TRANSIENT') {
      const error = new Error('Request failed with status code 503');
      error.response = { status: 503 };
      throw error;
    }
    return { data: zipOf(outcome) };
  };
};
const restoreAxios = () => { axios.get = originalGet; };

const yyyymmdd = (isoDate) => isoDate.replace(/-/g, '');

test('a clean run over 5 weekdays ingests each date once, and re-running with --resume skips every already-completed date without any new network calls', async (t) => {
  t.after(async () => { restoreAxios(); await cleanup(); });
  await cleanup();

  const byDate = {};
  for (const d of RANGE_DATES) byDate[yyyymmdd(d)] = [HEADER, tcsRow(d)].join('\n');
  installFakeAxios(byDate);

  const first = await runStockHistoryBackfill(RANGE.from, RANGE.to, { resume: false });
  assert.equal(first.datesConsidered, 5);
  assert.equal(first.completed, 5);
  assert.equal(first.failed, 0);
  assert.equal(first.rowsIngested, 5);

  const statusDocs = await BhavcopyIngestionStatus.find({ tradingDate: { $gte: TEST_DATE_FLOOR, $lte: TEST_DATE_CEILING } }).lean();
  assert.equal(statusDocs.length, 5);
  assert.ok(statusDocs.every((d) => d.status === 'COMPLETED'));

  const priceDocs = await StockPriceHistorySnapshot.find({ symbol: 'TCS', tradingDate: { $gte: TEST_DATE_FLOOR, $lte: TEST_DATE_CEILING } }).lean();
  assert.equal(priceDocs.length, 5);

  // Now make any further network call fail loudly -- if --resume incorrectly re-fetches a completed date, this proves it.
  axios.get = async () => { throw new Error('must not be called: --resume should skip every already-completed date'); };
  const second = await runStockHistoryBackfill(RANGE.from, RANGE.to, { resume: true });
  assert.equal(second.completed, 5);
  assert.equal(second.failed, 0);

  const priceDocsAfterResume = await StockPriceHistorySnapshot.find({ symbol: 'TCS', tradingDate: { $gte: TEST_DATE_FLOOR, $lte: TEST_DATE_CEILING } }).lean();
  assert.equal(priceDocsAfterResume.length, 5, 'resuming a fully-completed range must never duplicate rows');
});

test('re-running the SAME date without --resume re-fetches but upserts idempotently -- never a duplicate row, and a changed close price is reflected', async (t) => {
  t.after(async () => { restoreAxios(); await cleanup(); });
  await cleanup();

  const oneDay = { from: '2024-03-04', to: '2024-03-04' };
  installFakeAxios({ [yyyymmdd('2024-03-04')]: [HEADER, tcsRow('2024-03-04', 100)].join('\n') });
  await runStockHistoryBackfill(oneDay.from, oneDay.to, { resume: false });

  installFakeAxios({ [yyyymmdd('2024-03-04')]: [HEADER, tcsRow('2024-03-04', 150)].join('\n') }); // a corrected/re-published figure
  await runStockHistoryBackfill(oneDay.from, oneDay.to, { resume: false });

  const docs = await StockPriceHistorySnapshot.find({ symbol: 'TCS', tradingDate: new Date('2024-03-04T00:00:00.000Z') }).lean();
  assert.equal(docs.length, 1, 'the unique {symbol, exchange, tradingDate, provider} index must prevent a second document for the same date');
  assert.equal(docs[0].close, 150, 'a re-run reflects the latest fetched value rather than freezing the first one');
});

test('a 404 (no bhavcopy published) is recorded as NO_TRADING, not FAILED, and does not count toward the failure circuit breaker', async (t) => {
  t.after(async () => { restoreAxios(); await cleanup(); });
  await cleanup();

  const byDate = {};
  for (const d of RANGE_DATES) byDate[yyyymmdd(d)] = [HEADER, tcsRow(d)].join('\n');
  byDate[yyyymmdd('2024-03-06')] = 'NOT_FOUND'; // a holiday in the middle of the week
  installFakeAxios(byDate);

  const result = await runStockHistoryBackfill(RANGE.from, RANGE.to, { resume: false });
  assert.equal(result.noTrading, 1);
  assert.equal(result.completed, 4);
  assert.equal(result.failed, 0);

  const status = await BhavcopyIngestionStatus.findOne({ tradingDate: new Date('2024-03-06T00:00:00.000Z') }).lean();
  assert.equal(status.status, 'NO_TRADING');
});

test('circuit breaker: 5 consecutive transient failures stop the whole run rather than continuing to hammer a down provider', async (t) => {
  t.after(async () => { restoreAxios(); await cleanup(); });
  await cleanup();

  // An 8-weekday range (2 trading weeks) so there is room to observe the run stop before the range is exhausted.
  const longRange = { from: '2024-03-04', to: '2024-03-13' }; // Mon 3/4 .. Wed 3/13 -> 8 weekdays
  const byDate = {};
  for (const d of ['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08', '2024-03-11', '2024-03-12', '2024-03-13']) byDate[yyyymmdd(d)] = 'TRANSIENT';
  installFakeAxios(byDate);

  const messages = [];
  const result = await runStockHistoryBackfill(longRange.from, longRange.to, { resume: false, onProgress: (m) => messages.push(m) });

  assert.equal(result.datesConsidered, 8);
  assert.equal(result.failed, 5, 'the run must stop at exactly the circuit-breaker threshold, not run through the whole range');
  assert.equal(result.completed, 0);
  assert.equal(result.failedDates.length, 5);
  assert.ok(messages.some((m) => /Circuit breaker tripped/.test(m)));

  const statusDocs = await BhavcopyIngestionStatus.find({ tradingDate: { $gte: TEST_DATE_FLOOR, $lte: TEST_DATE_CEILING } }).lean();
  assert.equal(statusDocs.length, 5, 'the 3 dates after the trip must never have been attempted at all');
  assert.ok(statusDocs.every((d) => d.status === 'FAILED_RETRYABLE'));
});

test('a transient failure resets its streak after an intervening success -- the breaker only trips on a genuinely consecutive run', async (t) => {
  t.after(async () => { restoreAxios(); await cleanup(); });
  await cleanup();

  const byDate = {
    [yyyymmdd('2024-03-04')]: 'TRANSIENT',
    [yyyymmdd('2024-03-05')]: 'TRANSIENT',
    [yyyymmdd('2024-03-06')]: [HEADER, tcsRow('2024-03-06')].join('\n'), // breaks the streak
    [yyyymmdd('2024-03-07')]: 'TRANSIENT',
    [yyyymmdd('2024-03-08')]: 'TRANSIENT',
  };
  installFakeAxios(byDate);

  const result = await runStockHistoryBackfill(RANGE.from, RANGE.to, { resume: false });
  assert.equal(result.datesConsidered, 5);
  assert.equal(result.failed, 4, 'all 4 transient failures are recorded, just never 4-in-a-row');
  assert.equal(result.completed, 1);
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
