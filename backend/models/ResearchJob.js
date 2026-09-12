import mongoose from 'mongoose';

/**
 * ResearchJob
 * =============
 * Persistent (MongoDB-backed) unit of work for the universe-scale backfill
 * runner -- one job per (symbol, jobType, fromYear, toYear). Render's
 * filesystem is ephemeral, so job/queue state must live in Mongo, not
 * process memory, for a batch to be resumable across restarts.
 */
export const JOB_STATUSES = [
  'QUEUED', 'DISCOVERING', 'DOWNLOADING', 'EXTRACTING', 'VERIFYING',
  'COMPLETED', 'PARTIAL', 'FAILED_RETRYABLE', 'FAILED_PERMANENT',
];

export const ACTIVE_STATUSES = ['QUEUED', 'DISCOVERING', 'DOWNLOADING', 'EXTRACTING', 'VERIFYING'];
export const TERMINAL_STATUSES = ['COMPLETED', 'PARTIAL', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'];

const researchJobSchema = new mongoose.Schema({
  symbol: { type: String, required: true, uppercase: true, index: true },
  jobType: { type: String, enum: ['HISTORICAL_FACTS_BACKFILL'], default: 'HISTORICAL_FACTS_BACKFILL' },
  fromYear: { type: Number, required: true },
  toYear: { type: Number, required: true },
  status: { type: String, enum: JOB_STATUSES, default: 'QUEUED', index: true },
  priority: { type: Number, default: 0, index: true }, // higher runs first (featured companies get a high fixed priority, others by market cap)
  attempt: { type: Number, default: 0 },
  currentStage: { type: String, default: null }, // e.g. "FY2024" -- which year the resumable cursor is on
  processedDocuments: { type: Number, default: 0 },
  failedDocuments: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  cursor: {
    lastCompletedYear: { type: Number, default: null }, // years <= this are done; resume starts at lastCompletedYear+1
  },
}, { timestamps: true });

// Only one ACTIVE job per (symbol, jobType, fromYear, toYear) at a time --
// a completed/failed job for the same range can be superseded by a new one
// (e.g. a --force retry), so this is a partial unique index over active
// statuses only, not a blanket uniqueness constraint.
researchJobSchema.index(
  { symbol: 1, jobType: 1, fromYear: 1, toYear: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } }, name: 'unique_active_job_per_symbol_range' },
);
researchJobSchema.index({ status: 1, priority: -1 });

export const ResearchJob = mongoose.models.ResearchJob || mongoose.model('ResearchJob', researchJobSchema);

export default ResearchJob;
