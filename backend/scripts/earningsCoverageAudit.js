/**
 * earningsCoverageAudit.js
 * ==========================
 * `npm run earnings:audit -- [--label=baseline] [--symbols=A,B] [--api]
 *    [--out=reports/earnings-coverage] [--expect-target=host/db] [--list-pending=N]`
 *
 * READ-ONLY. Measures Earnings Intelligence research coverage for every
 * supported stock straight from the database, and (with --api) from the real
 * report/timeline route handlers. It never writes to the target database and
 * imports no Mongoose models (importing a model would let Mongoose create its
 * collections and indexes on connect).
 *
 * What it will NOT do: trust a ResearchJob's status as proof of coverage. A
 * fiscal year is covered only when a REAL_RESEARCH fact with a validated
 * financial metric, a numeric value and an http(s) source URL exists for it.
 * SEEDED_DEMO and origin-less facts never count.
 *
 * Categories:
 *   COMPLETE - every fiscal year in the window is covered from an exchange
 *              source, promise extraction has demonstrably run (or accepted
 *              promises exist), and no document/job is still in flight.
 *   PARTIAL  - some real facts or promise records exist, but not all of that.
 *   PENDING  - no real research stored (never attempted, or attempted with
 *              nothing stored yet; the reason column says which).
 *   BLOCKED  - a concrete recorded reason nothing can proceed (unresolvable
 *              BSE identity, permanently failed job, every filing failed).
 *
 * --api additionally calls GET /api/earnings-intelligence/:symbol and
 * /:symbol/timeline through the real router on an ephemeral local port, with
 * the IndianAPI key blanked in-process so verifying coverage spends no
 * provider quota.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUPPORTED_STOCKS, FEATURED_SYMBOLS, EARNINGS_COVERAGE_METRICS } from '../utils/constants.js';
import { PUBLIC_SAFE_EVIDENCE_STATUSES } from '../utils/earningsIntelligenceValidation.js';
import { describeMongoTarget, assertMongoTarget } from '../utils/mongoTarget.js';
import { getFiscalWindow } from '../utils/fiscalWindow.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors services/PromiseExtractionService.js PROMISE_ELIGIBLE_SOURCE_TYPES (a test pins the two together).
export const PROMISE_ELIGIBLE_TYPES = ['EARNINGS_CALL_TRANSCRIPT', 'FINANCIAL_RESULTS'];
const ACTIVE_JOB_STATUSES = ['QUEUED', 'DISCOVERING', 'DOWNLOADING', 'EXTRACTING', 'VERIFYING'];

export { describeMongoTarget };

export { getFiscalWindow };

/** Same rule as backfillUniverse.evaluateYearCoverage: the first 4-digit number in the period. */
export const fiscalYearOf = (period) => {
  const match = String(period || '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
};

const isHttpUrl = (url) => /^https?:\/\//i.test(String(url || ''));
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
export const isExchangeHosted = (url) => {
  const host = hostOf(url);
  return ['bseindia.com', 'nseindia.com'].some((d) => host === d || host.endsWith(`.${d}`));
};

const emptyRow = (symbol) => ({
  symbol,
  companyName: SUPPORTED_STOCKS[symbol]?.name || symbol,
  featured: FEATURED_SYMBOLS.includes(symbol),
  profile: { present: false, researchEnabled: null, bseScripCode: null, marketCapCr: null },
  facts: { real: 0, financial: 0, nonReal: 0, uniqueSourceDocs: 0, exchangeSourceDocs: 0, coveredYears: [], missingYears: [], byYear: {} },
  promises: { real: 0, publicSafe: 0, curatedFile: 0, candidates: { pending: 0, accepted: 0, rejected: 0 } },
  registry: { total: 0, extracted: 0, failed: 0, inFlight: 0, eligible: 0, promiseExtracted: 0, promiseFailed: 0, promisePending: 0, topErrors: [] },
  job: null,
  run: null,
});

/**
 * classifyCoverage - pure. Takes an assembled row and returns the category
 * and the human-readable reasons. See the header for what each means.
 */
export const classifyCoverage = (row, { expectedYears }) => {
  const { facts, promises, registry: reg, job, profile } = row;
  const years = facts.coveredYears.length;
  const acceptedPromises = promises.publicSafe + promises.curatedFile + promises.candidates.accepted;
  const reasons = [];

  const promiseStage = acceptedPromises > 0 ? 'ACCEPTED_PRESENT'
    : promises.candidates.pending > 0 ? 'CANDIDATES_PENDING_REVIEW'
      : (reg.eligible > 0 && reg.promisePending === 0 && reg.promiseFailed === 0) ? 'EXTRACTED_NONE_FOUND'
        : 'NOT_RUN';

  if (profile.present && profile.researchEnabled === false) {
    return { category: 'BLOCKED', promiseStage, reasons: ['No resolvable BSE scrip code (profile researchEnabled=false)'] };
  }
  if (job?.status === 'FAILED_PERMANENT') {
    return { category: 'BLOCKED', promiseStage, reasons: [`Job FAILED_PERMANENT after ${job.attempt} attempts: ${job.lastError || 'no filings/coverage found'}`] };
  }
  if (years === 0 && reg.total > 0 && reg.extracted === 0 && reg.failed === reg.total) {
    const why = reg.topErrors[0] ? `${reg.topErrors[0].error} (x${reg.topErrors[0].count})` : 'no error recorded';
    return { category: 'BLOCKED', promiseStage, reasons: [`All ${reg.total} registered filing(s) failed download/extraction: ${why}`] };
  }

  if (years < expectedYears) reasons.push(`Financial coverage ${years}/${expectedYears} years (missing ${facts.missingYears.map((y) => `FY${y}`).join(', ') || 'none'})`);
  if (years > 0 && facts.exchangeSourceDocs === 0) reasons.push('No exchange-hosted source document behind the covered years');
  if (promiseStage === 'NOT_RUN') reasons.push('Promise extraction has not run (or is unprovable: no document registry rows)');
  if (reg.inFlight > 0) reasons.push(`${reg.inFlight} registry document(s) still FETCHED/PENDING`);
  if (reg.failed > 0) reasons.push(`${reg.failed} registry document(s) FAILED`);
  if (job && ACTIVE_JOB_STATUSES.includes(job.status)) reasons.push(`Job still ${job.status}`);

  const financialComplete = years === expectedYears && facts.exchangeSourceDocs >= 1;
  const settled = reg.inFlight === 0 && !(job && ACTIVE_JOB_STATUSES.includes(job.status));
  if (financialComplete && promiseStage !== 'NOT_RUN' && settled) {
    return { category: 'COMPLETE', promiseStage, reasons: reasons.length ? reasons : ['All checks passed'] };
  }

  const hasAnything = facts.real > 0 || acceptedPromises > 0 || promises.candidates.pending > 0 || promises.real > 0;
  if (hasAnything) return { category: 'PARTIAL', promiseStage, reasons };

  const attempted = reg.total > 0 || Boolean(job) || Boolean(row.run);
  const note = attempted
    ? `Attempted but nothing stored${job ? ` (job ${job.status}${job.lastError ? `: ${job.lastError}` : ''})` : ''}`
    : 'Never attempted';
  return { category: 'PENDING', promiseStage, reasons: [note] };
};

const latestBy = (rows, keyOf) => {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const prev = map.get(key);
    if (!prev || new Date(row.updatedAt || row.createdAt || 0) > new Date(prev.updatedAt || prev.createdAt || 0)) map.set(key, row);
  }
  return map;
};

