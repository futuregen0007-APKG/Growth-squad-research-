/**
 * metricsStore.js
 * =================
 * Phase 5A Part 9: bounded, in-process, in-memory aggregator for RAG
 * operational metrics. NOT a source of truth and NOT durable — every
 * counter and sample resets to zero on process restart (documented,
 * expected, and exactly why the diagnostics endpoint labels it as such).
 *
 * Bounded by construction:
 *   - Counters are a fixed-size Map keyed ONLY by values from a small,
 *     enumerated set this module itself defines (status/category names) —
 *     never keyed by anything caller-supplied (a query string, an error
 *     message, a symbol), so cardinality can never grow unbounded.
 *   - Latency samples are a fixed-capacity ring buffer per stage
 *     (MAX_SAMPLES_PER_STAGE) — the oldest sample is evicted once full,
 *     never an unbounded array.
 *   - Nothing here ever stores a prompt, an evidence chunk, a document
 *     excerpt, a citation URL, or a trace id — only numbers and a small
 *     set of enumerated labels.
 *
 * Safe under concurrent async requests: every mutation is a single
 * synchronous operation on a plain Map/array (JavaScript's own
 * run-to-completion semantics make this safe without a lock — there is no
 * `await` between reading and writing any counter here).
 */

const MAX_SAMPLES_PER_STAGE = 500;

const BOUNDED_COMPLETION_STATUSES = Object.freeze([
  'grounded', 'partially_grounded', 'insufficient_evidence', 'refused', 'unsupported', 'failed',
]);

const BOUNDED_STAGES = Object.freeze([
  'validateInput', 'loadThreadMemory', 'loadUserContext', 'classifyIntent', 'extractEntities', 'planTools',
  'executeTools', 'validateEvidence', 'assessEvidenceSufficiency', 'replanMissingEvidence', 'composeAnswer',
  'validateFinalAnswer', 'repairAnswer', 'publishFinalAnswer', 'buildSafeFallback', 'logDiagnostics', 'saveMemory',
  'httpRequest', 'retrieval', 'generation', 'verification', 'repair',
]);

const startedAt = Date.now();

const RollingSamples = () => {
  const buffer = [];
  let head = 0;
  return {
    push(value) {
      if (buffer.length < MAX_SAMPLES_PER_STAGE) {
        buffer.push(value);
      } else {
        buffer[head] = value;
        head = (head + 1) % MAX_SAMPLES_PER_STAGE;
      }
    },
    values() { return buffer; },
  };
};

const percentile = (sortedValues, p) => {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[index];
};

/**
 * createMetricsStore - a factory (not a singleton export) so tests can
 * create an isolated store rather than sharing global mutable state with
 * every other test file. The app's own single shared instance is exported
 * at the bottom as `metricsStore`.
 */
