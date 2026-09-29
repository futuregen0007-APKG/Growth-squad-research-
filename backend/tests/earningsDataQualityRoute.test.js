import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';
import earningsIntelligenceRoute from '../routes/earningsIntelligence.js';
import ReconciliationCheck from '../models/ReconciliationCheck.js';
import ScheduledJobRun from '../models/ScheduledJobRun.js';
import { claimRun, completeRun } from '../services/ScheduledJobRunService.js';

/**
 * earningsDataQualityRoute.test.js
 * ===================================
 * GET /api/earnings-intelligence/data-quality is the one place a human (not
 * Claude, not a laptop) can see, live, whether the unattended pipeline is
 * healthy: each scheduled job's last success/failure, and every unresolved
 * reconciliation mismatch. Route-contract tests against a real mounted
 * Express app, the same technique used in chatRouteContract.test.js.
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const buildApp = () => {
  const app = express();
  app.use('/api/earnings-intelligence', earningsIntelligenceRoute);
  app.use((req, res) => { res.status(404).json({ success: false, error: 'Route not found' }); });
  return app;
};

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
  });
});

const request = (baseUrl, path) => new Promise((resolve, reject) => {
  const req = http.request(`${baseUrl}${path}`, { method: 'GET' }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  req.on('error', reject);
  req.end();
});

const TEST_SYMBOL = 'ZZDATAQUALITYTEST';
const TEST_JOB = 'test-data-quality-route-job';
const cleanup = async () => {
  await ReconciliationCheck.deleteMany({ symbol: TEST_SYMBOL });
  await ScheduledJobRun.deleteMany({ jobName: TEST_JOB });
};

test('/data-quality does not 404 -- it reaches the earnings-intelligence router before the bare :symbol route', async (t) => {
  t.after(cleanup);
  await cleanup();
  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, '/api/earnings-intelligence/data-quality');
    assert.notEqual(res.status, 404);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  } finally {
    await close();
  }
});

test('/data-quality reports an unresolved reconciliation mismatch grouped by symbol, and excludes OK (MATCH/SUM_MATCH) checks', async (t) => {
  t.after(cleanup);
  await cleanup();

  // unresolvedCount is a genuine GLOBAL count across the whole earnings
  // universe (that's the point of the route -- a real dashboard needs the
  // real total, not one scoped away from other symbols' real findings). This
  // shared local/dev database already carries real, currently-unresolved
  // mismatches from actual (non-test) reconciliation runs against real
  // companies -- asserting unresolvedCount against a hardcoded absolute
  // value fails as soon as that pre-existing count is anything but zero,
  // which it legitimately is here. Asserting the DELTA (before vs after
  // this test's own fixture) is immune to whatever else is genuinely
  // unresolved, while still verifying the exact same property: one new
  // unresolved check must add exactly 1, and the MATCH check must add 0.
  // Never delete or touch those pre-existing records -- they are real
  // findings, not test pollution.
  const { baseUrl, close } = await listen(buildApp());
  try {
    const before = await request(baseUrl, '/api/earnings-intelligence/data-quality');
    const baselineUnresolvedCount = before.body.data.reconciliation.unresolvedCount;

    await ReconciliationCheck.create([
      {
        checkKey: `${TEST_SYMBOL}|SOURCE_VALUE|FY2025|REVENUE|Consolidated`, checkType: 'SOURCE_VALUE', symbol: TEST_SYMBOL, metric: 'REVENUE', period: 'FY2025', basis: 'Consolidated', status: 'VALUE_MISMATCH', detail: 'stored 100, filing says 105', lastCheckedAt: new Date(),
      },
      {
        checkKey: `${TEST_SYMBOL}|QUARTER_SUM|FY2025|PAT|Standalone`, checkType: 'QUARTER_SUM', symbol: TEST_SYMBOL, metric: 'PAT', period: 'FY2025', basis: 'Standalone', status: 'MATCH', detail: null, lastCheckedAt: new Date(),
      },
    ]);

    const after = await request(baseUrl, '/api/earnings-intelligence/data-quality');
    assert.equal(after.body.data.reconciliation.unresolvedCount, baselineUnresolvedCount + 1, 'exactly one new unresolved check must be added -- the MATCH check must not be counted');
    assert.ok(after.body.data.reconciliation.bySymbol[TEST_SYMBOL]);
    assert.equal(after.body.data.reconciliation.bySymbol[TEST_SYMBOL].length, 1);
    assert.equal(after.body.data.reconciliation.bySymbol[TEST_SYMBOL][0].status, 'VALUE_MISMATCH');
  } finally {
    await close();
  }
});

test('/data-quality reports a scheduled job\'s current status and its last success/failure', async (t) => {
  t.after(cleanup);
  await cleanup();
  const claim = await claimRun(TEST_JOB);
  await completeRun(TEST_JOB, claim.runId, { status: 'FAILED', error: 'NSE index unavailable' });

  const { baseUrl, close } = await listen(buildApp());
  try {
    const res = await request(baseUrl, '/api/earnings-intelligence/data-quality');
    const job = res.body.data.scheduledJobs.find((j) => j.jobName === TEST_JOB);
    assert.ok(job, 'the job must appear in the data-quality view');
    assert.equal(job.status, 'FAILED');
    assert.equal(job.lastFailureError, 'NSE index unavailable');
  } finally {
    await close();
  }
});

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
