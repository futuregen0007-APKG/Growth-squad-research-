/**
 * collectNseTranscripts.js
 * ==========================
 * `npm run earnings:collect-transcripts -- --expect-target <host>/<database>
 *    [--symbols A,B] [--priority A,B,...] [--batch-size 10] [--max-batches N]
 *    [--max-runtime-min N] [--max-cost-usd N] [--from-year 2022] [--to-year 2026]
 *    [--concurrency 2] [--openai-concurrency 3] [--delay-ms 800]
 *    [--max-docs-per-symbol N] [--skip-promises] [--dry-run] [--label name]
 *    [--no-overlap-guard]`
 *
 * --max-cost-usd is an explicit, enforced spend cap on this run's OpenAI
 * calls (checked after every company, using the same token-based estimate
 * printed at the end); the run stops as soon as it is reached, mid-batch if
 * necessary, the same as --max-runtime-min.
 *
 * The transcript half of the earnings pipeline, run from NSE's own
 * announcements (see providers/NseAnnouncementProvider.js), because the BSE
 * announcement API refuses this client:
 *
 *   DISCOVERY  earnings-call transcripts filed on NSE, FY window
 *   DOWNLOAD   each PDF once, hashed, registered in CompanyDocumentRegistry
 *              (a re-filed copy of the same bytes is not registered twice)
 *   PROMISES   the existing promise stage (scripts/backfillPromises.js) reads
 *              each registered document and writes candidates as
 *              PENDING_REVIEW. Nothing is accepted here; a human review gate
 *              stays in place.
 *   OUTCOMES   the existing outcome check compares each candidate with the
 *              real facts already on file (the exchange XBRL figures). It uses
 *              no paid API here: INDIAN_API_KEY is blanked for this process.
 *
 * WHAT IS RECORDED, AND HOW IT IS KEPT APART
 *   - promiseExtractionStatus EXTRACTED with 0 candidates: the document was
 *     read in full and holds no qualifying guidance ("no qualifying guidance
 *     found").
 *   - promiseExtractionStatus FAILED: the document could not be read or the
 *     model could not be reached. It is retried on the next run.
 *   - A company with no transcript on NSE in the window is logged as such and
 *     stays NOT_RUN; that is not a finding about its guidance.
 *
 * Financial figures are NOT taken from these PDFs (the verified route is the
 * XBRL collector), and PDFs are not stored (EARNINGS_PERSIST_PDFS is forced to
 * false), so the database holds text-derived records only.
 *
 * RESUMABLE. Which companies still need work is derived from the database on
 * every batch; a registered document is never downloaded again and a document
 * whose promise stage finished is never re-read. Run the same command again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import { getFiscalWindow } from '../utils/fiscalWindow.js';
import { claimRun, heartbeat, completeRun } from '../services/ScheduledJobRunService.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_CONSECUTIVE_FAILURES = 4;

const discoveredAt = (r) => {
  const t = r.profile?.lastGuidanceDiscoveryAt ? new Date(r.profile.lastGuidanceDiscoveryAt).getTime() : NaN;
  return Number.isFinite(t) ? t : -Infinity; // never attempted -> first
};

/**
 * planTranscriptBatch - pure. FAIR ROTATION over the whole supported universe:
 * the requested priority symbols first, then every company ordered by when
 * its guidance discovery was last attempted (never-attempted first, then
 * oldest), unsettled before settled on a tie, then alphabetically -- minus
 * anything already attempted in this run.
 *
 * It used to take only "unsettled" companies alphabetically, with no memory
 * between runs: a company with no transcript on NSE stays NOT_RUN for ever, so
 * every bounded (weekly cron) run re-selected the same alphabetically-first
 * companies, and a settled company was never revisited -- so its NEXT
 * quarter's call would never be discovered.
 */
