/**
 * earningsXbrlBatch.js
 * ======================
 * `npm run earnings:xbrl-batch -- --expect-target <host>/<database> [--batch-size 10]
 *    [--max-batches N] [--max-runtime-min N] [--symbols A,B] [--from-year 2022]
 *    [--max-filings 24] [--delay-ms 1000] [--pause-ms 2000] [--plan-only]`
 *
 * Works through the PENDING supported companies in small batches, collecting
 * NSE XBRL facts with scripts/collectNseXbrlFundamentals.js (period-checked;
 * see services/NseXbrlService.js) and recording a ResearchJob for each.
 *
 * RESUMABLE WITHOUT A LEDGER FILE. What is "pending" is derived from the
 * database on every batch (scripts/earningsCoverageAudit.js), so a company
 * that already has facts, or a recorded permanent failure, is never selected
 * again. Running the same command after an interruption simply continues.
 * Each company is attempted at most once per run; a retryable failure is
 * picked up again on the next run until its third attempt.
 *
 * SAFETY. --expect-target is required and checked before connecting. It stops
 * after three consecutive companies whose NSE index was unavailable rather
 * than hammering a source that is refusing requests. Requests are throttled.
 * Nothing here accepts, edits or deletes anything: it only upserts real facts
 * and job records.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import { getFiscalWindow } from '../utils/fiscalWindow.js';
import { collectCoverageRows, orderPending, summarize } from './earningsCoverageAudit.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_CONSECUTIVE_INDEX_FAILURES = 3;

/**
 * planBatch - pure. The next symbols to process: the explicit list if given,
 * otherwise the pending, research-enabled companies by market cap (then
 * alphabetically), skipping anything already attempted in this run.
 */
export const planBatch = (rows, {
  batchSize = 10, explicit = null, attempted = new Set(), priority = [],
} = {}) => {
  let candidates;
  if (explicit?.length) {
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    candidates = explicit.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  } else {
    // `priority` (e.g. market-cap order) puts those symbols first, in that order; anything unlisted follows in the default order.
    const rank = new Map(priority.map((symbol, i) => [symbol, i]));
    candidates = orderPending(rows)
      .map((row, position) => ({ row, position }))
      .sort((a, b) => ((rank.get(a.row.symbol) ?? Infinity) - (rank.get(b.row.symbol) ?? Infinity)) || (a.position - b.position))
      .map((entry) => entry.row);
  }
  return candidates.filter((r) => !attempted.has(r.symbol)).slice(0, batchSize).map((r) => r.symbol);
};

