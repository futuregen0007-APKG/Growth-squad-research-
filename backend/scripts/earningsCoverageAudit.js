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
// Kept in sync with models/ReconciliationCheck.js's OK_STATUSES by hand, not by import: this file imports no
// Mongoose models (see header) so connecting here never creates that collection/its indexes as a side effect.
const RECONCILIATION_OK_STATUSES = ['MATCH', 'SUM_MATCH'];
import { PUBLIC_SAFE_EVIDENCE_STATUSES, isPubliclyVisibleRecord, PROMISE_DOCUMENT_TYPES } from '../utils/earningsIntelligenceValidation.js';
import { describeMongoTarget, assertMongoTarget } from '../utils/mongoTarget.js';
import { getFiscalWindow } from '../utils/fiscalWindow.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The shared list (utils/earningsIntelligenceValidation.js), also used by PromiseExtractionService -- a test pins the two together.
export const PROMISE_ELIGIBLE_TYPES = [...PROMISE_DOCUMENT_TYPES];
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
  facts: {
    real: 0, financial: 0, nonReal: 0, quarantined: 0, uniqueSourceDocs: 0, exchangeSourceDocs: 0, coveredYears: [], missingYears: [], byYear: {}, fullYearFacts: [], quarterlyFacts: 0, missingQuarters: [],
  },
  promises: {
    real: 0, publicSafe: 0, curatedFile: 0, timelineDeliverable: 0, candidates: { pending: 0, accepted: 0, rejected: 0 }, outcomes: {}, acceptedOutcomes: {},
  },
  registry: { total: 0, extracted: 0, failed: 0, inFlight: 0, eligible: 0, promiseExtracted: 0, promiseFailed: 0, promisePending: 0, topErrors: [] },
  dataQuality: { unresolvedReconciliationMismatches: 0 },
  job: null,
  run: null,
});

// promiseStage values that a site visitor can actually see something for: ACCEPTED_PRESENT means the timeline API
// serves real accepted promises; EXTRACTED_NONE_FOUND means every eligible document was read and none carried
// qualifying guidance, which is itself a definite, deliverable answer. CANDIDATES_PENDING_REVIEW and NOT_RUN are
// NOT deliverable -- a visitor hitting the timeline API for either still gets dataMode RESEARCH_PENDING, whatever
// the financial-facts side shows (confirmed live for RELIANCE/HDFCBANK/HINDUNILVR: each had 5/5 financial years
// and only PENDING_REVIEW candidates, and the timeline API reported dataMode:'RESEARCH_PENDING', not curated data).
const DELIVERABLE_PROMISE_STAGES = ['ACCEPTED_PRESENT', 'EXTRACTED_NONE_FOUND'];

/**
 * classifyCoverage - pure. Takes an assembled row and returns the category
 * and the human-readable reasons. See the header for what each means.
 *
 * Four things are tracked and reported SEPARATELY, and COMPLETE requires all
 * four to be genuinely finished -- never inferred from one alone:
 *   1. financial coverage   -- years/expectedYears, from real, sourced facts
 *   2. promise extraction   -- has the stage run at all (promiseStage)
 *   3. accepted promises    -- promises a visitor can actually see (never PENDING_REVIEW)
 *   4. outcome verification -- of the accepted promises, how many have a resolved outcome
 * A company with 5/5 financial years but only PENDING_REVIEW candidates is
 * PARTIAL, not COMPLETE: its promise/outcome side is not yet deliverable.
 */
