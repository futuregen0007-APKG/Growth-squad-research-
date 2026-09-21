/**
 * verifyProviderResilience.js
 * ==============================
 * Phase 6B acceptance: prove, against the REAL graph and the REAL stored
 * corpus, the four provider-resilience claims that unit tests can only
 * assert in isolation.
 *
 *   node scripts/verifyProviderResilience.js
 *
 * Not part of `npm test` — it drives real model and database calls.
 *
 * WHY THIS EXISTS. The Phase 6B audit found the 13.4s p95 was NOT caused by
 * rate limiting at all: it was Angel One's cold-start scrip-master download
 * (22.8s) colliding with a 10s tool timeout. But the rate-limit path had a
 * genuine and separate defect — every single request re-asked a provider
 * that had already said no, and paid a full round trip per section to hear
 * it again. These checks measure the difference that fixing it makes, end to
 * end, rather than asserting it in a mock.
 *
 * WHAT IS SIMULATED AND WHAT IS NOT. Tripping the gate calls
 * `gate.recordRateLimited()` — the exact method the real 429 handler calls,
 * producing the exact state a real 429 produces. Nothing downstream can tell
 * the difference, because there is no difference: the same gate object, the
 * same blocked window, the same code path through fetchResearchBundle. What
 * is avoided is burning real quota to manufacture a 429. Every latency
 * number below is a real end-to-end graph run.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';

dotenv.config();

const { graph } = await import('../graph/graph.js');
const { getRateLimitGate, inFlight, readiness, RATE_LIMIT_BACKOFF_MS } = await import('../services/providers/providerResilience.js');
const { registerExporter, unregisterExporter } = await import('../services/telemetry/ragTelemetry.js');
const { MANDATORY_QUERIES } = await import('./captureAnswerBaseline.js');

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
};

const runQuery = async (text, requestId) => {
  // Stage timings are captured so residual latency can be ATTRIBUTED. A p95
  // that is really the LLM verifier working through a 17-item comparison is
  // a different finding from a p95 spent waiting on a dead provider, and
  // only the second one is Phase 6B's to fix.
  const stageMs = {};
  const exporterName = `resilience-${requestId}`;
  registerExporter(exporterName, (e) => {
    if (e.eventName === 'rag.stage.completed') stageMs[e.stage] = e.durationMs;
  });

  const startedAt = Date.now();
  let state = {};
  try {
    state = await graph.invoke({
      messages: [new HumanMessage(text)],
      requestId,
      deadlineAt: Date.now() + 150000,
      aborted: () => false,
    });
  } catch (error) {
    state = { answer: null, errors: [error.message] };
  } finally {
    unregisterExporter(exporterName);
  }
  return {
    wallMs: Date.now() - startedAt,
    stageMs,
    evidenceCount: (state.evidence || []).length,
    validationStatus: state.validationStatus || null,
    answerLength: (state.answer || '').length,
    abstained: !state.answer || /no verified|hold no|not available|could not/i.test(state.answer || ''),
  };
};

/**
 * CHECK 1 - repeated 429s must cause FAST FAILOVER, not a slow one.
 *
 * The gate is tripped, then the five mandatory queries run. The answers must
 * still be produced from the stored corpus (that is the stale/stored
 * fallback doing its job) and the latency must not degrade, because the
 * blocked provider is never dialled.
 */
const checkFastFailover = async () => {
  const gate = getRateLimitGate('indian-api');
  gate.recordRateLimited();
  gate.recordRateLimited();
  gate.recordRateLimited();

  const before = gate.getStatus();
  const runs = [];
  for (const query of MANDATORY_QUERIES) {
    for (let i = 1; i <= 3; i += 1) {
      runs.push({ id: query.id, ...await runQuery(query.text, `resilience-429-${query.id}-${i}`) });
    }
  }
  const after = gate.getStatus();
  const wall = runs.map((r) => r.wallMs);

  return {
    runs: runs.length,
    gateBlockedThroughout: before.blocked && after.blocked,
    totalRateLimits: after.totalRateLimits,
    // The headline: every one of these would have been a wasted round trip.
    callsSkippedWithoutNetwork: after.callsSkipped - before.callsSkipped,
    stillAnswered: runs.filter((r) => r.evidenceCount > 0).length,
    p50LatencyMs: percentile(wall, 50),
    p95LatencyMs: percentile(wall, 95),
    maxLatencyMs: Math.max(...wall),
    perQuery: MANDATORY_QUERIES.map((q) => ({
      id: q.id,
      wallMs: runs.filter((r) => r.id === q.id).map((r) => r.wallMs),
      slowestStages: runs.filter((r) => r.id === q.id).map((r) => Object.entries(r.stageMs || {}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>k+'='+v).join(' ')),
      evidence: runs.filter((r) => r.id === q.id).map((r) => r.evidenceCount),
    })),
  };
};

