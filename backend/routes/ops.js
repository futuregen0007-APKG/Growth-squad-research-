import express from 'express';
import { requireOpsAccess } from '../middleware/requireOpsAccess.js';
import { metricsStore } from '../services/telemetry/metricsStore.js';
import { PRICE_TABLE_VERSION, PRICE_TABLE_ASOF } from '../services/telemetry/costEstimation.js';
import { getDependencySnapshot } from '../services/telemetry/dependencyState.js';

const router = express.Router();

/**
 * GET /api/ops/rag-metrics
 * ===========================
 * Phase 5A Part 9/10: the ONE operational diagnostics endpoint. Returns
 * only aggregated, bounded data already computed by metricsStore.js — no
 * individual prompt, model response, evidence chunk, citation URL, user
 * identity, API key, or stack trace ever appears here (see
 * metricsStore.js's own module note on what it structurally cannot hold).
 */
router.get('/rag-metrics', requireOpsAccess, (req, res) => {
  const snapshot = metricsStore.getSnapshot();
  res.json({
    success: true,
    data: {
      ...snapshot,
      costTable: { version: PRICE_TABLE_VERSION, asOf: PRICE_TABLE_ASOF },
      dependencies: getDependencySnapshot(),
      configuration: {
        nodeEnv: process.env.NODE_ENV || 'development',
        ragRetrievalMode: process.env.RAG_RETRIEVAL_MODE || null,
        chatTotalDeadlineMs: process.env.CHAT_TOTAL_DEADLINE_MS || null,
        openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
        atlasVectorSearchConfigured: process.env.VECTOR_SEARCH_ENABLED === 'true',
      },
    },
  });
});

export default router;
