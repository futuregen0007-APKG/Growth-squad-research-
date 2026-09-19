import mongoose from 'mongoose';

const managementPromiseSchema = new mongoose.Schema({
  dataOrigin: {
    type: String,
    enum: ['REAL_RESEARCH', 'SEEDED_DEMO'],
    default: 'REAL_RESEARCH',
    index: true,
  },
  companyId: { type: String, required: true, trim: true },
  symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
  companyName: { type: String, required: true, trim: true },

  // Set only for records imported from the curated file-based dataset
  // (backend/data/earnings-intelligence/promises/*.json) via `npm run
  // earnings:import`. Lets that script upsert idempotently instead of
  // blindly inserting, without disturbing any other ManagementPromise
  // documents (e.g. ones produced by the live DocumentResearchService
  // pipeline, which never set this field).
  curatedRecordId: { type: String, default: null, index: true, sparse: true },

  // Phase 4F/4F.1: Earnings Evidence Integrity Audit. Optional/additive --
  // mirrors the same shape (and the same status enum) as a curated JSON
  // record's own evidenceIntegrity field (see
  // utils/earningsIntelligenceValidation.js). Phase 4F.1 correction: this
  // now fails CLOSED everywhere, exactly like a curated JSON record --
  // isPubliclyVisibleRecord (the ONE shared predicate; the earlier,
  // separate isPubliclyVisiblePromise that failed OPEN for this
  // collection has been removed) requires an EXPLICIT VERIFIED_PRIMARY/
  // VERIFIED_EXCHANGE_COPY status before a document is visible in
  // getCompanyPromises/getCompanyTimeline or the grounded evidence
  // envelope. scripts/migrateEvidenceIntegrity.js backfills every
  // pre-existing REAL_RESEARCH document missing this field to
  // UNREVIEWED_LEGACY (itself NOT public-safe) rather than leaving it
  // null, so "never audited" is an explicit, auditable state rather than
  // silent absence.
  evidenceIntegrity: {
    status: {
      type: String,
      enum: [
        'VERIFIED_PRIMARY', 'VERIFIED_EXCHANGE_COPY', 'UNREVIEWED_LEGACY', 'SOURCE_UNAVAILABLE', 'PROVENANCE_INCOMPLETE',
        'CLAIM_NOT_FOUND', 'VALUE_MISMATCH', 'PERIOD_MISMATCH', 'UNSUPPORTED', 'QUARANTINED', null,
      ],
      default: null,
    },
    auditedAt: { type: Date, default: null },
    auditedBy: { type: String, default: null },
    notes: { type: String, default: null },
    // Phase 4F.1 migration audit trail (Part 3: "records migration
    // version and timestamp") -- set only by
    // scripts/migrateEvidenceIntegrity.js, never by a manual audit action
    // (those set auditedAt/auditedBy/notes above instead), so a reviewer
    // can always tell a migrated-default apart from an actually-reviewed
    // record even though both currently share status UNREVIEWED_LEGACY
    // immediately after a first migration run.
    migrationVersion: { type: String, default: null },
    migratedAt: { type: Date, default: null },
  },
  
  // Promise details
  promise: {
    statement: { type: String, required: true },
    metric: { 
      type: String, 
      required: true, 
      enum: [
        'REVENUE', 'REVENUE_GROWTH', 'EBITDA', 'EBITDA_MARGIN', 'PAT', 'PAT_GROWTH',
        'ORDER_BOOK', 'ORDER_INTAKE', 'ARR', 'BOOKINGS', 'CAPEX', 'DEBT', 'DEBT_REDUCTION',
        'MARGIN', 'MARKET_SHARE', 'CUSTOMER_COUNT', 'EMPLOYEE_COUNT', 'EMPLOYEE_PERCENTAGE', 'FREE_CASH_FLOW',
          'LARGE_DEALS', 'EXPORT_REVENUE', 'NIM', 'CREDIT_GROWTH', 'DEPOSIT_GROWTH', 'CASA',
          'OTHER_QUANTIFIABLE', 'OTHER'
      ] 
    },
    targetValue: { type: Number, required: true },
    targetUnit: { type: String, required: true, enum: ['INR_CRORE', 'INR_LAKH', 'USD_MILLION', 'USD_BILLION', 'PERCENTAGE', 'COUNT', 'OTHER'] },
    targetPeriod: { type: String, required: true }, // e.g., "FY2026", "Q4 FY2025"
    promiseDate: { type: Date, required: true },
    direction: { type: String, enum: ['AT_LEAST', 'AT_MOST', 'RANGE', 'EXACT', 'GROWTH', 'OTHER', 'HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'TARGET_RANGE'], default: null },
    operator: { type: String, enum: ['GTE', 'LTE', 'EQ', 'RANGE'], default: null },
    importance: { type: String, required: true, enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' }
  },
  
  // Outcome details
  outcome: {
    actualValue: { type: Number, default: null },
    actualUnit: { type: String, default: null },
    actualPeriod: { type: String, default: null },
    statement: { type: String, default: null },
    sourceUrl: { type: String, default: null },
    sourceDate: { type: Date, default: null },
    excerpt: { type: String, default: null },
    // Additive, provider-neutral provenance for the outcome value itself
    // (as opposed to evidence.outcomeSource, which describes a citable
    // document). `provider` names a data provider (e.g. 'indian-api',
    // 'document-research', 'news-api') — never presented as the original
    // filing publisher. evidenceRecords holds any additional supporting
    // OutcomeEvidence records beyond the single value used for scoring
    // (Phase 11: "multiple outcome evidence records").
    evidenceType: {
      type: String,
      enum: ['FINANCIAL_ACTUAL', 'KEY_METRIC', 'CORPORATE_ACTION', 'SHAREHOLDING_CHANGE', 'ANALYST_SNAPSHOT', 'COMPANY_NEWS', 'DOCUMENT_EVIDENCE', null],
      default: null
    },
    provider: { type: String, default: null },
    evidenceRecords: { type: [mongoose.Schema.Types.Mixed], default: undefined }
  },

  // Verification details
  verification: {
    achievementPercentage: { type: Number, default: null },
    status: { type: String, enum: ['FULFILLED', 'EXCEEDED', 'PARTIALLY_FULFILLED', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE'], default: 'INSUFFICIENT_EVIDENCE' },
    calculationExplanation: { type: String, default: null },
    confidence: { type: Number, default: null, min: 0, max: 1 },
    // Additive Phase 10/11 fields — optional, backward compatible with
    // existing records (absent = not yet evaluated for these dimensions).
    evidenceQuality: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', null], default: null },
    hasConflictingEvidence: { type: Boolean, default: false },
    conflictDetails: { type: String, default: null },
    verifiedAt: { type: Date, default: null }
  },
  
  // Explanation details
  explanation: {
    managementExplanation: { type: String, default: null },
    category: { 
      type: String, 
      enum: [
        'DEMAND_WEAKNESS', 'EXECUTION_DELAY', 'CUSTOMER_DELAY', 'MACROECONOMIC', 
        'REGULATORY', 'COMPETITIVE_PRESSURE', 'COMPETITION', 'CURRENCY', 'ACQUISITION', 
        'ONE_OFF', 'CAPACITY_CONSTRAINT', 'MANAGEMENT_REVISED_GUIDANCE', 'PROJECT_DELAY', 
        'INTERNAL_EXECUTION', 'TIMING', 'UNSPECIFIED', 'OTHER', 'NO_EXPLANATION_FOUND'
      ], 
      default: 'NO_EXPLANATION_FOUND' 
    },
    sourceUrl: { type: String, default: null },
    sourceDate: { type: Date, default: null },
    excerpt: { type: String, default: null }
  },
  
  // Evidence sources
  evidence: {
    promiseSource: {
      sourceType: { type: String, default: null },
      sourceName: { type: String, default: null },
      sourceUrl: { type: String, required: true },
      sourceDate: { type: Date, required: true },
      publicationDate: { type: Date, default: null },
      page: { type: Number, min: 1, default: null },
      title: { type: String, required: true },
      excerpt: { type: String, required: true },
      documentType: { type: String, default: null },
      authorityLevel: { type: Number, default: null }
    },
    outcomeSource: {
      sourceType: { type: String, default: null },
      sourceName: { type: String, default: null },
      sourceUrl: { type: String, default: null },
      sourceDate: { type: Date, default: null },
      publicationDate: { type: Date, default: null },
      title: { type: String, default: null },
      excerpt: { type: String, default: null },
      documentType: { type: String, default: null },
      authorityLevel: { type: Number, default: null }
    },
    explanationSource: {
      sourceType: { type: String, default: null },
      sourceName: { type: String, default: null },
      sourceUrl: { type: String, default: null },
      sourceDate: { type: Date, default: null },
      publicationDate: { type: Date, default: null },
      title: { type: String, default: null },
      excerpt: { type: String, default: null },
      documentType: { type: String, default: null },
      authorityLevel: { type: Number, default: null }
    }
  },
  
  // Research linkage
  researchRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResearchRun', default: null },
  
  // Legacy fields for backward compatibility (deprecated)
  exchange: { type: String, default: null },
  financialYear: { type: String, default: null },
  period: { type: String, default: null },
  promiseTitle: { type: String, default: null },
  promiseText: { type: String, default: null },
  promiseDescription: { type: String, default: null },
  promiseType: { type: String, default: null },
  metric: { type: String, default: null },
  metricType: { type: String, default: null },
  targetValue: { type: Number, default: null },
  targetUnit: { type: String, default: null },
  targetPeriod: { type: String, default: null },
  guidanceDate: { type: Date, default: null },
  announcementDate: { type: Date, default: null },
  actualValue: { type: Number, default: null },
  actualUnit: { type: String, default: null },
  actualPeriod: { type: String, default: null },
  actualDate: { type: Date, default: null },
  actualSourceUrl: { type: String, default: null },
  actualSourceTitle: { type: String, default: null },
  actualSourceDate: { type: Date, default: null },
  actualSourceExcerpt: { type: String, default: null },
  achievementPercentage: { type: Number, default: null },
  calculationExplanation: { type: String, default: null },
  status: { type: String, enum: ['FULFILLED', 'EXCEEDED', 'PARTIALLY_FULFILLED', 'MISSED', 'PENDING', 'INSUFFICIENT_EVIDENCE'], default: 'INSUFFICIENT_EVIDENCE' },
  importance: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'], default: 'MEDIUM' },
  sourceType: { type: String, default: null },
  sourceTitle: { type: String, default: null },
  sourceUrl: { type: String, default: null },
  sourceDate: { type: Date, default: null },
  sourceExcerpt: { type: String, default: null },
  confidenceScore: { type: Number, default: null },
  confidence: { type: Number, default: null },
  managementExplanation: { type: String, default: null },
  managementReason: { type: String, default: null },
  reasonType: { type: String, default: null },
  reasonSourceUrl: { type: String, default: null },
  reasonSourceExcerpt: { type: String, default: null },
  aiAnalysis: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

// Indexes for efficient queries
managementPromiseSchema.index({ symbol: 1, 'promise.targetPeriod': -1 });
managementPromiseSchema.index({ symbol: 1, 'verification.status': 1 });
managementPromiseSchema.index({ researchRunId: 1 });

export default mongoose.models.ManagementPromise || mongoose.model('ManagementPromise', managementPromiseSchema);
