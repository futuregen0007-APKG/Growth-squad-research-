/**
 * earningsReview.js
 * ===================
 * `npm run earnings:review -- --secret=X --symbol=TCS --list`
 * `npm run earnings:review -- --secret=X --symbol=TCS --accept=<id> --reviewer=<name> --evidence-status=VERIFIED_EXCHANGE_COPY`
 * `npm run earnings:review -- --secret=X --symbol=TCS --reject=<id> --reviewer=<name> --reason="..."`
 *
 * Phase 4F: --accept now REQUIRES --evidence-status (VERIFIED_PRIMARY or
 * VERIFIED_EXCHANGE_COPY) -- an explicit assertion that the reviewer
 * re-checked the promise/outcome evidence against real primary-source
 * text, not just that it "looks plausible." A candidate that cannot be
 * asserted this way should be rejected (--reject, optionally with
 * --reason) or left pending, never force-accepted without it.
 *
 * The ONLY path by which an automated candidate (models/PromiseCandidate.js,
 * MongoDB) may ever reach the real, public curated dataset
 * (promises/<SYMBOL>.json). This is a human-invoked, PROTECTED step by
 * design -- PromiseCandidateService/generateCandidates.js never call it, and
 * every mutating action requires EARNINGS_REVIEW_SECRET (an env var) to be
 * set and to match the --secret= argument; without it, nothing is read or
 * written and the function returns an explicit "unauthorized" result.
 *
 * --accept:
 *   1. Loads the candidate from Mongo, refuses if missing or previously
 *      REJECTED.
 *   2. Strips reviewStatus/reviewedBy/reviewedAt/Mongo metadata and
 *      re-validates the result with the exact same
 *      validateManagementPromiseRecord used everywhere else in this
 *      dataset -- a candidate that fails this is NEVER promoted, regardless
 *      of how it looked when generated.
 *   3. Idempotent: accepting an already-accepted id is a no-op that reports
 *      "already accepted", never a duplicate record.
 *   4. Appends the record to promises/<SYMBOL>.json (creating the file if
 *      this is the company's first verified promise) -- this file is
 *      git-committed by the reviewer afterward, same as the existing
 *      TCS.json workflow. The live API does not depend on that commit
 *      happening immediately: CuratedEarningsIntelligenceService also reads
 *      ACCEPTED candidates directly from Mongo, so the Faith Score reflects
 *      this acceptance immediately, even before anyone commits the file.
 *   5. Best-effort updates the company's companies.json override (recomputed
 *      counts) for durability/documentation; this is NOT required for the
 *      public API to reflect the acceptance (see step 4).
 *   6. Marks the candidate reviewStatus:'ACCEPTED' with reviewedBy/reviewedAt
 *      in Mongo (audit trail; the document itself is never deleted).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { validateManagementPromiseRecord, validateCuratedCompanyRecord, RESOLVED_STATUSES, PUBLIC_SAFE_EVIDENCE_STATUSES } from '../utils/earningsIntelligenceValidation.js';
import { listCandidatesForSymbol } from '../services/PromiseCandidateService.js';
import PromiseCandidate from '../models/PromiseCandidate.js';
import { reloadCuratedDataset } from '../services/CuratedEarningsIntelligenceService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(__dirname, '..', 'data', 'earnings-intelligence');
const COMPANIES_FILE = path.join(DATA_ROOT, 'companies.json');
const PROMISES_DIR = path.join(DATA_ROOT, 'promises');

/** Authorization gate: EARNINGS_REVIEW_SECRET must be set (non-empty) and must match the provided secret exactly. */
export const isAuthorized = (providedSecret) => {
  const expected = process.env.EARNINGS_REVIEW_SECRET;
  return Boolean(expected) && typeof providedSecret === 'string' && providedSecret === expected;
};

