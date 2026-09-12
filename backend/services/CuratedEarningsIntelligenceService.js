/**
 * CuratedEarningsIntelligenceService.js
 * ======================================
 * Serves the curated (file-based) Earnings Intelligence dataset:
 * backend/data/earnings-intelligence/{companies.json, promises/*.json, demo/*.json}.
 *
 * Design notes
 * ------------
 * - SUPPORTED_STOCKS (utils/constants.js) is the ONE authoritative stock list.
 *   companies.json holds sparse *overrides* for symbols with curated research;
 *   every other supported symbol is synthesized here as RESEARCH_PENDING. This
 *   is deliberate: maintaining a second, hand-written list of ~150 boilerplate
 *   RESEARCH_PENDING rows would drift from SUPPORTED_STOCKS over time.
 * - Everything is loaded once and cached in memory; `reloadCuratedDataset()`
 *   gives dev/admin tooling (and tests) a safe way to force a re-read.
 * - A malformed or invalid JSON file/record is logged and skipped -- it can
 *   never crash the service or silently degrade another company's data.
 * - DEMO_SYNTHETIC records live only under data/earnings-intelligence/demo/,
 *   are keyed to their own pseudo-symbols, and are only ever returned when
 *   EARNINGS_DEMO_MODE=true AND the caller explicitly asks for demo mode.
 *   Verified and synthetic records are never merged into the same score.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import PromiseCandidate from '../models/PromiseCandidate.js';
import {
  validateManagementPromiseRecord,
  validateCuratedCompanyRecord,
  findDuplicatePromiseIds,
  RESOLVED_STATUSES,
} from '../utils/earningsIntelligenceValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(__dirname, '..', 'data', 'earnings-intelligence');
const COMPANIES_FILE = path.join(DATA_ROOT, 'companies.json');
const PROMISES_DIR = path.join(DATA_ROOT, 'promises');
const DEMO_DIR = path.join(DATA_ROOT, 'demo');

export const DISCLAIMER = 'Curated research based on public company disclosures. Historical management execution is not investment advice.';

export const isDemoModeEnabled = () => String(process.env.EARNINGS_DEMO_MODE || '').toLowerCase() === 'true';

const deepClone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

export const normalizeCuratedSymbol = (symbol) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  return normalized || null;
};

const readJsonSafe = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { data: null, missing: true };
    const raw = fs.readFileSync(filePath, 'utf8');
    return { data: JSON.parse(raw), missing: false };
  } catch (err) {
    // Never expose file contents/paths beyond the basename in logs.
    logger.warn(`[CuratedEarningsIntelligence] Failed to read/parse ${path.basename(filePath)}: ${err.message}`);
    return { data: null, missing: false, error: err.message };
  }
};

const defaultCoverageRecord = (symbol) => {
  const supported = SUPPORTED_STOCKS[symbol] || {};
  return {
    symbol,
    companyName: supported.name || symbol,
    sector: supported.sector || 'Unknown',
    dataMode: 'RESEARCH_PENDING',
    coverageStatus: 'RESEARCH_PENDING',
    coverageStart: null,
    coverageEnd: null,
    lastVerifiedAt: null,
    nextReviewAfter: null,
    verifiedPromiseCount: 0,
    resolvedPromiseCount: 0,
    pendingPromiseCount: 0,
    notes: null,
  };
};

/** Loads promises/<symbol>.json or demo/<symbol>.json, validating every record. Never throws. */
const loadPromiseFile = (dir, symbol, { allowDemo }) => {
  const filePath = path.join(dir, `${symbol}.json`);
  const { data, missing, error } = readJsonSafe(filePath);
  const issues = [];
  if (missing || !data) {
    if (error) issues.push({ symbol, file: `${symbol}.json`, error });
    return { records: [], issues, company: null };
  }

  const company = allowDemo && data._meta?.company ? { ...data._meta.company, symbol } : null;
  const rawRecords = Array.isArray(data.records) ? data.records : [];
  const validRecords = [];
  for (const record of rawRecords) {
    const { valid, errors, warnings } = validateManagementPromiseRecord(record, { symbol, allowDemo });
    for (const warning of warnings) {
      logger.debug(`[CuratedEarningsIntelligence] ${symbol}: ${warning}`);
    }
    if (!valid) {
      issues.push({ symbol, recordId: record?.id || 'UNKNOWN', errors });
      logger.warn(`[CuratedEarningsIntelligence] Rejected invalid promise record ${record?.id || '(no id)'} for ${symbol}: ${errors.join('; ')}`);
      continue;
    }
    if (allowDemo && record.dataMode !== 'DEMO_SYNTHETIC') {
      issues.push({ symbol, recordId: record.id, errors: ['demo dataset must only contain DEMO_SYNTHETIC records'] });
      continue;
    }
    if (!allowDemo && record.dataMode !== 'CURATED_VERIFIED') {
      issues.push({ symbol, recordId: record.id, errors: ['verified promise file must only contain CURATED_VERIFIED records'] });
      continue;
    }
    validRecords.push(record);
  }

  return { records: validRecords, issues, company };
};