const readCuratedPromiseCounts = () => {
  const dir = path.join(BACKEND_DIR, 'data', 'earnings-intelligence', 'promises');
  const counts = {};
  if (!fs.existsSync(dir)) return counts;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const records = Array.isArray(parsed) ? parsed : (parsed.records || []);
      counts[path.basename(file, '.json').toUpperCase()] = records.filter((r) => r.dataMode !== 'DEMO_SYNTHETIC').length;
    } catch { /* an unreadable curated file simply contributes nothing */ }
  }
  return counts;
};

/** Reads everything needed with raw collection queries (read-only) and returns one row per symbol. */
export const collectCoverageRows = async (db, { symbols = null, now = new Date() } = {}) => {
  const window = getFiscalWindow(now);
  const universe = symbols?.length ? symbols : Object.keys(SUPPORTED_STOCKS);
  const col = (name) => db.collection(name);

  const [realFacts, nonRealAgg, promiseDocs, candidateAgg, registryDocs, jobs, runs, profiles] = await Promise.all([
    col('companyhistoricalfacts').find({ dataOrigin: 'REAL_RESEARCH' }, { projection: { symbol: 1, period: 1, 'metrics.metric': 1, 'metrics.actualValue': 1, 'source.url': 1 } }).toArray(),
    col('companyhistoricalfacts').aggregate([{ $match: { dataOrigin: { $ne: 'REAL_RESEARCH' } } }, { $group: { _id: '$symbol', n: { $sum: 1 } } }]).toArray(),
    col('managementpromises').find({ dataOrigin: 'REAL_RESEARCH' }, { projection: { symbol: 1, 'evidenceIntegrity.status': 1, 'evidence.promiseSource.sourceUrl': 1 } }).toArray(),
    col('promisecandidates').aggregate([{ $group: { _id: { symbol: '$symbol', status: '$reviewStatus' }, n: { $sum: 1 } } }]).toArray(),
    col('companydocumentregistries').find({}, { projection: { symbol: 1, sourceType: 1, extractionStatus: 1, promiseExtractionStatus: 1, error: 1 } }).toArray(),
    col('researchjobs').find({}).toArray(),
    col('researchruns').find({ dataOrigin: 'REAL_RESEARCH' }).toArray(),
    col('companyresearchprofiles').find({}).toArray(),
  ]);

  const curated = readCuratedPromiseCounts();
  const rows = new Map(universe.map((s) => [s, emptyRow(s)]));
  const rowFor = (symbol) => rows.get(String(symbol || '').toUpperCase());

  const urlSets = new Map();
  const yearSets = new Map();
  for (const fact of realFacts) {
    const row = rowFor(fact.symbol);
    if (!row) continue;
    row.facts.real += 1;
    const url = fact.source?.url;
    const validFinancial = EARNINGS_COVERAGE_METRICS.includes(fact.metrics?.metric) && fact.metrics?.actualValue != null && isHttpUrl(url);
    if (validFinancial) {
      row.facts.financial += 1;
      const year = fiscalYearOf(fact.period);
      if (year != null && year >= window.fromYear && year <= window.toYear) {
        if (!yearSets.has(row.symbol)) yearSets.set(row.symbol, new Set());
        yearSets.get(row.symbol).add(year);
        row.facts.byYear[year] = (row.facts.byYear[year] || 0) + 1;
      }
    }
    if (isHttpUrl(url)) {
      if (!urlSets.has(row.symbol)) urlSets.set(row.symbol, new Set());
      urlSets.get(row.symbol).add(url);
    }
  }
  for (const item of nonRealAgg) { const row = rowFor(item._id); if (row) row.facts.nonReal = item.n; }

  for (const promise of promiseDocs) {
    const row = rowFor(promise.symbol);
    if (!row) continue;
    row.promises.real += 1;
    if (PUBLIC_SAFE_EVIDENCE_STATUSES.includes(promise.evidenceIntegrity?.status)) row.promises.publicSafe += 1;
    const url = promise.evidence?.promiseSource?.sourceUrl;
    if (isHttpUrl(url)) {
      if (!urlSets.has(row.symbol)) urlSets.set(row.symbol, new Set());
      urlSets.get(row.symbol).add(url);
    }
  }
  for (const [symbol, count] of Object.entries(curated)) { const row = rowFor(symbol); if (row) row.promises.curatedFile = count; }
  for (const item of candidateAgg) {
    const row = rowFor(item._id.symbol);
    if (!row) continue;
    const key = { PENDING_REVIEW: 'pending', ACCEPTED: 'accepted', REJECTED: 'rejected' }[item._id.status];
    if (key) row.promises.candidates[key] += item.n;
  }

  const errorCounts = new Map();
  for (const doc of registryDocs) {
    const row = rowFor(doc.symbol);
    if (!row) continue;
    const reg = row.registry;
    reg.total += 1;
    if (doc.extractionStatus === 'EXTRACTED') reg.extracted += 1;
    else if (doc.extractionStatus === 'FAILED') {
      reg.failed += 1;
      const key = `${row.symbol}|${String(doc.error || 'unknown').slice(0, 140)}`;
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    } else reg.inFlight += 1;
    if (PROMISE_ELIGIBLE_TYPES.includes(doc.sourceType) && doc.extractionStatus === 'EXTRACTED') {
      reg.eligible += 1;
      if (doc.promiseExtractionStatus === 'EXTRACTED') reg.promiseExtracted += 1;
      else if (doc.promiseExtractionStatus === 'FAILED') reg.promiseFailed += 1;
      else reg.promisePending += 1;
    }
  }
  for (const [key, count] of errorCounts) {
    const [symbol, error] = key.split('|');
    rowFor(symbol)?.registry.topErrors.push({ error, count });
  }
  for (const row of rows.values()) row.registry.topErrors.sort((a, b) => b.count - a.count).splice(3);

  for (const job of latestBy(jobs, (j) => j.symbol).values()) {
    const row = rowFor(job.symbol);
    if (row) row.job = { status: job.status, attempt: job.attempt, lastError: job.lastError || null, processedDocuments: job.processedDocuments, fromYear: job.fromYear, toYear: job.toYear, updatedAt: job.updatedAt };
  }
  for (const run of latestBy(runs, (r) => r.companySymbol).values()) {
    const row = rowFor(run.companySymbol);
    if (row) row.run = { status: run.status, state: run.state || null, error: run.error || null, updatedAt: run.updatedAt };
  }
  for (const profile of profiles) {
    const row = rowFor(profile.symbol);
    if (row) row.profile = { present: true, researchEnabled: profile.researchEnabled, bseScripCode: profile.bseScripCode || null, marketCapCr: profile.marketCapCr ?? null };
  }

  for (const row of rows.values()) {
    const years = [...(yearSets.get(row.symbol) || [])].sort();
    row.facts.coveredYears = years;
    row.facts.missingYears = Array.from({ length: window.expectedYears }, (_, i) => window.fromYear + i).filter((y) => !years.includes(y));
    const urls = [...(urlSets.get(row.symbol) || [])];
    row.facts.uniqueSourceDocs = urls.length;
    row.facts.exchangeSourceDocs = urls.filter(isExchangeHosted).length;
    Object.assign(row, classifyCoverage(row, window));
  }

  return { window, rows: [...rows.values()] };
};

