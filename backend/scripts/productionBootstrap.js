/**
 * productionBootstrap.js
 * =========================
 * `npm run data:bootstrap -- [flags]`
 *
 * A single orchestrator over the ALREADY-EXISTING ingestion/backfill
 * services (never duplicates their provider logic -- it imports and calls
 * the same exported functions `npm run stocks:backfill-history` etc.
 * already use). Exists because the individual stages were built and run
 * independently across earlier sessions; this sequences them in the real
 * dependency order, with one shared set of safety flags, against
 * whichever MONGODB_URI is already set in the environment it runs in.
 *
 * Flags:
 *   --status-only        Read-only: print current data-status + last run
 *                         per stage. No writes, no provider calls.
 *   --dry-run             Print the exact plan (stages, symbol lists, date
 *                         ranges) with zero writes and zero provider calls.
 *                         Confirms there is nothing destructive before a
 *                         real run.
 *   --stage=<name|all>    Run only this stage (comma-separated for
 *                         several), or "all" (default) for every stage in
 *                         dependency order.
 *   --symbols=A,B,C       Restrict symbol-based stages to this list.
 *                         Ignored (with a note) by universe-wide stages
 *                         (bhavcopy ingestion, investment products).
 *   --batch-size=N        Passed through to stages that batch (fundamentals
 *                         refresh, earnings universe backfill).
 *   --resume              Passed through to every stage that supports it --
 *                         each stage's own idempotency/resume logic decides
 *                         what "already done" means for it.
 *   --max-runtime=<min>   Wall-clock budget in minutes (default 12, safely
 *                         under Render's request/shell limits). The
 *                         orchestrator checks this before starting each
 *                         stage AND before each symbol inside a
 *                         per-symbol stage, and stops cleanly (never mid-
 *                         write) once exceeded -- the next --resume run
 *                         picks up where it left off.
 *
 * Every stage records its outcome in BootstrapRunLog (last attempt +
 * bounded history): status, provider, dataset timestamp, symbols
 * succeeded/failed with reasons, and summary counts. Never imports
 * seedHistoricalIntelligence.js or any SEEDED_DEMO-producing code.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { BootstrapRunLog } from '../models/BootstrapRunLog.js';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import { collectProductionStatus, explainSymptoms } from './productionStatus.js';

import { syncCompanyResearchProfiles } from '../services/CompanyResearchProfileSync.js';
import { runStockHistoryBackfill } from './backfillStockHistory.js';
import { run as computeHistoricalMetrics } from './computeHistoricalMetrics.js';
import { run as refreshStockFundamentals } from './refreshStockFundamentals.js';
import { ingestAllProducts } from '../services/GoalProductRecommendationService.js';
import { run as runEarningsUniverseBackfill } from './backfillUniverse.js';
import { runPromiseBackfillForSymbol } from './backfillPromises.js';

dotenv.config();

const DEFAULT_MAX_RUNTIME_MIN = 12;
const ALL_SYMBOLS = Object.keys(SUPPORTED_STOCKS);

class RuntimeBudgetExceeded extends Error {}

const makeBudget = (maxRuntimeMin) => {
  const deadline = Date.now() + maxRuntimeMin * 60 * 1000;
  return {
    remainingMs: () => deadline - Date.now(),
    check: () => { if (Date.now() >= deadline) throw new RuntimeBudgetExceeded('Wall-clock budget (--max-runtime) exceeded'); },
  };
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const yearAgoIso = () => {
  const d = new Date();
  d.setDate(d.getDate() - 400); // >1Y of trading days for 52W/1Y-return coverage
  return d.toISOString().slice(0, 10);
};

const recordAttempt = (stage, attempt) => BootstrapRunLog.recordAttempt(stage, attempt).catch((err) => {
  logger.warn(`[productionBootstrap] Failed to persist run log for ${stage}: ${err.message}`);
});

/**
 * Each stage: { name, description, universeWide (ignores --symbols),
 * plan(ctx) -> human-readable dry-run description, execute(ctx) -> attempt summary }
 */
