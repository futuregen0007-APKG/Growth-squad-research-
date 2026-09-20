/**
 * captureAnswerBaseline.js
 * ===========================
 * Phase 6A: runs real user questions through the REAL graph, with the real
 * configured providers, and records everything Phase 5 telemetry can see —
 * resolved entities, intent, planned vs executed tools, provider outcomes
 * and their failure classification, evidence, verification, per-stage
 * latency, and the final user-visible answer.
 *
 * This is a diagnostic/acceptance harness, not a unit test: it makes real
 * model and provider calls and is never part of `npm test`.
 *
 *   node scripts/captureAnswerBaseline.js --out baseline.json
 *   node scripts/captureAnswerBaseline.js --out after.json --only 1,2
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HumanMessage } from '@langchain/core/messages';

dotenv.config();

const { graph } = await import('../graph/graph.js');
const { buildDiagnostics } = await import('../graph/nodes/logDiagnostics.js');
const { buildTurnMetrics } = await import('../services/telemetry/turnClassification.js');
const { registerExporter, unregisterExporter } = await import('../services/telemetry/ragTelemetry.js');
const { estimateRequestCost } = await import('../services/telemetry/costEstimation.js');

/** The five mandatory Phase 6A queries, in order. */
export const MANDATORY_QUERIES = [
  { id: 1, text: 'HDFCBANK vs ICICIBANK margin trends' },
  { id: 2, text: 'BEL vs HAL on margins and valuation' },
  { id: 3, text: 'Which is better for the long term: ICICI Bank or HDFC Bank?' },
  { id: 4, text: 'Compare TCS and INFY growth, margins, and valuation' },
  { id: 5, text: 'Analyse RELIANCE for a five-year investor' },
];

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const runOne = async ({ id, text }) => {
  const events = [];
  const exporterName = `baseline-${id}`;
  registerExporter(exporterName, (event) => events.push(event));

  const startedAt = Date.now();
  let finalState = null;
  let thrown = null;
  try {
    finalState = await graph.invoke({
      messages: [new HumanMessage(text)],
      requestId: `baseline-${id}`,
      traceId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      deadlineAt: Date.now() + 120000,
      aborted: () => false,
    });
  } catch (error) {
    thrown = { message: error.message, stack: error.stack?.split('\n').slice(0, 4) };
  } finally {
    unregisterExporter(exporterName);
  }

  const wallMs = Date.now() - startedAt;
  const state = finalState || {};
  const diagnostics = finalState ? buildDiagnostics(state) : null;
  const turnMetrics = finalState ? buildTurnMetrics(state) : null;

  return {
    id,
    query: text,
    wallMs,
    thrown,
    // --- resolution ---
    intent: state.intent ?? null,
    intentConfidence: state.intentConfidence ?? null,
    entities: state.entities ?? null,
    scopeSignal: state.scopeSignal ?? null,
    requestedDimensions: state.requestedDimensions ?? null,
    // --- tools ---
    toolPlan: (state.toolPlan || []).map((s) => ({ tool: s.tool, args: s.args })),
    toolResults: (state.toolResults || []).map((t) => ({
      tool: t.tool,
      symbol: t.symbol ?? null,
      status: t.status,
      errorCode: t.errorCode ?? null,
      warning: t.warning ?? null,
      resultCount: t.resultCount ?? null,
      evidenceCount: t.evidenceCount ?? null,
      durationMs: t.durationMs ?? null,
      deduplicated: Boolean(t.deduplicated),
      // What the tool actually returned, shallowly, so a missing/null/zero
      // field is visible without dumping whole documents.
      dataKeys: t.data && typeof t.data === 'object' ? Object.keys(t.data).slice(0, 40) : null,
      dataSample: t.data ? JSON.stringify(t.data).slice(0, 1500) : null,
    })),
    // --- evidence ---
    evidenceCount: (state.evidence || []).length,
    researchEvidenceCount: (state.researchEvidence || []).length,
    evidenceSample: (state.evidence || []).slice(0, 6).map((e) => JSON.stringify(e).slice(0, 400)),
    missingEvidence: state.missingEvidence ?? null,
    evidenceCoverage: state.evidenceCoverage ?? null,
    retrievalMode: state.retrievalMode ?? null,
    // --- generation / verification ---
    validationStatus: state.validationStatus ?? null,
    validationIssues: state.validationIssues ?? null,
    groundingStatus: state.groundingStatus ?? null,
    groundedClaims: (state.groundedClaims || []).map((c) => ({
      claimId: c.claimId, verificationStatus: c.verificationStatus, reasonCode: c.reasonCode,
    })),
    citations: state.citations ?? [],
    repairAttempted: Boolean(state.repairAttempted),
    warnings: state.warnings ?? [],
    errors: state.errors ?? [],
    // --- telemetry ---
    completionStatus: turnMetrics?.completionStatus ?? null,
    errorCategory: turnMetrics?.errorCategory ?? null,
    nodeTimings: state.nodeTimings ?? [],
    llmCalls: (state.llmCalls || []).map((c) => ({
      node: c.node, role: c.role, model: c.model, durationMs: c.durationMs,
      timedOut: c.timedOut, skipped: c.skipped ?? null,
      inputTokens: c.inputTokens ?? null, outputTokens: c.outputTokens ?? null,
    })),
    estimatedCost: estimateRequestCost(state.llmCalls || []).estimatedCost,
    telemetryEvents: events.map((e) => ({
      eventName: e.eventName, stage: e.stage ?? null, tool: e.tool ?? null,
      durationMs: e.durationMs ?? null, errorCategory: e.errorCategory ?? null,
      toolStatus: e.toolStatus ?? null,
    })),
    diagnostics,
    // --- what the user actually sees ---
    answer: state.answer ?? null,
  };
};

const main = async () => {
  const outPath = arg('out', 'baseline.json');
  const only = arg('only');
  const selected = only
    ? MANDATORY_QUERIES.filter((q) => only.split(',').map(Number).includes(q.id))
    : MANDATORY_QUERIES;

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`MongoDB connected (${mongoose.connection.name}); running ${selected.length} quer(ies) against REAL providers\n`);

  const results = [];
  for (const query of selected) {
    process.stdout.write(`[${query.id}] ${query.text} ... `);
    // eslint-disable-next-line no-await-in-loop
    const result = await runOne(query);
    results.push(result);
    console.log(`${result.wallMs}ms  intent=${result.intent}  tools=${result.toolResults.map((t) => `${t.tool}:${t.status}`).join(',') || 'none'}  status=${result.completionStatus || result.validationStatus}`);
  }

  writeFileSync(outPath, JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2));
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
main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
}
