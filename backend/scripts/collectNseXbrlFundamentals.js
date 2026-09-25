/**
 * collectNseXbrlFundamentals.js
 * ================================
 * Phase 6B: collects REAL, attributable fundamentals for companies the
 * corpus has no filing data for from the exchange's own published XBRL
 * filings.
 *
 * SOURCE AND METHOD. NSE publishes a corporate-results index at
 * `/api/corporates-financial-results`, where each entry carries the filing's
 * period, filing timestamp, audit status, consolidated/standalone flag, and
 * a link to the XBRL document the company itself filed. This script reads
 * that index, downloads the linked XBRL, and extracts only tags the filing
 * actually contains, taking each figure from the context that spans exactly
 * the filing's own period (see services/NseXbrlService.js). Every figure
 * keeps its source URL, filing date, reporting period and the exact XBRL tag
 * and context it came from.
 *
 * WHAT IT WILL NOT DO:
 *   - No site whose access is blocked is worked around. A refused request
 *     stays refused and is reported as such.
 *   - No figure is invented, inferred, or back-filled. A tag that is absent
 *     from a filing, or present only for another period, yields no fact.
 *   - Values are stored in the project's standard unit (INR crore). XBRL
 *     reports absolute rupees, so the conversion is recorded explicitly in
 *     the extraction provenance alongside the original value.
 *   - Suspicious output is screened by services/factQuarantine.js before
 *     storage, on the same terms as any other fact.
 *
 * KNOWN LIMIT. NSE's results index (as observed Sep 2026) holds nothing filed
 * after the quarter ending 31 Dec 2024, whatever date range is requested.
 * Fiscal years from FY2026 (and the last quarter of FY2025) are therefore not
 * obtainable from this source.
 *
 *   node scripts/collectNseXbrlFundamentals.js --symbols BEL,HAL
 *   node scripts/collectNseXbrlFundamentals.js --symbols BEL --dry-run
 *   node scripts/collectNseXbrlFundamentals.js --symbols SBIN,TITAN --from-year 2022 --max-filings 24 \
 *        --prefer-consolidated --delay-ms 1000 --expect-target cluster.example.net/mydb
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import {
  readTag, parseNseDate, toReportingPeriod, extractFactsFromFiling, selectFilings, toFactDocument, fiscalYearOfPeriod, deriveJobOutcome, nseSymbolFor, NSE_REQUEST_HEADERS,
} from '../services/NseXbrlService.js';
import { getFiscalWindow } from '../utils/fiscalWindow.js';

dotenv.config();

const CompanyHistoricalFact = (await import('../models/CompanyHistoricalFact.js')).default;
const { ResearchJob } = await import('../models/ResearchJob.js');
const { screenFact, FACT_VERDICTS } = await import('../services/factQuarantine.js');

// Kept exported for existing callers; the implementations live in the service.
export { readTag, parseNseDate, toReportingPeriod, extractFactsFromFiling };

const NSE_RESULTS_API = 'https://www.nseindia.com/api/corporates-financial-results';

const REQUEST_HEADERS = NSE_REQUEST_HEADERS;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One polite retry for a transient failure (network error, 429, 5xx); a 4xx refusal is final. */
const fetchWithRetry = async (url, parse) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(30000) });
      if (response.ok) return await parse(response);
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt === 2) throw new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      if (attempt === 2 || /^HTTP 4\d\d/.test(error.message)) throw error;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(3000);
  }
  return null;
};
const fetchJson = (url) => fetchWithRetry(url, (r) => r.json());
const fetchText = (url) => fetchWithRetry(url, (r) => r.text());