const buildCache = () => {
  const issues = [];
  const companiesBySymbol = new Map();
  const promisesBySymbol = new Map();
  const demoBySymbol = new Map();
  const demoCompaniesBySymbol = new Map();

  // 1. Start every SUPPORTED_STOCKS symbol as RESEARCH_PENDING (the safe default).
  for (const symbol of Object.keys(SUPPORTED_STOCKS)) {
    companiesBySymbol.set(symbol, defaultCoverageRecord(symbol));
  }

  // 2. Apply curated overrides from companies.json, validating each one.
  const { data: companiesFile } = readJsonSafe(COMPANIES_FILE);
  const overrides = Array.isArray(companiesFile?.companies) ? companiesFile.companies : [];
  for (const override of overrides) {
    const symbol = normalizeCuratedSymbol(override?.symbol);
    if (!symbol) continue;
    if (!SUPPORTED_STOCKS[symbol]) {
      issues.push({ symbol, error: 'companies.json overrides a symbol that is not in SUPPORTED_STOCKS -- ignored' });
      logger.warn(`[CuratedEarningsIntelligence] companies.json references unsupported symbol "${symbol}" -- ignored`);
      continue;
    }
    const { valid, errors } = validateCuratedCompanyRecord(override);
    if (!valid) {
      issues.push({ symbol, errors });
      logger.warn(`[CuratedEarningsIntelligence] Rejected invalid companies.json entry for ${symbol}: ${errors.join('; ')}`);
      continue;
    }
    companiesBySymbol.set(symbol, { ...override });
  }

  // 3. Load verified promise records for every symbol that has curated overrides.
  const allLoadedRecords = [];
  for (const symbol of companiesBySymbol.keys()) {
    const { records, issues: fileIssues } = loadPromiseFile(PROMISES_DIR, symbol, { allowDemo: false });
    issues.push(...fileIssues);
    if (records.length) {
      promisesBySymbol.set(symbol, records);
      allLoadedRecords.push(...records);
    }
  }

  // 4. Load demo/synthetic records (never merged with verified ones) for any pseudo-symbol present.
  if (fs.existsSync(DEMO_DIR)) {
    for (const fileName of fs.readdirSync(DEMO_DIR)) {
      if (!fileName.endsWith('.json')) continue;
      const symbol = normalizeCuratedSymbol(fileName.replace(/\.json$/i, ''));
      const { records, issues: fileIssues, company } = loadPromiseFile(DEMO_DIR, symbol, { allowDemo: true });
      issues.push(...fileIssues);
      if (records.length) demoBySymbol.set(symbol, records);
      if (company) demoCompaniesBySymbol.set(symbol, company);
    }
  }

  // 5. Dataset-wide duplicate id detection across every verified file.
  const duplicates = findDuplicatePromiseIds(allLoadedRecords);
  for (const dup of duplicates) {
    issues.push({ symbol: dup.symbols.join(','), error: `duplicate promise id "${dup.id}"` });
    logger.warn(`[CuratedEarningsIntelligence] Duplicate promise id detected: ${dup.id}`);
  }

  return { companiesBySymbol, promisesBySymbol, demoBySymbol, demoCompaniesBySymbol, issues, loadedAt: new Date().toISOString() };
};

let cache = null;
const ensureCache = () => {
  if (!cache) cache = buildCache();
  return cache;
};

