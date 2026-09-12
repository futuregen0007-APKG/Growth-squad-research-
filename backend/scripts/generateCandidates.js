/**
 * generateCandidates.js
 * =======================
 * `npm run earnings:candidates -- --symbol=TCS` (or `--symbol=TCS,ICICIBANK`)
 *
 * Runs PromiseCandidateService for one or more symbols against the REAL
 * document-collection/extraction/outcome-matching pipeline (live network,
 * live LLM calls) and upserts whatever is found into MongoDB
 * (models/PromiseCandidate.js, reviewStatus PENDING_REVIEW). Never writes to
 * promises/<SYMBOL>.json -- candidates require an explicit
 * `npm run earnings:review -- --accept` to be promoted.
 *
 * A company with no discoverable Tier 1/2 documents, or no extractable
 * quantifiable promise, legitimately produces zero candidates -- this is
 * reported plainly, never forced.
 *
 * This phase targets TCS first, then the six other companies with a
 * verified sourceRegistry in CompanyResearchProfiles.js (NEWGEN, HDFCBANK,
 * ICICIBANK, BHEL, LT, HAL). Do not run this against all 215 SUPPORTED_STOCKS.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { generateCandidatesForSymbol, saveCandidates } from '../services/PromiseCandidateService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const parseArgs = (argv) => {
  const symbolArg = argv.find((arg) => arg.startsWith('--symbol='));
  const symbols = symbolArg
    ? symbolArg.replace('--symbol=', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [];
  return { symbols };
};

const run = async () => {
  const { symbols } = parseArgs(process.argv.slice(2));
  if (!symbols.length) {
    console.error('Usage: npm run earnings:candidates -- --symbol=TCS[,ICICIBANK,...]');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
  if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

  console.log('Earnings Intelligence candidate generation');
  console.log('='.repeat(60));

  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ===`);
    // eslint-disable-next-line no-await-in-loop
    const { candidates, reason } = await generateCandidatesForSymbol(symbol);
    if (!candidates.length) {
      console.log(`No candidates generated. ${reason || ''}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const results = await saveCandidates(candidates);
    for (const result of results) {
      console.log(`  [${result.action}] ${result.id}${result.error ? ` (${result.error})` : ''}`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  run().catch((err) => {
    logger.error(`[earnings:candidates] Failed: ${err.message}`);
    console.error('Candidate generation failed:', err.message);
    process.exit(1);
  });
}

export { run };
