import mongoose from 'mongoose';

/**
 * BootstrapRunLog
 * =================
 * One document per named production-bootstrap stage (see
 * scripts/productionBootstrap.js). Updated in place on every run of that
 * stage (not append-only) so `--resume`/`--status-only` can answer "did
 * this stage already succeed, and for which symbols" without re-deriving
 * it from the underlying data collections themselves. `history` keeps the
 * last few attempts for basic auditability without the document growing
 * unbounded.
 */
const attemptSchema = new mongoose.Schema({
  startedAt: Date,
  finishedAt: Date,
  status: { type: String, enum: ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'], required: true },
  dryRun: { type: Boolean, default: false },
  provider: { type: String, default: null },
  datasetTimestamp: { type: Date, default: null },
  symbolsRequested: { type: [String], default: [] },
  symbolsSucceeded: { type: [String], default: [] },
  symbolsFailed: { type: [{ symbol: String, reason: String }], default: [] },
  counts: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const bootstrapRunLogSchema = new mongoose.Schema({
  stage: { type: String, required: true, unique: true, index: true },
  lastAttempt: { type: attemptSchema, default: null },
  history: { type: [attemptSchema], default: [] },
}, { timestamps: true });

const MAX_HISTORY = 10;

bootstrapRunLogSchema.statics.recordAttempt = async function recordAttempt(stage, attempt) {
  const doc = await this.findOneAndUpdate(
    { stage },
    {
      $set: { lastAttempt: attempt },
      $push: { history: { $each: [attempt], $slice: -MAX_HISTORY } },
    },
    { upsert: true, new: true },
  );
  return doc;
};

export const BootstrapRunLog = mongoose.models.BootstrapRunLog || mongoose.model('BootstrapRunLog', bootstrapRunLogSchema);

export default BootstrapRunLog;
