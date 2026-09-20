import express from 'express';
import { requireOpsAccess } from '../middleware/requireOpsAccess.js';
import { metricsStore } from '../services/telemetry/metricsStore.js';
import { PRICE_TABLE_VERSION, PRICE_TABLE_ASOF } from '../services/telemetry/costEstimation.js';
import { getPricingMetadata } from '../services/telemetry/modelPricing.js';
import { getDependencySnapshot, summarizeReadiness } from '../services/telemetry/dependencyState.js';
import { sharedMetrics, mergeSnapshots } from '../services/telemetry/sharedMetrics.js';
import { getOtlpStatus } from '../services/telemetry/otlpExporter.js';
import { costLedger } from '../services/telemetry/costLedger.js';

const router = express.Router();

/**
 * GET /api/ops/rag-metrics
 * ===========================
 * Phase 5A Part 9/10: the ONE operational diagnostics endpoint. Returns
 * only aggregated, bounded data already computed by metricsStore.js — no
 * individual prompt, model response, evidence chunk, citation URL, user
 * identity, API key, or stack trace ever appears here (see
 * metricsStore.js's own module note on what it structurally cannot hold).
 *
 * Phase 5B additions, all reporting-only:
 *   - `aggregation`: whether these numbers are this instance's or the whole
 *     deployment's, and — when shared aggregation is configured but its
 *     backend is unreachable — that it has fallen back to local. An
 *     operator must never have to guess which of those they are reading.
 *   - `exporter`: the OTLP exporter's queue depth, drops, and retries, so a
 *     collector outage is visible here rather than only in the logs. Never
 *     the endpoint's credentials.
 *   - `pricing`: the cost table's provenance and staleness.
 *   - `costLedger`: how many LLM calls were counted, and how many duplicate
 *     submissions were correctly refused.
 *
 * The handler reads the shared backend at most once per request and never
 * writes to it, so calling this endpoint cannot perturb the metrics it
 * reports.
 */
router.get('/rag-metrics', requireOpsAccess, async (req, res) => {
  const localSnapshot = metricsStore.getSnapshot();

  // A shared read that fails returns null and is reported as 'degraded' —
  // it never fails the request, and never blocks on a dead backend beyond
  // the Redis client's own connect timeout.
  const sharedSnapshot = await sharedMetrics.readSharedSnapshot().catch(() => null);
  if (sharedSnapshot) sharedMetrics.pruneInstances().catch(() => {});

  const aggregation = sharedMetrics.getAggregationStatus({
    sharedReadSucceeded: sharedSnapshot ? true : null,
  });
  const snapshot = mergeSnapshots(localSnapshot, sharedSnapshot);

  res.json({
    success: true,
    data: {
      ...snapshot,
      aggregation,
      exporter: getOtlpStatus(),
      costLedger: costLedger.getStats(),
      costTable: { version: PRICE_TABLE_VERSION, asOf: PRICE_TABLE_ASOF },
      pricing: getPricingMetadata(),
      dependencies: getDependencySnapshot(),
      readiness: summarizeReadiness(),
      configuration: {
        nodeEnv: process.env.NODE_ENV || 'development',
        ragRetrievalMode: process.env.RAG_RETRIEVAL_MODE || null,
        chatTotalDeadlineMs: process.env.CHAT_TOTAL_DEADLINE_MS || null,
        openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
        atlasVectorSearchConfigured: process.env.VECTOR_SEARCH_ENABLED === 'true',
        sharedAggregationConfigured: process.env.RAG_METRICS_SHARED_AGGREGATION === 'true',
        otlpExportConfigured: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
      },
    },
  });
});

export default router;
