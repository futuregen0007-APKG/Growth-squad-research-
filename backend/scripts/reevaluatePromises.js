/**
 * reevaluatePromises.js
 * ======================
 * `node scripts/reevaluatePromises.js --expect-target <host>/<database>
 *    [--symbol TCS | --symbol=TCS | --symbols TCS,INFY,HDFCBANK]
 *    [--batch-size 25] [--max-runtime-min 30] [--allow-indian-api]
 *    [--dry-run] [--label name] [--no-overlap-guard]`
 *
 * Re-checks PromiseCandidate records whose outcome is still open once their
 * target period has closed. Before this job, the outcome matcher ran exactly
 * once, at candidate-generation time (scripts/backfillPromises.js); a promise
 * whose period had not ended then stayed PENDING forever.
 *
 *   SELECTS   candidates (PENDING_REVIEW or ACCEPTED; never REJECTED; never
 *             locked) whose outcome.status is PENDING or INSUFFICIENT_EVIDENCE
 *             (whoever set it, so a later filing can still resolve it) AND
 *             whose target period plus the statutory reporting window has
 *             passed (utils/promiseOutcome.js isTargetPeriodClosed). Least
 *             recently re-evaluated first, so a bounded batch rotates through
 *             the backlog across runs.
 *   LOOKS UP  the actual with the existing OutcomeEvidenceService
 *             .searchActualOutcomesLocalFirst (consumed as-is: stored facts ->
 *             persisted documents -> IndianAPI). IndianAPI is blanked by
 *             default (no paid API from a cron), like the transcript job.
 *   DECIDES   with the fixed ManagementPromiseService.calculatePromiseStatus.
 *             A failed or non-comparable lookup is INSUFFICIENT_EVIDENCE with
 *             the specific reason -- never a substituted value, never MISSED.
 *   WRITES    PENDING_REVIEW candidates: outcome/outcomeEvidence are updated
 *             (re-validated with validateCandidatePromiseRecord first; the
 *             candidate is still unpublished and a human still reviews it).
 *             ACCEPTED candidates: a human decision is never overwritten --
 *             the fresh result is stored only in `reevaluation.proposedOutcome`
 *             for the reviewer. Every touched record gets a `reevaluation`
 *             audit entry. Curated promises/<SYMBOL>.json files are never
 *             written (Render's filesystem is ephemeral, and they are
 *             human-curated, git-committed records).
 *
 * SECOND POOL - evidence drift on COMPLETED outcomes (ACHIEVED / EXCEEDED /
 *             MISSED). Deliberately cheap: only the DB-only tier (a)
 *             (searchActualOutcomeFromHistoricalFacts) is consulted and its
 *             result fingerprinted (reevaluation.evidenceHash). Only when a
 *             stored fingerprint exists AND differs is the full 3-tier lookup
 *             run and the verdict recomputed. A first observation only stores
 *             a baseline. Outcome changes follow the same write rules as above
 *             (PENDING_REVIEW applied after validation; ACCEPTED proposal only)
 *             and are appended to reevaluation.history (never rewritten).
 *
 *   SKIPS     locked candidates (reevaluation.locked, set by a human with
 *             earningsReview.js --lock) and ACCEPTED candidates whose
 *             committed promises/<SYMBOL>.json record is no longer public-safe
 *             (e.g. evidenceIntegrity.status QUARANTINED) -- read-only file access.
 *   REPORTS   the freshness of the two upstream jobs (XBRL + transcript
 *             refresh) in the run stats. Reporting only: it never changes
 *             which candidates are evaluated or how.
 *
 * Bounded (--batch-size, --max-runtime-min), resumable (selection is derived
 * from the database each run) and idempotent (re-running recomputes the same
 * result from the same evidence).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import {
  claimRun, heartbeat, completeRun, getStatus,
} from '../services/ScheduledJobRunService.js';
import { calculatePromiseStatus } from '../services/ManagementPromiseService.js';
import {
  isTargetPeriodClosed, canonicalUnit, toCandidateOutcomeStatus, EVALUABLE_OUTCOMES, canonicalOutcomeFromStoredStatus,
} from '../utils/promiseOutcome.js';
import { validateCandidatePromiseRecord, PUBLIC_SAFE_EVIDENCE_STATUSES } from '../utils/earningsIntelligenceValidation.js';
import { UPSTREAM_JOB_NAMES, describeUpstreamFreshness } from '../utils/upstreamFreshness.js';

export const DEFAULT_BATCH_SIZE = 25;
const OPEN_STATUSES = ['PENDING', 'INSUFFICIENT_EVIDENCE'];
// Numeric-comparison completions only. PARTIAL (read-only legacy) and
// QUALITATIVE_ONLY are not re-checked for drift.
export const COMPLETED_STATUSES = ['ACHIEVED', 'EXCEEDED', 'MISSED'];
export const NO_TIER_A_MATCH = 'NO_TIER_A_MATCH';

const PROMISES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'earnings-intelligence', 'promises');

/**
 * createCuratedRecordLoader - read-only lookup of a committed
 * promises/<SYMBOL>.json record by id (same path convention as
 * earningsReview.js). Each file is read at most once per run. Returns
 * { found, record, error }. An unreadable/corrupt file reports `error`, and
 * the gate below then fails closed for ACCEPTED candidates of that symbol.
 */