export const planTranscriptBatch = (rows, {
  batchSize = 10, explicit = null, attempted = new Set(), priority = [],
} = {}) => {
  const unsettled = (r) => r.promiseStage === 'NOT_RUN' || (r.registry?.promisePending ?? 0) > 0 || (r.registry?.promiseFailed ?? 0) > 0;
  let candidates;
  if (explicit?.length) {
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    candidates = explicit.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  } else {
    const rank = new Map(priority.map((symbol, i) => [symbol, i]));
    candidates = rows
      .filter((r) => r.profile?.researchEnabled !== false)
      .sort((a, b) => ((rank.get(a.symbol) ?? Infinity) - (rank.get(b.symbol) ?? Infinity))
        || (discoveredAt(a) - discoveredAt(b))
        || (Number(unsettled(b)) - Number(unsettled(a)))
        || a.symbol.localeCompare(b.symbol));
  }
  return candidates.filter((r) => !attempted.has(r.symbol)).slice(0, batchSize).map((r) => r.symbol);
};

/** discoveryRecord - pure. What is written to the company profile after one attempt. */
export const discoveryRecord = (result, at = new Date()) => ({
  lastGuidanceDiscoveryAt: at,
  lastGuidanceDiscoveryResult: {
    at,
    discovered: result.discovered,
    byType: result.byType || {},
    registered: result.registered,
    duplicates: result.duplicates,
    downloadFailed: result.downloadFailed,
    promiseDocsProcessed: result.promiseDocsProcessed,
    noGuidanceDocs: result.noGuidanceDocs,
    promiseFailures: result.promiseFailures,
    candidates: result.candidates,
    noDocuments: Boolean(result.noTranscripts),
    error: result.error || null,
  },
});

/** shouldStopTranscripts - pure. Why the run must stop now, or null. */
export const shouldStopTranscripts = ({
  consecutiveFailures = 0, elapsedMs = 0, maxRuntimeMs = 0, batchesDone = 0, maxBatches = 0, estimatedUsd = 0, maxCostUsd = 0,
}) => {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return `${consecutiveFailures} companies in a row failed at discovery or extraction; stopping rather than repeat the same failure`;
  if (maxRuntimeMs && elapsedMs >= maxRuntimeMs) return 'the --max-runtime-min budget is used up';
  if (maxBatches && batchesDone >= maxBatches) return 'the --max-batches limit was reached';
  if (maxCostUsd && estimatedUsd >= maxCostUsd) return `the --max-cost-usd budget ($${maxCostUsd}) is used up (spent ~$${estimatedUsd.toFixed(3)})`;
  return null;
};

// gpt-4o-mini list price at the time of writing: $0.15 per million input tokens, $0.60 per million output tokens.
export const estimateModelCostUsd = (modelUsage) => (modelUsage.promptTokens * 0.15 + modelUsage.completionTokens * 0.60) / 1e6;

/**
 * processSymbol - one company: discover, register new documents, run the
 * promise stage. Dependencies are injected so the flow is testable without a
 * network or a database. Never throws for a per-document problem; a discovery
 * error is returned as `error`.
 */
