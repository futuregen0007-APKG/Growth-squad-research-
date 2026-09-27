import mongoose from 'mongoose';

/**
 * One document per scheduled job name (e.g. "earnings-xbrl-refresh"), holding
 * the durable state a Render Cron Job's own ephemeral disk cannot: whether a
 * run is currently in flight (so a second, overlapping invocation can refuse
 * to start), a checkpoint for the run in progress, and the timestamps/error
 * of the last success and last failure. Runtime-generated data must live
 * here, not in a local file, since a cron job's container disk does not
 * survive between runs.
 */
const scheduledJobRunSchema = new mongoose.Schema({
  jobName: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['RUNNING', 'SUCCESS', 'FAILED'], required: true },
  runId: { type: String, required: true },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  heartbeatAt: { type: Date, default: null },
  checkpoint: { type: mongoose.Schema.Types.Mixed, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastSuccessStats: { type: mongoose.Schema.Types.Mixed, default: null },
  lastFailureAt: { type: Date, default: null },
  lastFailureError: { type: String, default: null },
}, { timestamps: true, collection: 'scheduled_job_runs' });

export default mongoose.models.ScheduledJobRun || mongoose.model('ScheduledJobRun', scheduledJobRunSchema);