export const createCuratedRecordLoader = ({ promisesDir = PROMISES_DIR, existsFn = fs.existsSync, readFileFn = fs.readFileSync } = {}) => {
  const cache = new Map();
  return (symbol, id) => {
    if (!cache.has(symbol)) {
      const filePath = path.join(promisesDir, `${symbol}.json`);
      try {
        const records = existsFn(filePath) ? (JSON.parse(readFileFn(filePath, 'utf8')).records || []) : [];
        cache.set(symbol, { records, error: null });
      } catch (error) {
        cache.set(symbol, { records: [], error: `could not read promises/${symbol}.json (${error.message})` });
      }
    }
    const { records, error } = cache.get(symbol);
    if (error) return { found: false, record: null, error };
    const record = records.find((r) => r?.id === id) || null;
    return { found: Boolean(record), record, error: null };
  };
};

/**
 * passesCuratedVisibilityGate - pure. Only constrains ACCEPTED candidates.
 * - A committed JSON record whose evidenceIntegrity.status is not public-safe
 *   (e.g. QUARANTINED: a human pulled it for evidence-provenance reasons) ->
 *   skipped entirely; no effort is spent re-evaluating it.
 * - An unreadable curated file -> skipped (fail closed).
 * - ACCEPTED in Mongo but with NO JSON record yet (accepted, not yet
 *   committed/deployed) -> ALLOWED. It is not public either way, and only
 *   reevaluation.proposedOutcome is ever written for an ACCEPTED candidate,
 *   so keeping that proposal fresh for whenever it is promoted is harmless.
 */
export const passesCuratedVisibilityGate = (candidate, curated) => {
  if (candidate?.reviewStatus !== 'ACCEPTED') return true;
  if (curated?.error) return false;
  if (curated?.found) return PUBLIC_SAFE_EVIDENCE_STATUSES.includes(curated.record?.evidenceIntegrity?.status);
  return true;
};

const isLocked = (candidate) => candidate?.reevaluation?.locked === true;

/**
 * Conservative category -> metric fallback for candidates generated before
 * `promise.metric` was stored. Only categories whose EVERY source metric
 * resolves to the identical outcome-fact alias set in OutcomeEvidenceService
 * are listed (e.g. PROFITABILITY came from PAT or PAT_GROWTH, both of which
 * match PAT facts). ORDER_BOOK is absent on purpose: it was produced from
 * ORDER_BOOK, ORDER_INTAKE, ARR and BOOKINGS, which are not the same figure.
 * Anything else stays unresolved rather than guessed.
 */
const CATEGORY_METRIC_FALLBACK = {
  REVENUE_GROWTH: 'REVENUE',
  MARGIN: 'MARGIN',
  PROFITABILITY: 'PAT',
  DEBT_REDUCTION: 'DEBT',
  CAPEX: 'CAPEX',
};

export const resolveCandidateMetric = (candidate) => {
  const metric = candidate?.promise?.metric;
  if (metric) return String(metric).toUpperCase();
  return CATEGORY_METRIC_FALLBACK[String(candidate?.promise?.category || '').toUpperCase()] || null;
};

