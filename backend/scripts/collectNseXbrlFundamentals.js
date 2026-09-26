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
 * TWO FEEDS. NSE's legacy results index (`corporates-financial-results`, as
 * observed Sep 2026) holds nothing filed after the quarter ending 31 Dec 2024,
 * whatever date range is requested. Its Integrated Filing (Financials) feed
 * (`integrated-filing-results`) starts at the quarter ending 31 Mar 2025 and is
 * current. Both are read, merged, and reduced to one filing per period and
 * basis (newest wins, so a revision supersedes its original), which together
 * give the quarterly series FY2022..FY2026. Companies missing from the legacy
 * index (e.g. insurers) only get what the integrated feed holds.
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
  readTag, parseNseDate, toReportingPeriod, extractFactsFromFiling, selectFilings, olderVersionsOf, integratedRowToRecord, toFactDocument, fiscalYearOfPeriod, deriveJobOutcome, nseSymbolFor, NSE_REQUEST_HEADERS,
  corroborateStatedFullYear, ADDITIVE_METRICS, STATED_OVER_DECLARED, factBasisFilter,
} from '../services/NseXbrlService.js';
import { getFiscalWindow } from '../utils/fiscalWindow.js';

dotenv.config();

const CompanyHistoricalFact = (await import('../models/CompanyHistoricalFact.js')).default;
const { ResearchJob } = await import('../models/ResearchJob.js');
const { screenFact, FACT_VERDICTS } = await import('../services/factQuarantine.js');

// Kept exported for existing callers; the implementations live in the service.
export { readTag, parseNseDate, toReportingPeriod, extractFactsFromFiling };

// Two exchange feeds, each covering a different span. The legacy results index
// ends at the quarter ended 2024-12-31; the Integrated Filing (Financials)
// feed starts at the quarter ended 2025-03-31 and is current. Together they
// carry a company's whole FY2022..FY2026 quarterly series.
const NSE_RESULTS_API = 'https://www.nseindia.com/api/corporates-financial-results';
const NSE_INTEGRATED_API = 'https://www.nseindia.com/api/integrated-filing-results';
const INTEGRATED_TYPE = 'Integrated Filing- Financials';

// Facts read from an NSE-published XBRL file; a later filing for the same
// company, period and metric supersedes the stored one in place.
const NSE_XBRL_URL_PREFIX = /^https:\/\/nsearchives\.nseindia\.com\/corporate\/xbrl\//;

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

/**
 * loadFilingIndex - both feeds for one NSE symbol, as one list of records.
 * A feed that fails is reported, not fatal: the other may still carry years.
 * Only when BOTH fail is the company's index unavailable.
 */
const loadFilingIndex = async (nseSymbol, delayMs) => {
  const feedErrors = [];
  let legacy = [];
  let integrated = [];
  let integratedTruncated = false;

  try {
    const body = await fetchJson(`${NSE_RESULTS_API}?index=equities&symbol=${encodeURIComponent(nseSymbol)}&period=Quarterly`);
    legacy = Array.isArray(body) ? body : [];
  } catch (error) {
    feedErrors.push(`legacy results index: ${error.message}`);
  }
  await sleep(delayMs);

  try {
    const body = await fetchJson(`${NSE_INTEGRATED_API}?index=equities&symbol=${encodeURIComponent(nseSymbol)}&type=${encodeURIComponent(INTEGRATED_TYPE)}`);
    const rows = Array.isArray(body?.data) ? body.data : [];
    integratedTruncated = Number(body?.totalCount) > rows.length;
    integrated = rows.map(integratedRowToRecord).filter(Boolean);
  } catch (error) {
    feedErrors.push(`integrated filing feed: ${error.message}`);
  }
  await sleep(delayMs);

  return {
    index: [...legacy, ...integrated], feedErrors, integratedTruncated, legacyRows: legacy.length, integratedRows: integrated.length,
  };
};

