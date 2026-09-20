/**
 * traceAnswerStability.js
 * ==========================
 * Phase 6A reliability: runs each mandatory query N times and records
 * exactly which claims fail verification, classified by failure kind, so
 * the non-determinism can be attributed to composition, repair, evidence
 * identity, or citation parsing rather than guessed at.
 *
 *   node scripts/traceAnswerStability.js --runs 5 --out stability.json
 *
 * Not part of `npm test` — real provider and model calls.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';

dotenv.config();

const { graph } = await import('../graph/graph.js');
const { registerExporter, unregisterExporter } = await import('../services/telemetry/ragTelemetry.js');
const { MANDATORY_QUERIES } = await import('./captureAnswerBaseline.js');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/**
 * Failure taxonomy. Each kind points at a different subsystem, which is the
 * whole point of separating them.
 */
export const FAILURE_KINDS = Object.freeze({
  MISSING_CITATION: 'MISSING_CITATION',       // claim has no [N] at all
  WRONG_CITATION: 'WRONG_CITATION',           // [N] exists but points at the wrong/nonexistent item
  UNSUPPORTED_INFERENCE: 'UNSUPPORTED_INFERENCE', // interpretation beyond any cited figure
  PERIOD_MISMATCH: 'PERIOD_MISMATCH',         // right metric, wrong reporting period
  SYMBOL_MISMATCH: 'SYMBOL_MISMATCH',
  PARSER_FORMAT: 'PARSER_FORMAT',             // citation present but not extractable
  OTHER: 'OTHER',
});

const classifyClaimFailure = (claim) => {
  const verdict = String(claim.verdict || '').toUpperCase();
  const reason = String(claim.reasonCode || '').toUpperCase();
  if (verdict === 'INVALID_CITATION') return FAILURE_KINDS.WRONG_CITATION;
  if (reason.includes('MISSING_CITATION')) return FAILURE_KINDS.MISSING_CITATION;
  if (verdict === 'WRONG_PERIOD' || reason.includes('PERIOD')) return FAILURE_KINDS.PERIOD_MISMATCH;
  if (verdict === 'WRONG_SYMBOL' || reason.includes('SYMBOL')) return FAILURE_KINDS.SYMBOL_MISMATCH;
  if (verdict === 'UNSUPPORTED' || verdict === 'PARTIALLY_SUPPORTED') {
    return reason.includes('NO_MATCHING_EVIDENCE') || !reason
      ? FAILURE_KINDS.UNSUPPORTED_INFERENCE
      : FAILURE_KINDS.OTHER;
  }
  return FAILURE_KINDS.OTHER;
};

const REPAIRABLE = new Set([
  'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'WRONG_SYMBOL', 'WRONG_PERIOD',
  'WRONG_DIMENSION', 'FORECAST_AS_ACTUAL', 'GUIDANCE_AS_OUTCOME', 'INVALID_CITATION',
]);

const runOnce = async (query, runIndex) => {
  const events = [];
  const name = `stability-${query.id}-${runIndex}`;
  registerExporter(name, (e) => events.push(e));
  const startedAt = Date.now();
  let state = {};
  try {
    state = await graph.invoke({
      messages: [new HumanMessage(query.text)],
      requestId: `stability-${query.id}-${runIndex}`,
      deadlineAt: Date.now() + 150000,
      aborted: () => false,
    });
  } catch (error) {
    state = { answer: null, errors: [error.message] };
  } finally {
    unregisterExporter(name);
  }

  const claims = state.claimValidation || [];
  const failing = claims.filter((c) => REPAIRABLE.has(String(c.verdict || '').toUpperCase()));

  // Verification passes, in order, from telemetry — pass 1 is composition's
  // output, pass 2 (if any) is the repair's.
  const verificationPasses = events
    .filter((e) => e.eventName === 'rag.verification.completed')
    .map((e) => ({ verdict: e.verificationVerdict, repairAttempted: e.repairAttempted, durationMs: e.durationMs }));

  const stageMs = {};
  for (const e of events.filter((x) => x.eventName === 'rag.stage.completed')) {
    stageMs[e.stage] = (stageMs[e.stage] || 0) + (e.durationMs || 0);
  }

  const answer = String(state.answer || '');
  const citeNumbers = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const evidenceCount = (state.evidence || []).length;

  return {
    run: runIndex,
    wallMs: Date.now() - startedAt,
    validationStatus: state.validationStatus ?? null,
    repairCount: state.repairCount ?? 0,
    evidenceCount,
    answerLength: answer.length,
    citationCount: citeNumbers.length,
    citationsOutOfRange: citeNumbers.filter((n) => n < 1 || n > evidenceCount).length,
    verificationPasses,
    claimCount: claims.length,
    failingClaims: failing.map((c) => ({
      claimId: c.claimId,
      verdict: c.verdict,
      reasonCode: c.reasonCode || null,
      kind: classifyClaimFailure(c),
      evidenceIndexes: c.evidenceIndexes || [],
    })),
    validationIssues: state.validationIssues || [],
    stageMs,
    answer,
  };
};

const main = async () => {
  const runs = Number(arg('runs', 5));
  const outPath = arg('out', 'stability.json');
  const only = arg('only');
  const queries = only
    ? MANDATORY_QUERIES.filter((q) => only.split(',').map(Number).includes(q.id))
    : MANDATORY_QUERIES;

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`Stability trace: ${queries.length} queries x ${runs} runs\n`);

  const results = [];
  for (const query of queries) {
    const perQuery = [];
    for (let i = 1; i <= runs; i += 1) {
      process.stdout.write(`  Q${query.id} run ${i}/${runs} ... `);
      // eslint-disable-next-line no-await-in-loop
      const r = await runOnce(query, i);
      perQuery.push(r);
      console.log(`${r.validationStatus.padEnd(10)} evid=${String(r.evidenceCount).padStart(2)} cites=${String(r.citationCount).padStart(2)} fails=${r.failingClaims.length} [${r.failingClaims.map((f) => f.kind).join(',')}] ${r.wallMs}ms`);
    }
    results.push({ query, runs: perQuery });
  }

  // --- aggregate ---
  const allRuns = results.flatMap((r) => r.runs);
  const byKind = {};
  for (const r of allRuns) for (const f of r.failingClaims) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

  const summary = {
    totalRuns: allRuns.length,
    passed: allRuns.filter((r) => r.validationStatus === 'PASSED').length,
    retrievedEvidence: allRuns.filter((r) => r.evidenceCount > 0).length,
    citationsOutOfRange: allRuns.reduce((a, r) => a + r.citationsOutOfRange, 0),
    failureKinds: byKind,
    perQuery: results.map((r) => ({
      id: r.query.id,
      passed: r.runs.filter((x) => x.validationStatus === 'PASSED').length,
      of: r.runs.length,
      evidence: r.runs.map((x) => x.evidenceCount),
    })),
  };

  console.log('\n--- SUMMARY ---');
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(outPath, JSON.stringify({ capturedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log(`\nWrote ${outPath}`);
  await mongoose.disconnect();
};


/**
 * Only run when executed directly. Importing this module for its exported
 * query list must never trigger a real run - doing so previously hijacked
 * another script's Mongo connection and disconnected it mid-trace, which
 * looked exactly like a product regression (evidence dropping to 0).
 */
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => {}); process.exit(1); });
}
