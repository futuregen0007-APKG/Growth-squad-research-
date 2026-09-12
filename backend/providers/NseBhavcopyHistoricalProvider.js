/**
 * NseBhavcopyHistoricalProvider.js
 * ===================================
 * Real historical OHLCV from NSE's own official CM-UDiFF "Common Bhavcopy
 * Final" file -- ONE file per trading day covers every listed equity, which
 * is why this replaces per-symbol Angel One historical-candle calls (Angel
 * One's historical endpoint returns HTTP 403 for the large majority of
 * symbols in this environment; confirmed live, independent of concurrency).
 * Angel One remains the only source for LIVE/current price -- this module
 * is never used for that.
 *
 * URL confirmed live: https://nsearchives.nseindia.com/content/cm/
 * BhavCopy_NSE_CM_0_0_0_<YYYYMMDD>_F_0000.csv.zip -- a small ZIP containing
 * one CSV with columns TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,
 * TckrSymb,SctySrs,...,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,
 * ...,TtlTradgVol,TtlTrfVal,... Only FinInstrmTp==='STK' rows are equities;
 * only SctySrs==='EQ' is the primary listed series (other series --
 * BE/BZ/SM/etc. -- are deliberately not supported here, per "ignore non-EQ
 * series unless deliberately supported").
 */
import axios from 'axios';
import https from 'node:https';
import AdmZip from 'adm-zip';
import { logger } from '../utils/logger.js';
import { SCRIP_ID_OVERRIDES } from './BseScripMasterProvider.js';

// The same real, verified rename map already resolved for BSE scrip codes
// (13 companies whose current exchange ticker differs from this project's
// internal SUPPORTED_STOCKS key, e.g. REC -> RECLTD, ZOMATO -> ETERNAL) --
// confirmed live that every override target is also NSE's real EQ-series
// ticker for that company, so the same map applies here rather than
// guessing a second, NSE-specific one. Reversed so an incoming NSE ticker
// (e.g. "RECLTD") maps back to the internal key ("REC") the rest of this
// project already uses.
const NSE_TICKER_TO_INTERNAL_SYMBOL = Object.fromEntries(
  Object.entries(SCRIP_ID_OVERRIDES).map(([internalSymbol, exchangeTicker]) => [exchangeTicker, internalSymbol]),
);

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const NSE_REFERER = 'https://www.nseindia.com/';
// Same fix as BSE's provider this session: connection reuse to these
// exchange archive hosts has previously triggered malformed-header errors
// under load; disabling keep-alive avoided it there and costs nothing here.
const NO_KEEPALIVE_AGENT = new https.Agent({ keepAlive: false });

const SUPPORTED_SERIES = new Set(['EQ']);

const formatYyyyMmDd = (date) => {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

export const buildBhavcopyUrl = (date) => `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${formatYyyyMmDd(date)}_F_0000.csv.zip`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded retry for transient errors only -- a permanent 4xx (404: no
// trading that day, e.g. a weekend/holiday) must never be retried.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const withRetry = async (fn, { retries = 3, baseDelayMs = 1000 } = {}) => {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      const status = error.response?.status;
      const transient = RETRYABLE_STATUS.has(status) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code);
      if (!transient || attempt === retries) throw error;
      // eslint-disable-next-line no-await-in-loop
      await sleep(baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * 300));
    }
  }
  return undefined;
};

/**
 * downloadBhavcopy - fetches one trading day's ZIP and returns the raw CSV
 * text. Throws with `.notFound = true` for a 404 (no trading that day --
 * weekend/holiday, a permanent condition, never retried by the caller as a
 * transient failure) so a caller can record NO_TRADING rather than FAILED.
 */
