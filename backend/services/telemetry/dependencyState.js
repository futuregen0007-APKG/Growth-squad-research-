/**
 * dependencyState.js
 * ====================
 * Phase 5A Part 11: last-known dependency state for MongoDB, OpenAI,
 * local retrieval, Atlas Vector Search (optional/deferred), the Earnings-
 * Intelligence store, and the annotation store.
 *
 * Every check here reads ALREADY-TRACKED, in-memory state — mongoose's own
 * `connection.readyState` (no query), `OpenAIClientFactory.isConfigured()`
 * (a `Boolean(process.env.OPENAI_API_KEY)` check, no network call, no
 * billable request) — exactly the same non-billable, non-blocking
 * discipline utils/healthHandlers.js's `/ready` already uses. This module
 * is deliberately never called from `/ready` itself (Part 11: "`/ready`
 * must not perform expensive live probes on every request" — it already
 * doesn't, and gains nothing from a richer breakdown on the hot path);
 * it backs the ops diagnostics endpoint instead, where a fuller picture
 * is exactly what an operator wants.
 */
import mongoose from 'mongoose';
import { OpenAIClientFactory } from '../../llm/OpenAIClientFactory.js';
import { mongoStateLabel } from '../../utils/healthHandlers.js';

export const DEPENDENCY_STATUSES = Object.freeze(['ready', 'degraded', 'unavailable', 'not_configured']);

/**
 * getDependencySnapshot - `required: true` marks a dependency the
 * grounded-chat path cannot function without at all (MongoDB, OpenAI,
 * local retrieval, which itself depends on MongoDB); `required: false`
 * marks an optional one (Atlas — explicitly deferred to Phase 5B unless
 * VECTOR_SEARCH_ENABLED is set; the Earnings-Intelligence/annotation
 * stores, which degrade a specific feature rather than the whole pipeline).
 */
export const getDependencySnapshot = () => {
  const mongoState = mongoose.connection.readyState;
  const mongoStatus = mongoState === 1 ? 'ready' : (mongoState === 2 ? 'degraded' : 'unavailable');
  const mongoDetail = mongoStateLabel(mongoState);
  const openAiConfigured = OpenAIClientFactory.isConfigured();
  const atlasConfigured = process.env.VECTOR_SEARCH_ENABLED === 'true';

  return {
    mongodb: { status: mongoStatus, detail: mongoDetail, required: true },
    openai: {
      status: openAiConfigured ? 'ready' : 'unavailable',
      detail: openAiConfigured ? 'API key configured' : 'no API key configured (never a billable check)',
      required: true,
    },
    // Every store below reads through MongoDB, so each MIRRORS MongoDB's own
    // status rather than collapsing anything short of 'ready' to
    // 'unavailable' — a connecting MongoDB genuinely means "degraded, still
    // coming up," and flattening that here would make summarizeReadiness'
    // own 'degraded' verdict unreachable for the one required dependency
    // that can ever be in that state.
    localRetrieval: {
      status: mongoStatus,
      detail: 'lexical/hybrid retrieval reads ResearchDocumentChunk via MongoDB',
      required: true,
    },
    atlasVectorSearch: atlasConfigured
      ? { status: mongoStatus, detail: 'VECTOR_SEARCH_ENABLED=true', required: false }
      : { status: 'not_configured', detail: 'deferred to Phase 5B', required: false },
    earningsIntelligenceStore: {
      status: mongoStatus, detail: 'ManagementPromise / curated JSON records', required: false,
    },
    annotationStore: {
      status: mongoStatus, detail: 'ResearchGuidanceAnnotation', required: false,
    },
  };
};

/**
 * summarizeReadiness - collapses getDependencySnapshot into one verdict:
 * 'ready' (every required dependency ready), 'degraded' (a required
 * dependency is degraded but at least connecting), 'unavailable' (a
 * required dependency is fully down). Never considers an optional
 * dependency when deciding this — Atlas being unconfigured must never
 * make the overall system look unready.
 */
export const summarizeReadiness = (snapshot = getDependencySnapshot()) => {
  const required = Object.values(snapshot).filter((dep) => dep.required);
  if (required.some((dep) => dep.status === 'unavailable')) return 'unavailable';
  if (required.some((dep) => dep.status === 'degraded')) return 'degraded';
  return 'ready';
};

export default { getDependencySnapshot, summarizeReadiness, DEPENDENCY_STATUSES };