/** Orders PENDING, research-enabled symbols by real market cap (descending), never by Mongo order. */
export const orderPending = (rows) => rows
  .filter((r) => r.category === 'PENDING' && r.profile.researchEnabled !== false)
  .sort((a, b) => (b.profile.marketCapCr ?? -1) - (a.profile.marketCapCr ?? -1) || a.symbol.localeCompare(b.symbol));

export const summarize = (rows) => {
  const counts = { COMPLETE: 0, PARTIAL: 0, PENDING: 0, BLOCKED: 0 };
  for (const r of rows) counts[r.category] += 1;
  const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);
  return {
    symbols: rows.length,
    categories: counts,
    realFacts: sum((r) => r.facts.real),
    financialFacts: sum((r) => r.facts.financial),
    nonRealFactsExcluded: sum((r) => r.facts.nonReal),
    uniqueSourceDocs: sum((r) => r.facts.uniqueSourceDocs),
    acceptedPromises: sum((r) => r.promises.publicSafe + r.promises.curatedFile + r.promises.candidates.accepted),
    pendingCandidates: sum((r) => r.promises.candidates.pending),
    rejectedCandidates: sum((r) => r.promises.candidates.rejected),
    registryDocs: sum((r) => r.registry.total),
  };
};

const httpGet = async (base, route) => {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(60000) });
    const body = await response.json().catch(() => null);
    return { status: response.status, ms: Date.now() - started, body };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, body: null, error: error.message };
  }
};