export const downloadBhavcopy = async (date) => {
  const url = buildBhavcopyUrl(date);
  try {
    const response = await withRetry(() => axios.get(url, {
      headers: { 'User-Agent': BROWSER_UA, Referer: NSE_REFERER },
      responseType: 'arraybuffer',
      httpsAgent: NO_KEEPALIVE_AGENT,
      timeout: 20000,
    }));
    const zip = new AdmZip(Buffer.from(response.data));
    const entries = zip.getEntries();
    if (!entries.length) throw new Error('Bhavcopy ZIP contained no entries');
    return { csvText: zip.readAsText(entries[0]), sourceUrl: url };
  } catch (error) {
    if (error.response?.status === 404) {
      const notFoundError = new Error(`No bhavcopy published for ${formatYyyyMmDd(date)} (likely a non-trading day)`);
      notFoundError.notFound = true;
      throw notFoundError;
    }
    throw error;
  }
};

/** Minimal, dependency-free CSV line splitter -- the bhavcopy format never quotes/escapes fields (confirmed live: plain comma-separated, no embedded commas in any column used here). */
const splitCsvLine = (line) => line.split(',');

/**
 * parseBhavcopyCsv - pure function: real CSV text -> normalized OHLCV rows,
 * filtered to `universeSymbols` (the existing 215-stock universe) and to
 * the EQ series only. Never guesses a missing/malformed numeric field --
 * a row with a non-finite OHLC value is dropped rather than defaulted.
 */
export const parseBhavcopyCsv = (csvText, universeSymbols, { sourceUrl = null } = {}) => {
  const universe = new Set((universeSymbols || []).map((s) => String(s).toUpperCase()));
  const lines = String(csvText || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((name, index) => [name.trim(), index]));
  const required = ['TradDt', 'FinInstrmTp', 'ISIN', 'TckrSymb', 'SctySrs', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric', 'PrvsClsgPric', 'TtlTradgVol', 'TtlTrfVal'];
  if (required.some((name) => !(name in col))) {
    throw new Error(`Bhavcopy CSV is missing an expected column (schema may have changed): expected ${required.join(', ')}`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = splitCsvLine(lines[i]);
    if (fields[col.FinInstrmTp] !== 'STK') continue;
    const series = fields[col.SctySrs];
    if (!SUPPORTED_SERIES.has(series)) continue;
    const nseTicker = String(fields[col.TckrSymb] || '').trim().toUpperCase();
    const symbol = NSE_TICKER_TO_INTERNAL_SYMBOL[nseTicker] || nseTicker;
    if (!universe.has(symbol)) continue;

    const open = Number(fields[col.OpnPric]);
    const high = Number(fields[col.HghPric]);
    const low = Number(fields[col.LwPric]);
    const close = Number(fields[col.ClsPric]);
    const previousClose = Number(fields[col.PrvsClsgPric]);
    const volume = Number(fields[col.TtlTradgVol]);
    const turnover = Number(fields[col.TtlTrfVal]);
    if (![open, high, low, close].every(Number.isFinite)) continue;

    rows.push({
      symbol,
      exchange: 'NSE',
      series,
      isin: fields[col.ISIN] || null,
      tradingDate: new Date(fields[col.TradDt]),
      open,
      high,
      low,
      close,
      previousClose: Number.isFinite(previousClose) ? previousClose : null,
      volume: Number.isFinite(volume) ? volume : null,
      turnover: Number.isFinite(turnover) ? turnover : null,
      provider: 'NSE_BHAVCOPY',
      sourceUrl,
    });
  }
  return rows;
};

/**
 * fetchAndParseBhavcopyForDate - the main entry point for one trading date:
 * download + parse + filter to the universe, in one step. Throws (with
 * `.notFound`/`.transient` markers where applicable) rather than silently
 * returning an empty array on failure, so the backfill script can
 * distinguish "genuinely no trading that day" from "download failed".
 */
export const fetchAndParseBhavcopyForDate = async (date, universeSymbols) => {
  const { csvText, sourceUrl } = await downloadBhavcopy(date);
  const rows = parseBhavcopyCsv(csvText, universeSymbols, { sourceUrl });
  return { rows, sourceUrl, fetchedAt: new Date() };
};

export default { downloadBhavcopy, parseBhavcopyCsv, fetchAndParseBhavcopyForDate, buildBhavcopyUrl };