/**
 * resolveSecret - CLI-only convenience: when the operator omits --secret=,
 * fall back to reading EARNINGS_REVIEW_SECRET directly from process.env
 * rather than requiring it to be retyped on the command line. This changes
 * nothing about the protection itself -- isAuthorized still requires the
 * resolved value to be a non-empty string equal to process.env's own value,
 * so a shell with no EARNINGS_REVIEW_SECRET set resolves to null and every
 * mutating action still fails closed exactly as before. Never logged.
 */
export const resolveSecret = (argSecret) => (
  typeof argSecret === 'string' && argSecret.length ? argSecret : (process.env.EARNINGS_REVIEW_SECRET || null)
);

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const writeJson = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

/** Recomputes a companies.json override from a symbol's current promises/<SYMBOL>.json records (best-effort; the live API does not depend on this). */
export const buildCompanyOverride = (symbol, existingOverride, promiseRecords) => {
  const resolved = promiseRecords.filter((r) => RESOLVED_STATUSES.includes(r.outcome?.status));
  const pending = promiseRecords.filter((r) => r.outcome?.status === 'PENDING');
  const base = existingOverride || {
    symbol,
    companyName: SUPPORTED_STOCKS[symbol]?.name || symbol,
    sector: SUPPORTED_STOCKS[symbol]?.sector || 'Unknown',
    dataMode: 'CURATED_VERIFIED',
    coverageStatus: 'PARTIAL',
    coverageStart: null,
    coverageEnd: null,
    lastVerifiedAt: null,
    nextReviewAfter: null,
    verifiedPromiseCount: 0,
    resolvedPromiseCount: 0,
    pendingPromiseCount: 0,
    notes: null,
  };
  return {
    ...base,
    dataMode: 'CURATED_VERIFIED',
    // Never auto-upgrade to COMPLETE -- whether coverage is genuinely
    // complete is a human judgment about the disclosure history, not just a
    // promise count.
    coverageStatus: base.coverageStatus === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL',
    verifiedPromiseCount: promiseRecords.length,
    resolvedPromiseCount: resolved.length,
    pendingPromiseCount: pending.length,
    lastVerifiedAt: new Date().toISOString().slice(0, 10),
  };
};

const toPromotedRecord = (candidateDoc) => {
  const { reviewStatus, reviewedBy, reviewedAt, _id, __v, createdAt, updatedAt, ...rest } = candidateDoc;
  return rest;
};

/**
 * acceptCandidate - the sole promotion path. Requires a valid `secret`
 * (see isAuthorized) or it refuses immediately without reading/writing
 * anything.
 *
 * Phase 4F Task 5: promotion additionally REQUIRES an explicit
 * `evidenceIntegrity` assertion from the reviewer (`{status, notes}`,
 * status one of PUBLIC_SAFE_EVIDENCE_STATUSES) -- a candidate is never
 * promoted "unaudited and hope it's fine." This is what
 * isPubliclyVisibleRecord (utils/earningsIntelligenceValidation.js) later
 * checks before the record can ever appear in a public timeline, so a
 * promotion that skipped this step would otherwise silently produce an
 * invisible record rather than an obviously-refused one.
 */
