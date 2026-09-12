/**
 * refreshFinancialIntelligence.js
 * =================================
 * `npm run earnings:refresh-financial` (optionally `-- --batch-size=10
 * --delay-ms=3000` to override the defaults, or `--symbol=TCS,HAL` to refresh
 * only specific symbols instead of all of SUPPORTED_STOCKS).
 *
 * Pre-warms CompanyResearchService's cache (backed by IndianApiProvider's
 * Redis cache, 1-hour TTL) for the Financial Snapshot (revenue/profit
 * growth, margin, EPS, debt trend -- discrete reported figures, never a
 * blended "score"), so a real
 * page load never pays the live-fetch cost. Iterates SUPPORTED_STOCKS in
 * small batches with a delay between batches -- never all 215 concurrently
 * -- and retries a transient failure once, mirroring IndianApiProvider's own
 * MAX_RETRIES=1 "one bounded retry, never a retry storm" convention.
 *
 * This never writes to Mongo or the curated dataset -- it only reads
 * through the existing IndianAPI-backed provider/cache stack, exactly the
 * same call a real request would make.
 */
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { getCompanyResearchBundle } from '../services/CompanyResearchService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const DEFAULT_BATCH_SIZE = Number(process.env.FINANCIAL_REFRESH_BATCH_SIZE) || 5;
export const DEFAULT_BATCH_DELAY_MS = Number(process.env.FINANCIAL_REFRESH_BATCH_DELAY_MS) || 2000;
const MAX_RETRIES = 1; // one bounded retry only -- never a retry storm (mirrors IndianApiProvider.js)
const RETRY_DELAY_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const chunk = (items, size) => {
  const safeSize = Math.max(1, Number(size) || 1);
  const batches = [];
  for (let i = 0; i < items.length; i += safeSize) batches.push(items.slice(i, i + safeSize));
  return batches;
};

/**
 * refreshOneSymbol - fetches (and thereby caches) one symbol's research
 * bundle. Never throws: a failure after MAX_RETRIES is reported in the
 * returned status, not propagated, so one bad symbol never stops a batch.
 */
export const refreshOneSymbol = async (symbol, { fetchBundle, attempt = 0 } = {}) => {
  try {
    const bundle = await fetchBundle(symbol);
    return { symbol, status: 'OK', configured: Boolean(bundle?.configured) };
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      return refreshOneSymbol(symbol, { fetchBundle, attempt: attempt + 1 });
    }
    logger.warn(`[refreshFinancialIntelligence] ${symbol} failed after ${attempt + 1} attempt(s): ${err.message}`);
    return { symbol, status: 'FAILED', error: err.message };
  }
};

/**
 * refreshAllFinancialIntelligence - batches `symbols` (default: every
 * SUPPORTED_STOCKS key) into groups of `batchSize`, fetching each batch
 * concurrently (bounded by batchSize, never more) and waiting `batchDelayMs`
 * between batches. `fetchBundle` is injectable so tests can run this with a
 * mocked provider and zero live network calls.
 */
export const refreshAllFinancialIntelligence = async ({
  symbols = Object.keys(SUPPORTED_STOCKS),
  batchSize = DEFAULT_BATCH_SIZE,
  batchDelayMs = DEFAULT_BATCH_DELAY_MS,
  fetchBundle = getCompanyResearchBundle,
  onBatchComplete = null,
} = {}) => {
  const batches = chunk(symbols, batchSize);
  const results = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await Promise.all(batch.map((symbol) => refreshOneSymbol(symbol, { fetchBundle })));
    results.push(...batchResults);
    if (onBatchComplete) onBatchComplete({ batchIndex: i, totalBatches: batches.length, batchResults });
    if (i < batches.length - 1 && batchDelayMs > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(batchDelayMs);
    }
  }

  return results;
};

const parseArgs = (argv) => {
  const symbolArg = argv.find((a) => a.startsWith('--symbol='));
  const batchSizeArg = argv.find((a) => a.startsWith('--batch-size='));
  const delayArg = argv.find((a) => a.startsWith('--delay-ms='));
  return {
    symbols: symbolArg ? symbolArg.replace('--symbol=', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined,
    batchSize: batchSizeArg ? Number(batchSizeArg.replace('--batch-size=', '')) : undefined,
    batchDelayMs: delayArg ? Number(delayArg.replace('--delay-ms=', '')) : undefined,
  };
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const symbols = args.symbols || Object.keys(SUPPORTED_STOCKS);
  const batchSize = args.batchSize || DEFAULT_BATCH_SIZE;
  const batchDelayMs = args.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;

  console.log(`Refreshing Financial Snapshot data for ${symbols.length} symbol(s), batch size ${batchSize}, ${batchDelayMs}ms between batches.`);

  const results = await refreshAllFinancialIntelligence({
    symbols,
    batchSize,
    batchDelayMs,
    onBatchComplete: ({ batchIndex, totalBatches, batchResults }) => {
      console.log(`Batch ${batchIndex + 1}/${totalBatches}: ${batchResults.map((r) => `${r.symbol}=${r.status}`).join(', ')}`);
    },
  });

  const ok = results.filter((r) => r.status === 'OK').length;
  const failed = results.filter((r) => r.status === 'FAILED');
  console.log('');
  console.log(`Done. OK: ${ok}, Failed: ${failed.length}.`);
  if (failed.length) console.log('Failed symbols:', failed.map((r) => r.symbol).join(', '));

  process.exit(0);
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  run().catch((err) => {
    logger.error(`[earnings:refresh-financial] Failed: ${err.message}`);
    console.error('Refresh failed:', err.message);
    process.exit(1);
  });
}

export { run };
