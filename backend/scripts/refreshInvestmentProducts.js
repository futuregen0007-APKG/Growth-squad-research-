/**
 * refreshInvestmentProducts.js
 * ===============================
 * `npm run products:refresh` (optionally `-- --batch-size=10 --delay-ms=500`).
 *
 * Daily ingest job: real AMFI scheme universe + real per-scheme NAV history
 * -> InvestmentProductSnapshot documents in Mongo. This is the only thing
 * that ever calls the AMFI/mfapi.in providers -- goal requests only ever
 * read the persisted snapshots (see GoalProductRecommendationService.js).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ingestAllProducts } from '../services/GoalProductRecommendationService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const parseArgs = (argv) => {
  const batchArg = argv.find((a) => a.startsWith('--batch-size='));
  const delayArg = argv.find((a) => a.startsWith('--delay-ms='));
  return {
    batchSize: batchArg ? Number(batchArg.split('=')[1]) : undefined,
    delayMs: delayArg ? Number(delayArg.split('=')[1]) : undefined,
  };
};

export const run = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
  }

  const { batchSize, delayMs } = parseArgs(process.argv.slice(2));
  const result = await ingestAllProducts({
    ...(batchSize ? { batchSize } : {}),
    ...(delayMs ? { delayMs } : {}),
  });

  console.log('Investment product ingest complete');
  console.log('='.repeat(60));
  console.log(`Persisted: ${result.ingested}`);
  console.log(`Failed/skipped: ${result.failed}`);

  await mongoose.disconnect();
  process.exit(0);
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  run().catch((err) => {
    logger.error(`[products:refresh] Failed: ${err.message}`);
    console.error('Product ingest failed:', err.message);
    process.exit(1);
  });
}

export default run;