export const acceptCandidate = async (symbol, candidateId, { reviewer, secret, evidenceIntegrity } = {}) => {
  if (!isAuthorized(secret)) {
    return { ok: false, error: 'Unauthorized: EARNINGS_REVIEW_SECRET is not set, or the provided secret does not match.' };
  }
  if (!reviewer) {
    return { ok: false, error: 'A --reviewer name is required for the audit trail.' };
  }
  if (!evidenceIntegrity?.status || !PUBLIC_SAFE_EVIDENCE_STATUSES.includes(evidenceIntegrity.status)) {
    return { ok: false, error: `Refusing to promote "${candidateId}": an explicit evidenceIntegrity.status of ${PUBLIC_SAFE_EVIDENCE_STATUSES.join(' or ')} is required to assert the promise/outcome evidence was re-verified against real primary-source text (Phase 4F Task 5). Use rejectCandidate with a reason instead if it fails verification.` };
  }

  const candidate = await PromiseCandidate.findOne({ symbol, id: candidateId }).lean();
  if (!candidate) {
    return { ok: false, error: `No candidate with id "${candidateId}" found for ${symbol}.` };
  }
  if (candidate.reviewStatus === 'REJECTED') {
    return { ok: false, error: `Candidate "${candidateId}" was previously REJECTED. Re-run generation to produce a fresh candidate instead of forcing this one through.` };
  }

  const promisesFilePath = path.join(PROMISES_DIR, `${symbol}.json`);
  const promisesFile = readJson(promisesFilePath, { _meta: { symbol, schema: '../schemas/managementPromise.schema.json' }, records: [] });
  const alreadyPromoted = promisesFile.records.some((r) => r.id === candidateId);

  if (candidate.reviewStatus === 'ACCEPTED' && alreadyPromoted) {
    return { ok: true, idempotent: true, message: `Candidate "${candidateId}" was already accepted for ${symbol}. No changes made.` };
  }

  const promoted = {
    ...toPromotedRecord(candidate),
    evidenceIntegrity: {
      status: evidenceIntegrity.status,
      auditedAt: new Date().toISOString().slice(0, 10),
      auditedBy: reviewer,
      notes: evidenceIntegrity.notes || null,
    },
  };
  const { valid, errors } = validateManagementPromiseRecord(promoted, { symbol, allowDemo: false });
  if (!valid) {
    return { ok: false, error: `Refusing to promote "${candidateId}": fails validateManagementPromiseRecord: ${errors.join('; ')}` };
  }

  if (!alreadyPromoted) {
    promisesFile.records.push(promoted);
    writeJson(promisesFilePath, promisesFile);
  }

  // Best-effort companies.json update -- never blocks or fails the acceptance itself.
  let companyOverride = null;
  try {
    const companiesFile = readJson(COMPANIES_FILE, { companies: [] });
    const existingIndex = companiesFile.companies.findIndex((c) => c.symbol === symbol);
    companyOverride = buildCompanyOverride(symbol, existingIndex >= 0 ? companiesFile.companies[existingIndex] : null, promisesFile.records);
    const companyValidation = validateCuratedCompanyRecord(companyOverride);
    if (companyValidation.valid) {
      if (existingIndex >= 0) companiesFile.companies[existingIndex] = companyOverride;
      else companiesFile.companies.push(companyOverride);
      writeJson(COMPANIES_FILE, companiesFile);
    } else {
      logger.warn(`[earnings:review] companies.json update skipped for ${symbol}: ${companyValidation.errors.join('; ')}`);
    }
  } catch (err) {
    logger.warn(`[earnings:review] companies.json update failed for ${symbol}: ${err.message}`);
  }

  await PromiseCandidate.updateOne({ symbol, id: candidateId }, { reviewStatus: 'ACCEPTED', reviewedBy: reviewer, reviewedAt: new Date() });

  reloadCuratedDataset(); // refreshes this process's JSON-file cache; harmless no-op for a separate running server process

  return {
    ok: true,
    idempotent: false,
    message: `Accepted "${candidateId}" for ${symbol}.`,
    promisesFileRecordCount: promisesFile.records.length,
    companyOverride,
  };
};

/**
 * rejectCandidate - `reason` (Phase 4F) is an optional, machine-readable
 * explanation for WHY the candidate failed review -- required by this
 * project's evidence-integrity policy ("candidates failing any requirement
 * must remain pending or be rejected with a reason"), stored in the
 * candidate's own `verification.notes` field (never a new field the
 * validator doesn't already know about) so it survives alongside the
 * existing audit trail (reviewedBy/reviewedAt) rather than being a second,
 * disconnected place to look.
 */