/**
 * CHECK 2 - the gate reopens on its own. A provider outage must not park the
 * provider permanently; recovery needs no operator action and no restart.
 */
const checkRecovery = () => {
  const gate = getRateLimitGate('indian-api');
  const blockedWhileWindowOpen = gate.isBlocked();
  const retryAfterMs = gate.retryAfterMs();

  // Reopen by letting the window lapse, using the gate's own clock rather
  // than sleeping for two minutes.
  gate.blockedUntil = Date.now() - 1;
  const reopensItself = !gate.isBlocked();

  gate.recordSuccess();
  const backoffResetsAfterSuccess = gate.recordRateLimited() === RATE_LIMIT_BACKOFF_MS[0];
  gate.blockedUntil = 0;
  gate.recordSuccess();

  return {
    blockedWhileWindowOpen,
    retryAfterMs,
    cappedAtMs: RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1],
    reopensItself,
    backoffResetsAfterSuccess,
    gateOpenAtEnd: !gate.isBlocked(),
  };
};

/**
 * CHECK 3 - concurrent identical requests collapse into one upstream call.
 * Two comparisons naming the same company, launched together, must not
 * fetch that company's bundle twice.
 */
const checkDeduplication = async () => {
  const before = inFlight.getStatus();
  const started = Date.now();

  await Promise.all([
    runQuery('Compare TCS and INFY growth, margins, and valuation', 'resilience-dedupe-a'),
    runQuery('Compare TCS and INFY growth, margins, and valuation', 'resilience-dedupe-b'),
    runQuery('Compare TCS and HDFCBANK on margins', 'resilience-dedupe-c'),
  ]);

  const after = inFlight.getStatus();
  return {
    concurrentRequests: 3,
    wallMs: Date.now() - started,
    deduplicatedCalls: after.deduplicated - before.deduplicated,
    issuedCalls: after.issued - before.issued,
    leftPending: after.inFlight,
  };
};

/** CHECK 4 - a warming provider is reported, not waited on. */
const checkWarmingIsNotWaitedOn = async () => {
  readiness.markWarming('angel-one');
  const started = Date.now();
  const run = await runQuery('What is the live price of TCS?', 'resilience-warming');
  const wallMs = Date.now() - started;
  readiness.markReady('angel-one');

  return {
    wallMs,
    // The defect this replaced: the caller blocked until a 10s tool timeout.
    failedOverUnder10s: wallMs < 10000,
    answered: run.answerLength > 0,
  };
};

const main = async () => {
  // The stored corpus IS the failover target. Without this connection the
  // run measures the latency of answering with nothing, which is fast and
  // meaningless.
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  const report = { capturedAt: new Date().toISOString(), checks: {} };

  console.log('\n[1/4] repeated 429s -> fast failover (15 real graph runs)...');
  report.checks.fastFailover = await checkFastFailover();

  console.log('[2/4] rate-limit gate recovery...');
  report.checks.recovery = checkRecovery();

  console.log('[3/4] concurrent identical requests -> de-duplication...');
  report.checks.deduplication = await checkDeduplication();

  console.log('[4/4] warming provider -> immediate failover...');
  report.checks.warming = await checkWarmingIsNotWaitedOn();

  console.log('\n--- PROVIDER RESILIENCE ---');
  console.log(JSON.stringify(report.checks, null, 2));
  writeFileSync('provider-resilience.json', JSON.stringify(report, null, 2));
  console.log('\nWrote provider-resilience.json');
  await mongoose.disconnect();
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => {}); process.exit(1); });
}

export default { main };