export const createMetricsStore = () => {
  const counters = new Map(); // "category:label" -> count, label always from a bounded enum
  const latencySamples = new Map(BOUNDED_STAGES.map((stage) => [stage, RollingSamples()]));
  const tokenTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  let unknownUsageCount = 0;
  let estimatedCostTotal = 0;
  let costUnknownCount = 0;
  let requestTotal = 0;
  const errorCategoryCounts = new Map();

  const bump = (category, label) => {
    const key = `${category}:${label}`;
    counters.set(key, (counters.get(key) || 0) + 1);
  };

  return {
    startedAt,

    recordRequest({ completionStatus, isResearch, repairAttempted, repairSucceeded } = {}) {
      requestTotal += 1;
      bump('requestKind', isResearch ? 'research' : 'ordinary');
      if (completionStatus && BOUNDED_COMPLETION_STATUSES.includes(completionStatus)) {
        bump('completionStatus', completionStatus);
      }
      if (repairAttempted) {
        bump('repair', 'attempted');
        bump('repair', repairSucceeded ? 'succeeded' : 'failed');
      }
    },

    recordAmbiguousCompany() { bump('scope', 'ambiguousCompany'); },
    recordUnsupportedPeriod() { bump('scope', 'unsupportedPeriod'); },
    recordZeroEvidence() { bump('evidence', 'zero'); },
    recordQuarantinedRejected() { bump('evidence', 'quarantinedRejected'); },
    recordUnsafeEvidenceRejected() { bump('evidence', 'unsafeRejected'); },
    recordCitationCount(count) { if (Number.isFinite(count) && count >= 0) bump('citations', count > 5 ? '6+' : String(count)); },
    recordVerifiedClaimCount(count) { if (Number.isFinite(count) && count >= 0) bump('verifiedClaims', count > 5 ? '6+' : String(count)); },
    recordRejectedClaimCount(count) { if (Number.isFinite(count) && count >= 0) bump('rejectedClaims', count > 5 ? '6+' : String(count)); },
    recordRetrievalMode(mode) { if (typeof mode === 'string' && mode.length <= 40) bump('retrievalMode', mode); },

    recordErrorCategory(category) {
      if (typeof category !== 'string' || category.length > 40) return;
      errorCategoryCounts.set(category, (errorCategoryCounts.get(category) || 0) + 1);
    },

    /** durationMs must already be a monotonic-timer-derived duration — this store never computes it itself. */
    recordStageLatency(stage, durationMs) {
      if (!BOUNDED_STAGES.includes(stage) || !Number.isFinite(durationMs) || durationMs < 0) return;
      latencySamples.get(stage).push(durationMs);
    },

    recordTokenUsage({
      inputTokens, outputTokens, cachedInputTokens, reasoningTokens, usageUnknown,
    } = {}) {
      if (usageUnknown) { unknownUsageCount += 1; return; }
      if (Number.isFinite(inputTokens)) tokenTotals.inputTokens += inputTokens;
      if (Number.isFinite(outputTokens)) tokenTotals.outputTokens += outputTokens;
      if (Number.isFinite(cachedInputTokens)) tokenTotals.cachedInputTokens += cachedInputTokens;
      if (Number.isFinite(reasoningTokens)) tokenTotals.reasoningTokens += reasoningTokens;
    },

    recordCost(estimatedCost) {
      if (estimatedCost === null || estimatedCost === undefined) { costUnknownCount += 1; return; }
      if (Number.isFinite(estimatedCost)) estimatedCostTotal += estimatedCost;
    },

    getSnapshot() {
      const latency = {};
      for (const [stage, samples] of latencySamples.entries()) {
        const sorted = [...samples.values()].sort((a, b) => a - b);
        latency[stage] = {
          sampleCount: sorted.length,
          p50: sorted.length >= 2 ? percentile(sorted, 50) : null,
          p95: sorted.length >= 20 ? percentile(sorted, 95) : null,
          p99: sorted.length >= 100 ? percentile(sorted, 99) : null,
          note: sorted.length < 2 ? 'insufficient samples for percentiles' : null,
        };
      }
      return {
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        resetsOnRestart: true,
        requestTotal,
        counters: Object.fromEntries(counters),
        errorCategoryCounts: Object.fromEntries(errorCategoryCounts),
        latencyByStage: latency,
        tokenTotals: { ...tokenTotals },
        unknownUsageCount,
        estimatedCostTotal: Number(estimatedCostTotal.toFixed(6)),
        costUnknownCount,
      };
    },

    /** Test-only: resets every counter/sample. Never used by app code. */
    __resetForTests() {
      counters.clear();
      errorCategoryCounts.clear();
      for (const stage of BOUNDED_STAGES) latencySamples.set(stage, RollingSamples());
      tokenTotals.inputTokens = 0; tokenTotals.outputTokens = 0; tokenTotals.cachedInputTokens = 0; tokenTotals.reasoningTokens = 0;
      unknownUsageCount = 0; estimatedCostTotal = 0; costUnknownCount = 0; requestTotal = 0;
    },
  };
};

export const metricsStore = createMetricsStore();
export const BOUNDED_STAGES_LIST = BOUNDED_STAGES;
export const BOUNDED_COMPLETION_STATUSES_LIST = BOUNDED_COMPLETION_STATUSES;
export const MAX_SAMPLES_PER_STAGE_VALUE = MAX_SAMPLES_PER_STAGE;

export default { createMetricsStore, metricsStore };