export const rejectCandidate = async (symbol, candidateId, { reviewer, secret, reason = null } = {}) => {
  if (!isAuthorized(secret)) {
    return { ok: false, error: 'Unauthorized: EARNINGS_REVIEW_SECRET is not set, or the provided secret does not match.' };
  }
  if (!reviewer) {
    return { ok: false, error: 'A --reviewer name is required for the audit trail.' };
  }

  const candidate = await PromiseCandidate.findOne({ symbol, id: candidateId }).lean();
  if (!candidate) {
    return { ok: false, error: `No candidate with id "${candidateId}" found for ${symbol}.` };
  }

  const update = { reviewStatus: 'REJECTED', reviewedBy: reviewer, reviewedAt: new Date() };
  if (reason) update['verification.notes'] = reason;
  await PromiseCandidate.updateOne({ symbol, id: candidateId }, update);
  return { ok: true, message: `Rejected "${candidateId}" for ${symbol}${reason ? ` (${reason})` : ''}. It will never be promoted; re-run generation for a fresh candidate.` };
};

/** Read-only -- listing candidates does not require the secret, only mutating actions do. */
export const listCandidates = async (symbol) => {
  const records = await listCandidatesForSymbol(symbol);
  return records;
};

const parseArgs = (argv) => {
  const args = {
    symbol: null, secret: null, reviewer: null, accept: null, reject: null, list: false,
    evidenceStatus: null, reason: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--symbol=')) args.symbol = arg.replace('--symbol=', '').trim().toUpperCase();
    else if (arg.startsWith('--secret=')) args.secret = arg.replace('--secret=', '');
    else if (arg.startsWith('--reviewer=')) args.reviewer = arg.replace('--reviewer=', '').trim();
    else if (arg.startsWith('--accept=')) args.accept = arg.replace('--accept=', '').trim();
    else if (arg.startsWith('--reject=')) args.reject = arg.replace('--reject=', '').trim();
    else if (arg.startsWith('--evidence-status=')) args.evidenceStatus = arg.replace('--evidence-status=', '').trim();
    else if (arg.startsWith('--reason=')) args.reason = arg.replace('--reason=', '').trim();
    else if (arg === '--list') args.list = true;
  }
  return args;
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  args.secret = resolveSecret(args.secret);
  if (!args.symbol) {
    console.error('Usage: npm run earnings:review -- --secret=<secret> --symbol=TCS [--list | --accept=<id> --reviewer=<name> --evidence-status=<VERIFIED_PRIMARY|VERIFIED_EXCHANGE_COPY> [--reason=<notes>] | --reject=<id> --reviewer=<name> [--reason=<notes>]]');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
  if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

  if (args.list) {
    const candidates = await listCandidates(args.symbol);
    if (!candidates.length) {
      console.log(`No candidates on file for ${args.symbol}. Run: npm run earnings:candidates -- --symbol=${args.symbol}`);
    } else {
      console.log(`Candidates for ${args.symbol}:`);
      for (const record of candidates) {
        console.log(`  [${record.reviewStatus}] ${record.id} -- ${record.promise.category} ${record.promise.targetPeriod} -- outcome: ${record.outcome.status}`);
      }
    }
  } else if (args.accept) {
    const result = await acceptCandidate(args.symbol, args.accept, {
      reviewer: args.reviewer, secret: args.secret,
      evidenceIntegrity: args.evidenceStatus ? { status: args.evidenceStatus, notes: args.reason } : undefined,
    });
    console.log(result.ok ? (result.message || 'Accepted.') : `ERROR: ${result.error}`);
    if (!result.ok) process.exitCode = 1;
  } else if (args.reject) {
    const result = await rejectCandidate(args.symbol, args.reject, { reviewer: args.reviewer, secret: args.secret, reason: args.reason });
    console.log(result.ok ? result.message : `ERROR: ${result.error}`);
    if (!result.ok) process.exitCode = 1;
  } else {
    console.error('Specify one of --list, --accept=<id>, or --reject=<id>.');
    process.exitCode = 1;
  }

  await mongoose.disconnect();
  process.exit(process.exitCode || 0);
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  run().catch((err) => {
    logger.error(`[earnings:review] Failed: ${err.message}`);
    console.error('Review command failed:', err.message);
    process.exit(1);
  });
}
