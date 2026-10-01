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
 *   SELECTS   candidates (PENDING_REVIEW or ACCEPTED; never REJECTED) whose
 *             outcome.status is PENDING -- or INSUFFICIENT_EVIDENCE previously
 *             written by THIS job, so a later filing can still resolve it --
 *             AND whose target period plus the statutory reporting window has
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
 * Bounded (--batch-size, --max-runtime-min), resumable (selection is derived
 * from the database each run) and idempotent (re-running recomputes the same
 * result from the same evidence).
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { assertMongoTarget } from '../utils/mongoTarget.js';
import { claimRun, heartbeat, completeRun } from '../services/ScheduledJobRunService.js';
import { calculatePromiseStatus } from '../services/ManagementPromiseService.js';
import {
  isTargetPeriodClosed, canonicalUnit, toCandidateOutcomeStatus, EVALUABLE_OUTCOMES,
} from '../utils/promiseOutcome.js';
import { validateCandidatePromiseRecord } from '../utils/earningsIntelligenceValidation.js';

export const DEFAULT_BATCH_SIZE = 25;
const OPEN_STATUSES = ['PENDING', 'INSUFFICIENT_EVIDENCE'];

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

/** isDueForReevaluation - pure. */
export const isDueForReevaluation = (candidate, { asOf = new Date() } = {}) => {
  if (!candidate || candidate.reviewStatus === 'REJECTED') return false;
  const status = candidate.outcome?.status;
  if (status === 'PENDING') return isTargetPeriodClosed(candidate.promise?.targetPeriod, asOf);
  // Only an INSUFFICIENT_EVIDENCE this job wrote itself is retried; one set by a human is left alone.
  if (status === 'INSUFFICIENT_EVIDENCE' && candidate.reevaluation?.lastRunAt) return isTargetPeriodClosed(candidate.promise?.targetPeriod, asOf);
  return false;
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

/**
 * runReevaluation - the orchestrator. All I/O is injected so it is testable
 * without a database or network. `findCandidatesFn({ symbols })` returns lean
 * candidate documents; `updateCandidateFn(candidate, $set)` persists one.
 */
export const runReevaluation = async ({
  findCandidatesFn,
  updateCandidateFn,
  outcomeSearchFn,
  getProfileFn = (symbol) => ({ symbol }),
  symbols = null,
  batchSize = DEFAULT_BATCH_SIZE,
  asOf = new Date(),
  dryRun = false,
  runId = null,
  maxRuntimeMs = 0,
  log = () => {},
}) => {
  const startedAt = Date.now();
  const all = await findCandidatesFn({ symbols });
  const due = all
    .filter((candidate) => isDueForReevaluation(candidate, { asOf }))
    .sort((a, b) => (new Date(a.reevaluation?.lastRunAt || 0) - new Date(b.reevaluation?.lastRunAt || 0)) || String(a.symbol).localeCompare(String(b.symbol)) || String(a.id).localeCompare(String(b.id)));
  const batch = due.slice(0, batchSize);
  const stats = {
    scanned: all.length, due: due.length, processed: 0, applied: 0, proposed: 0, unchangedDryRun: 0, failures: 0,
    byResult: {}, stopReason: null,
  };

  for (const candidate of batch) {
    if (maxRuntimeMs && Date.now() - startedAt >= maxRuntimeMs) { stats.stopReason = 'the --max-runtime-min budget is used up'; break; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const evaluation = await reevaluateCandidate(candidate, { profile: getProfileFn(candidate.symbol), outcomeSearchFn, asOf });
      const update = buildCandidateUpdate(candidate, evaluation, { asOf, runId });
      stats.processed += 1;
      stats.byResult[evaluation.result] = (stats.byResult[evaluation.result] || 0) + 1;
      if (dryRun) {
        stats.unchangedDryRun += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await updateCandidateFn(candidate, update.$set);
        if (update.applied) stats.applied += 1; else stats.proposed += 1;
      }
      log(`  ${String(candidate.symbol).padEnd(10)} ${String(candidate.id).padEnd(26)} ${candidate.promise?.targetPeriod || ''} -> ${evaluation.result}${evaluation.reason ? ` (${evaluation.reason})` : ''} [${dryRun ? 'dry run' : update.note}]`);
    } catch (error) {
      stats.failures += 1;
      log(`  ${candidate.symbol} ${candidate.id}: failed -- ${error.message}`);
    }
  }
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
    const { searchActualOutcomesLocalFirst } = await import('../services/OutcomeEvidenceService.js');
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

    const stats = await runReevaluation({
      findCandidatesFn: ({ symbols }) => PromiseCandidate.find({
        reviewStatus: { $in: ['PENDING_REVIEW', 'ACCEPTED'] },
        'outcome.status': { $in: OPEN_STATUSES },
        ...(symbols?.length ? { symbol: { $in: symbols } } : {}),
      }).lean(),
      updateCandidateFn: async (candidate, $set) => {
        await PromiseCandidate.updateOne({ _id: candidate._id }, { $set });
        if (runId) await heartbeat(jobName, runId, { lastId: candidate.id, symbol: candidate.symbol });
      },
      outcomeSearchFn: searchActualOutcomesLocalFirst,
      getProfileFn: (symbol) => getCompanyResearchProfile(symbol, SUPPORTED_STOCKS[symbol]?.name, SUPPORTED_STOCKS[symbol]?.sector),
      symbols: args.symbols,
      batchSize: args.batchSize,
      dryRun: args.dryRun,
      runId: runId ? String(runId) : null,
      maxRuntimeMs: args.maxRuntimeMin * 60000,
      log: (line) => console.log(line),
    });

    console.log(`\n${stats.stopReason ? `Stopped: ${stats.stopReason}.` : 'Run finished.'} ${JSON.stringify(stats)}`);
    if (stats.due > stats.processed) console.log(`${stats.due - stats.processed} due record(s) remain; re-run the same command to continue.`);
    if (runId) await completeRun(jobName, runId, { status: 'SUCCESS', stats });
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