/** Calls the real report + timeline handlers for the given symbols and reduces each to what a visitor would see. */
export const runApiChecks = async (symbols) => {
  process.env.INDIAN_API_KEY = ''; // no provider quota is spent verifying coverage
  mongoose.set('autoIndex', false); // reading through the services must not create indexes
  const [{ default: express }, { default: router }] = await Promise.all([
    import('express'),
    import('../routes/earningsIntelligence.js'),
  ]);
  const app = express();
  app.use('/api/earnings-intelligence', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/earnings-intelligence`;
  const originalLog = console.log;
  console.log = () => {}; // the router logs every request
  const results = {};
  try {
    for (const symbol of symbols) {
      // eslint-disable-next-line no-await-in-loop
      const [report, timeline] = await Promise.all([httpGet(base, `/${symbol}`), httpGet(base, `/${symbol}/timeline`)]);
      const r = report.body?.data || {};
      const t = timeline.body?.data || {};
      results[symbol] = {
        report: {
          http: report.status,
          state: r.researchState ?? r.state ?? null,
          financialYears: r.financialCoverage ? `${r.financialCoverage.completedYears}/${r.financialCoverage.expectedYears}` : null,
          financialMissing: r.financialCoverage?.missingYears || null,
          sourceDocuments: Array.isArray(r.sourceDocuments) ? r.sourceDocuments.length : null,
          facts: r.factsCount ?? (Array.isArray(r.facts) ? r.facts.length : null),
          promiseScoreStatus: r.promiseCoverage?.scoreStatus ?? null,
          promisesTotal: r.promiseCoverage?.promisesTotal ?? null,
        },
        timeline: {
          http: timeline.status,
          dataMode: t.dataMode ?? null,
          coverageStatus: t.coverageStatus ?? null,
          totalPromises: t.summary?.totalPromises ?? (Array.isArray(t.promises) ? t.promises.length : null),
          faithScore: t.summary?.faithScore ?? null,
          message: timeline.body?.message ?? null,
        },
      };
    }
  } finally {
    console.log = originalLog;
    await new Promise((resolve) => { server.close(resolve); });
  }
  return results;
};

const pad = (value, n) => String(value).padEnd(n);
const yearsCell = (r, window) => `${r.facts.coveredYears.length}/${window.expectedYears}`;

export const renderMarkdown = ({ label, target, window, rows, summary, api }) => {
  const lines = [];
  lines.push(`# Earnings Intelligence coverage: ${label}`, '', `- Target database: \`${target.label}\`${target.implicitDatabase ? ' (no database name in the URI, so the driver default)' : ''}`,
    `- Generated: ${new Date().toISOString()}`, `- Fiscal window: FY${window.fromYear}-FY${window.toYear} (${window.expectedYears} years)`, '',
    '## Summary', '', `| Metric | Value |`, `|---|---|`);
  lines.push(`| Supported symbols | ${summary.symbols} |`);
  for (const [k, v] of Object.entries(summary.categories)) lines.push(`| ${k} | ${v} |`);
  lines.push(`| Real facts (financial-valid) | ${summary.realFacts} (${summary.financialFacts}) |`, `| Non-real facts excluded (demo/unknown origin) | ${summary.nonRealFactsExcluded} |`,
    `| Unique source documents | ${summary.uniqueSourceDocs} |`, `| Accepted promises | ${summary.acceptedPromises} |`, `| Pending-review candidates | ${summary.pendingCandidates} |`,
    `| Registry documents | ${summary.registryDocs} |`, '', '## Per symbol', '',
    '| Symbol | Category | FY covered | Real facts | Src docs (exchange) | Promises acc/pend | Registry ok/fail | Job | Reason |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.symbol} | ${r.category} | ${yearsCell(r, window)} | ${r.facts.real} | ${r.facts.uniqueSourceDocs} (${r.facts.exchangeSourceDocs}) | ${r.promises.publicSafe + r.promises.curatedFile + r.promises.candidates.accepted}/${r.promises.candidates.pending} | ${r.registry.extracted}/${r.registry.failed} | ${r.job?.status || '-'} | ${r.reasons.join('; ').replace(/\|/g, '/')} |`);
  }
  if (api) {
    lines.push('', '## API view', '', '| Symbol | Report HTTP | Years | Src docs | State | Timeline HTTP | Data mode | Promises |', '|---|---|---|---|---|---|---|---|');
    for (const [symbol, a] of Object.entries(api)) {
      lines.push(`| ${symbol} | ${a.report.http} | ${a.report.financialYears ?? '-'} | ${a.report.sourceDocuments ?? '-'} | ${a.report.state ?? '-'} | ${a.timeline.http} | ${a.timeline.dataMode ?? '-'} | ${a.timeline.totalPromises ?? '-'} |`);
    }
  }
  return `${lines.join('\n')}\n`;
};