export const processSymbol = async (symbol, {
  fromYear, toYear, discover, register, runPromises, delayMs = 0, dryRun = false, skipPromises = false, maxDocs = 0,
}) => {
  const result = {
    symbol, discovered: 0, byFiscalYear: {}, registered: 0, alreadyRegistered: 0, duplicates: 0, downloadFailed: 0, promiseDocsProcessed: 0, noGuidanceDocs: 0, promiseFailures: 0, candidates: 0, errors: [], error: null, noTranscripts: false,
  };
  let found;
  try {
    found = await discover(symbol, { fromYear, toYear });
  } catch (error) {
    result.error = `discovery failed: ${error.message}`;
    return result;
  }
  let filings = found.filings;
  if (maxDocs) filings = filings.slice(-maxDocs);
  result.discovered = filings.length;
  result.byType = {};
  for (const filing of filings) {
    result.byFiscalYear[filing.fiscalYear] = (result.byFiscalYear[filing.fiscalYear] || 0) + 1;
    result.byType[filing.documentType] = (result.byType[filing.documentType] || 0) + 1;
  }
  result.noTranscripts = filings.length === 0;
  if (dryRun) return result;

  const buffers = new Map();
  for (const filing of filings) {
    // eslint-disable-next-line no-await-in-loop
    const registered = await register(filing);
    if (registered.status === 'REGISTERED') { result.registered += 1; buffers.set(filing.url, registered.buffer); }
    else if (registered.status === 'ALREADY_REGISTERED') result.alreadyRegistered += 1;
    else if (registered.status === 'DUPLICATE_CONTENT') result.duplicates += 1;
    else { result.downloadFailed += 1; result.errors.push({ url: filing.url, error: registered.error || registered.status }); }
    // eslint-disable-next-line no-await-in-loop
    if (delayMs) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
  }

  if (skipPromises) return result;
  // Freshly downloaded bytes are reused, so a transcript is downloaded once for both stages.
  const getBuffer = async (doc) => (buffers.has(doc.url) ? { buffer: buffers.get(doc.url), source: 'IN_MEMORY' } : null);
  const summary = await runPromises(symbol, { fromYear, toYear, getBuffer });
  result.promiseDocsProcessed = summary.documentsProcessed;
  result.noGuidanceDocs = summary.documentsWithNoGuidance;
  result.candidates = summary.candidatesSaved;
  result.promiseFailures = summary.errors.length;
  result.errors.push(...summary.errors);
  return result;
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const parseArgs = (argv) => {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const list = (flag) => (get(flag) ? get(flag).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null);
  return {
    expectTarget: get('--expect-target'),
    explicit: list('--symbols'),
    priority: list('--priority') || [],
    batchSize: Number(get('--batch-size')) || 10,
    maxBatches: Number(get('--max-batches')) || 0,
    maxRuntimeMin: Number(get('--max-runtime-min')) || 0,
    maxCostUsd: Number(get('--max-cost-usd')) || 0,
    fromYear: get('--from-year') ? Number(get('--from-year')) : null,
    toYear: get('--to-year') ? Number(get('--to-year')) : null,
    concurrency: Number(get('--concurrency')) || 2,
    openaiConcurrency: Number(get('--openai-concurrency')) || 3,
    delayMs: get('--delay-ms') ? Number(get('--delay-ms')) : 800,
    maxDocs: Number(get('--max-docs-per-symbol')) || 0,
    skipPromises: argv.includes('--skip-promises'),
    dryRun: argv.includes('--dry-run'),
    label: get('--label') || 'transcripts',
    noOverlapGuard: argv.includes('--no-overlap-guard'),
    documentTypes: list('--document-types'),
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  let jobName = null;
  let runId = null;
  (async () => {
    dotenv.config();
    const args = parseArgs(process.argv.slice(2));
    if (!args.dryRun && !args.expectTarget) throw new Error('--expect-target <host>/<database> is required: this script writes to the database.');

    // Set before the pipeline modules load: no stored PDFs, and no paid outcome API.
    process.env.EARNINGS_PERSIST_PDFS = 'false';
    process.env.INDIAN_API_KEY = '';

    const window = getFiscalWindow();
    const fromYear = args.fromYear ?? window.fromYear;
    // The financial window ends at the last COMPLETED fiscal year, but guidance for the year in progress is
    // given on THIS year's calls -- so discovery runs through the current fiscal year by default.
    const now = new Date();
    const currentFiscalYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    const toYear = args.toYear ?? Math.max(window.toYear, currentFiscalYear);
    const {
      searchNseAnnouncements, registerNseFiling, configureNseDiscoveryConcurrency, NSE_GUIDANCE_DOCUMENT_TYPES,
    } = await import('../providers/NseAnnouncementProvider.js');
    const { runPromiseBackfillForSymbol } = await import('./backfillPromises.js');
    const { configurePromiseExtractionConcurrency } = await import('../services/PromiseExtractionService.js');
    const { getDocumentBuffer } = await import('../providers/ExchangeFilingDocumentProvider.js');
    const { collectCoverageRows, summarize } = await import('./earningsCoverageAudit.js');
    configureNseDiscoveryConcurrency(1);
    configurePromiseExtractionConcurrency(args.openaiConcurrency);

    // Count the model calls this run makes (and the tokens the API reports), so cost is measured, not guessed.
    const modelUsage = { calls: 0, promptTokens: 0, completionTokens: 0 };
    const { openai } = await import('../services/openaiClient.js');
    if (openai?.chat?.completions?.create) {
      const original = openai.chat.completions.create.bind(openai.chat.completions);
      openai.chat.completions.create = async (...callArgs) => {
        const response = await original(...callArgs);
        modelUsage.calls += 1;
        modelUsage.promptTokens += response?.usage?.prompt_tokens || 0;
        modelUsage.completionTokens += response?.usage?.completion_tokens || 0;
        return response;
      };
    }

    if (!args.dryRun) {
      const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
      console.log(`Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

      jobName = `transcripts-batch:${args.label}`;
      if (!args.noOverlapGuard) {
        const claim = await claimRun(jobName);
        if (!claim.ok) {
          console.error(`Refusing to start: job "${jobName}" is already RUNNING (started ${claim.existing?.startedAt}, last heartbeat ${claim.existing?.heartbeatAt || 'never'}). Pass --no-overlap-guard to override.`);
          await mongoose.disconnect();
          process.exit(1);
        }
        runId = claim.runId;
        console.log(`Claimed scheduled-job run "${jobName}" (${runId}).`);
      }
    } else {
      console.log('Dry run: discovery only, no database connection.');
    }
    console.log(`Fiscal years FY${fromYear}-FY${toYear}; concurrency ${args.concurrency} companies, ${args.openaiConcurrency} model calls; PDFs stored: no; paid outcome API: off\n`);

    const ledgerDir = path.join(BACKEND_DIR, 'reports', 'earnings-coverage');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const ledger = path.join(ledgerDir, `${args.label}-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const attempted = new Set();
    const startedAt = Date.now();
    const totals = {
      companies: 0, discovered: 0, registered: 0, duplicates: 0, downloadFailed: 0, promiseDocs: 0, noGuidanceDocs: 0, promiseFailures: 0, candidates: 0, noTranscripts: 0, errors: 0,
    };
    let consecutiveFailures = 0;
    let batchesDone = 0;
    let stopReason = null;

    const deps = {
      fromYear,
      toYear,
      delayMs: args.delayMs,
      dryRun: args.dryRun,
      skipPromises: args.skipPromises,
      maxDocs: args.maxDocs,
      discover: (symbol, range) => searchNseAnnouncements(symbol, { ...range, documentTypes: args.documentTypes || NSE_GUIDANCE_DOCUMENT_TYPES }),
      register: (filing) => registerNseFiling(filing),
      runPromises: (symbol, options) => runPromiseBackfillForSymbol(symbol, {
        resume: true,
        fromYear,
        toYear,
        getBuffer: async (doc) => (await options.getBuffer(doc)) || getDocumentBuffer(doc),
      }),
    };

    for (;;) {
      let symbols;
      if (args.dryRun || args.explicit) {
        symbols = (args.explicit || []).filter((s) => !attempted.has(s)).slice(0, args.batchSize);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await collectCoverageRows(mongoose.connection.db);
        symbols = planTranscriptBatch(rows, {
          batchSize: args.batchSize, attempted, priority: args.priority,
        });
        const remaining = rows.filter((r) => !attempted.has(r.symbol) && (r.promiseStage === 'NOT_RUN' || r.registry.promisePending > 0 || r.registry.promiseFailed > 0)).length;
        if (symbols.length) console.log(`\n=== Batch ${batchesDone + 1}: ${symbols.join(', ')}  (promise stage unsettled in database: ${remaining}) ===`);
      }
      if (!symbols.length) { console.log('\nNothing left to attempt in this run.'); break; }
      if (args.dryRun || args.explicit) console.log(`\n=== Batch ${batchesDone + 1}: ${symbols.join(', ')} ===`);
      symbols.forEach((s) => attempted.add(s));

      // Companies run a few at a time; the exchange requests and model calls are gated globally.
      const queue = [...symbols];
      const worker = async () => {
        while (queue.length && !stopReason) {
          const symbol = queue.shift();
          const t0 = Date.now();
          // eslint-disable-next-line no-await-in-loop
          const result = await processSymbol(symbol, deps);
          totals.companies += 1;
          totals.discovered += result.discovered;
          totals.registered += result.registered;
          totals.duplicates += result.duplicates;
          totals.downloadFailed += result.downloadFailed;
          totals.promiseDocs += result.promiseDocsProcessed;
          totals.noGuidanceDocs += result.noGuidanceDocs;
          totals.promiseFailures += result.promiseFailures;
          totals.candidates += result.candidates;
          if (result.noTranscripts && !result.error) totals.noTranscripts += 1;
          if (result.error) totals.errors += 1;
          const failed = Boolean(result.error) || (result.discovered > 0 && result.promiseFailures + result.downloadFailed >= result.discovered);
          consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
          const line = { at: new Date().toISOString(), symbol, seconds: Math.round((Date.now() - t0) / 1000), ...result };
          fs.appendFileSync(ledger, `${JSON.stringify(line)}\n`);
          // Durable rotation marker (Render's filesystem is ephemeral, so the ledger above is not enough).
          if (!args.dryRun) {
            // eslint-disable-next-line no-await-in-loop
            await mongoose.connection.db.collection('companyresearchprofiles').updateOne({ symbol }, { $set: discoveryRecord(result) }).catch((err) => console.warn(`  (could not record discovery attempt for ${symbol}: ${err.message})`));
          }
          const years = Object.entries(result.byFiscalYear).map(([fy, n]) => `${fy}:${n}`).join(' ') || 'none';
          console.log(`  ${symbol.padEnd(12)} transcripts=${result.discovered} [${years}] registered=${result.registered} dup=${result.duplicates} dlFail=${result.downloadFailed} | promise docs=${result.promiseDocsProcessed} noGuidance=${result.noGuidanceDocs} failed=${result.promiseFailures} candidates=${result.candidates} ${line.seconds}s${result.error ? ` | ${result.error}` : ''}${result.noTranscripts && !result.error ? ' | NO TRANSCRIPTS ON NSE IN WINDOW' : ''}`);
          stopReason = shouldStopTranscripts({
            consecutiveFailures, elapsedMs: Date.now() - startedAt, maxRuntimeMs: args.maxRuntimeMin * 60000, estimatedUsd: estimateModelCostUsd(modelUsage), maxCostUsd: args.maxCostUsd,
          });
          // eslint-disable-next-line no-await-in-loop
          await sleep(1000);
        }
      };
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(Array.from({ length: Math.min(args.concurrency, symbols.length) }, worker));

      batchesDone += 1;
      // eslint-disable-next-line no-await-in-loop
      if (runId) await heartbeat(jobName, runId, { batchesDone, attempted: [...attempted], totals, estimatedUsd: estimateModelCostUsd(modelUsage) });
      if (!stopReason) stopReason = shouldStopTranscripts({ batchesDone, maxBatches: args.maxBatches });
      if (stopReason) break;
    }

    console.log(`\n${stopReason ? `Stopped: ${stopReason}.` : 'Run finished.'}`);
    console.log(`This run: ${JSON.stringify(totals)} in ${Math.round((Date.now() - startedAt) / 60000)} min; ledger ${path.relative(process.cwd(), ledger)}`);
    const estimatedUsd = estimateModelCostUsd(modelUsage);
    console.log(`Model usage: ${modelUsage.calls} calls, ${modelUsage.promptTokens} prompt + ${modelUsage.completionTokens} completion tokens (about $${estimatedUsd.toFixed(3)} at list price)`);
    if (!args.dryRun) {
      const { rows } = await collectCoverageRows(mongoose.connection.db);
      console.log(`Database now: ${JSON.stringify(summarize(rows).categories)}`);
      console.log(`Resume with the same command; next: ${planTranscriptBatch(rows, { batchSize: 10, priority: args.priority }).join(',') || '(none unsettled)'}`);
      if (runId) await completeRun(jobName, runId, { status: 'SUCCESS', stats: { ...totals, batchesDone, stopReason, estimatedUsd } });
      await mongoose.disconnect();
    }
    process.exit(0);
  })().catch(async (error) => {
    console.error('Transcript run failed:', error.message);
    try {
      if (jobName && runId && mongoose.connection.readyState === 1) {
        await completeRun(jobName, runId, { status: 'FAILED', error: error.message });
      }
    } catch { /* best-effort: the primary failure is already reported above */ }
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