/** Forces a fresh read of every curated data file. Safe to call any time (dev/admin/tests). */
export const reloadCuratedDataset = () => {
  cache = buildCache();
  return {
    companies: cache.companiesBySymbol.size,
    verifiedCompanies: Array.from(cache.promisesBySymbol.keys()).length,
    demoCompanies: Array.from(cache.demoBySymbol.keys()).length,
    issues: cache.issues,
    loadedAt: cache.loadedAt,
  };
};

export const listSupportedCompanies = () => {
  const { companiesBySymbol } = ensureCache();
  return Array.from(companiesBySymbol.keys()).sort();
};

const isDbConnected = () => mongoose.connection?.readyState === 1;

/**
 * fetchAcceptedCandidates - live MongoDB query for a symbol's ACCEPTED
 * PromiseCandidate documents, mapped into the exact same "record" shape as a
 * promises/<SYMBOL>.json entry (id, symbol, dataMode, promise, outcome,
 * promiseEvidence, outcomeEvidence, verification), plus reviewedBy/reviewedAt
 * for provenance. Never throws (DB unavailable / query failure both resolve
 * to an empty array, so a Mongo outage degrades to "JSON-only", never a crash).
 * PENDING_REVIEW and REJECTED candidates are never returned here -- this is
 * the one place that decides what "accepted" means for public visibility.
 */
const fetchAcceptedCandidates = async (symbol) => {
  if (!isDbConnected()) return [];
  try {
    const docs = await PromiseCandidate.find({ symbol, reviewStatus: 'ACCEPTED' }).lean();
    return docs.map((doc) => ({
      id: doc.id,
      symbol: doc.symbol,
      dataMode: doc.dataMode,
      promise: doc.promise,
      outcome: doc.outcome,
      promiseEvidence: doc.promiseEvidence,
      outcomeEvidence: doc.outcomeEvidence || null,
      verification: doc.verification,
      reviewedBy: doc.reviewedBy || null,
      reviewedAt: doc.reviewedAt ? new Date(doc.reviewedAt).toISOString() : null,
    }));
  } catch (err) {
    logger.warn(`[CuratedEarningsIntelligence] Failed to load accepted candidates for ${symbol}: ${err.message}`);
    return [];
  }
};

/**
 * Merges git-committed JSON records with live-accepted Mongo candidates for one symbol.
 * On an id collision (the normal case once a candidate is accepted: `acceptCandidate`
 * promotes it into promises/<SYMBOL>.json), the JSON record's promise/outcome/evidence
 * content wins since it is the durable, potentially hand-edited source of truth -- but
 * `reviewedBy`/`reviewedAt` are carried over from the Mongo record, because
 * `toPromotedRecord` deliberately strips those fields before writing to JSON and Mongo
 * is their only home.
 */
const fetchMergedRecords = async (normalized, { mode } = {}) => {
  const { promisesBySymbol, demoBySymbol } = ensureCache();

  if (mode === 'DEMO') {
    if (!isDemoModeEnabled()) return [];
    return (demoBySymbol.get(normalized) || []).map(deepClone);
  }

  const jsonRecords = (promisesBySymbol.get(normalized) || []).map(deepClone);
  const acceptedCandidates = await fetchAcceptedCandidates(normalized);

  const byId = new Map();
  for (const record of acceptedCandidates) byId.set(record.id, record);
  for (const record of jsonRecords) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing
      ? { ...record, reviewedBy: record.reviewedBy ?? existing.reviewedBy ?? null, reviewedAt: record.reviewedAt ?? existing.reviewedAt ?? null }
      : record);
  }
  return Array.from(byId.values());
};

const applyPromiseFilters = (records, filters = {}) => {
  let results = records;

  if (filters.year) {
    const year = String(filters.year);
    results = results.filter((r) => String(r.promise?.targetPeriod || '').includes(year));
  }
  if (filters.category) {
    const category = String(filters.category).toUpperCase();
    results = results.filter((r) => r.promise?.category === category);
  }
  if (filters.status) {
    const status = String(filters.status).toUpperCase();
    results = results.filter((r) => r.outcome?.status === status);
  }

  return [...results].sort((a, b) => new Date(a.promise?.promiseDate || 0) - new Date(b.promise?.promiseDate || 0));
};