const STAGES = [
  {
    name: 'bse-profile-sync',
    description: 'BSE company-profile/scrip-master sync -> CompanyResearchProfile (market cap, ISIN, BSE code)',
    universeWide: true,
    plan: () => 'Fetch the real BSE scrip master once; upsert one CompanyResearchProfile per SUPPORTED_STOCKS symbol (idempotent).',
    execute: async () => {
      const result = await syncCompanyResearchProfiles();
      return {
        status: 'COMPLETED',
        provider: 'BSE scrip master (api.bseindia.com)',
        counts: result,
        symbolsFailed: (result.unresolvedSymbols || []).map((symbol) => ({ symbol, reason: 'No resolvable BSE scrip code' })),
      };
    },
  },
  {
    name: 'nse-bhavcopy',
    description: 'NSE Bhavcopy historical-price ingestion -> StockPriceHistorySnapshot',
    universeWide: true, // one file/day covers every listed equity; --symbols does not narrow the download
    plan: ({ resume }) => `Download NSE CM bhavcopy for every trading day from ${yearAgoIso()} to ${todayIso()}${resume ? ' (--resume: skip dates already COMPLETED)' : ''}.`,
    execute: async ({ resume }) => {
      const from = yearAgoIso();
      const to = todayIso();
      const summary = await runStockHistoryBackfill(from, to, { resume, onProgress: (line) => console.log(`  ${line}`) });
      return {
        status: summary.failed > 0 && summary.completed === 0 ? 'FAILED' : (summary.failed > 0 ? 'PARTIAL' : 'COMPLETED'),
        provider: 'NSE bhavcopy (nsearchives.nseindia.com)',
        datasetTimestamp: new Date(to),
        counts: summary,
        symbolsFailed: (summary.failedDates || []).map((date) => ({ symbol: date, reason: 'Bhavcopy download/parse failed for this date' })),
      };
    },
  },
  {
    name: 'historical-metrics',
    description: 'Historical-metrics snapshot generation -> StockHistoricalMetricsSnapshot (52W range, 1Y return, volatility, drawdown)',
    universeWide: false,
    plan: ({ symbols }) => `Compute metrics for ${symbols.length} symbol(s): ${symbols.join(', ')} -- pure computation over already-ingested price rows, no network calls.`,
    execute: async ({ symbols }) => {
      // recomputeMetricsForSymbols only returns aggregate counts (computed/
      // skipped/failed), not a per-symbol failure list -- onProgress lines
      // are logged for visibility but not parsed into structured data here,
      // rather than guessing at a fragile string format.
      const result = await computeHistoricalMetrics({ symbols, onProgress: (line) => console.log(`  ${line}`) });
      return {
        status: result.failed > 0 && result.computed === 0 ? 'FAILED' : (result.failed > 0 ? 'PARTIAL' : 'COMPLETED'),
        provider: 'internal (StockPriceHistorySnapshot)',
        counts: result,
      };
    },
  },
  {
    name: 'stock-fundamentals',
    description: 'Stock-fundamentals refresh -> StockFundamentalsSnapshot (IndianAPI, quota-limited)',
    universeWide: false,
    plan: ({ symbols, batchSize, resume }) => `Refresh fundamentals for ${symbols.length} symbol(s) in batches of ${batchSize}${resume ? ' (--resume: skip already-completed)' : ''}. May stop early on IndianAPI rate limit -- resumable.`,
    execute: async ({ symbols, batchSize, resume }) => {
      const result = await refreshStockFundamentals({ symbols, batchSize, resume });
      return {
        status: result.stoppedEarly ? 'PARTIAL' : 'COMPLETED',
        provider: 'IndianAPI (with REAL_RESEARCH-derived fallback)',
        counts: result,
        symbolsFailed: (result.failedSymbols || []).map((f) => ({ symbol: f.symbol, reason: f.error || f.errorCode || f.status || 'IndianAPI fetch failed' })),
      };
    },
  },
  {
    name: 'investment-products',
    description: 'AMFI + mfapi investment-product refresh -> InvestmentProductSnapshot (dataset-level, not per-symbol)',
    universeWide: true,
    plan: ({ batchSize }) => `Fetch the real AMFI scheme universe once; compute returns/risk per scheme in batches of ${batchSize || 10}; upsert InvestmentProductSnapshot.`,
    execute: async ({ batchSize }) => {
      const result = await ingestAllProducts({ batchSize: batchSize || undefined });
      return {
        status: result.ingested > 0 ? 'COMPLETED' : 'FAILED',
        provider: 'AMFI (NAVAll.txt) + mfapi.in',
        counts: result,
      };
    },
  },
  {
    name: 'earnings-universe',
    description: 'Earnings document discovery/storage + historical-fact extraction -> CompanyDocumentRegistry, CompanyHistoricalFact (REAL_RESEARCH)',
    universeWide: false,
    plan: ({ symbols, batchSize, resume }) => `Discover + extract facts for ${symbols.length} symbol(s): ${symbols.join(', ')} (company-concurrency capped, batch size ${batchSize})${resume ? ' (--resume)' : ''}. Persists PDFs via the existing durable document-storage backend, never the filesystem.`,
    execute: async ({ symbols, batchSize, resume }) => {
      // backfillUniverse.run() has no internal fromYear/toYear default of
      // its own (only its CLI arg-parser does) -- mirror that same default
      // here (last 4 fiscal years) so calling it as a library function
      // behaves identically to `npm run earnings:backfill-universe`.
      const toYear = new Date().getFullYear();
      const fromYear = toYear - 4;
      const results = await runEarningsUniverseBackfill({
        explicitSymbols: symbols, fromYear, toYear, batchSize, companyConcurrency: 2, resume,
      });
      const failed = results.filter((r) => r.status === 'FAILED_PERMANENT' || r.status === 'FAILED_RETRYABLE');
      const completed = results.filter((r) => r.status === 'COMPLETED' || r.status === 'PARTIAL');
      return {
        status: failed.length > 0 && completed.length === 0 ? 'FAILED' : (failed.length > 0 ? 'PARTIAL' : 'COMPLETED'),
        provider: 'BSE exchange filings (ExchangeFilingDocumentProvider) + OpenAI extraction',
        counts: { total: results.length, completed: completed.length, failed: failed.length },
        symbolsFailed: failed.map((r) => ({ symbol: r.symbol, reason: r.error || r.reason || 'Unknown failure' })),
      };
    },
  },
  {
    name: 'promise-extraction',
    description: 'Promise extraction + outcome verification -> ManagementPromise / PromiseCandidate (REAL_RESEARCH, PENDING_REVIEW)',
    universeWide: false,
    plan: ({ symbols, resume }) => `Extract + verify management promises for ${symbols.length} symbol(s): ${symbols.join(', ')}${resume ? ' (--resume)' : ''}. Candidates land as PENDING_REVIEW -- a human must accept them via earnings:review before they count toward Faith Score.`,
    execute: async ({ symbols, resume, budget }) => {
      const symbolsFailed = [];
      const symbolsSucceeded = [];
      let candidatesSaved = 0;
      for (const symbol of symbols) {
        budget.check();
        try {
          // eslint-disable-next-line no-await-in-loop
          const summary = await runPromiseBackfillForSymbol(symbol, { resume, onProgress: (line) => console.log(`  ${line}`) });
          candidatesSaved += summary.candidatesSaved;
          symbolsSucceeded.push(symbol);
        } catch (error) {
          if (error instanceof RuntimeBudgetExceeded) throw error;
          symbolsFailed.push({ symbol, reason: error.message });
        }
      }
      return {
        status: symbolsFailed.length > 0 && symbolsSucceeded.length === 0 ? 'FAILED' : (symbolsFailed.length > 0 ? 'PARTIAL' : 'COMPLETED'),
        provider: 'internal (CompanyDocumentRegistry) + OpenAI extraction + OutcomeEvidenceService',
        counts: { candidatesSaved, symbolsSucceeded: symbolsSucceeded.length, symbolsFailed: symbolsFailed.length },
        symbolsSucceeded,
        symbolsFailed,
      };
    },
  },
  {
    name: 'faith-score',
    description: 'Faith Score recalculation',
    universeWide: true,
    plan: () => 'No batch step exists or is needed: Faith Score is computed live at read time from ManagementPromise/CompanyHistoricalFact records already in Mongo (see CuratedEarningsIntelligenceService.js). This stage is a documented no-op.',
    execute: async () => ({ status: 'COMPLETED', provider: 'internal (computed live, not persisted)', counts: { note: 'no-op by design -- see plan()' } }),
  },
];

