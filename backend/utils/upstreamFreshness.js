/**
 * upstreamFreshness.js
 * =====================
 * Pure classification of an upstream scheduled job's health from its
 * ScheduledJobRun document (services/ScheduledJobRunService.js getStatus).
 * REPORTING ONLY: scripts/reevaluatePromises.js logs this and records it in
 * its own run stats so a run made on stale/failed upstream data is visible
 * after the fact. It never gates, skips or alters any outcome evaluation.
 */

/** Job names as built by earningsXbrlBatch.js / collectNseTranscripts.js from render.yaml's --label flags. */
export const UPSTREAM_JOB_NAMES = Object.freeze({
  xbrlRefresh: 'xbrl-batch:cron-xbrl-refresh',
  transcriptRefresh: 'transcripts-batch:cron-transcript-refresh',
});

/**
 * Both upstream crons run weekly (render.yaml). 10 days = one 7-day cycle
 * plus a 3-day buffer for a late or slow run, so a single on-schedule run
 * always reads FRESH and one missed cycle reads STALE.
 */
export const DEFAULT_FRESH_WITHIN_MS = 10 * 24 * 60 * 60 * 1000;

export const UPSTREAM_FRESHNESS = Object.freeze(['FRESH', 'STALE', 'FAILED', 'NEVER_RUN']);

const toTime = (value) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * classifyUpstreamFreshness - pure.
 *   NEVER_RUN  no record, or a record that has never completed (e.g. its
 *              very first run is still RUNNING): nothing has succeeded or failed.
 *   FAILED     the most recent completion is a failure (a failure newer than
 *              the last success, or a failure with no success ever).
 *   FRESH      last success within `freshWithinMs` of `now`.
 *   STALE      has succeeded before, but not within the window.
 */
export const classifyUpstreamFreshness = (jobRun, { now = new Date(), freshWithinMs = DEFAULT_FRESH_WITHIN_MS } = {}) => {
  if (!jobRun) return 'NEVER_RUN';
  const success = toTime(jobRun.lastSuccessAt);
  const failure = toTime(jobRun.lastFailureAt);
  if (success === null && failure === null) return 'NEVER_RUN';
  if (failure !== null && (success === null || failure > success)) return 'FAILED';
  return toTime(now) - success <= freshWithinMs ? 'FRESH' : 'STALE';
};

/** describeUpstreamFreshness - the {status, lastSuccessAt} shape stored in run stats. */
export const describeUpstreamFreshness = (jobRun, options = {}) => ({
  status: classifyUpstreamFreshness(jobRun, options),
  lastSuccessAt: jobRun?.lastSuccessAt ? new Date(jobRun.lastSuccessAt).toISOString() : null,
});
