import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  claimRun, heartbeat, completeRun, getStatus, getAllStatuses,
} from '../services/ScheduledJobRunService.js';
import ScheduledJobRun from '../models/ScheduledJobRun.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const JOB = 'test-job-zzscheduled';
const cleanup = async () => { await ScheduledJobRun.deleteMany({ jobName: JOB }); };

test('claimRun creates a RUNNING record on first use, and getStatus reflects it', async (t) => {
  t.after(cleanup);
  await cleanup();
  const claim = await claimRun(JOB);
  assert.equal(claim.ok, true);
  assert.ok(claim.runId);

  const status = await getStatus(JOB);
  assert.equal(status.status, 'RUNNING');
  assert.equal(status.runId, claim.runId);
});

test('claimRun refuses a second, overlapping run while the first is still RUNNING and fresh (overlap protection)', async (t) => {
  t.after(cleanup);
  await cleanup();
  const first = await claimRun(JOB);
  assert.equal(first.ok, true);

  const second = await claimRun(JOB);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'ALREADY_RUNNING');
  assert.equal(second.existing.runId, first.runId, 'must report the run that is actually holding the claim');
});

test('claimRun reclaims a run whose heartbeat has gone stale (interrupted/crashed run recovery)', async (t) => {
  t.after(cleanup);
  await cleanup();
  const first = await claimRun(JOB, { staleAfterMs: 50 });
  assert.equal(first.ok, true);
  await new Promise((resolve) => { setTimeout(resolve, 80); }); // outlive the 50ms staleness window without a heartbeat

  const second = await claimRun(JOB, { staleAfterMs: 50 });
  assert.equal(second.ok, true, 'a stale RUNNING record (crashed run, no heartbeat) must be reclaimable');
  assert.notEqual(second.runId, first.runId);

  const status = await getStatus(JOB);
  assert.equal(status.runId, second.runId, 'the reclaiming run must now hold the record');
});

test('heartbeat updates the checkpoint for the current run only, and is a no-op for a superseded runId', async (t) => {
  t.after(cleanup);
  await cleanup();
  const first = await claimRun(JOB, { staleAfterMs: 50 });
  await heartbeat(JOB, first.runId, { batchesDone: 1, symbolsAttempted: ['TCS'] });

  let status = await getStatus(JOB);
  assert.deepEqual(status.checkpoint, { batchesDone: 1, symbolsAttempted: ['TCS'] });

  await new Promise((resolve) => { setTimeout(resolve, 80); });
  const second = await claimRun(JOB, { staleAfterMs: 50 });
  assert.equal(second.ok, true);

  // The superseded (first) run tries to heartbeat after losing its claim -- must not resurrect stale state.
  await heartbeat(JOB, first.runId, { batchesDone: 99, symbolsAttempted: ['SHOULD-NOT-APPEAR'] });
  status = await getStatus(JOB);
  assert.equal(status.runId, second.runId);
  assert.notDeepEqual(status.checkpoint, { batchesDone: 99, symbolsAttempted: ['SHOULD-NOT-APPEAR'] });
});

test('completeRun(SUCCESS) records lastSuccessAt/lastSuccessStats and frees the job for the next claim', async (t) => {
  t.after(cleanup);
  await cleanup();
  const claim = await claimRun(JOB);
  const result = await completeRun(JOB, claim.runId, { status: 'SUCCESS', stats: { companies: 5, facts: 20 } });
  assert.equal(result.ok, true);

  const status = await getStatus(JOB);
  assert.equal(status.status, 'SUCCESS');
  assert.ok(status.lastSuccessAt);
  assert.deepEqual(status.lastSuccessStats, { companies: 5, facts: 20 });
  assert.equal(status.lastFailureAt, null);

  const reclaim = await claimRun(JOB);
  assert.equal(reclaim.ok, true, 'a completed (non-RUNNING) job must always be claimable again');
});

test('completeRun(FAILED) records lastFailureAt/lastFailureError while preserving any earlier lastSuccessAt', async (t) => {
  t.after(cleanup);
  await cleanup();
  const first = await claimRun(JOB);
  await completeRun(JOB, first.runId, { status: 'SUCCESS', stats: { companies: 3 } });
  const firstStatus = await getStatus(JOB);

  const second = await claimRun(JOB);
  await completeRun(JOB, second.runId, { status: 'FAILED', error: 'NSE index unavailable' });

  const status = await getStatus(JOB);
  assert.equal(status.status, 'FAILED');
  assert.equal(status.lastFailureError, 'NSE index unavailable');
  assert.ok(status.lastFailureAt);
  assert.equal(status.lastSuccessAt.getTime(), firstStatus.lastSuccessAt.getTime(), 'an earlier success must not be erased by a later failure');
});

test('getAllStatuses lists every scheduled job, for a data-quality/ops status view', async (t) => {
  t.after(cleanup);
  await cleanup();
  await claimRun(JOB);
  const all = await getAllStatuses();
  assert.ok(all.find((s) => s.jobName === JOB));
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
