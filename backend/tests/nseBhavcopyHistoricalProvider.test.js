import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBhavcopyCsv, buildBhavcopyUrl } from '../providers/NseBhavcopyHistoricalProvider.js';

/**
 * nseBhavcopyHistoricalProvider.test.js
 * ========================================
 * parseBhavcopyCsv is the exact boundary where a raw NSE file becomes rows
 * this project trusts: symbol renaming (a company's internal key differs
 * from its current NSE ticker), EQ-series-only filtering, and dropping a
 * row with a non-finite OHLC value rather than defaulting it. None of this
 * had a test before -- the bug that motivated this file was diagnosed as
 * "the ingestion never ran", but the parser itself was equally unverified.
 */

const HEADER = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,TtlTradgVol,TtlTrfVal';
const row = ({
  date = '2026-09-24', instrType = 'STK', isin = 'INE000A00000', ticker = 'TCS', series = 'EQ', open = 100, high = 105, low = 99, close = 103, last = 103, prevClose = 101, volume = 1000, turnover = 100300,
} = {}) => [date, date, 'CM', 'NSE', instrType, '1', isin, ticker, series, open, high, low, close, last, prevClose, volume, turnover].join(',');

test('buildBhavcopyUrl formats the official NSE archive URL with a zero-padded YYYYMMDD', () => {
  assert.equal(buildBhavcopyUrl(new Date('2026-01-05T00:00:00.000Z')), 'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260105_F_0000.csv.zip');
});

test('parses a well-formed row for a symbol in the universe', () => {
  const csv = [HEADER, row()].join('\n');
  const rows = parseBhavcopyCsv(csv, ['TCS', 'INFY']);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { symbol: rows[0].symbol, open: rows[0].open, high: rows[0].high, low: rows[0].low, close: rows[0].close, previousClose: rows[0].previousClose, volume: rows[0].volume, turnover: rows[0].turnover, provider: rows[0].provider },
    { symbol: 'TCS', open: 100, high: 105, low: 99, close: 103, previousClose: 101, volume: 1000, turnover: 100300, provider: 'NSE_BHAVCOPY' },
  );
  assert.equal(rows[0].tradingDate.toISOString().slice(0, 10), '2026-09-24');
});

test('a symbol not in the requested universe is dropped, never defaulted or invented', () => {
  const csv = [HEADER, row({ ticker: 'RANDOMCO' })].join('\n');
  assert.deepEqual(parseBhavcopyCsv(csv, ['TCS', 'INFY']), []);
});

test('only FinInstrmTp===STK rows are kept -- an index/derivative row is dropped', () => {
  const csv = [HEADER, row({ instrType: 'IDX' })].join('\n');
  assert.deepEqual(parseBhavcopyCsv(csv, ['TCS']), []);
});

test('only SctySrs===EQ rows are kept -- BE/BZ/SM and other series are dropped, not silently accepted', () => {
  for (const series of ['BE', 'BZ', 'SM', 'ST']) {
    const csv = [HEADER, row({ series })].join('\n');
    assert.deepEqual(parseBhavcopyCsv(csv, ['TCS']), [], `series ${series} must be dropped`);
  }
});

test('a row with a non-finite OHLC field is dropped rather than defaulted to 0 or NaN', () => {
  const csv = [HEADER, row({ close: '-' })].join('\n');
  assert.deepEqual(parseBhavcopyCsv(csv, ['TCS']), []);
});

test('a ticker with a known internal-symbol override is renamed to the internal SUPPORTED_STOCKS key (e.g. RECLTD -> REC)', () => {
  const csv = [HEADER, row({ ticker: 'RECLTD' })].join('\n');
  const rows = parseBhavcopyCsv(csv, ['REC']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'REC');
});

test('a ticker with no override and no matching universe entry produces nothing, and is never guessed', () => {
  const csv = [HEADER, row({ ticker: 'RECLTD' })].join('\n');
  assert.deepEqual(parseBhavcopyCsv(csv, ['RECLTD']), [], 'the raw exchange ticker is never accepted as a fallback identity once an override exists for it');
});

test('an empty CSV (or header-only) produces no rows without throwing', () => {
  assert.deepEqual(parseBhavcopyCsv('', ['TCS']), []);
  assert.deepEqual(parseBhavcopyCsv(HEADER, ['TCS']), []);
});

test('a CSV missing an expected column throws a clear schema-changed error rather than silently parsing garbage', () => {
  const brokenHeader = HEADER.replace('ClsPric,', '');
  assert.throws(() => parseBhavcopyCsv([brokenHeader, row()].join('\n'), ['TCS']), /missing an expected column/);
});

test('multiple valid rows for different universe symbols on the same day are all kept', () => {
  const csv = [HEADER, row({ ticker: 'TCS' }), row({ ticker: 'INFY', close: 200 }), row({ ticker: 'NOTINUNIVERSE' })].join('\n');
  const rows = parseBhavcopyCsv(csv, ['TCS', 'INFY']);
  assert.deepEqual(rows.map((r) => r.symbol).sort(), ['INFY', 'TCS']);
});