/** shouldStop - pure. Why the run must stop now, or null. */
export const shouldStop = ({ consecutiveIndexFailures = 0, elapsedMs = 0, maxRuntimeMs = 0, batchesDone = 0, maxBatches = 0 }) => {
  if (consecutiveIndexFailures >= MAX_CONSECUTIVE_INDEX_FAILURES) return `NSE's results index was unavailable for ${consecutiveIndexFailures} companies in a row; stopping rather than hammering it`;
  if (maxRuntimeMs && elapsedMs >= maxRuntimeMs) return 'the --max-runtime-min budget is used up';
  if (maxBatches && batchesDone >= maxBatches) return 'the --max-batches limit was reached';
  return null;
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const parseArgs = (argv) => {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  return {
    expectTarget: get('--expect-target'),
    batchSize: Number(get('--batch-size')) || 10,
    maxBatches: Number(get('--max-batches')) || 0,
    maxRuntimeMin: Number(get('--max-runtime-min')) || 0,
    explicit: get('--symbols') ? get('--symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    priority: get('--priority') ? get('--priority').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [],
    fromYear: get('--from-year') ? Number(get('--from-year')) : null,
    maxFilings: Number(get('--max-filings')) || 24,
    delayMs: get('--delay-ms') ? Number(get('--delay-ms')) : 1000,
    pauseMs: get('--pause-ms') ? Number(get('--pause-ms')) : 2000,
    planOnly: argv.includes('--plan-only'),
    label: get('--label') || 'xbrl-batch',
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    dotenv.config();
    const args = parseArgs(process.argv.slice(2));
    if (!args.expectTarget) throw new Error('--expect-target <host>/<database> is required: this script writes to the database.');
    const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
    console.log(`Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

    const { collectSymbol, recordJob } = await import('./collectNseXbrlFundamentals.js');
    const window = getFiscalWindow();
    const fromYear = args.fromYear ?? window.fromYear;
    const options = { dryRun: false, fromYear, maxFilings: args.maxFilings, preferConsolidated: true, delayMs: args.delayMs };

    const ledgerDir = path.join(BACKEND_DIR, 'reports', 'earnings-coverage');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const ledger = path.join(ledgerDir, `${args.label}-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const attempted = new Set();
    const startedAt = Date.now();
    let batchesDone = 0;
    let consecutiveIndexFailures = 0;
    let stopReason = null;
    const totals = { companies: 0, facts: 0, requests: 0, statuses: {} };

    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await collectCoverageRows(mongoose.connection.db);
      const symbols = planBatch(rows, { batchSize: args.batchSize, explicit: args.explicit, attempted, priority: args.priority });
      const remaining = orderPending(rows).filter((r) => !attempted.has(r.symbol)).length;
      if (!symbols.length) { console.log(`\nNothing left to attempt (pending not yet tried this run: ${remaining}).`); break; }

      console.log(`\n=== Batch ${batchesDone + 1}: ${symbols.join(', ')}  (pending in database: ${orderPending(rows).length}) ===`);
      if (args.planOnly) { console.log('--plan-only: stopping before any request.'); break; }

      for (const symbol of symbols) {
        attempted.add(symbol);
        const t0 = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const result = await collectSymbol(symbol, options);
        // eslint-disable-next-line no-await-in-loop
        const status = await recordJob(result, { fromYear, toYear: window.toYear });
        totals.companies += 1;
        totals.facts += result.stored;
        totals.requests += result.requests || 0;
        totals.statuses[status] = (totals.statuses[status] || 0) + 1;
        consecutiveIndexFailures = result.error ? consecutiveIndexFailures + 1 : 0;
        const line = { at: new Date().toISOString(), batch: batchesDone + 1, symbol, status, filings: result.filings, facts: result.stored, quarantined: result.quarantined, unavailable: result.unavailable, noContext: result.noMatchingContext, fiscalYears: result.fiscalYears, latestPeriod: result.latestPeriod, requests: result.requests, seconds: Math.round((Date.now() - t0) / 1000), error: result.error || null };
        fs.appendFileSync(ledger, `${JSON.stringify(line)}\n`);
        console.log(`  ${symbol.padEnd(12)} ${status.padEnd(17)} filings=${result.filings} facts=${result.stored} years=[${(result.fiscalYears || []).join(',')}] ${line.seconds}s${result.error ? ` | ${result.error}` : ''}`);

        stopReason = shouldStop({ consecutiveIndexFailures, elapsedMs: Date.now() - startedAt, maxRuntimeMs: args.maxRuntimeMin * 60000 });
        if (stopReason) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(args.pauseMs);
      }
      batchesDone += 1;
      if (!stopReason) stopReason = shouldStop({ batchesDone, maxBatches: args.maxBatches });
      if (stopReason) break;
    }

    const { rows } = await collectCoverageRows(mongoose.connection.db);
    console.log(`\n${stopReason ? `Stopped: ${stopReason}.` : 'Run finished.'}`);
    console.log(`This run: ${totals.companies} companies, ${totals.facts} facts stored, ~${totals.requests} exchange requests, ${Math.round((Date.now() - startedAt) / 60000)} min. Job outcomes: ${JSON.stringify(totals.statuses)}`);
    console.log(`Database now: ${JSON.stringify(summarize(rows).categories)}; ledger: ${path.relative(process.cwd(), ledger)}`);
    console.log(`Resume with the same command; the next symbols will be: ${planBatch(rows, { batchSize: 10, priority: args.priority }).join(',') || '(none pending)'}`);
    await mongoose.disconnect();
    process.exit(0);
  })().catch(async (error) => {
    console.error('Batch run failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