const collectSymbol = async (symbol, { dryRun, fromYear, maxFilings, preferConsolidated, delayMs }) => {
  const nseSymbol = nseSymbolFor(symbol);
  const url = `${NSE_RESULTS_API}?index=equities&symbol=${encodeURIComponent(nseSymbol)}&period=Quarterly`;
  let index;
  try {
    index = await fetchJson(url);
  } catch (error) {
    console.log(`  ${symbol}: results index unavailable — ${error.message}`);
    return { symbol, filings: 0, facts: 0, stored: 0, quarantined: 0, error: error.message };
  }
  await sleep(delayMs);

  const selected = selectFilings(index, { symbol: nseSymbol, fromYear, maxFilings, preferConsolidated });

  let factCount = 0;
  let stored = 0;
  let quarantined = 0;
  let noMatchingContext = 0;
  let unavailable = 0;
  const periods = new Set();

  for (const filing of selected) {
    let xml;
    try {
      // eslint-disable-next-line no-await-in-loop
      xml = await fetchText(filing.xbrl);
    } catch (error) {
      unavailable += 1;
      console.log(`  ${symbol} ${toReportingPeriod(filing)}: XBRL unavailable — ${error.message}`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);

    // Facts are stored under the supported symbol even when NSE lists the company under a renamed one.
    const facts = extractFactsFromFiling(xml, { ...filing, symbol });
    if (!facts.length) noMatchingContext += 1;
    factCount += facts.length;

    for (const fact of facts) {
      const screen = screenFact({ metric: fact.metric, value: fact.value, unit: fact.unit, title: fact.label });
      if (screen.verdict !== FACT_VERDICTS.USABLE) {
        quarantined += 1;
        console.log(`  ${symbol} ${fact.period} ${fact.metric}=${fact.value} ${fact.unit} -> ${screen.verdict} (${screen.reason})`);
        continue;
      }
      periods.add(fact.period);
      if (dryRun) { stored += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      await CompanyHistoricalFact.updateOne(
        { symbol: fact.symbol, period: fact.period, 'metrics.metric': fact.metric, 'source.url': fact.sourceUrl },
        { $set: toFactDocument(fact) },
        { upsert: true },
      );
      stored += 1;
    }
  }

  const sortedPeriods = [...periods].sort();
  const fiscalYears = [...new Set(sortedPeriods.map(fiscalYearOfPeriod).filter((y) => y != null))].sort();
  return {
    symbol, filings: selected.length, facts: factCount, stored, quarantined, unavailable, noMatchingContext, periods: sortedPeriods, fiscalYears,
    latestPeriod: selected.length ? toReportingPeriod(selected[0]) : null,
    requests: 1 + selected.length, // the results index plus one XBRL download per selected filing
  };
};

/**
 * recordJob - one ResearchJob per (symbol, fiscal-year range), so an
 * interrupted run resumes from the database alone and the coverage audit can
 * say why a company is partial or blocked. A job another route already
 * finished (COMPLETED) is never downgraded.
 */
const recordJob = async (result, { fromYear, toYear }) => {
  const key = { symbol: result.symbol, jobType: 'HISTORICAL_FACTS_BACKFILL', fromYear, toYear };
  const existing = await ResearchJob.findOne(key).lean();
  if (existing?.status === 'COMPLETED') return existing.status;

  const coveredYears = (result.fiscalYears || []).filter((y) => y >= fromYear && y <= toYear);
  const outcome = deriveJobOutcome({
    indexError: result.error || null,
    filings: result.filings,
    factsStored: result.stored,
    coveredYears: coveredYears.length,
    expectedYears: toYear - fromYear + 1,
    latestPeriod: result.latestPeriod,
    attempt: (existing?.attempt || 0) + 1,
  });
  await ResearchJob.findOneAndUpdate(
    key,
    {
      $set: {
        status: outcome.status,
        lastError: outcome.lastError,
        processedDocuments: result.filings,
        startedAt: existing?.startedAt || new Date(),
        completedAt: new Date(),
        cursor: { lastCompletedYear: coveredYears.length ? Math.max(...coveredYears) : null },
      },
      $inc: { attempt: 1 },
    },
    { upsert: true },
  );
  return outcome.status;
};

const main = async () => {
  const symbols = (arg('symbols', 'BEL,HAL') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const dryRun = hasFlag('dry-run');
  const options = {
    dryRun,
    fromYear: arg('from-year') ? Number(arg('from-year')) : null,
    maxFilings: arg('max-filings') ? Number(arg('max-filings')) : 12,
    preferConsolidated: hasFlag('prefer-consolidated'),
    delayMs: arg('delay-ms') ? Number(arg('delay-ms')) : 1000,
  };

  const target = assertMongoTarget(process.env.MONGODB_URI, arg('expect-target'));
  console.log(dryRun ? 'Dry run: no database connection.' : `Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);
  if (!dryRun) await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`Collecting NSE XBRL fundamentals for ${symbols.length} symbol(s)${dryRun ? ' (dry run)' : ''}: from-year=${options.fromYear ?? 'any'} max-filings=${options.maxFilings} prefer-consolidated=${options.preferConsolidated} delay=${options.delayMs}ms\n`);

  const results = [];
  for (const symbol of symbols) {
    // eslint-disable-next-line no-await-in-loop
    const result = await collectSymbol(symbol, options);
    results.push(result);
    if (!dryRun) {
      const window = getFiscalWindow();
      // eslint-disable-next-line no-await-in-loop
      result.jobStatus = await recordJob(result, { fromYear: options.fromYear ?? window.fromYear, toYear: window.toYear });
    }
    console.log(`  ${symbol}: ${result.filings} filing(s) -> ${result.facts} fact(s), ${result.stored} stored, ${result.quarantined} quarantined${result.unavailable ? `, ${result.unavailable} unavailable` : ''}${result.noMatchingContext ? `, ${result.noMatchingContext} with no matching period context` : ''}${result.jobStatus ? ` | job ${result.jobStatus}` : ''}`);
    if (result.fiscalYears?.length) console.log(`     fiscal years: ${result.fiscalYears.map((y) => `FY${y}`).join(', ')}`);
  }

  console.log('\n--- summary ---');
  console.log(JSON.stringify(results));
  if (!dryRun) await mongoose.disconnect();
};

export { collectSymbol, recordJob };

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
