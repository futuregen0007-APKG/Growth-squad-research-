/**
 * backfillUniverse.js
 * =====================
 * `npm run earnings:backfill-universe -- --from-year=2022 --to-year=2026
 *   --batch-size=10 --company-concurrency=2 --openai-concurrency=1 --resume`
 *
 * Scales the proven 6-company Earnings Intelligence backfill
 * (scripts/backfillHistoricalFacts.js's runAutomatedBackfillForSymbol) to
 * the full ~205-stock universe via a persistent MongoDB job queue
 * (ResearchJob), never processing the whole universe in one run.
 *
 * Symbol selection (rule: never silently pick from Mongo ordering):
 *   --symbols=A,B,C   -> exactly these, printed verbatim, no prioritization.
 *   otherwise         -> incomplete featured companies first, then the rest
 *                        of CompanyResearchProfile by real market cap
 *                        (descending), truncated to --batch-size. The
 *                        resulting list is always printed before any work
 *                        starts.
 *
 * Every external call this script makes (BSE discovery/download, OpenAI
 * extraction) goes through the SAME hardened providers used for the 6
 * featured companies -- same retry/throttle/dedup/hash-caching rules, only
 * the concurrency knobs are reconfigured here from CLI flags.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ResearchJob, ACTIVE_STATUSES } from '../models/ResearchJob.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { EARNINGS_COVERAGE_METRICS } from '../utils/constants.js';
import CompanyDocumentRegistry from '../models/CompanyDocumentRegistry.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import { syncCompanyResearchProfiles } from '../services/CompanyResearchProfileSync.js';
import { runAutomatedBackfillForSymbol } from './backfillHistoricalFacts.js';
import { configureExchangeProviderConcurrency } from '../providers/ExchangeFilingDocumentProvider.js';
import { configureOpenAIConcurrency } from '../services/FactExtractionService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const FEATURED_SYMBOLS = ['TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'BHEL', 'NEWGEN'];
const MAX_RETRYABLE_ATTEMPTS = 3; // a job crosses FAILED_RETRYABLE -> FAILED_PERMANENT after this many attempts with zero years covered
const VALID_METRICS_FOR_COVERAGE = EARNINGS_COVERAGE_METRICS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const chunk = (items, size) => {
  const safeSize = Math.max(1, Number(size) || 1);
  const batches = [];
  for (let i = 0; i < items.length; i += safeSize) batches.push(items.slice(i, i + safeSize));
  return batches;
};

/** Real coverage check -- never counts a news/OTHER-only fact as covering a year (rule: don't count news facts unless they carry a validated financial metric). */
export const evaluateYearCoverage = async (symbol, fromYear, toYear) => {
  const facts = await CompanyHistoricalFact.find({ symbol, dataOrigin: 'REAL_RESEARCH' }).lean();
  const coveredYears = new Set();
  for (const fact of facts) {
    const yearMatch = String(fact.period || '').match(/\d{4}/);
    if (!yearMatch) continue;
    const year = Number(yearMatch[0]);
    if (year < fromYear || year > toYear) continue;
    if (fact.metrics?.actualValue != null && VALID_METRICS_FOR_COVERAGE.includes(fact.metrics?.metric)) coveredYears.add(year);
  }
  const expectedYears = toYear - fromYear + 1;
  return { expectedYears, completedYears: coveredYears.size, coveredYears: Array.from(coveredYears).sort(), missingYears: Array.from({ length: expectedYears }, (_, i) => fromYear + i).filter((y) => !coveredYears.has(y)) };
};

/**
 * Builds the symbol selection list, printed verbatim before any work
 * starts. `--symbols` bypasses all prioritization; otherwise: incomplete
 * featured companies first, then the remaining CompanyResearchProfile
 * universe sorted by real market cap (descending) -- never Mongo's default
 * insertion order.
 */
export const selectBatchSymbols = async ({ explicitSymbols, fromYear, toYear, batchSize, force }) => {
  if (explicitSymbols?.length) {
    return { symbols: explicitSymbols, source: 'EXPLICIT' };
  }

  const completedFeatured = new Set(
    (await ResearchJob.find({ symbol: { $in: FEATURED_SYMBOLS }, fromYear, toYear, status: 'COMPLETED' }).lean())
      .map((j) => j.symbol),
  );
  const incompleteFeatured = FEATURED_SYMBOLS.filter((s) => force || !completedFeatured.has(s));

  const permanentlyFailed = force ? new Set() : new Set(
    (await ResearchJob.find({ fromYear, toYear, status: 'FAILED_PERMANENT' }).lean()).map((j) => j.symbol),
  );
  const completedOther = force ? new Set() : new Set(
    (await ResearchJob.find({ fromYear, toYear, status: 'COMPLETED' }).lean()).map((j) => j.symbol),
  );

  const rest = await CompanyResearchProfile.find({
    researchEnabled: true,
    symbol: { $nin: [...FEATURED_SYMBOLS, ...permanentlyFailed, ...completedOther] },
  }).sort({ marketCapCr: -1 }).lean();

  const symbols = [...incompleteFeatured, ...rest.map((r) => r.symbol)].slice(0, batchSize);
  return { symbols, source: 'PRIORITIZED' };
};

const claimJob = async (symbol, fromYear, toYear, force) => {
  const existing = await ResearchJob.findOne({ symbol, jobType: 'HISTORICAL_FACTS_BACKFILL', fromYear, toYear }).sort({ createdAt: -1 }).lean();
  if (existing?.status === 'FAILED_PERMANENT' && !force) {
    return { skip: true, reason: 'FAILED_PERMANENT (use --force to retry)' };
  }
  if (existing?.status === 'COMPLETED' && !force) {
    return { skip: true, reason: 'already COMPLETED for this range' };
  }

  const job = await ResearchJob.findOneAndUpdate(
    { symbol, jobType: 'HISTORICAL_FACTS_BACKFILL', fromYear, toYear, status: { $nin: ACTIVE_STATUSES } },
    { $set: { status: 'DISCOVERING', startedAt: new Date() }, $inc: { attempt: 1 } },
    { upsert: true, new: true },
  ).catch(() => null); // the partial unique index rejects a concurrent duplicate active job -- treated as "already running", not an error

  if (!job) return { skip: true, reason: 'already has an active job (concurrent run)' };
  return { skip: false, job };
};

