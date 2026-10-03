import mongoose from 'mongoose';

/**
 * PromiseCandidate
 * =================
 * Machine-generated, human-reviewed draft Management Faith Score records.
 *
 * WHY MONGO, NOT A JSON FILE: this project's backend deploys to Render,
 * whose filesystem is ephemeral -- anything an automated job writes to a
 * local file (not committed to git) is lost on the next restart/redeploy.
 * Candidates are generated at runtime (PromiseCandidateService.js) and
 * reviewed at runtime (scripts/earningsReview.js), so they must live in the
 * database, not in backend/data/earnings-intelligence/. The hand-curated
 * promises/<SYMBOL>.json files remain JSON on purpose -- they are edited
 * once by a human and committed to git, so they redeploy correctly.
 *
 * Mirrors the managementPromise.schema.json shape used by the curated JSON
 * files field-for-field (promise/outcome/promiseEvidence/outcomeEvidence/
 * verification), plus reviewStatus + reviewer metadata. This lets
 * CuratedEarningsIntelligenceService merge an ACCEPTED candidate into the
 * exact same "record" shape it already uses for JSON-file records, and lets
 * scripts/earningsReview.js re-validate a candidate with the SAME
 * validateManagementPromiseRecord used for the JSON files before promoting it.
 *
 * reviewStatus:
 *   PENDING_REVIEW - generated, not yet visible to any public API.
 *   ACCEPTED       - promoted; CuratedEarningsIntelligenceService includes
 *                    it in getCompanyPromises/getCompanyTimeline, where it
 *                    can contribute to the Faith Score exactly like a
 *                    promises/<SYMBOL>.json record.
 *   REJECTED       - permanently excluded; never promoted again under this id.
 */