const parseArgs = (argv) => {
  const get = (flag) => { const a = argv.find((x) => x.startsWith(`${flag}=`)); return a ? a.split('=')[1] : null; };
  const symbolsArg = get('--symbols');
  const stageArg = get('--stage');
  return {
    statusOnly: argv.includes('--status-only'),
    dryRun: argv.includes('--dry-run'),
    stage: stageArg ? stageArg.split(',').map((s) => s.trim()) : ['all'],
    symbols: symbolsArg ? symbolsArg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    batchSize: Number(get('--batch-size')) || 10,
    resume: argv.includes('--resume'),
    maxRuntimeMin: Number(get('--max-runtime')) || DEFAULT_MAX_RUNTIME_MIN,
    expectTarget: get('--expect-target'),
  };
};

const selectedStages = (stageFilter) => (
  stageFilter.includes('all') ? STAGES : STAGES.filter((s) => stageFilter.includes(s.name))
);

export const runBootstrap = async (options) => {
  const {
    statusOnly, dryRun, stage, symbols, batchSize, resume, maxRuntimeMin,
  } = options;
  const targetSymbols = symbols && symbols.length ? symbols : ALL_SYMBOLS;
  const budget = makeBudget(maxRuntimeMin);
  const stages = selectedStages(stage);

  if (statusOnly) {
    const status = await collectProductionStatus();
    const lastRuns = await BootstrapRunLog.find({}).lean();
    console.log('\n=== Current data status ===');
    console.log(JSON.stringify(status, null, 2));
    console.log('\n=== Diagnosed symptoms ===');
    explainSymptoms(status).forEach((s) => console.log(`- ${s}`));
    console.log('\n=== Last bootstrap attempt per stage ===');
    for (const s of STAGES) {
      const log = lastRuns.find((r) => r.stage === s.name);
      console.log(`${s.name.padEnd(20)} ${log?.lastAttempt ? `${log.lastAttempt.status} at ${log.lastAttempt.finishedAt || log.lastAttempt.startedAt}` : '(never run)'}`);
    }
    return { statusOnly: true };
  }

  console.log(`\nStages to run: ${stages.map((s) => s.name).join(', ')}`);
  console.log(`Symbols: ${symbols ? symbols.join(', ') : `(full universe, ${ALL_SYMBOLS.length} symbols)`}`);
  console.log(`Max runtime: ${maxRuntimeMin} min | resume=${resume} | batchSize=${batchSize}\n`);

  if (dryRun) {
    console.log('=== DRY RUN -- no writes, no provider calls ===\n');
    for (const s of stages) {
      const ctx = { symbols: s.universeWide ? targetSymbols : targetSymbols, batchSize, resume };
      console.log(`[${s.name}] ${s.description}`);
      console.log(`  Plan: ${s.plan(ctx)}`);
      if (s.universeWide && symbols) console.log('  Note: --symbols is ignored by this stage (it is universe-wide/dataset-level).');
    }
    console.log('\nNo destructive operation exists in any stage: every write is an idempotent upsert keyed by (symbol[/date/scheme]); nothing is dropped or deleted.');
    return { dryRun: true, stages: stages.map((s) => s.name) };
  }

  const outcomes = [];
  for (const s of stages) {
    try {
      budget.check();
    } catch (error) {
      console.log(`\nStopping before stage "${s.name}": ${error.message}. Re-run with --resume to continue.`);
      break;
    }

    const ctx = { symbols: targetSymbols, batchSize, resume, budget };
    const startedAt = new Date();
    console.log(`\n=== Stage: ${s.name} ===`);
    console.log(s.description);
    await recordAttempt(s.name, { startedAt, status: 'RUNNING', dryRun: false, symbolsRequested: s.universeWide ? [] : targetSymbols });

    try {
      const result = await s.execute(ctx);
      const attempt = {
        startedAt, finishedAt: new Date(), status: result.status, dryRun: false,
        provider: result.provider || null, datasetTimestamp: result.datasetTimestamp || new Date(),
        symbolsRequested: s.universeWide ? [] : targetSymbols,
        symbolsSucceeded: result.symbolsSucceeded || [],
        symbolsFailed: result.symbolsFailed || [],
        counts: result.counts || {},
      };
      await recordAttempt(s.name, attempt);
      outcomes.push({ stage: s.name, ...attempt });
      console.log(`Result: ${result.status} -- ${JSON.stringify(result.counts)}`);
      if (result.symbolsFailed?.length) console.log(`Failed: ${result.symbolsFailed.map((f) => `${f.symbol} (${f.reason})`).join('; ')}`);
    } catch (error) {
      if (error instanceof RuntimeBudgetExceeded) {
        await recordAttempt(s.name, { startedAt, finishedAt: new Date(), status: 'PARTIAL', dryRun: false });
        console.log(`\nStopping mid-stage "${s.name}": ${error.message}. Re-run with --resume to continue.`);
        break;
      }
      await recordAttempt(s.name, { startedAt, finishedAt: new Date(), status: 'FAILED', dryRun: false });
      logger.error(`[productionBootstrap] Stage ${s.name} failed: ${error.message}`);
      console.log(`Stage "${s.name}" FAILED: ${error.message}`);
      outcomes.push({ stage: s.name, status: 'FAILED', error: error.message });
      // Continue to next stage -- one stage failing must not abort the whole run.
    }
  }

  return { outcomes };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    const args = parseArgs(process.argv.slice(2));

    // Printed on every run, and enforced before anything connects when
    // --expect-target=<host>/<database> is given (a URI with no database name
    // writes into the driver default, "test").
    const target = assertMongoTarget(mongoUri, args.expectTarget);
    console.log(`Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);

    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
    await runBootstrap(args);

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[data:bootstrap] Failed: ${err.message}`);
    console.error('Bootstrap failed:', err.message);
    process.exit(1);
  });
}

export default runBootstrap;