export const classifyCoverage = (row, { expectedYears }) => {
  const {
    facts, promises, registry: reg, job, profile, dataQuality,
  } = row;
  const years = facts.coveredYears.length;
  // publicSafe (ManagementPromise, served by /report) and timelineDeliverable (curated file union accepted
  // candidates, served by /timeline) are two INDEPENDENT public surfaces with their own id spaces -- summed,
  // never double-counted within either (see collectCoverageRows for how timelineDeliverable is deduped).
  const acceptedPromises = promises.publicSafe + promises.timelineDeliverable;
  const reasons = [];

  const promiseStage = acceptedPromises > 0 ? 'ACCEPTED_PRESENT'
    : promises.candidates.pending > 0 ? 'CANDIDATES_PENDING_REVIEW'
      : (reg.eligible > 0 && reg.promisePending === 0 && reg.promiseFailed === 0) ? 'EXTRACTED_NONE_FOUND'
        : 'NOT_RUN';
  const promiseDeliverable = DELIVERABLE_PROMISE_STAGES.includes(promiseStage);

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
  if (promiseStage === 'CANDIDATES_PENDING_REVIEW') reasons.push(`${promises.candidates.pending} promise candidate(s) await human review (npm run earnings:review) -- the timeline API still reports RESEARCH_PENDING until then`);
  if (promiseStage === 'ACCEPTED_PRESENT') {
    const acceptedOutcomes = promises.acceptedOutcomes || {};
    const unresolved = (acceptedOutcomes.PENDING || 0) + (acceptedOutcomes.INSUFFICIENT_EVIDENCE || 0) + (acceptedOutcomes.UNKNOWN || 0);
    if (unresolved > 0) reasons.push(`${unresolved} of ${acceptedPromises} accepted promise(s) have no resolved outcome yet`);
  }
  if (reg.inFlight > 0) reasons.push(`${reg.inFlight} registry document(s) still FETCHED/PENDING`);
  if (reg.failed > 0) reasons.push(`${reg.failed} registry document(s) FAILED`);
  if (job && ACTIVE_JOB_STATUSES.includes(job.status)) reasons.push(`Job still ${job.status}`);
  // Visible, never silently dropped: a mismatch between two independent readings of the same figures (source
  // filing vs. stored value, or quarters vs. declared full year) that has NOT been proven wrong on either side
  // (see models/ReconciliationCheck.js) -- reported here for transparency, the same as quarantinedFacts, but it
  // never by itself keeps a company from COMPLETE: the underlying values are each individually source-correct.
  if (dataQuality?.unresolvedReconciliationMismatches > 0) reasons.push(`${dataQuality.unresolvedReconciliationMismatches} unresolved reconciliation mismatch(es) (npm run earnings:verify-xbrl) -- values are individually source-verified, not silently treated as reconciled`);

  const financialComplete = years === expectedYears && facts.exchangeSourceDocs >= 1;
  const settled = reg.inFlight === 0 && !(job && ACTIVE_JOB_STATUSES.includes(job.status));
  if (financialComplete && promiseDeliverable && settled) {
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

/**
 * readCuratedPromiseIds - the curated JSON file (data/earnings-intelligence/
 * promises/<SYMBOL>.json) for each symbol, as the set of record ids that are
 * actually PUBLICLY VISIBLE -- the same isPubliclyVisibleRecord gate the real
 * timeline API applies (CuratedEarningsIntelligenceService.fetchMergedRecords).
 * A record whose evidenceIntegrity.status is QUARANTINED (a real, recorded
 * source-fetch failure -- see utils/earningsIntelligenceValidation.js) is kept
 * in the file for audit history but never served publicly, so counting it as
 * an "accepted promise" here would overstate coverage the same way the old,
 * looser dataMode!=='DEMO_SYNTHETIC' filter did (confirmed live: TCS.json
 * carries 3 records, one QUARANTINED after a tcs.com 403 on re-fetch, so only
 * 2 are ever actually delivered -- exactly what the real timeline reports).
 */
export const readCuratedPromiseIds = () => {
  const dir = path.join(BACKEND_DIR, 'data', 'earnings-intelligence', 'promises');
  const idsBySymbol = {};
  if (!fs.existsSync(dir)) return idsBySymbol;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const records = Array.isArray(parsed) ? parsed : (parsed.records || []);
      idsBySymbol[path.basename(file, '.json').toUpperCase()] = new Set(
        records.filter((r) => r.dataMode !== 'DEMO_SYNTHETIC' && isPubliclyVisibleRecord(r)).map((r) => r.id),
      );
    } catch { /* an unreadable curated file simply contributes nothing */ }
  }
  return idsBySymbol;
};