/** Recomputes a coverage record's dataMode/coverageStatus/counts live from the actual merged record set, so an accepted-in-Mongo-but-not-yet-committed-to-git promise still reports correctly. */
const buildLiveCoverage = (staticRecord, merged) => {
  if (!merged.length) return deepClone(staticRecord);
  const resolved = merged.filter((r) => RESOLVED_STATUSES.includes(r.outcome?.status));
  const pending = merged.filter((r) => r.outcome?.status === 'PENDING');
  return {
    ...deepClone(staticRecord),
    dataMode: 'CURATED_VERIFIED',
    coverageStatus: staticRecord.coverageStatus === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL',
    verifiedPromiseCount: merged.length,
    resolvedPromiseCount: resolved.length,
    pendingPromiseCount: pending.length,
  };
};

/**
 * getCompanyCoverage - ASYNC (queries Mongo for accepted candidates so the
 * returned dataMode/counts are always live, even for a symbol with zero
 * companies.json override, e.g. one whose first-ever accepted candidate
 * hasn't been committed to git yet).
 */
export const getCompanyCoverage = async (symbol, filters = {}) => {
  const normalized = normalizeCuratedSymbol(symbol);
  if (!normalized) return null;
  const { companiesBySymbol, demoCompaniesBySymbol } = ensureCache();

  if (filters.mode === 'DEMO') {
    if (!isDemoModeEnabled()) return null; // disabled by default, no exceptions
    const demoRecord = demoCompaniesBySymbol.get(normalized);
    return demoRecord ? deepClone(demoRecord) : null;
  }

  const staticRecord = companiesBySymbol.get(normalized);
  if (!staticRecord) return null; // not a supported stock at all

  const merged = await fetchMergedRecords(normalized);
  return buildLiveCoverage(staticRecord, merged);
};

/** getCompanyPromises - ASYNC; see fetchMergedRecords for why. */
export const getCompanyPromises = async (symbol, filters = {}) => {
  const normalized = normalizeCuratedSymbol(symbol);
  if (!normalized) return [];
  const merged = await fetchMergedRecords(normalized, { mode: filters.mode });
  return applyPromiseFilters(merged, filters);
};

const STATUS_VALUE = { ACHIEVED: 1, PARTIAL: 0.5, MISSED: 0 };
const MIN_RESOLVED_FOR_SCORE = 3;

export const faithScoreLabel = (score) => {
  if (score == null) return 'Insufficient verified history';
  if (score >= 80) return 'Strong execution history';
  if (score >= 60) return 'Generally reliable';
  if (score >= 40) return 'Mixed execution history';
  return 'Weak execution history';
};

/**
 * Deterministic Faith Score. Never asks an LLM for the number.
 * statusValue: ACHIEVED=1.0, PARTIAL=0.5, MISSED=0.0; PENDING/INSUFFICIENT_EVIDENCE excluded.
 * weightedResult = statusValue * evidenceConfidence
 * faithScore = round(sum(weightedResult) / sum(evidenceConfidence) * 100)
 * Requires >= 3 resolved, verified promises; otherwise returns null (never 0).
 */
export const calculateFaithScore = (records = []) => {
  const eligible = records.filter((r) => RESOLVED_STATUSES.includes(r.outcome?.status));

  if (eligible.length < MIN_RESOLVED_FOR_SCORE) {
    return { faithScore: null, faithScoreLabel: faithScoreLabel(null), resolvedCount: eligible.length, breakdown: [] };
  }

  let weightedSum = 0;
  let confidenceSum = 0;
  const breakdown = eligible.map((r) => {
    const statusValue = STATUS_VALUE[r.outcome.status] ?? 0;
    const evidenceConfidence = typeof r.verification?.evidenceConfidence === 'number' ? r.verification.evidenceConfidence : 0;
    const weightedResult = statusValue * evidenceConfidence;
    weightedSum += weightedResult;
    confidenceSum += evidenceConfidence;
    return { id: r.id, period: r.promise?.targetPeriod || null, status: r.outcome.status, statusValue, evidenceConfidence, weightedResult };
  });

  const faithScore = confidenceSum > 0 ? Math.round((weightedSum / confidenceSum) * 100) : null;
  return { faithScore, faithScoreLabel: faithScoreLabel(faithScore), resolvedCount: eligible.length, breakdown };
};

