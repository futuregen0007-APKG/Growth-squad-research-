/**
 * backfillStockHistory.js
 * ==========================
 * `npm run stocks:backfill-history -- --from=2025-09-13 --to=2026-09-12 [--resume]`
 *
 * Replaces per-symbol Angel One historical-candle calls (HTTP 403 for most
 * symbols in this environment) with NSE's own official CM-UDiFF bhavcopy:
 * ONE file per trading day covers every listed equity, so a full year of
 * history for the whole 215-stock universe costs ~250 HTTP requests total,
 * never 215-per-day.
 *
 * Resumable: BhavcopyIngestionStatus records one document per calendar date
 * attempted; --resume skips any date already COMPLETED or NO_TRADING.
 * Circuit breaker: stops the whole run (not just one date) after
 * MAX_CONSECUTIVE_FAILURES transient failures in a row, since that pattern
 * means the provider itself is down/blocking, not that today happened to
 * have a bad file.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { fetchAndParseBhavcopyForDate } from '../providers/NseBhavcopyHistoricalProvider.js';
import StockPriceHistorySnapshot from '../models/StockPriceHistorySnapshot.js';
import BhavcopyIngestionStatus from '../models/BhavcopyIngestionStatus.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const MAX_CONSECUTIVE_FAILURES = 5;
const THROTTLE_MS = 400; // polite spacing between one-file-per-day requests

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dateRange = (fromStr, toStr) => {
  const dates = [];
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T00:00:00.000Z`);
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue; // NSE never trades weekends -- skip without even attempting a download
    dates.push(new Date(d));
  }
  return dates;
};

/** Upserts every parsed row for one date, keyed by the model's own unique {symbol,exchange,tradingDate,provider} index -- re-running a date is always safe. */
const persistRows = async (rows) => {
  let written = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await StockPriceHistorySnapshot.findOneAndUpdate(
      { symbol: row.symbol, exchange: row.exchange, tradingDate: row.tradingDate, provider: row.provider },
      { $set: { ...row, fetchedAt: new Date(), dataAsOf: row.tradingDate } },
      { upsert: true },
    );
    written += 1;
  }
  return written;
};

export const runStockHistoryBackfill = async (fromStr, toStr, { resume = false, onProgress = () => {} } = {}) => {
  const universeSymbols = Object.keys(SUPPORTED_STOCKS);
  const dates = dateRange(fromStr, toStr);

  const summary = {
    datesConsidered: dates.length, completed: 0, noTrading: 0, failed: 0, rowsIngested: 0, failedDates: [],
  };
  let consecutiveFailures = 0;

  for (const tradingDate of dates) {
    if (resume) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await BhavcopyIngestionStatus.findOne({ tradingDate }).lean();
      if (existing && ['COMPLETED', 'NO_TRADING'].includes(existing.status)) {
        if (existing.status === 'COMPLETED') summary.completed += 1; else summary.noTrading += 1;
        continue;
      }
    }

    const dateLabel = tradingDate.toISOString().slice(0, 10);
    try {
      // eslint-disable-next-line no-await-in-loop
      const { rows, sourceUrl } = await fetchAndParseBhavcopyForDate(tradingDate, universeSymbols);
      // eslint-disable-next-line no-await-in-loop
      const written = await persistRows(rows);
      // eslint-disable-next-line no-await-in-loop
      await BhavcopyIngestionStatus.findOneAndUpdate(
        { tradingDate },
        {
          $set: {
            status: 'COMPLETED', rowsIngested: written, symbolsMatched: rows.length, sourceUrl, error: null, attemptedAt: new Date(),
          },
        },
        { upsert: true },
      );
      summary.completed += 1;
      summary.rowsIngested += written;
      consecutiveFailures = 0;
      onProgress(`[${dateLabel}] OK -- ${written} rows (${rows.length} symbols matched)`);
    } catch (error) {
      if (error.notFound) {
        // eslint-disable-next-line no-await-in-loop
        await BhavcopyIngestionStatus.findOneAndUpdate(
          { tradingDate },
          { $set: { status: 'NO_TRADING', error: error.message, attemptedAt: new Date() } },
          { upsert: true },
        );
        summary.noTrading += 1;
        consecutiveFailures = 0;
        onProgress(`[${dateLabel}] NO_TRADING`);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await BhavcopyIngestionStatus.findOneAndUpdate(
          { tradingDate },
          { $set: { status: 'FAILED_RETRYABLE', error: error.message, attemptedAt: new Date() } },
          { upsert: true },
        );
        summary.failed += 1;
        summary.failedDates.push(dateLabel);
        consecutiveFailures += 1;
        onProgress(`[${dateLabel}] FAILED -- ${error.message}`);
        logger.warn(`[backfillStockHistory] ${dateLabel}: ${error.message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          onProgress(`Circuit breaker tripped after ${consecutiveFailures} consecutive failures -- stopping this run. Re-run with --resume once the provider recovers.`);
          break;
        }
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(THROTTLE_MS);
  }

  return summary;
};

const parseArgs = (argv) => ({
  from: (argv.find((a) => a.startsWith('--from=')) || '').split('=')[1] || null,
  to: (argv.find((a) => a.startsWith('--to=')) || '').split('=')[1] || null,
  resume: argv.includes('--resume'),
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const { from, to, resume } = parseArgs(process.argv.slice(2));
    if (!from || !to) throw new Error('--from=YYYY-MM-DD and --to=YYYY-MM-DD are required');

    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    console.log(`Stock history backfill: ${from} -> ${to}${resume ? ' (--resume)' : ''}`);
    console.log('='.repeat(70));
    const summary = await runStockHistoryBackfill(from, to, { resume, onProgress: (line) => console.log(line) });
    console.log('='.repeat(70));
    console.log(`Dates considered: ${summary.datesConsidered}, completed: ${summary.completed}, no-trading: ${summary.noTrading}, failed: ${summary.failed}`);
    console.log(`Total rows ingested: ${summary.rowsIngested}`);
    if (summary.failedDates.length) console.log(`Failed dates: ${summary.failedDates.join(', ')}`);

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[stocks:backfill-history] Failed: ${err.message}`);
    console.error('Backfill failed:', err.message);
    process.exit(1);
  });
}

export default runStockHistoryBackfill;