/** Reads everything needed with raw collection queries (read-only) and returns one row per symbol. */
export const collectCoverageRows = async (db, { symbols = null, now = new Date() } = {}) => {
  const window = getFiscalWindow(now);
  const universe = symbols?.length ? symbols : Object.keys(SUPPORTED_STOCKS);
  const col = (name) => db.collection(name);

  const [realFacts, nonRealAgg, promiseDocs, candidateAgg, acceptedCandidateDocs, registryDocs, jobs, runs, profiles, reconciliationChecks] = await Promise.all([
    col('companyhistoricalfacts').find({ dataOrigin: 'REAL_RESEARCH' }, { projection: { symbol: 1, period: 1, 'metrics.metric': 1, 'metrics.actualValue': 1, 'source.url': 1, quarantine: 1 } }).toArray(),
    col('companyhistoricalfacts').aggregate([{ $match: { dataOrigin: { $ne: 'REAL_RESEARCH' } } }, { $group: { _id: '$symbol', n: { $sum: 1 } } }]).toArray(),
    col('managementpromises').find({ dataOrigin: 'REAL_RESEARCH' }, { projection: { symbol: 1, 'evidenceIntegrity.status': 1, 'evidence.promiseSource.sourceUrl': 1, curatedRecordId: 1 } }).toArray(),
    col('promisecandidates').aggregate([{ $group: { _id: { symbol: '$symbol', status: '$reviewStatus', outcome: '$outcome.status' }, n: { $sum: 1 } } }]).toArray(),
    // Full id list (not just a count) for ACCEPTED candidates only -- needed to de-duplicate against the
    // curated JSON file below: acceptCandidate (scripts/earningsReview.js) writes a promoted candidate into
    // BOTH PromiseCandidate (reviewStatus: ACCEPTED) and promises/<SYMBOL>.json under the SAME id, so the two
    // stores hold the same promise, not two different ones, once promotion has happened.
    col('promisecandidates').find({ reviewStatus: 'ACCEPTED' }, { projection: { symbol: 1, id: 1 } }).toArray(),
    col('companydocumentregistries').find({}, { projection: { symbol: 1, sourceType: 1, extractionStatus: 1, promiseExtractionStatus: 1, error: 1 } }).toArray(),
    col('researchjobs').find({}).toArray(),
    col('researchruns').find({ dataOrigin: 'REAL_RESEARCH' }).toArray(),
    col('companyresearchprofiles').find({}).toArray(),
    col('reconciliation_checks').find({}, { projection: { symbol: 1, status: 1 } }).toArray(),
  ]);

  const curatedIds = readCuratedPromiseIds();
  const acceptedIdsBySymbol = new Map();
  for (const doc of acceptedCandidateDocs) {
    const symbol = String(doc.symbol || '').toUpperCase();
    if (!acceptedIdsBySymbol.has(symbol)) acceptedIdsBySymbol.set(symbol, new Set());
    acceptedIdsBySymbol.get(symbol).add(doc.id);
  }
  // A ManagementPromise document imported from the curated file (npm run earnings:import) carries the JSON
  // record's own id in `curatedRecordId` -- an explicit, schema-designed link, not a coincidence. Confirmed
  // live for TCS: both its publicSafe ManagementPromise records set curatedRecordId to TCS-FY2025-001 and
  // TCS-FY2026-002, the SAME two curated-file records -- identical statement, target period and source URL.
  // Without excluding these, timelineDeliverable's union would count the SAME promise a second time under the
  // curated file's id, alongside publicSafe already counting it under the ManagementPromise id.
  const linkedCuratedIdsBySymbol = new Map();
  for (const promise of promiseDocs) {
    if (!promise.curatedRecordId || !PUBLIC_SAFE_EVIDENCE_STATUSES.includes(promise.evidenceIntegrity?.status)) continue;
    const symbol = String(promise.symbol || '').toUpperCase();
    if (!linkedCuratedIdsBySymbol.has(symbol)) linkedCuratedIdsBySymbol.set(symbol, new Set());
    linkedCuratedIdsBySymbol.get(symbol).add(promise.curatedRecordId);
  }
  const rows = new Map(universe.map((s) => [s, emptyRow(s)]));
  const rowFor = (symbol) => rows.get(String(symbol || '').toUpperCase());

  // Unresolved reconciliation differences (scripts/verifyNseXbrlFacts.js): each check's LATEST verdict is
  // persisted, so a check that used to mismatch and has since been confirmed correct is no longer counted here.
  for (const check of reconciliationChecks) {
    if (RECONCILIATION_OK_STATUSES.includes(check.status)) continue;
    const row = rowFor(check.symbol);
    if (row) row.dataQuality.unresolvedReconciliationMismatches += 1;
  }

  const urlSets = new Map();
  const yearSets = new Map();
  const quarterSets = new Map(); // symbol -> Set of "2026Q3"
  const fullYearSets = new Map(); // symbol -> Set of 2026 (a fact labelled FY2026 itself)
  for (const fact of realFacts) {
    const row = rowFor(fact.symbol);
    if (!row) continue;
    row.facts.real += 1;
    const url = fact.source?.url;
    // A quarantined fact was read correctly from its source, but the value itself is implausible/internally
    // inconsistent with the company's own adjacent filings (see models/CompanyHistoricalFact.js `quarantine`
    // field) -- it counts toward "real facts on file" for transparency but never toward covered years/quarters,
    // the same way the report/timeline routes exclude it from what a visitor sees (NOT_QUARANTINED_FILTER in
    // ManagementPromiseService.js).
    if (fact.quarantine?.quarantined) { row.facts.quarantined = (row.facts.quarantined || 0) + 1; continue; }
    const validFinancial = EARNINGS_COVERAGE_METRICS.includes(fact.metrics?.metric) && fact.metrics?.actualValue != null && isHttpUrl(url);
    if (validFinancial) {
      row.facts.financial += 1;
      const year = fiscalYearOf(fact.period);
      if (year != null && year >= window.fromYear && year <= window.toYear) {
        if (!yearSets.has(row.symbol)) yearSets.set(row.symbol, new Set());
        yearSets.get(row.symbol).add(year);
        row.facts.byYear[year] = (row.facts.byYear[year] || 0) + 1;
        const quarter = String(fact.period).match(/^Q([1-4]) FY(\d{4})$/);
        if (quarter) {
          if (!quarterSets.has(row.symbol)) quarterSets.set(row.symbol, new Set());
          quarterSets.get(row.symbol).add(`${quarter[2]}Q${quarter[1]}`);
        } else if (/^FY\d{4}$/.test(String(fact.period))) {
          if (!fullYearSets.has(row.symbol)) fullYearSets.set(row.symbol, new Set());
          fullYearSets.get(row.symbol).add(year);
        }
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
  for (const [symbol, ids] of Object.entries(curatedIds)) { const row = rowFor(symbol); if (row) row.promises.curatedFile = ids.size; }
  for (const item of candidateAgg) {
    const row = rowFor(item._id.symbol);
    if (!row) continue;
    const key = { PENDING_REVIEW: 'pending', ACCEPTED: 'accepted', REJECTED: 'rejected' }[item._id.status];
    if (key) row.promises.candidates[key] += item.n;
    const outcome = item._id.outcome || 'UNKNOWN';
    row.promises.outcomes[outcome] = (row.promises.outcomes[outcome] || 0) + item.n;
    // Only an ACCEPTED candidate is ever shown to a visitor (PENDING_REVIEW never reaches the timeline API), so
    // outcome verification is reported for this subset specifically -- never blended with unreviewed candidates.
    if (item._id.status === 'ACCEPTED') row.promises.acceptedOutcomes[outcome] = (row.promises.acceptedOutcomes[outcome] || 0) + item.n;
  }
  // Deliverable promises visible via the /timeline route: the curated file's publicly-visible ids UNION the
  // accepted candidates' ids, MINUS any id already linked to and counted by a publicSafe ManagementPromise
  // record (see linkedCuratedIdsBySymbol above) -- a union, not a sum, because acceptCandidate gives a promoted
  // candidate the SAME id in both stores, and earnings:import gives an imported ManagementPromise record the
  // curated file's own id. Both are the same promise counted twice under a different id, not two promises.
  for (const row of rows.values()) {
    const linked = linkedCuratedIdsBySymbol.get(row.symbol) || new Set();
    const ids = new Set([...(curatedIds[row.symbol] || []), ...(acceptedIdsBySymbol.get(row.symbol) || [])].filter((id) => !linked.has(id)));
    row.promises.timelineDeliverable = ids.size;
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
    if (row) row.job = { status: job.status, attempt: job.attempt, lastError: job.lastError || null, processedDocuments: job.processedDocuments, fromYear: job.fromYear, toYear: job.toYear, updatedAt: job.updatedAt, lastAttemptAt: job.lastAttemptAt || null };
  }
  for (const run of latestBy(runs, (r) => r.companySymbol).values()) {
    const row = rowFor(run.companySymbol);
    if (row) row.run = { status: run.status, state: run.state || null, error: run.error || null, updatedAt: run.updatedAt };
  }
  for (const profile of profiles) {
    const row = rowFor(profile.symbol);
    if (row) {
      row.profile = {
        present: true,
        researchEnabled: profile.researchEnabled,
        bseScripCode: profile.bseScripCode || null,
        marketCapCr: profile.marketCapCr ?? null,
        lastGuidanceDiscoveryAt: profile.lastGuidanceDiscoveryAt || null,
        lastGuidanceDiscoveryResult: profile.lastGuidanceDiscoveryResult || null,
      };
    }
  }

  for (const row of rows.values()) {
    const years = [...(yearSets.get(row.symbol) || [])].sort();
    row.facts.coveredYears = years;
    row.facts.missingYears = Array.from({ length: window.expectedYears }, (_, i) => window.fromYear + i).filter((y) => !years.includes(y));
    // Quarter-level detail. Only meaningful for a company that has quarterly facts at all (exchange XBRL); a
    // company known only from fiscal-year documents would otherwise list every quarter as missing.
    const quarters = quarterSets.get(row.symbol) || new Set();
    row.facts.quarterlyFacts = quarters.size;
    row.facts.fullYearFacts = [...(fullYearSets.get(row.symbol) || [])].sort();
    row.facts.missingQuarters = quarters.size
      ? Array.from({ length: window.expectedYears }, (_, i) => window.fromYear + i)
        .flatMap((y) => [1, 2, 3, 4].filter((q) => !quarters.has(`${y}Q${q}`)).map((q) => `FY${y} Q${q}`))
      : [];
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
    quarantinedFacts: sum((r) => r.facts.quarantined || 0),
    unresolvedReconciliationMismatches: sum((r) => r.dataQuality?.unresolvedReconciliationMismatches || 0),
    uniqueSourceDocs: sum((r) => r.facts.uniqueSourceDocs),
    acceptedPromises: sum((r) => r.promises.publicSafe + r.promises.timelineDeliverable),
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
    `| Quarantined facts excluded (implausible value, source verified) | ${summary.quarantinedFacts} |`,
    `| Unresolved reconciliation mismatches (npm run earnings:verify-xbrl) | ${summary.unresolvedReconciliationMismatches} |`,
    `| Unique source documents | ${summary.uniqueSourceDocs} |`, `| Accepted promises | ${summary.acceptedPromises} |`, `| Pending-review candidates | ${summary.pendingCandidates} |`,
    `| Registry documents | ${summary.registryDocs} |`, '', '## Per symbol', '',
    '| Symbol | Category | FY covered | Real facts | Src docs (exchange) | Promises acc/pend | Registry ok/fail | Job | Reason |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.symbol} | ${r.category} | ${yearsCell(r, window)} | ${r.facts.real} | ${r.facts.uniqueSourceDocs} (${r.facts.exchangeSourceDocs}) | ${r.promises.publicSafe + r.promises.timelineDeliverable}/${r.promises.candidates.pending} | ${r.registry.extracted}/${r.registry.failed} | ${r.job?.status || '-'} | ${r.reasons.join('; ').replace(/\|/g, '/')} |`);
  }
  const incomplete = rows.filter((r) => r.category !== 'COMPLETE');
  if (incomplete.length) {
    lines.push('', '## Exact gaps of incomplete companies', '',
      '| Symbol | Category | Missing fiscal years | Missing quarters | Full-year facts | Promise stage | Docs pending/failed | Candidates (outcomes) |', '|---|---|---|---|---|---|---|---|');
    for (const r of incomplete) {
      const missingQuarters = r.facts.missingQuarters || [];
      const quarterCell = !r.facts.quarterlyFacts ? 'no quarterly facts' : missingQuarters.length ? `${missingQuarters.length}: ${missingQuarters.slice(0, 6).join(', ')}${missingQuarters.length > 6 ? ', ...' : ''}` : 'none';
      const outcomes = Object.entries(r.promises.outcomes || {}).map(([k, v]) => `${k} ${v}`).join(', ');
      lines.push(`| ${r.symbol} | ${r.category} | ${r.facts.missingYears.map((y) => `FY${y}`).join(', ') || 'none'} | ${quarterCell} | ${(r.facts.fullYearFacts || []).map((y) => `FY${y}`).join(', ') || 'none'} | ${r.promiseStage} | ${r.registry.promisePending}/${r.registry.promiseFailed} | ${r.promises.candidates.pending + r.promises.candidates.accepted + r.promises.candidates.rejected}${outcomes ? ` (${outcomes})` : ''} |`);
    }
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
    console.log(`Real facts ${summary.realFacts} (financial-valid ${summary.financialFacts}) | non-real excluded ${summary.nonRealFactsExcluded} | quarantined ${summary.quarantinedFacts} | unresolved reconciliation mismatches ${summary.unresolvedReconciliationMismatches} | source docs ${summary.uniqueSourceDocs} | accepted promises ${summary.acceptedPromises} | pending candidates ${summary.pendingCandidates} | registry docs ${summary.registryDocs}`);
    const shown = rows.filter((r) => r.category !== 'PENDING' || args.symbols);
    if (shown.length) {
      console.log(`\n${pad('SYMBOL', 12)}${pad('CATEGORY', 10)}${pad('FY', 6)}${pad('FACTS', 7)}${pad('DOCS', 6)}${pad('PROM a/p', 10)}REASON`);
      for (const r of shown) {
        console.log(`${pad(r.symbol, 12)}${pad(r.category, 10)}${pad(yearsCell(r, window), 6)}${pad(r.facts.real, 7)}${pad(r.facts.uniqueSourceDocs, 6)}${pad(`${r.promises.publicSafe + r.promises.timelineDeliverable}/${r.promises.candidates.pending}`, 10)}${r.reasons.join('; ').slice(0, 110)}`);
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
