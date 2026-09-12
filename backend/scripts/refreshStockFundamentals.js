/**
 * refreshStockFundamentals.js
 * =============================
 * `npm run stocks:refresh-fundamentals` (optionally `-- --batch-size=5
 * --delay-ms=2000 --symbol=TCS,HAL --resume`).
 *
 * Precomputes the P/E + ROE Redis cache (24h TTL) that DynamicUniverseService
 * reads on every "Load Eligible Stocks" request -- the daily prewarm job
 * required so a goal request never fetches+scores all 215 stocks live on a
 * button click. Persists progress after every batch (fundamentals:meta) so
 * `--resume` can pick up where a quota-exhausted run left off instead of
 * restarting the whole 205+ stock universe, and stops early (rather than
 * burning remaining retries) once IndianAPI starts returning RATE_LIMITED
 * for a whole batch.
 */
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { fetchAndCacheFundamentals, getRefreshMeta, saveRefreshMeta } from '../services/StockFundamentalsService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const DEFAULT_BATCH_SIZE = Number(process.env.FUNDAMENTALS_REFRESH_BATCH_SIZE) || 5;
export const DEFAULT_BATCH_DELAY_MS = Number(process.env.FUNDAMENTALS_REFRESH_BATCH_DELAY_MS) || 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const chunk = (items, size) => {
  const safeSize = Math.max(1, Number(size) || 1);
  const batches = [];
  for (let i = 0; i < items.length; i += safeSize) batches.push(items.slice(i, i + safeSize));
  return batches;
};

const parseArgs = (argv) => {
  const symbolArg = argv.find((a) => a.startsWith('--symbol='));
  const batchArg = argv.find((a) => a.startsWith('--batch-size='));
  const delayArg = argv.find((a) => a.startsWith('--delay-ms='));
  return {
    symbols: symbolArg ? symbolArg.split('=')[1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    batchSize: batchArg ? Number(batchArg.split('=')[1]) : DEFAULT_BATCH_SIZE,
    delayMs: delayArg ? Number(delayArg.split('=')[1]) : DEFAULT_BATCH_DELAY_MS,
    resume: argv.includes('--resume'),
  };
};

/**
 * `--resume` skips symbols the previous run already completed successfully
 * (tracked in fundamentals:meta.completedSymbols) -- only symbols still
 * missing or previously failed are retried. Without --resume, every
 * requested symbol is attempted (a fresh full cycle).
 */
export const run = async ({
  symbols, batchSize, delayMs, resume = false, fetchFn = fetchAndCacheFundamentals,
  getMetaFn = getRefreshMeta, saveMetaFn = saveRefreshMeta,
} = {}) => {
  const universe = symbols && symbols.length ? symbols : Object.keys(SUPPORTED_STOCKS);
  const meta = await getMetaFn();
  const alreadyCompleted = new Set(resume ? (meta.completedSymbols || []) : []);
  const targets = universe.filter((symbol) => !alreadyCompleted.has(symbol));

  const completedSymbols = new Set(alreadyCompleted);
  const failedSymbols = [];
  const results = [];
  let stoppedEarly = false;

  const batches = chunk(targets, batchSize);
  for (const [index, batch] of batches.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await Promise.all(batch.map(async (symbol) => {
      const outcome = await fetchFn(symbol);
      return { symbol, ...outcome };
    }));
    results.push(...batchResults);

    for (const r of batchResults) {
      if (r.status === 'OK') { completedSymbols.add(r.symbol); }
      else { failedSymbols.push({ symbol: r.symbol, status: r.status, errorCode: r.errorCode, error: r.error }); }
    }

    const rateLimitedCount = batchResults.filter((r) => r.status === 'RATE_LIMITED').length;
    const providerStatus = rateLimitedCount === batchResults.length ? 'RATE_LIMITED' : rateLimitedCount > 0 ? 'DEGRADED' : 'OK';

    // eslint-disable-next-line no-await-in-loop
    await saveMetaFn({
      lastSuccessfulRefresh: completedSymbols.size ? new Date().toISOString() : meta.lastSuccessfulRefresh,
      providerStatus,
      completedSymbols: Array.from(completedSymbols),
      failedSymbols: failedSymbols.map((f) => f.symbol),
      lastAttemptAt: new Date().toISOString(),
    });

    // Every symbol in this whole batch came back rate-limited: the quota is
    // exhausted right now, so stop rather than burn through the remaining
    // batches on guaranteed failures. Progress already saved above -- a
    // later `--resume` continues from here.
    if (rateLimitedCount === batchResults.length && batchResults.length > 0) {
      logger.warn(`[refreshStockFundamentals] Entire batch ${index + 1}/${batches.length} was rate-limited -- stopping early. Re-run with --resume once quota resets.`);
      stoppedEarly = true;
      break;
    }

    logger.info(`[refreshStockFundamentals] Batch ${index + 1}/${batches.length}: ${batchResults.filter((r) => r.status === 'OK').length}/${batch.length} succeeded`);
    if (index < batches.length - 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }

  return { results, completedSymbols: Array.from(completedSymbols), failedSymbols, stoppedEarly, totalTargeted: universe.length, skippedAlreadyDone: universe.length - targets.length };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const { symbols, batchSize, delayMs, resume } = parseArgs(process.argv.slice(2));
  run({ symbols, batchSize, delayMs, resume }).then((summary) => {
    console.log('Stock fundamentals refresh complete');
    console.log('='.repeat(60));
    console.log(`Universe targeted: ${summary.totalTargeted}${resume ? ` (${summary.skippedAlreadyDone} already done, skipped via --resume)` : ''}`);
    console.log(`Succeeded this run: ${summary.completedSymbols.length}`);
    console.log(`Failed: ${summary.failedSymbols.length}`);
    for (const f of summary.failedSymbols) console.log(`  [${f.status}] ${f.symbol} -- ${f.errorCode || 'UNKNOWN'}: ${f.error || ''}`);
    if (summary.stoppedEarly) console.log('\nStopped early due to rate limiting. Re-run with --resume once quota resets.');
    process.exit(0);
  }).catch((err) => {
    logger.error(`[stocks:refresh-fundamentals] Failed: ${err.message}`);
    console.error('Refresh failed:', err.message);
    process.exit(1);
  });
}

export default run;