const parseArgs = (argv) => {
  const get = (flag) => { const a = argv.find((x) => x.startsWith(`${flag}=`)); return a ? a.slice(flag.length + 1) : null; };
  const symbolsArg = get('--symbols');
  return {
    label: get('--label') || 'audit',
    symbols: symbolsArg ? symbolsArg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null,
    api: argv.includes('--api'),
    out: get('--out') || path.join('reports', 'earnings-coverage'),
    expectTarget: get('--expect-target'),
    listPending: get('--list-pending') ? Number(get('--list-pending')) : null,
    noWrite: argv.includes('--no-report-file'),
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    dotenv.config();
    const args = parseArgs(process.argv.slice(2));
    const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
    console.log(`Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

    const { window, rows } = await collectCoverageRows(mongoose.connection.db, { symbols: args.symbols });
    const summary = summarize(rows);

    if (args.listPending) {
      console.log(orderPending(rows).slice(0, args.listPending).map((r) => r.symbol).join(','));
      await mongoose.disconnect();
      process.exit(0);
    }

    let api = null;
    if (args.api) {
      const apiSymbols = args.symbols?.length ? args.symbols : rows.filter((r) => r.category !== 'PENDING').map((r) => r.symbol);
      api = await runApiChecks(apiSymbols);
    }

    console.log(`\nFiscal window FY${window.fromYear}-FY${window.toYear}`);
    console.log('Categories:', JSON.stringify(summary.categories));
    console.log(`Real facts ${summary.realFacts} (financial-valid ${summary.financialFacts}) | non-real excluded ${summary.nonRealFactsExcluded} | source docs ${summary.uniqueSourceDocs} | accepted promises ${summary.acceptedPromises} | pending candidates ${summary.pendingCandidates} | registry docs ${summary.registryDocs}`);
    const shown = rows.filter((r) => r.category !== 'PENDING' || args.symbols);
    if (shown.length) {
      console.log(`\n${pad('SYMBOL', 12)}${pad('CATEGORY', 10)}${pad('FY', 6)}${pad('FACTS', 7)}${pad('DOCS', 6)}${pad('PROM a/p', 10)}REASON`);
      for (const r of shown) {
        console.log(`${pad(r.symbol, 12)}${pad(r.category, 10)}${pad(yearsCell(r, window), 6)}${pad(r.facts.real, 7)}${pad(r.facts.uniqueSourceDocs, 6)}${pad(`${r.promises.publicSafe + r.promises.curatedFile + r.promises.candidates.accepted}/${r.promises.candidates.pending}`, 10)}${r.reasons.join('; ').slice(0, 110)}`);
      }
    }
    if (api) {
      console.log('\nAPI view (report | timeline)');
      for (const [symbol, a] of Object.entries(api)) {
        console.log(`${pad(symbol, 12)}report ${a.report.http} years=${a.report.financialYears} srcDocs=${a.report.sourceDocuments} state=${a.report.state} | timeline ${a.timeline.http} mode=${a.timeline.dataMode} promises=${a.timeline.totalPromises}`);
      }
    }

    if (!args.noWrite) {
      const outDir = path.resolve(BACKEND_DIR, args.out);
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.join(outDir, `${args.label}-${stamp}`);
      fs.writeFileSync(`${base}.json`, JSON.stringify({ label: args.label, target: target.label, generatedAt: new Date().toISOString(), window, summary, rows, api }, null, 2));
      fs.writeFileSync(`${base}.md`, renderMarkdown({ label: args.label, target, window, rows, summary, api }));
      console.log(`\nReport saved: ${path.relative(process.cwd(), `${base}.md`)} (+ .json)`);
    }
    await mongoose.disconnect();
    process.exit(0);
  })().catch((error) => {
    console.error('Coverage audit failed:', error.message);
    process.exit(1);
  });
}

export default collectCoverageRows;