const EXPECTED_QUARTERS_WINDOW = 20; // 5-year window x 4 quarters -- same convention used across the app's coverage fields

/** A record's targetPeriod into the set of quarter-keys it verifies -- a full-FY period ("FY2025") verifies all 4 quarters of that year; a quarter-specific period ("Q1 FY2025") verifies just that one. */
const targetPeriodToQuarterKeys = (targetPeriod) => {
  const period = String(targetPeriod || '').trim();
  const quarterMatch = period.match(/^Q(\d)\s*FY\s*(\d{4})$/i);
  if (quarterMatch) return [`FY${quarterMatch[2]}Q${quarterMatch[1]}`];
  const yearMatch = period.match(/^FY\s*(\d{4})$/i);
  if (yearMatch) return [1, 2, 3, 4].map((q) => `FY${yearMatch[1]}Q${q}`);
  return [];
};

/**
 * Faith Score coverage status + quarter-level detail (rule: distinct from
 * financial-facts coverage -- this counts resolved PROMISES, never
 * CompanyHistoricalFact records). `researchFailed` is an optional signal
 * from the legacy ResearchRun-backed system (ManagementPromiseService),
 * which this curated-data-only function has no direct visibility into.
 */
export const computeFaithScoreCoverage = (records = [], { coverageStatus, researchFailed = false, dataAsOf = null } = {}) => {
  const resolved = records.filter((r) => RESOLVED_STATUSES.includes(r.outcome?.status));
  const quarterSet = new Set();
  for (const r of resolved) for (const key of targetPeriodToQuarterKeys(r.promise?.targetPeriod)) quarterSet.add(key);
  const completedQuarters = Math.min(quarterSet.size, EXPECTED_QUARTERS_WINDOW);

  const counts = { achieved: 0, partial: 0, missed: 0, pending: 0 };
  for (const r of records) {
    const status = r.outcome?.status;
    if (status === 'ACHIEVED') counts.achieved += 1;
    else if (status === 'PARTIAL') counts.partial += 1;
    else if (status === 'MISSED') counts.missed += 1;
    else if (status === 'PENDING') counts.pending += 1;
  }

  let scoreStatus;
  if (researchFailed) scoreStatus = 'RESEARCH_FAILED';
  else if (coverageStatus === 'RESEARCH_PENDING') scoreStatus = 'RESEARCH_PENDING';
  else if (!records.length) scoreStatus = 'NO_OFFICIAL_TRANSCRIPT';
  else if (resolved.length < MIN_RESOLVED_FOR_SCORE) scoreStatus = 'INSUFFICIENT_EVIDENCE';
  else if (resolved.length >= 10 && completedQuarters >= 8) scoreStatus = 'VERIFIED';
  else scoreStatus = 'PROVISIONAL';

  const confidence = resolved.length >= 10 && completedQuarters >= 8 ? 'HIGH' : resolved.length >= MIN_RESOLVED_FOR_SCORE ? 'MEDIUM' : 'LOW';

  const sortedQuarterKeys = [...quarterSet].sort();
  const missingQuarters = EXPECTED_QUARTERS_WINDOW - completedQuarters;

  return {
    scoreStatus,
    confidence,
    expectedQuarters: EXPECTED_QUARTERS_WINDOW,
    completedQuarters,
    promisesTotal: records.length,
    promisesResolved: resolved.length,
    achieved: counts.achieved,
    partial: counts.partial,
    missed: counts.missed,
    pending: counts.pending,
    missingQuarters,
    coveredQuarterLabels: sortedQuarterKeys,
    dataAsOf: dataAsOf || new Date().toISOString(),
  };
};

/**
 * Evidence Confidence: the mean `verification.evidenceConfidence` across the
 * same resolved-promise population used by the Faith Score, expressed 0-100.
 * Returns null when there is no resolved evidence to average at all (never 0).
 */
export const calculateEvidenceConfidence = (records = []) => {
  const eligible = records.filter((r) => RESOLVED_STATUSES.includes(r.outcome?.status));
  if (!eligible.length) return null;
  const mean = eligible.reduce((sum, r) => sum + (typeof r.verification?.evidenceConfidence === 'number' ? r.verification.evidenceConfidence : 0), 0) / eligible.length;
  return Math.round(mean * 100);
};

