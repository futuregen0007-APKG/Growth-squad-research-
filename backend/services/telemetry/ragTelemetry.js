/**
 * ragTelemetry.js
 * =================
 * Phase 5A Part 3: the provider-neutral telemetry service every RAG
 * observability signal in this project flows through. Exporters are
 * pluggable (see `registerExporter`) so a future CloudWatch/OpenTelemetry
 * integration is a new exporter, never a change to call sites — the two
 * exporters registered by default (`consoleExporter`, the in-memory
 * `metricsStore`) are themselves ordinary exporters, not special-cased.
 *
 * SAFETY MODEL (see safeSerialization.js for the redaction layer):
 *   1. `emitEvent` only accepts fields the caller explicitly names.
 *   2. Every event is passed through `redactDeep` before any exporter
 *      sees it, as defense in depth.
 *   3. An exporter that throws is caught and logged at 'warn' — telemetry
 *      failure NEVER propagates to the caller (Part 2/12: "telemetry
 *      failure must never break the user's answer").
 */
import { logger } from '../../utils/logger.js';
import { redactDeep } from './safeSerialization.js';
import { metricsStore as defaultMetricsStore } from './metricsStore.js';

export const RAG_EVENT_NAMES = Object.freeze([
  'rag.request.started', 'rag.scope.resolved', 'rag.tools.planned', 'rag.retrieval.completed',
  'rag.evidence.built', 'rag.generation.completed', 'rag.verification.completed', 'rag.repair.started',
  'rag.repair.completed', 'rag.request.completed', 'rag.request.failed', 'rag.stage.completed',
  'dependency.timeout', 'dependency.failure',
]);

export const TELEMETRY_SCHEMA_VERSION = 1;

// The complete set of keys `emitEvent` will ever forward, split into
// dimensions (bounded-cardinality labels, safe as metrics dimensions too)
// and measurements (numbers). Anything NOT in one of these two lists is
// silently dropped — this is the "allow-list" primary protection Part 3
// requires; redactDeep below is the secondary one.
const ALLOWED_DIMENSION_KEYS = new Set([
  'traceId', 'requestId', 'route', 'intent', 'researchQuestionType', 'companySymbol', 'fiscalYear', 'fiscalQuarter',
  'retrievalMode', 'groundingStatus', 'verificationVerdict', 'completionStatus', 'errorCategory', 'stage',
  'tool', 'toolStatus', 'model', 'role', 'node', 'cacheStatus', 'circuitState', 'cancellationMode',
]);
const ALLOWED_MEASUREMENT_KEYS = new Set([
  'durationMs', 'evidenceCount', 'citationCount', 'verifiedClaimCount', 'rejectedClaimCount', 'resultCount',
  'retrievalCandidateCount', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens',
  'estimatedCost', 'repairAttempted', 'repairSucceeded', 'toolCount', 'llmCallCount',
]);

/**
 * RAG_EVENT_SCHEMA — the minimal, documented contract for every declared
 * event: which allow-listed fields it always carries (`required`) and which
 * it may carry when the turn genuinely produced them (`optional`).
 *
 * This is DOCUMENTATION plus a TEST contract, deliberately not a runtime
 * filter: `emitEvent` still forwards any allow-listed field and drops
 * everything else, exactly as before, so a schema mistake can never cause a
 * real event to be silently dropped on the request path. Tests assert every
 * emit site satisfies its schema (see tests/telemetryEventContract.test.js).
 *
 * Deliberately absent from EVERY schema: prompts, model responses, streamed
 * token text, evidence/document text, citation URLs, user identity,
 * credentials, and raw token COUNTS. Token counts and their derived cost
 * stay where Phase 5A already captured them — on `state.llmCalls`, summed
 * once per turn by logDiagnostics.js into `rag.request.completed` and the
 * metrics store — so no per-stage event re-carries them.
 *
 * `traceId` + `requestId` are required on every event: together they link
 * every event of one request, across nodes, rounds, and both controllers.
 */
