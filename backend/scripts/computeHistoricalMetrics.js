/**
 * computeHistoricalMetrics.js
 * =============================
 * `npm run stocks:compute-metrics -- --symbols=TCS,INFY,BHEL`
 * `npm run stocks:compute-metrics` (full SUPPORTED_STOCKS universe)
 *
 * Stage 3 of the production bootstrap: turns already-ingested
 * StockPriceHistorySnapshot rows (NSE bhavcopy, see backfillStockHistory.js)
 * into the persisted StockHistoricalMetricsSnapshot documents Goals/Stock
 * Detail actually read (52W high/low, 1Y return, volatility, drawdown).
 * Pure computation over data already in MongoDB -- no external network
 * calls, no provider quota, safe to (re-)run for any subset of symbols at
 * any time. Reuses StockHistoricalMetricsService.recomputeMetricsForSymbols
 * exactly as-is; this file only adds a thin, filterable CLI wrapper.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { recomputeMetricsForSymbols } from '../services/StockHistoricalMetricsService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const run = async ({ symbols, onProgress = () => {} } = {}) => {
  const targets = symbols && symbols.length ? symbols : Object.keys(SUPPORTED_STOCKS);
  const results = await recomputeMetricsForSymbols(targets, { onProgress });
  return { targets, ...results };
};

const parseArgs = (argv) => {
  const symbolsArg = argv.find((a) => a.startsWith('--symbols='));
  return {
    symbols: symbolsArg ? symbolsArg.split('=')[1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });

    const args = parseArgs(process.argv.slice(2));
    const result = await run({ ...args, onProgress: (msg) => console.log(msg) });
    console.log('\nSummary:', JSON.stringify({ computed: result.computed, skipped: result.skipped, failed: result.failed }));

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[stocks:compute-metrics] Failed: ${err.message}`);
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

export default run;