const FRESHNESS_FULL_CREDIT_MONTHS = 12;
const FRESHNESS_ZERO_CREDIT_MONTHS = 36;

const freshnessComponent = (lastVerifiedAt) => {
  if (!lastVerifiedAt) return 0;
  const ageMs = Date.now() - new Date(lastVerifiedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
  if (ageMonths <= FRESHNESS_FULL_CREDIT_MONTHS) return 15;
  if (ageMonths >= FRESHNESS_ZERO_CREDIT_MONTHS) return 0;
  const span = FRESHNESS_ZERO_CREDIT_MONTHS - FRESHNESS_FULL_CREDIT_MONTHS;
  return Math.round(15 * (1 - (ageMonths - FRESHNESS_FULL_CREDIT_MONTHS) / span));
};

/**
 * Coverage Score (0-100), deterministic and independent of the Faith Score so
 * a strong score can never hide thin coverage:
 *  - up to 25 pts: distinct reporting periods covered (capped at 5 periods)
 *  - up to 35 pts: resolved-promise count (capped at 8 promises, the plan's
 *    initial per-company target ceiling)
 *  - up to 25 pts: share of records carrying both promise AND (when resolved)
 *    outcome evidence
 *  - up to 15 pts: freshness of `lastVerifiedAt` (full credit inside 12
 *    months, decaying linearly to 0 at 36+ months)
 */
export const calculateCoverageScore = (company, records = []) => {
  const distinctPeriods = new Set(records.map((r) => r.promise?.targetPeriod).filter(Boolean));
  const periodsScore = (Math.min(distinctPeriods.size, 5) / 5) * 25;

  const resolved = records.filter((r) => RESOLVED_STATUSES.includes(r.outcome?.status));
  const resolvedScore = (Math.min(resolved.length, 8) / 8) * 35;

  const withCompleteEvidence = records.filter((r) => {
    const hasPromiseEvidence = Boolean(r.promiseEvidence);
    const needsOutcomeEvidence = RESOLVED_STATUSES.includes(r.outcome?.status);
    return hasPromiseEvidence && (!needsOutcomeEvidence || Boolean(r.outcomeEvidence));
  });
  const evidenceScore = records.length ? (withCompleteEvidence.length / records.length) * 25 : 0;

  const freshnessScore = freshnessComponent(company?.lastVerifiedAt);

  return Math.round(Math.min(100, periodsScore + resolvedScore + evidenceScore + freshnessScore));
};

const collectSources = (records) => {
  const seen = new Map();
  for (const record of records) {
    for (const evidence of [record.promiseEvidence, record.outcomeEvidence]) {
      if (!evidence?.sourceUrl || seen.has(evidence.sourceUrl)) continue;
      seen.set(evidence.sourceUrl, {
        title: evidence.sourceTitle,
        url: evidence.sourceUrl,
        type: evidence.sourceType,
        publishedAt: evidence.publishedAt,
      });
    }
  }
  return Array.from(seen.values());
};

const toTimelineEntry = (record) => ({
  id: record.id,
  category: record.promise.category,
  period: record.promise.targetPeriod,
  statement: record.promise.statement,
  originalExcerpt: record.promise.originalExcerpt || null,
  promiseDate: record.promise.promiseDate,
  target: {
    value: record.promise.targetValue ?? null,
    unit: record.promise.targetUnit ?? null,
    operator: record.promise.operator,
    type: record.promise.targetType,
  },
  status: record.outcome.status,
  outcome: {
    actualValue: record.outcome.actualValue ?? null,
    actualUnit: record.outcome.actualUnit ?? null,
    evaluationDate: record.outcome.evaluationDate ?? null,
    explanation: record.outcome.explanation ?? null,
  },
  promiseEvidence: record.promiseEvidence,
  outcomeEvidence: record.outcomeEvidence,
  evidenceConfidence: record.verification?.evidenceConfidence ?? null,
  dataMode: record.dataMode,
  // Present (non-null) only for a record accepted through the
  // PromiseCandidate review workflow; a hand-authored JSON record never has
  // these, since it was written directly by a human, not "reviewed" as a
  // discrete accept/reject action.
  reviewedBy: record.reviewedBy ?? null,
  reviewedAt: record.reviewedAt ?? null,
});

/**
 * Builds the full curated timeline response. Returns null only when `symbol`
 * isn't a supported project stock at all (the route layer treats that as a
 * 404-worthy case distinct from "supported but RESEARCH_PENDING"). ASYNC --
 * merges live-accepted Mongo candidates with the git-committed JSON records
 * (see fetchMergedRecords) so an acceptance is reflected immediately,
 * without requiring a redeploy.
 */
export const getCompanyTimeline = async (symbol, filters = {}) => {
  const normalized = normalizeCuratedSymbol(symbol);
  if (!normalized) return null;

  const { companiesBySymbol, demoCompaniesBySymbol } = ensureCache();
  const staticRecord = filters.mode === 'DEMO'
    ? (isDemoModeEnabled() ? demoCompaniesBySymbol.get(normalized) : null)
    : companiesBySymbol.get(normalized);
  if (!staticRecord) return null;

  const merged = await fetchMergedRecords(normalized, { mode: filters.mode });
  const coverage = filters.mode === 'DEMO' ? deepClone(staticRecord) : buildLiveCoverage(staticRecord, merged);
  const records = applyPromiseFilters(merged, filters);

  const faith = calculateFaithScore(records);
  const evidenceConfidence = calculateEvidenceConfidence(records);
  const coverageScore = calculateCoverageScore(coverage, records);
  const faithCoverage = computeFaithScoreCoverage(records, { coverageStatus: coverage.coverageStatus, dataAsOf: coverage.lastVerifiedAt });

  const counts = { achieved: 0, partial: 0, missed: 0, pending: 0, insufficientEvidence: 0 };
  for (const record of records) {
    switch (record.outcome?.status) {
      case 'ACHIEVED': counts.achieved++; break;
      case 'PARTIAL': counts.partial++; break;
      case 'MISSED': counts.missed++; break;
      case 'PENDING': counts.pending++; break;
      case 'INSUFFICIENT_EVIDENCE': counts.insufficientEvidence++; break;
      default: break;
    }
  }

  return {
    symbol: normalized,
    companyName: coverage.companyName,
    dataMode: coverage.dataMode,
    coverageStatus: coverage.coverageStatus,
    lastVerifiedAt: coverage.lastVerifiedAt,
    nextReviewAfter: coverage.nextReviewAfter,
    summary: {
      faithScore: faith.faithScore,
      faithScoreLabel: faith.faithScoreLabel,
      evidenceConfidence,
      coverageScore,
      totalPromises: records.length,
      resolvedPromises: faith.resolvedCount,
      achieved: counts.achieved,
      partial: counts.partial,
      missed: counts.missed,
      pending: counts.pending,
      insufficientEvidence: counts.insufficientEvidence,
      scoreBreakdown: faith.breakdown,
      // Task 4: Faith Score coverage state -- managementFaithScore is the
      // canonical name for this score (see rule: never confuse it with
      // financial-facts coverage, which is a fully separate object).
      managementFaithScore: faith.faithScore,
      scoreStatus: faithCoverage.scoreStatus,
      confidence: faithCoverage.confidence,
      expectedQuarters: faithCoverage.expectedQuarters,
      completedQuarters: faithCoverage.completedQuarters,
      promisesTotal: faithCoverage.promisesTotal,
      promisesResolved: faithCoverage.promisesResolved,
      missingQuarters: faithCoverage.missingQuarters,
      dataAsOf: faithCoverage.dataAsOf,
    },
    timeline: records.map(toTimelineEntry),
    sources: collectSources(records),
    disclaimer: DISCLAIMER,
  };
};

export const validateCuratedRecord = (record, context = {}) => (
  record && record.promise
    ? validateManagementPromiseRecord(record, context)
    : validateCuratedCompanyRecord(record)
);

export default {
  DISCLAIMER,
  isDemoModeEnabled,
  normalizeCuratedSymbol,
  reloadCuratedDataset,
  listSupportedCompanies,
  getCompanyCoverage,
  getCompanyPromises,
  calculateFaithScore,
  calculateEvidenceConfidence,
  calculateCoverageScore,
  computeFaithScoreCoverage,
  getCompanyTimeline,
  validateCuratedRecord,
  faithScoreLabel,
};