/**
 * deriveJobLastError - the reason recorded on a ResearchJob after a run, so a
 * later reader can tell "BSE has nothing for this company" apart from "never
 * attempted" (both otherwise look like zero coverage).
 */
export const deriveJobLastError = (summary) => {
  if (summary.some((y) => y.status === 'DISCOVERY_FAILED')) return 'One or more fiscal years had a discovery failure';
  if (summary.length > 0 && summary.every((y) => y.status === 'NO_FILINGS_FOUND')) return 'No exchange filings found for any fiscal year in the range';
  return null;
};

const runOneSymbol = async (symbol, { fromYear, toYear, resume, force }) => {
  const claim = await claimJob(symbol, fromYear, toYear, force);
  if (claim.skip) return { symbol, status: 'SKIPPED', reason: claim.reason };

  try {
    const summary = await runAutomatedBackfillForSymbol(symbol, { fromYear, toYear, resume });
    const coverage = await evaluateYearCoverage(symbol, fromYear, toYear);
    const factsExtracted = summary.reduce((sum, y) => sum + (y.documents || []).reduce((s, d) => s + (d.factsExtracted || 0), 0), 0);

    let status;
    if (coverage.completedYears === coverage.expectedYears) status = 'COMPLETED';
    else if (coverage.completedYears > 0) status = 'PARTIAL';
    else status = claim.job.attempt >= MAX_RETRYABLE_ATTEMPTS ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE';

    await ResearchJob.updateOne(
      { _id: claim.job._id },
      { $set: { status, completedAt: new Date(), processedDocuments: factsExtracted, cursor: { lastCompletedYear: coverage.coveredYears.at(-1) || null }, lastError: deriveJobLastError(summary) } },
    );
    return { symbol, status, coverage, factsExtracted };
  } catch (error) {
    const status = claim.job.attempt >= MAX_RETRYABLE_ATTEMPTS ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE';
    await ResearchJob.updateOne({ _id: claim.job._id }, { $set: { status, completedAt: new Date(), lastError: error.message } });
    logger.warn(`[backfillUniverse] ${symbol} failed: ${error.message}`);
    return { symbol, status, error: error.message };
  }
};

export const run = async ({
  explicitSymbols, fromYear, toYear, batchSize = 10, companyConcurrency = 2,
  discoveryConcurrency = 3, downloadConcurrency = 2, openaiConcurrency = 1,
  resume = false, force = false, requestSpacingMs = [300, 900],
} = {}) => {
  configureExchangeProviderConcurrency({ discovery: discoveryConcurrency, download: downloadConcurrency });
  configureOpenAIConcurrency(openaiConcurrency);

  await syncCompanyResearchProfiles();
  const { symbols, source } = await selectBatchSymbols({ explicitSymbols, fromYear, toYear, batchSize, force });

  console.log(`Symbol selection (${source}): ${symbols.length ? symbols.join(', ') : '(none -- nothing left to process for this range)'}`);
  if (!symbols.length) return [];

  const results = [];
  for (const batch of chunk(symbols, companyConcurrency)) {
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await Promise.all(batch.map(async (symbol) => {
      // Randomized spacing before each company starts -- never launch every
      // company in a batch against BSE at the exact same instant.
      const [minMs, maxMs] = requestSpacingMs;
      // eslint-disable-next-line no-await-in-loop
      await sleep(minMs + Math.floor(Math.random() * (maxMs - minMs)));
      return runOneSymbol(symbol, { fromYear, toYear, resume, force });
    }));
    results.push(...batchResults);
  }
  return results;
};

const parseArgs = (argv) => {
  const get = (flag) => { const a = argv.find((x) => x.startsWith(`${flag}=`)); return a ? a.split('=')[1] : null; };
  const symbolsArg = get('--symbols');
  return {
    explicitSymbols: symbolsArg ? symbolsArg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    fromYear: Number(get('--from-year')) || new Date().getFullYear() - 4,
    toYear: Number(get('--to-year')) || new Date().getFullYear(),
    batchSize: Number(get('--batch-size')) || 10,
    companyConcurrency: Number(get('--company-concurrency')) || 2,
    discoveryConcurrency: Number(get('--discovery-concurrency')) || 3,
    downloadConcurrency: Number(get('--download-concurrency')) || 2,
    openaiConcurrency: Number(get('--openai-concurrency')) || 1,
    resume: argv.includes('--resume'),
    force: argv.includes('--force'),
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    const args = parseArgs(process.argv.slice(2));
    const results = await run(args);

    console.log('\nBatch summary');
    console.log('='.repeat(70));
    for (const r of results) {
      const cov = r.coverage ? `${r.coverage.completedYears}/${r.coverage.expectedYears} years` : '-';
      console.log(`${r.symbol.padEnd(14)} ${r.status.padEnd(18)} ${cov.padEnd(12)} facts=${r.factsExtracted ?? 0}${r.error ? ` -- ${r.error}` : ''}${r.reason ? ` (${r.reason})` : ''}`);
    }
    const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    console.log('\nCounts:', JSON.stringify(counts));

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[earnings:backfill-universe] Failed: ${err.message}`);
    console.error('Batch failed:', err.message);
    process.exit(1);
  });
}

export default run;