/**
 * isDueForReevaluation - pure. Open-status pool. `curated` is the
 * createCuratedRecordLoader result for an ACCEPTED candidate (omit otherwise).
 * INSUFFICIENT_EVIDENCE is revisited whoever set it (a later filing may now
 * resolve it); a human who wants it left alone locks it instead
 * (earningsReview.js --lock). For an ACCEPTED candidate only a proposal is
 * ever written, so revisiting it never changes a public outcome.
 */
export const isDueForReevaluation = (candidate, { asOf = new Date(), curated = null } = {}) => {
  if (!candidate || candidate.reviewStatus === 'REJECTED') return false;
  if (isLocked(candidate)) return false;
  if (!OPEN_STATUSES.includes(candidate.outcome?.status)) return false;
  if (!passesCuratedVisibilityGate(candidate, curated)) return false;
  return isTargetPeriodClosed(candidate.promise?.targetPeriod, asOf);
};

/**
 * isDueForDriftCheck - pure. Completed-outcome pool: a numeric completion
 * (ACHIEVED/EXCEEDED/MISSED) with a resolvable metric and a numeric target,
 * not REJECTED, not locked, and passing the same curated visibility gate.
 */
export const isDueForDriftCheck = (candidate, { curated = null } = {}) => {
  if (!candidate || candidate.reviewStatus === 'REJECTED') return false;
  if (isLocked(candidate)) return false;
  if (!COMPLETED_STATUSES.includes(candidate.outcome?.status)) return false;
  if (!resolveCandidateMetric(candidate)) return false;
  if (candidate.promise?.targetValue === null || candidate.promise?.targetValue === undefined) return false;
  return passesCuratedVisibilityGate(candidate, curated);
};

/**
 * computeEvidenceHash - pure. sha256 over the load-bearing fields of a tier-(a)
 * match, or the literal NO_TIER_A_MATCH when tier (a) found nothing.
 */