export const RAG_EVENT_SCHEMA = Object.freeze({
  // --- request lifecycle (controllers/ChatController.js) ---
  'rag.request.started': { required: ['traceId', 'requestId', 'route'], optional: [] },
  'rag.request.completed': {
    required: ['traceId', 'requestId', 'completionStatus', 'errorCategory', 'durationMs'],
    optional: [
      'intent', 'researchQuestionType', 'companySymbol', 'fiscalYear', 'retrievalMode', 'groundingStatus',
      'evidenceCount', 'citationCount', 'verifiedClaimCount', 'rejectedClaimCount', 'repairAttempted',
      'estimatedCost', 'llmCallCount',
    ],
  },
  // Emitted ONLY when a request failed OUTSIDE the graph's own safety net —
  // never alongside rag.request.completed for the same request.
  'rag.request.failed': { required: ['traceId', 'requestId', 'errorCategory', 'durationMs'], optional: ['route'] },

  // --- per-turn stages (graph nodes) ---
  'rag.scope.resolved': {
    required: ['traceId', 'requestId', 'researchQuestionType'],
    optional: ['intent', 'companySymbol', 'fiscalYear', 'fiscalQuarter'],
  },
  'rag.tools.planned': { required: ['traceId', 'requestId', 'toolCount'], optional: ['intent', 'llmCallCount'] },
  // Emitted once per RETRIEVAL ROUND. A replan cycle (graph.js routes
  // replanMissingEvidence back to executeTools) genuinely runs retrieval a
  // second time, so a second event is a real second round, not a duplicate.
  'rag.retrieval.completed': {
    required: ['traceId', 'requestId', 'toolCount', 'durationMs'],
    optional: ['evidenceCount', 'resultCount', 'retrievalMode'],
  },
  'rag.evidence.built': { required: ['traceId', 'requestId', 'evidenceCount'], optional: ['retrievalMode'] },
  // Emitted only when a generation call genuinely ran — the zero-evidence
  // fast path (composeAnswer.js) deliberately makes no call and emits nothing.
  'rag.generation.completed': {
    required: ['traceId', 'requestId', 'durationMs'],
    optional: ['model', 'role', 'llmCallCount', 'groundingStatus'],
  },
  // Emitted once per VERIFICATION PASS. A repaired draft is re-verified
  // (graph.js cycles repairAnswer back to validateFinalAnswer), so a second
  // event is a real second pass — `repairAttempted` distinguishes it.
  'rag.verification.completed': {
    required: ['traceId', 'requestId', 'verificationVerdict', 'durationMs'],
    optional: ['groundingStatus', 'verifiedClaimCount', 'rejectedClaimCount', 'repairAttempted', 'llmCallCount'],
  },
  'rag.repair.started': { required: ['traceId', 'requestId'], optional: ['verificationVerdict'] },
  // `repairSucceeded` here means THIS PASS produced a new draft — NOT that
  // the turn ended well. The turn-level judgement ("the answer PASSED after
  // a repair") is a different field on rag.request.completed, computed by
  // turnClassification.js.
  'rag.repair.completed': { required: ['traceId', 'requestId', 'durationMs', 'repairSucceeded'], optional: ['llmCallCount'] },

  // --- per-node timing (graph/timing.js, one per node that actually ran) ---
  'rag.stage.completed': { required: ['traceId', 'requestId', 'stage', 'durationMs'], optional: [] },

  // --- dependency outcomes (graph/nodes/executeTools.js) ---
  // Scope: the TOOL layer, where every external data dependency (MongoDB-backed
  // retrieval, market-data/news providers) is actually called. Emitted once per
  // genuinely-executed step, never for a deduplicated repeat (which made no
  // real call). LLM-provider outcomes are deliberately NOT re-emitted here:
  // they are already first-class categories in errorTaxonomy.js
  // (LLM_TIMEOUT/LLM_RATE_LIMITED/LLM_PROVIDER_FAILURE) and reach telemetry via
  // rag.request.completed's own errorCategory, so emitting them again would
  // double-count one failure as two.
  'dependency.timeout': { required: ['traceId', 'requestId', 'tool'], optional: ['toolStatus', 'durationMs'] },
  'dependency.failure': { required: ['traceId', 'requestId', 'tool'], optional: ['toolStatus', 'durationMs', 'errorCategory'] },
});

const exporters = new Map();

/** registerExporter - `fn(event)` may be sync or async; a throw/rejection is caught by emitEvent, never by the exporter's own caller. */
export const registerExporter = (name, fn) => { exporters.set(name, fn); };
export const unregisterExporter = (name) => { exporters.delete(name); };
export const listExporterNames = () => [...exporters.keys()];

const consoleExporter = (event) => {
  logger.debug(`[rag-telemetry] ${JSON.stringify(event)}`);
};
registerExporter('console', consoleExporter);

const metricsExporter = (event) => {
  if (event.durationMs != null && event.stage) defaultMetricsStore.recordStageLatency(event.stage, event.durationMs);
  if (event.errorCategory) defaultMetricsStore.recordErrorCategory(event.errorCategory);
  if (event.retrievalMode) defaultMetricsStore.recordRetrievalMode(event.retrievalMode);
};
registerExporter('metricsStore', metricsExporter);

/**
 * buildSafeEvent - constructs the final event object from allow-listed
 * fields only, then redacts it as a second pass. `fields` may contain
 * anything a careless caller passes; only ALLOWED_DIMENSION_KEYS/
 * ALLOWED_MEASUREMENT_KEYS ever survive into the returned object.
 */
export const buildSafeEvent = (eventName, fields = {}) => {
  const timestamp = new Date().toISOString();
  const picked = { schemaVersion: TELEMETRY_SCHEMA_VERSION, eventName, timestamp };
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_DIMENSION_KEYS.has(key) || ALLOWED_MEASUREMENT_KEYS.has(key)) picked[key] = value;
  }
  return redactDeep(picked);
};

/**
 * emitEvent - the ONE function every call site uses. Never throws, never
 * awaits an exporter longer than it takes to catch a failure — a hung or
 * broken exporter delays nothing on the request path (exporters are
 * fire-and-forget from this function's point of view; `logger` output
 * itself is synchronous and always succeeds unless the process is already
 * in serious trouble).
 */
export const emitEvent = (eventName, fields = {}) => {
  if (!RAG_EVENT_NAMES.includes(eventName)) {
    logger.warn(`[rag-telemetry] dropped an event with an unrecognized name: ${String(eventName).slice(0, 60)}`);
    return;
  }
  const event = buildSafeEvent(eventName, fields);
  for (const [name, exporter] of exporters.entries()) {
    try {
      const outcome = exporter(event);
      if (outcome && typeof outcome.catch === 'function') {
        outcome.catch((err) => logger.warn(`[rag-telemetry] exporter "${name}" failed: ${err.message}`));
      }
    } catch (err) {
      logger.warn(`[rag-telemetry] exporter "${name}" threw: ${err.message}`);
    }
  }
};

export default {
  RAG_EVENT_NAMES, RAG_EVENT_SCHEMA, TELEMETRY_SCHEMA_VERSION, registerExporter, unregisterExporter, listExporterNames, buildSafeEvent, emitEvent,
};