const promiseCandidateSchema = new mongoose.Schema({
  // Human-readable id, e.g. "TCS-FY2026-CAND-001" -- distinct from Mongo's
  // own _id, and the same id namespace convention used by JSON records
  // (managementPromise.schema.json requires "<SYMBOL>-...-<3-digit-seq>").
  id: { type: String, required: true, unique: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
  dataMode: { type: String, enum: ['CURATED_VERIFIED'], default: 'CURATED_VERIFIED' },
  reviewStatus: { type: String, enum: ['PENDING_REVIEW', 'ACCEPTED', 'REJECTED'], default: 'PENDING_REVIEW', index: true },

  promise: {
    statement: { type: String, required: true },
    originalExcerpt: { type: String, default: null },
    category: { type: String, required: true },
    promiseDate: { type: String, required: true }, // ISO date-only string (YYYY-MM-DD), matching the JSON schema
    targetPeriod: { type: String, required: true },
    targetType: { type: String, required: true },
    targetValue: { type: Number, default: null },
    targetUnit: { type: String, default: null },
    operator: { type: String, required: true },
    // Additive, optional (null on every pre-existing candidate):
    // - targetValueMax: RANGE upper bound (targetValue is the low bound).
    // - metric: the precise extracted metric (e.g. EBITDA_MARGIN), which the
    //   coarse `category` cannot recover; used by scripts/reevaluatePromises.js.
    // - revisesPromiseId: id of the earlier promise (same metric + target
    //   period) this one revises -- see services/PromisesVsActualsService.js.
    targetValueMax: { type: Number, default: null },
    metric: { type: String, default: null },
    revisesPromiseId: { type: String, default: null },
    // v2 extraction (null on earlier candidates): what the target covers and on which basis, as the
    // speaker stated it -- used to refuse a comparison with a figure of a different scope or basis.
    scope: { type: String, default: null }, // COMPANY | SEGMENT
    segment: { type: String, default: null },
    reportingBasis: { type: String, default: null }, // CONSOLIDATED | STANDALONE (null = not stated)
    currencyBasis: { type: String, default: null }, // CONSTANT_CURRENCY | REPORTED_CURRENCY (null = not stated)
    metricDefinition: { type: String, default: null },
    speaker: { type: String, default: null }, // MANAGEMENT for every v2 candidate (others are dropped)
  },
  // Which extraction produced this record: null = v1 (no precise metric, no range upper bound, no speaker
  // check); 'v2' = services/PromiseExtractionService.js PROMPT_VERSION promise-extraction-v2.
  extractionVersion: { type: String, default: null, index: true },
  // Result of the deterministic evidence-review gate (scripts/autoReviewCandidates.js): why a candidate was
  // promoted, or the specific reasons it stays pending for a human. Rewritten on each gate run.
  autoReview: {
    type: new mongoose.Schema({
      checkedAt: { type: Date, default: null },
      decision: { type: String, default: null }, // ACCEPTED | KEPT_PENDING | REITERATION
      reasons: { type: [String], default: [] },
      groupKey: { type: String, default: null },
      reiterationOf: { type: String, default: null },
      sourceVerified: { type: Boolean, default: null },
    }, { _id: false }),
    default: null,
  },

  outcome: {
    // Valid values: utils/earningsIntelligenceValidation.js OUTCOME_STATUSES
    // (ACHIEVED, EXCEEDED, PARTIAL [read-only legacy], MISSED, PENDING,
    // INSUFFICIENT_EVIDENCE, QUALITATIVE_ONLY).
    status: { type: String, required: true },
    actualValue: { type: Number, default: null },
    actualUnit: { type: String, default: null },
    evaluationDate: { type: String, default: null },
    explanation: { type: String, default: null },
  },

  promiseEvidence: {
    sourceTitle: { type: String, required: true },
    sourceType: { type: String, required: true },
    sourceUrl: { type: String, required: true },
    publishedAt: { type: String, required: true },
    pageNumber: { type: Number, default: null },
    excerpt: { type: String, required: true },
  },

  outcomeEvidence: {
    type: new mongoose.Schema({
      sourceTitle: { type: String, required: true },
      sourceType: { type: String, required: true },
      sourceUrl: { type: String, required: true },
      publishedAt: { type: String, required: true },
      pageNumber: { type: Number, default: null },
      excerpt: { type: String, required: true },
    }, { _id: false }),
    default: null,
  },

  verification: {
    verifiedAt: { type: String, required: true },
    verifiedBy: { type: String, required: true, default: 'AUTOMATED_CANDIDATE_GENERATOR' },
    evidenceConfidence: { type: Number, required: true, min: 0, max: 1 },
    notes: { type: String, default: null },
  },

  // Reviewer metadata -- who accepted/rejected this candidate and when.
  // Distinct from verification.verifiedBy, which always names the automated
  // generator; these two fields are null until a human acts on the record.
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  // The reviewer's evidence assertion, written by acceptCandidate (scripts/earningsReview.js) together with
  // reviewStatus ACCEPTED. Kept on the document so an accepted record is durably public from the database
  // (isPubliclyVisibleRecord requires it) even where the committed promises/<SYMBOL>.json copy cannot be
  // written -- e.g. a scheduled job on Render's ephemeral filesystem. Null until accepted.
  evidenceIntegrity: {
    type: new mongoose.Schema({
      status: { type: String, default: null },
      auditedAt: { type: String, default: null },
      auditedBy: { type: String, default: null },
      notes: { type: String, default: null },
    }, { _id: false }),
    default: null,
  },

  // Additive audit trail written ONLY by scripts/reevaluatePromises.js. For a
  // PENDING_REVIEW candidate the job also updates `outcome` directly (it is
  // not public yet and a human still reviews it). For an ACCEPTED candidate a
  // human decision is never overwritten: the freshly computed result is
  // stored here as `proposedOutcome` for the reviewer, and `outcome` is left
  // untouched.
  //
  // Additive fields (all defaulted, so every pre-existing document reads unchanged):
  // - locked/lockedBy/lockedAt/lockReason: an explicit human-review lock set
  //   ONLY by scripts/earningsReview.js --lock / --unlock. A locked candidate
  //   is never selected by the re-evaluation job, whatever its status. Distinct
  //   from REJECTED (terminal) and ACCEPTED (still receives proposals).
  // - evidenceHash: sha256 fingerprint of the cheap tier-(a) CompanyHistoricalFact
  //   match (or the literal 'NO_TIER_A_MATCH'), used to detect evidence drift on
  //   completed outcomes without re-running the costly lookup tiers every week.
  // - evidenceHashCheckedAt: when that fingerprint was last recomputed (rotation
  //   key so a bounded batch cycles through every completed candidate).
  // - history: append-only audit trail of every outcome change (applied or only
  //   proposed), with the previous/new outcome and evidence fingerprint. Entries
  //   are only ever $push-ed, never rewritten or removed.
  reevaluation: {
    type: new mongoose.Schema({
      lastRunAt: { type: Date, default: null },
      result: { type: String, default: null }, // canonical outcome (MET/EXCEEDED/MISSED/PENDING/INSUFFICIENT_EVIDENCE/QUALITATIVE_ONLY)
      reason: { type: String, default: null },
      appliedToOutcome: { type: Boolean, default: false },
      proposedOutcome: { type: mongoose.Schema.Types.Mixed, default: null },
      proposedOutcomeEvidence: { type: mongoose.Schema.Types.Mixed, default: null },
      runId: { type: String, default: null },
      locked: { type: Boolean, default: false },
      lockedBy: { type: String, default: null },
      lockedAt: { type: Date, default: null },
      lockReason: { type: String, default: null },
      evidenceHash: { type: String, default: null },
      evidenceHashCheckedAt: { type: Date, default: null },
      history: {
        type: [new mongoose.Schema({
          at: { type: Date, required: true },
          trigger: { type: String, enum: ['EVIDENCE_DRIFT', 'OPEN_STATUS_RECHECK'], required: true },
          previousOutcome: { type: String, default: null },
          previousEvidenceHash: { type: String, default: null },
          newOutcome: { type: String, default: null },
          newEvidenceHash: { type: String, default: null },
          reason: { type: String, default: null },
          applied: { type: Boolean, default: false },
        }, { _id: false })],
        default: [],
      },
    }, { _id: false }),
    default: null,
  },
}, { timestamps: true });

// A generation run over the same source documents must never create a
// duplicate candidate for the same symbol / period / metric / scope / evidence
// URL. The precise metric and scope are part of the key: the earlier key
// (symbol, period, coarse category, URL) made two different targets from one
// transcript -- e.g. a gross-margin and an EBITDA-margin target, both category
// MARGIN -- overwrite each other. v1 records carry metric/scope null, so they
// keep exactly their old uniqueness. scripts/migratePromiseCandidateIndex.js
// replaces the old index on an existing database.
export const CANDIDATE_UNIQUE_INDEX_NAME = 'unique_candidate_per_symbol_period_category_metric_scope_source';
export const LEGACY_CANDIDATE_UNIQUE_INDEX_NAME = 'unique_candidate_per_symbol_period_category_source';
promiseCandidateSchema.index(
  {
    symbol: 1, 'promise.targetPeriod': 1, 'promise.category': 1, 'promise.metric': 1, 'promise.scope': 1, 'promise.segment': 1, 'promiseEvidence.sourceUrl': 1,
  },
  { unique: true, name: CANDIDATE_UNIQUE_INDEX_NAME },
);

export default mongoose.models.PromiseCandidate || mongoose.model('PromiseCandidate', promiseCandidateSchema);