export const computeEvidenceHash = (match) => {
  if (!match) return NO_TIER_A_MATCH;
  const norm = (value) => (value instanceof Date ? value.toISOString() : (value ?? null));
  const payload = JSON.stringify([
    norm(match.actualValue), norm(match.actualUnit), norm(match.actualPeriod), norm(match.outcomeSourceUrl), norm(match.outcomeSourceDate),
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
};

/**
 * effectivePreviousOutcome - the latest verdict on record for change
 * detection: a pending proposal (ACCEPTED, or a PENDING_REVIEW whose
 * application failed validation) if there is one, else the stored outcome.
 * Comparing against the proposal stops an ACCEPTED candidate from logging
 * the same proposed change again on every run.
 */
const effectivePreviousOutcome = (candidate) => candidate.reevaluation?.proposedOutcome?.status ?? candidate.outcome?.status ?? null;

const sameOutcome = (a, b) => (canonicalOutcomeFromStoredStatus(a) ?? a) === (canonicalOutcomeFromStoredStatus(b) ?? b);

/** flattenReevaluationSet - pure. `reevaluation: {...}` -> dotted `reevaluation.<k>` keys, so a write never clobbers lock/hash/history fields. */
export const flattenReevaluationSet = ($set) => {
  const flat = {};
  for (const [key, value] of Object.entries($set || {})) {
    if (key === 'reevaluation' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) flat[`reevaluation.${k}`] = v;
    } else {
      flat[key] = value;
    }
  }
  return flat;
};

const toIsoDateOnly = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

/**
 * reevaluateCandidate - one record. Never throws; never invents a value.
 * Returns { result, reason, outcome, outcomeEvidence, evidenceConfidence, matched }.
 */
export const reevaluateCandidate = async (candidate, { profile, outcomeSearchFn, asOf = new Date() }) => {
  const promise = candidate.promise || {};
  const metric = resolveCandidateMetric(candidate);
  const base = {
    targetValue: promise.targetValue,
    targetValueMax: promise.targetValueMax ?? null,
    targetUnit: canonicalUnit(promise.targetUnit),
    operator: promise.operator,
    metric: metric || promise.category || '',
    targetType: promise.targetType,
    targetPeriod: promise.targetPeriod,
    asOf,
  };

  let match = null;
  let lookupFailure = null;
  if (!metric) {
    lookupFailure = `the promise's metric is not recorded and its category (${promise.category || 'none'}) does not identify one metric unambiguously, so no actual could be looked up automatically.`;
  } else if (promise.targetValue !== null && promise.targetValue !== undefined) {
    try {
      match = await outcomeSearchFn(profile, {
        metric, targetPeriod: promise.targetPeriod, targetValue: promise.targetValue, targetUnit: canonicalUnit(promise.targetUnit),
      });
    } catch (error) {
      lookupFailure = `the actual-result lookup failed (${error.message}); no value was substituted.`;
      match = null;
    }
  }

  if (match && match.actualValue !== null && match.actualValue !== undefined && match.outcomeSourceUrl) {
    const verdict = calculatePromiseStatus({
      ...base, actualValue: match.actualValue, actualUnit: canonicalUnit(match.actualUnit) || base.targetUnit, actualPeriod: match.actualPeriod || null,
    });
    if (EVALUABLE_OUTCOMES.includes(verdict.outcome)) {
      const evaluationDate = toIsoDateOnly(match.outcomeSourceDate) || toIsoDateOnly(asOf);
      return {
        result: verdict.outcome,
        reason: null,
        matched: true,
        outcome: {
          status: toCandidateOutcomeStatus(verdict.outcome),
          actualValue: match.actualValue,
          actualUnit: promise.targetUnit ?? null,
          evaluationDate,
          explanation: verdict.calculationExplanation,
        },
        outcomeEvidence: {
          sourceTitle: match.outcomeSource || 'Company financial results',
          sourceType: 'FINANCIAL_RESULTS',
          sourceUrl: match.outcomeSourceUrl,
          publishedAt: evaluationDate,
          pageNumber: null,
          excerpt: String(match.outcomeStatement || verdict.calculationExplanation).slice(0, 2000),
        },
        evidenceConfidence: Math.min(0.75, typeof match.confidence === 'number' ? match.confidence : 0.75),
      };
    }
    // A match that is not like-for-like (unit / period / basis) is reported as such, not compared.
    return {
      result: verdict.outcome, reason: verdict.reason, matched: false,
      outcome: { status: toCandidateOutcomeStatus(verdict.outcome), actualValue: null, actualUnit: null, evaluationDate: null, explanation: verdict.reason },
      outcomeEvidence: null, evidenceConfidence: null,
    };
  }

  const verdict = calculatePromiseStatus({ ...base, actualValue: null, evidenceUnavailableReason: lookupFailure });
  return {
    result: verdict.outcome, reason: verdict.reason, matched: false,
    outcome: { status: toCandidateOutcomeStatus(verdict.outcome), actualValue: null, actualUnit: null, evaluationDate: null, explanation: verdict.reason },
    outcomeEvidence: null, evidenceConfidence: null,
  };
};

/**
 * buildCandidateUpdate - pure. The $set for one record, honouring the
 * review rules in the header (ACCEPTED -> proposal only).
 */
export const buildCandidateUpdate = (candidate, evaluation, { asOf = new Date(), runId = null } = {}) => {
  const reevaluation = {
    lastRunAt: new Date(asOf),
    result: evaluation.result,
    reason: evaluation.reason,
    appliedToOutcome: false,
    proposedOutcome: null,
    proposedOutcomeEvidence: null,
    runId,
  };

  if (candidate.reviewStatus === 'ACCEPTED') {
    return { $set: { reevaluation: { ...reevaluation, proposedOutcome: evaluation.outcome, proposedOutcomeEvidence: evaluation.outcomeEvidence } }, applied: false, note: 'ACCEPTED: proposal stored for human review; outcome left unchanged' };
  }

  // PENDING_REVIEW: apply, but only if the resulting record still validates.
  const next = {
    ...candidate,
    outcome: evaluation.outcome,
    outcomeEvidence: evaluation.outcomeEvidence,
    verification: {
      ...candidate.verification,
      evidenceConfidence: evaluation.evidenceConfidence ?? candidate.verification?.evidenceConfidence ?? 0.5,
    },
  };
  const { valid, errors } = validateCandidatePromiseRecord(next, { symbol: candidate.symbol, allowDemo: false });
  if (!valid) {
    return {
      $set: { reevaluation: { ...reevaluation, reason: `Not applied: the re-evaluated record failed validation (${errors.join('; ')})`, proposedOutcome: evaluation.outcome, proposedOutcomeEvidence: evaluation.outcomeEvidence } },
      applied: false,
      note: 'validation failed; proposal stored only',
    };
  }
  return {
    $set: {
      outcome: next.outcome,
      outcomeEvidence: next.outcomeEvidence,
      'verification.evidenceConfidence': next.verification.evidenceConfidence,
      reevaluation: { ...reevaluation, appliedToOutcome: true },
    },
    applied: true,
    note: 'applied',
  };
};

const historyEntry = ({
  asOf, trigger, previousOutcome, previousEvidenceHash, newOutcome, newEvidenceHash, reason, applied,
}) => ({
  at: new Date(asOf), trigger, previousOutcome, previousEvidenceHash, newOutcome, newEvidenceHash, reason, applied,
});

const byKeyThenId = (key) => (a, b) => (new Date(key(a) || 0) - new Date(key(b) || 0))
  || String(a.symbol).localeCompare(String(b.symbol)) || String(a.id).localeCompare(String(b.id));

/**
 * runReevaluation - the orchestrator. All I/O is injected so it is testable
 * without a database or network. `findCandidatesFn({ symbols })` returns lean
 * candidate documents; `updateCandidateFn(candidate, { $set, $push? })`
 * persists one (`$set` uses dotted `reevaluation.*` keys, so lock/hash/
 * history fields are never clobbered). `historicalFactsFn` is tier (a) ONLY
 * (OutcomeEvidenceService.searchActualOutcomeFromHistoricalFacts); when it is
 * not supplied the completed-outcome drift pool is disabled.
 *
 * Budget: ONE --batch-size / --max-runtime-min budget shared by both pools.
 * Due open-status candidates go first (time-sensitive: a newly closed period
 * is the main thing this job exists for, and there are fewer of them); the
 * remaining batch slots go to completed-candidate drift checks, least
 * recently checked first, so a bounded batch rotates through them over runs.
 */
export const runReevaluation = async ({
  findCandidatesFn,
  updateCandidateFn,
  outcomeSearchFn,
  historicalFactsFn = null,
  loadCuratedRecordFn = createCuratedRecordLoader(),
  getProfileFn = (symbol) => ({ symbol }),
  symbols = null,
  batchSize = DEFAULT_BATCH_SIZE,
  asOf = new Date(),
  dryRun = false,
  runId = null,
  maxRuntimeMs = 0,
  upstreamFreshness = null,
  log = () => {},
}) => {
  const startedAt = Date.now();
  const all = await findCandidatesFn({ symbols });
  const curatedOf = new Map();
  for (const candidate of all) {
    if (candidate.reviewStatus === 'ACCEPTED') curatedOf.set(candidate, loadCuratedRecordFn(candidate.symbol, candidate.id));
  }
  const curatedFor = (candidate) => curatedOf.get(candidate) || null;

  const due = all
    .filter((candidate) => isDueForReevaluation(candidate, { asOf, curated: curatedFor(candidate) }))
    .sort(byKeyThenId((c) => c.reevaluation?.lastRunAt));
  const driftDue = historicalFactsFn
    ? all.filter((candidate) => isDueForDriftCheck(candidate, { curated: curatedFor(candidate) })).sort(byKeyThenId((c) => c.reevaluation?.evidenceHashCheckedAt))
    : [];
  const batch = due.slice(0, batchSize);
  const driftBatch = driftDue.slice(0, Math.max(0, batchSize - batch.length));

  const stats = {
    scanned: all.length, due: due.length, processed: 0, applied: 0, proposed: 0, unchangedDryRun: 0, failures: 0,
    byResult: {}, stopReason: null,
    skippedLocked: all.filter(isLocked).length,
    skippedNotPublic: all.filter((c) => c.reviewStatus === 'ACCEPTED' && !isLocked(c) && !passesCuratedVisibilityGate(c, curatedFor(c))).length,
    historyEntries: 0,
    drift: {
      enabled: Boolean(historicalFactsFn), due: driftDue.length, checked: 0, baselined: 0, unchanged: 0, evidenceChanged: 0,
      outcomeChanged: 0, applied: 0, proposed: 0, failures: 0,
    },
    upstreamFreshness,
  };
  const outOfTime = () => maxRuntimeMs && Date.now() - startedAt >= maxRuntimeMs;

  for (const candidate of batch) {
    if (outOfTime()) { stats.stopReason = 'the --max-runtime-min budget is used up'; break; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const evaluation = await reevaluateCandidate(candidate, { profile: getProfileFn(candidate.symbol), outcomeSearchFn, asOf });
      const update = buildCandidateUpdate(candidate, evaluation, { asOf, runId });
      stats.processed += 1;
      stats.byResult[evaluation.result] = (stats.byResult[evaluation.result] || 0) + 1;
      const previous = effectivePreviousOutcome(candidate);
      const changed = !sameOutcome(previous, evaluation.outcome.status);
      if (dryRun) {
        stats.unchangedDryRun += 1;
      } else {
        const write = { $set: flattenReevaluationSet(update.$set) };
        if (changed) {
          const storedHash = candidate.reevaluation?.evidenceHash ?? null;
          write.$push = {
            'reevaluation.history': historyEntry({
              asOf, trigger: 'OPEN_STATUS_RECHECK', previousOutcome: previous, previousEvidenceHash: storedHash,
              newOutcome: evaluation.outcome.status, newEvidenceHash: storedHash,
              reason: `${evaluation.reason || evaluation.outcome.explanation || 'recomputed'} [${update.note}]`, applied: update.applied,
            }),
          };
        }
        // eslint-disable-next-line no-await-in-loop
        await updateCandidateFn(candidate, write);
        if (changed) stats.historyEntries += 1;
        if (update.applied) stats.applied += 1; else stats.proposed += 1;
      }
      log(`  ${String(candidate.symbol).padEnd(10)} ${String(candidate.id).padEnd(26)} ${candidate.promise?.targetPeriod || ''} -> ${evaluation.result}${evaluation.reason ? ` (${evaluation.reason})` : ''} [${dryRun ? 'dry run' : update.note}]`);
    } catch (error) {
      stats.failures += 1;
      log(`  ${candidate.symbol} ${candidate.id}: failed -- ${error.message}`);
    }
  }

  for (const candidate of driftBatch) {
    if (stats.stopReason) break;
    if (outOfTime()) { stats.stopReason = 'the --max-runtime-min budget is used up'; break; }
    const label = `  ${String(candidate.symbol).padEnd(10)} ${String(candidate.id).padEnd(26)} drift`;
    try {
      const promise = candidate.promise || {};
      const profile = getProfileFn(candidate.symbol);
      // Tier (a) only: DB-only and cheap. The LLM / paid tiers run only on a detected change.
      // eslint-disable-next-line no-await-in-loop
      const tierA = await historicalFactsFn(profile, {
        metric: resolveCandidateMetric(candidate), targetPeriod: promise.targetPeriod, targetValue: promise.targetValue, targetUnit: canonicalUnit(promise.targetUnit),
      });
      const newHash = computeEvidenceHash(tierA);
      const storedHash = candidate.reevaluation?.evidenceHash ?? null;
      stats.drift.checked += 1;
      const $set = { 'reevaluation.evidenceHashCheckedAt': new Date(asOf) };
      let $push = null;
      let note;

      if (!storedHash) {
        // First observation (every candidate completed before this field existed): baseline, not drift.
        $set['reevaluation.evidenceHash'] = newHash;
        stats.drift.baselined += 1;
        note = 'baseline evidence fingerprint stored';
      } else if (storedHash === newHash) {
        stats.drift.unchanged += 1;
        note = 'evidence unchanged';
      } else {
        stats.drift.evidenceChanged += 1;
        // Evidence moved: authoritative full lookup, decided by the same calculatePromiseStatus path.
        // eslint-disable-next-line no-await-in-loop
        const evaluation = await reevaluateCandidate(candidate, { profile, outcomeSearchFn, asOf });
        stats.byResult[evaluation.result] = (stats.byResult[evaluation.result] || 0) + 1;
        $set['reevaluation.evidenceHash'] = newHash;
        const previous = effectivePreviousOutcome(candidate);
        if (sameOutcome(previous, evaluation.outcome.status)) {
          // Documented choice: no history entry. History records outcome changes
          // only; the refreshed fingerprint is the new baseline for next week.
          note = `evidence changed; verdict unchanged (${evaluation.outcome.status})`;
        } else {
          const update = buildCandidateUpdate(candidate, evaluation, { asOf, runId });
          Object.assign($set, flattenReevaluationSet(update.$set));
          $push = {
            'reevaluation.history': historyEntry({
              asOf, trigger: 'EVIDENCE_DRIFT', previousOutcome: previous, previousEvidenceHash: storedHash,
              newOutcome: evaluation.outcome.status, newEvidenceHash: newHash,
              reason: `Tier-(a) evidence fingerprint changed; full re-check: ${evaluation.reason || evaluation.outcome.explanation || 'recomputed'} [${update.note}]`,
              applied: update.applied,
            }),
          };
          stats.drift.outcomeChanged += 1;
          if (!dryRun) { if (update.applied) stats.drift.applied += 1; else stats.drift.proposed += 1; }
          note = `OUTCOME CHANGED ${previous} -> ${evaluation.outcome.status} [${update.note}]`;
        }
      }
      if (!dryRun) {
        // eslint-disable-next-line no-await-in-loop
        await updateCandidateFn(candidate, $push ? { $set, $push } : { $set });
        if ($push) stats.historyEntries += 1;
      }
      log(`${label} -> ${note}${dryRun ? ' [dry run]' : ''}`);
    } catch (error) {
      stats.drift.failures += 1;
      log(`${label}: failed -- ${error.message}`);
    }
  }
  return stats;
};

/**
 * collectUpstreamFreshness - REPORTING ONLY. Classifies the two upstream
 * refresh jobs; a lookup error is reported as UNKNOWN, never thrown, and the
 * result never influences candidate selection or evaluation.
 */
export const collectUpstreamFreshness = async ({ getStatusFn, now = new Date() }) => {
  const out = {};
  for (const [key, jobName] of Object.entries(UPSTREAM_JOB_NAMES)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      out[key] = describeUpstreamFreshness(await getStatusFn(jobName), { now });
    } catch (error) {
      out[key] = { status: 'UNKNOWN', lastSuccessAt: null, error: error.message };
    }
  }
  return out;
};

