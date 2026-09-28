import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { runBootstrap, BOOTSTRAP_JOB_NAME } from '../scripts/productionBootstrap.js';
import { claimRun, getStatus } from '../services/ScheduledJobRunService.js';
import ScheduledJobRun from '../models/ScheduledJobRun.js';
import BootstrapRunLog from '../models/BootstrapRunLog.js';

/**
 * productionBootstrap.test.js
 * ==============================
 * This is the single orchestrator every stock-data refresh (prices,
 * metrics, profiles, fundamentals, products) runs through -- and the
 * planned automatic-refresh entry point -- but had zero test coverage.
 * These tests cover what was newly added: overlap protection (reusing
 * ScheduledJobRunService, already built/tested for the earnings-intelligence
 * cron jobs) so two scheduled/manual runs can never race on the same
 * collections, and that a run's completion is durably recorded. The
 * `faith-score` stage is used as the exercised path because it is the one
 * real stage that makes no network/DB writes of its own (a documented
 * no-op, see productionBootstrap.js) -- this proves the orchestration
 * wiring itself without needing to mock BSE/NSE/AMFI.
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const cleanup = async () => {
  await ScheduledJobRun.deleteMany({ jobName: BOOTSTRAP_JOB_NAME });
  await BootstrapRunLog.deleteMany({ stage: 'faith-score' });
};

test('a run refuses to start while another run of the same tool is already RUNNING, and touches no stage', async (t) => {
  t.after(cleanup);
  await cleanup();
  const existingClaim = await claimRun(BOOTSTRAP_JOB_NAME);
  assert.equal(existingClaim.ok, true);

  const result = await runBootstrap({
    statusOnly: false, dryRun: false, stage: ['faith-score'], symbols: null, batchSize: 10, resume: false, maxRuntimeMin: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ALREADY_RUNNING');
  assert.equal(result.existing.runId, existingClaim.runId);

  const log = await BootstrapRunLog.findOne({ stage: 'faith-score' }).lean();
  assert.equal(log, null, 'a refused run must never execute or record any stage');
});

test('--no-overlap-guard bypasses the lock entirely, for a deliberate manual override', async (t) => {
  t.after(cleanup);
  await cleanup();
  await claimRun(BOOTSTRAP_JOB_NAME);

  const result = await runBootstrap({
    statusOnly: false, dryRun: false, stage: ['faith-score'], symbols: null, batchSize: 10, resume: false, maxRuntimeMin: 1, noOverlapGuard: true,
  });
  assert.ok(!('ok' in result) || result.ok !== false, 'the override must let the run proceed despite the existing claim');
  assert.equal(result.outcomes[0].stage, 'faith-score');
  assert.equal(result.outcomes[0].status, 'COMPLETED');
});

test('a normal run claims the job, records the stage outcome, and marks the job SUCCESS with a durable stats summary', async (t) => {
  t.after(cleanup);
  await cleanup();

  const result = await runBootstrap({
    statusOnly: false, dryRun: false, stage: ['faith-score'], symbols: null, batchSize: 10, resume: false, maxRuntimeMin: 1,
  });
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].status, 'COMPLETED');

  const jobStatus = await getStatus(BOOTSTRAP_JOB_NAME);
  assert.equal(jobStatus.status, 'SUCCESS');
  assert.ok(jobStatus.lastSuccessAt);
  assert.deepEqual(jobStatus.lastSuccessStats.stages, [{ stage: 'faith-score', status: 'COMPLETED' }]);

  const log = await BootstrapRunLog.findOne({ stage: 'faith-score' }).lean();
  assert.equal(log.lastAttempt.status, 'COMPLETED');

  // The job is released (no longer RUNNING) -- a subsequent run must be claimable again.
  const reclaim = await claimRun(BOOTSTRAP_JOB_NAME);
  assert.equal(reclaim.ok, true);
});

test('a repeat run of the same stage is idempotent: running faith-score twice never errors and both attempts are recorded', async (t) => {
  t.after(cleanup);
  await cleanup();

  const first = await runBootstrap({
    statusOnly: false, dryRun: false, stage: ['faith-score'], symbols: null, batchSize: 10, resume: false, maxRuntimeMin: 1,
  });
  const second = await runBootstrap({
    statusOnly: false, dryRun: false, stage: ['faith-score'], symbols: null, batchSize: 10, resume: false, maxRuntimeMin: 1,
  });
  assert.equal(first.outcomes[0].status, 'COMPLETED');
  assert.equal(second.outcomes[0].status, 'COMPLETED');

  // recordAttempt is called twice per run (a RUNNING transition, then the real outcome) -- 2 runs -> 4 history entries.
  const log = await BootstrapRunLog.findOne({ stage: 'faith-score' }).lean();
  assert.equal(log.history.length, 4, 'both runs\' RUNNING and COMPLETED transitions are kept in the bounded history, never silently overwritten');
  assert.equal(log.history.filter((h) => h.status === 'COMPLETED').length, 2);
});

test('--dry-run never claims the job and never touches ScheduledJobRun at all', async (t) => {
  t.after(cleanup);
  await cleanup();

  const result = await runBootstrap({
    statusOnly: false, dryRun: true, stage: ['faith-score'], symbols: null, batchSize: 10, resume: false, maxRuntimeMin: 1,
  });
  assert.equal(result.dryRun, true);
  const jobStatus = await getStatus(BOOTSTRAP_JOB_NAME);
  assert.equal(jobStatus, null, 'a dry run makes no writes, so it must never create a run-status document either');
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