/** The additive quarter facts already stored for a company (from NSE XBRL), in the shape corroborateStatedFullYear reads. */
const loadStoredQuarters = async (symbol) => {
  const docs = await CompanyHistoricalFact.find({
    symbol, dataOrigin: 'REAL_RESEARCH', period: /^Q[1-4] FY\d{4}$/, 'metrics.metric': { $in: [...ADDITIVE_METRICS] }, 'source.url': NSE_XBRL_URL_PREFIX,
  }).select('period metrics fact source.excerpt').lean();
  return docs.map((d) => ({
    period: d.period,
    metric: d.metrics?.metric,
    value: d.metrics?.actualValue,
    consolidated: String(d.fact || '').match(/\((Consolidated|Non-Consolidated|Standalone),/)?.[1] || null,
    tag: String(d.source?.excerpt || '').match(/XBRL tag ([A-Za-z]+)/)?.[1] || null,
  }));
};

const collectSymbol = async (symbol, {
  dryRun, fromYear, toYear = null, maxFilings, preferConsolidated, delayMs, fullYearOnly = false,
}) => {
  const nseSymbol = nseSymbolFor(symbol);
  const {
    index, feedErrors, integratedTruncated, legacyRows, integratedRows,
  } = await loadFilingIndex(nseSymbol, delayMs);
  if (feedErrors.length >= 2) {
    const message = feedErrors.join('; ');
    console.log(`  ${symbol}: filing index unavailable — ${message}`);
    return { symbol, filings: 0, facts: 0, stored: 0, quarantined: 0, error: message };
  }
  if (integratedTruncated) console.log(`  ${symbol}: integrated feed reported more rows than it returned; older periods may be missing`);

  let selected = selectFilings(index, {
    symbol: nseSymbol, fromYear, toYear, maxFilings, preferConsolidated,
  });
  // A full-year pass reads only the March-quarter filings, each of which carries the year.
  if (fullYearOnly) selected = selected.filter((filing) => /^Q4 FY/.test(toReportingPeriod(filing) || ''));

  let factCount = 0;
  let stored = 0;
  let quarantined = 0;
  let noMatchingContext = 0;
  let unavailable = 0;
  let requests = 2; // one request per feed
  let usedFallbackVersion = 0;
  const periods = new Set();

  /** Downloads one filing and returns its facts, or null when the file could not be fetched. */
  const readFiling = async (filing) => {
    let xml;
    try {
      xml = await fetchText(filing.xbrl);
    } catch (error) {
      console.log(`  ${symbol} ${toReportingPeriod(filing)}: XBRL unavailable — ${error.message}`);
      return null;
    } finally {
      requests += 1;
      await sleep(delayMs);
    }
    // Facts are stored under the supported symbol even when NSE lists the company under a renamed one.
    const extracted = extractFactsFromFiling(xml, { ...filing, symbol }, { allowStatedFullYear: true });
    return fullYearOnly ? extracted.filter((fact) => /^FY\d{4}$/.test(fact.period)) : extracted;
  };

  // Phase 1: read every selected filing (falling back to an older version when the newest carries nothing).
  const extractedFacts = [];
  for (const filing of selected) {
    // eslint-disable-next-line no-await-in-loop
    let facts = await readFiling(filing);
    if (facts === null) { unavailable += 1; }
    if (!facts?.length) {
      // The newest file may be a revision that carries no statements; try the earlier version(s) of the same period and basis.
      for (const older of olderVersionsOf(index, filing)) {
        // eslint-disable-next-line no-await-in-loop
        const olderFacts = await readFiling(older);
        if (olderFacts?.length) { facts = olderFacts; usedFallbackVersion += 1; break; }
      }
    }
    if (!facts?.length) { if (facts !== null) noMatchingContext += 1; continue; }
    factCount += facts.length;
    extractedFacts.push(...facts);
  }

  // Phase 2: a full-year figure read through a filing's STATED period is kept only if the four quarters sum to it.
  let toStore = extractedFacts;
  let withheldYears = [];
  if (extractedFacts.some((f) => f.extraction?.contextSource === STATED_OVER_DECLARED && /^FY\d{4}$/.test(f.period))) {
    const storedQuarters = dryRun ? [] : await loadStoredQuarters(symbol);
    const corroborated = corroborateStatedFullYear(extractedFacts, storedQuarters);
    toStore = corroborated.facts;
    withheldYears = corroborated.rejected;
    for (const rejection of withheldYears) console.log(`  ${symbol} ${rejection.fiscalYear} ${rejection.metric}: stated full-year figure withheld — ${rejection.reason}`);
  }

  // Phase 3: screen and store.
  for (const fact of toStore) {
    const screen = screenFact({ metric: fact.metric, value: fact.value, unit: fact.unit, title: fact.label });
    if (screen.verdict !== FACT_VERDICTS.USABLE) {
      quarantined += 1;
      console.log(`  ${symbol} ${fact.period} ${fact.metric}=${fact.value} ${fact.unit} -> ${screen.verdict} (${screen.reason})`);
      continue;
    }
    periods.add(fact.period);
    if (dryRun) { stored += 1; continue; }
    // Keyed on company + period + metric + BASIS (not the URL), restricted to facts read from NSE XBRL: a
    // restated or re-filed result for the SAME basis replaces the earlier figure in place instead of leaving
    // two, while a Consolidated and a Standalone figure for the same period are always two distinct documents
    // -- never overwriting each other (see factBasisFilter).
    // eslint-disable-next-line no-await-in-loop
    await CompanyHistoricalFact.updateOne(
      {
        symbol: fact.symbol, period: fact.period, 'metrics.metric': fact.metric, dataOrigin: 'REAL_RESEARCH', 'source.type': 'QUARTERLY_REPORT', 'source.url': NSE_XBRL_URL_PREFIX, ...factBasisFilter(fact.consolidated),
      },
      { $set: toFactDocument(fact) },
      { upsert: true },
    );
    stored += 1;
  }

  const sortedPeriods = [...periods].sort();
  const fiscalYears = [...new Set(sortedPeriods.map(fiscalYearOfPeriod).filter((y) => y != null))].sort();
  return {
    symbol, filings: selected.length, facts: factCount, stored, quarantined, unavailable, noMatchingContext, periods: sortedPeriods, fiscalYears,
    latestPeriod: selected.length ? toReportingPeriod(selected[0]) : null,
    requests,
    feeds: { legacyRows, integratedRows },
    feedErrors: feedErrors.length ? feedErrors : undefined,
    usedFallbackVersion: usedFallbackVersion || undefined,
    withheldYears: withheldYears.length ? withheldYears.map((w) => `${w.fiscalYear}: ${w.reason}`) : undefined,
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
    toYear: getFiscalWindow().toYear,
    maxFilings: arg('max-filings') ? Number(arg('max-filings')) : 24,
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