/**
 * runScheduledReevaluation - the job body between claim and exit: reports
 * upstream freshness, runs the re-evaluation, and records the stats
 * (including upstreamFreshness) via completeRunFn when a run was claimed.
 */
export const runScheduledReevaluation = async ({
  getStatusFn, completeRunFn, jobName = null, runId = null, log = () => {}, asOf = new Date(), ...runArgs
}) => {
  const upstreamFreshness = await collectUpstreamFreshness({ getStatusFn, now: asOf });
  for (const [key, value] of Object.entries(upstreamFreshness)) {
    log(`Upstream ${key} (${UPSTREAM_JOB_NAMES[key]}): ${value.status}; last success ${value.lastSuccessAt || 'never'}${value.error ? ` (status lookup failed: ${value.error})` : ''}`);
  }
  const stats = await runReevaluation({
    ...runArgs, asOf, runId: runId ? String(runId) : null, upstreamFreshness, log,
  });
  if (runId && completeRunFn) await completeRunFn(jobName, runId, { status: 'SUCCESS', stats });
  return stats;
};

export const parseArgs = (argv) => {
  const get = (flag) => {
    const eq = argv.find((arg) => arg.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const listOf = (value) => (value ? String(value).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null);
  const symbols = [...(listOf(get('--symbol')) || []), ...(listOf(get('--symbols')) || [])];
  return {
    expectTarget: get('--expect-target'),
    symbols: symbols.length ? [...new Set(symbols)] : null,
    batchSize: Number(get('--batch-size')) || DEFAULT_BATCH_SIZE,
    maxRuntimeMin: Number(get('--max-runtime-min')) || 0,
    allowIndianApi: argv.includes('--allow-indian-api'),
    dryRun: argv.includes('--dry-run'),
    label: get('--label') || 'promise-reevaluation',
    noOverlapGuard: argv.includes('--no-overlap-guard'),
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  let jobName = null;
  let runId = null;
  (async () => {
    dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
    const args = parseArgs(process.argv.slice(2));
    if (!args.expectTarget) throw new Error('--expect-target <host>/<database> is required: this script reads (and, without --dry-run, writes) the database.');
    // Set before the outcome modules load: no paid outcome API unless explicitly allowed.
    if (!args.allowIndianApi) process.env.INDIAN_API_KEY = '';

    const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
    console.log(`Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

    const { default: PromiseCandidate } = await import('../models/PromiseCandidate.js');
    const { searchActualOutcomesLocalFirst, searchActualOutcomeFromHistoricalFacts } = await import('../services/OutcomeEvidenceService.js');
    const { getCompanyResearchProfile } = await import('../research/CompanyResearchProfiles.js');
    const { SUPPORTED_STOCKS } = await import('../utils/constants.js');

    jobName = `promise-reevaluation:${args.label}`;
    if (!args.dryRun && !args.noOverlapGuard) {
      const claim = await claimRun(jobName);
      if (!claim.ok) {
        console.error(`Refusing to start: job "${jobName}" is already RUNNING (started ${claim.existing?.startedAt}, last heartbeat ${claim.existing?.heartbeatAt || 'never'}). Pass --no-overlap-guard to override.`);
        await mongoose.disconnect();
        process.exit(1);
      }
      runId = claim.runId;
      console.log(`Claimed scheduled-job run "${jobName}" (${runId}).`);
    }
    console.log(`Scope: ${args.symbols ? args.symbols.join(', ') : 'all symbols'}; batch ${args.batchSize}; IndianAPI fallback: ${args.allowIndianApi ? 'on' : 'off'}${args.dryRun ? '; DRY RUN (no writes)' : ''}\n`);

    const stats = await runScheduledReevaluation({
      getStatusFn: getStatus,
      completeRunFn: completeRun,
      jobName,
      runId,
      findCandidatesFn: ({ symbols }) => PromiseCandidate.find({
        reviewStatus: { $in: ['PENDING_REVIEW', 'ACCEPTED'] },
        'outcome.status': { $in: [...OPEN_STATUSES, ...COMPLETED_STATUSES] },
        'reevaluation.locked': { $ne: true },
        ...(symbols?.length ? { symbol: { $in: symbols } } : {}),
      }).lean(),
      updateCandidateFn: async (candidate, { $set, $push }) => {
        // Pre-existing documents have reevaluation: null, and MongoDB cannot $set a
        // dotted path through null. Initialise it first (only while still null).
        if (!candidate.reevaluation) {
          await PromiseCandidate.updateOne({ _id: candidate._id, reevaluation: null }, { $set: { reevaluation: {} } });
        }
        // A lock a human applied after this run read the record still wins.
        await PromiseCandidate.updateOne(
          { _id: candidate._id, 'reevaluation.locked': { $ne: true } },
          { $set, ...($push ? { $push } : {}) },
        );
        if (runId) await heartbeat(jobName, runId, { lastId: candidate.id, symbol: candidate.symbol });
      },
      outcomeSearchFn: searchActualOutcomesLocalFirst,
      historicalFactsFn: searchActualOutcomeFromHistoricalFacts,
      loadCuratedRecordFn: createCuratedRecordLoader(),
      getProfileFn: (symbol) => getCompanyResearchProfile(symbol, SUPPORTED_STOCKS[symbol]?.name, SUPPORTED_STOCKS[symbol]?.sector),
      symbols: args.symbols,
      batchSize: args.batchSize,
      dryRun: args.dryRun,
      maxRuntimeMs: args.maxRuntimeMin * 60000,
      log: (line) => console.log(line),
    });

    console.log(`\n${stats.stopReason ? `Stopped: ${stats.stopReason}.` : 'Run finished.'} ${JSON.stringify(stats)}`);
    if (stats.due > stats.processed) console.log(`${stats.due - stats.processed} due record(s) remain; re-run the same command to continue.`);
    await mongoose.disconnect();
    process.exit(0);
  })().catch(async (error) => {
    console.error('Promise re-evaluation failed:', error.message);
    try {
      if (jobName && runId && mongoose.connection.readyState === 1) {
        await completeRun(jobName, runId, { status: 'FAILED', error: error.message });
      }
    } catch { /* best-effort: the primary failure is already reported above */ }
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
