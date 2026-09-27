import crypto from 'node:crypto';
import ScheduledJobRun from '../models/ScheduledJobRun.js';

/** Default: a run that hasn't heartbeat in 90 minutes is presumed crashed (never a graceful exit), not still in flight. */
export const DEFAULT_STALE_AFTER_MS = 90 * 60 * 1000;

/**
 * claimRun - overlap protection. Atomically starts a RUNNING record for
 * `jobName` unless one is already RUNNING and recently heartbeat (or started,
 * if it never got to heartbeat once). A genuinely crashed run (no heartbeat
 * within `staleAfterMs`) is reclaimable, so a killed container does not wedge
 * the job forever. Relies on the unique index on `jobName`: if two processes
 * race to claim a job that has never run before, one insert wins and the
 * other gets a duplicate-key error, which is treated the same as "already
 * running".
 */
export const claimRun = async (jobName, { staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const runId = crypto.randomUUID();
  try {
    const claimed = await ScheduledJobRun.findOneAndUpdate(
      {
        jobName,
        $or: [
          { status: { $ne: 'RUNNING' } },
          { heartbeatAt: { $lt: staleBefore } },
          { heartbeatAt: null, startedAt: { $lt: staleBefore } },
        ],
      },
      {
        $set: {
          status: 'RUNNING', runId, startedAt: now, heartbeatAt: now, finishedAt: null, checkpoint: null,
        },
      },
      { upsert: true, new: true },
    );
    return { ok: true, runId, doc: claimed };
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await ScheduledJobRun.findOne({ jobName }).lean();
      return { ok: false, reason: 'ALREADY_RUNNING', existing };
    }
    throw error;
  }
};

/** heartbeat - records progress on the run this process holds. A no-op if a newer run has since claimed the job (this process's runId is stale). */
export const heartbeat = async (jobName, runId, checkpoint) => {
  await ScheduledJobRun.updateOne({ jobName, runId }, { $set: { heartbeatAt: new Date(), checkpoint } });
};

/**
 * completeRun - marks the run SUCCESS or FAILED and updates the job's
 * last-success/last-failure record. Guarded by runId so a run that lost its
 * claim (superseded by a reclaim after going stale) cannot overwrite a newer
 * run's status.
 */
export const completeRun = async (jobName, runId, { status, stats = null, error = null } = {}) => {
  const now = new Date();
  const set = { status, finishedAt: now, heartbeatAt: now };
  if (status === 'SUCCESS') { set.lastSuccessAt = now; set.lastSuccessStats = stats; }
  else { set.lastFailureAt = now; set.lastFailureError = error; }
  const result = await ScheduledJobRun.updateOne({ jobName, runId }, { $set: set });
  return { ok: result.matchedCount > 0 };
};

/** getStatus - read-only, for a status page or API: the current/last state of one scheduled job, or null if it has never run. */
export const getStatus = async (jobName) => ScheduledJobRun.findOne({ jobName }).lean();

/** getAllStatuses - read-only, for a data-quality/ops status view of every scheduled job. */
export const getAllStatuses = async () => ScheduledJobRun.find({}).sort({ jobName: 1 }).lean();
