import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsStore, MAX_SAMPLES_PER_STAGE_VALUE } from '../services/telemetry/metricsStore.js';
import {
  estimateCallCost, estimateRequestCost, PRICE_TABLE, PRICE_TABLE_VERSION, PRICE_TABLE_ASOF,
} from '../services/telemetry/costEstimation.js';

/**
 * Phase 5A Part 5/9 tests. Two invariants: the in-memory metrics store is
 * bounded by construction (cardinality and memory both), and an unknown
 * cost is always reported as unknown -- never silently as zero.
 */

test('a fresh store starts empty and labels itself as non-durable', () => {
  const store = createMetricsStore();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.requestTotal, 0);
  assert.deepEqual(snapshot.counters, {});
  assert.equal(snapshot.resetsOnRestart, true, 'the endpoint must never present this as a source of truth');
  assert.equal(typeof snapshot.uptimeSeconds, 'number');
  assert.deepEqual(snapshot.tokenTotals, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });
});

test('createMetricsStore returns isolated instances -- one test/store never contaminates another', () => {
  const a = createMetricsStore();
  const b = createMetricsStore();
  a.recordRequest({ completionStatus: 'grounded', isResearch: true });
  assert.equal(a.getSnapshot().requestTotal, 1);
  assert.equal(b.getSnapshot().requestTotal, 0);
});

test('recordRequest counts the research/ordinary split and only bounded completion statuses', () => {
  const store = createMetricsStore();
  store.recordRequest({ completionStatus: 'grounded', isResearch: true });
  store.recordRequest({ completionStatus: 'insufficient_evidence', isResearch: true });
  store.recordRequest({ completionStatus: null, isResearch: false });

  const { counters, requestTotal } = store.getSnapshot();
  assert.equal(requestTotal, 3, 'every request counts toward the total, even one with no grounding concept');
  assert.equal(counters['requestKind:research'], 2);
  assert.equal(counters['requestKind:ordinary'], 1);
  assert.equal(counters['completionStatus:grounded'], 1);
  assert.equal(counters['completionStatus:insufficient_evidence'], 1);
});

test('a caller-supplied completion status outside the bounded set is ignored -- cardinality can never grow', () => {
  const store = createMetricsStore();
  store.recordRequest({ completionStatus: 'something-a-caller-made-up', isResearch: false });
  store.recordRequest({ completionStatus: 'x'.repeat(5000), isResearch: false });

  const { counters, requestTotal } = store.getSnapshot();
  assert.equal(requestTotal, 2, 'the request itself is still counted');
  assert.equal(Object.keys(counters).some((key) => key.startsWith('completionStatus:')), false);
});

test('repair outcomes are counted as attempted plus exactly one of succeeded/failed', () => {
  const store = createMetricsStore();
  store.recordRequest({ completionStatus: 'grounded', repairAttempted: true, repairSucceeded: true });
  store.recordRequest({ completionStatus: 'grounded', repairAttempted: true, repairSucceeded: false });
  store.recordRequest({ completionStatus: 'grounded', repairAttempted: false });

  const { counters } = store.getSnapshot();
  assert.equal(counters['repair:attempted'], 2, 'a turn that never needed a repair is never counted as one');
  assert.equal(counters['repair:succeeded'], 1);
  assert.equal(counters['repair:failed'], 1);
});

test('count-style metrics bucket into a small fixed set, collapsing anything above 5 into "6+"', () => {
  const store = createMetricsStore();
  store.recordCitationCount(0);
  store.recordCitationCount(3);
  store.recordCitationCount(97);
  store.recordVerifiedClaimCount(2);
  store.recordRejectedClaimCount(11);
  store.recordCitationCount(-1);      // nonsense input, ignored
  store.recordCitationCount(Infinity); // nonsense input, ignored

  const { counters } = store.getSnapshot();
  assert.equal(counters['citations:0'], 1);
  assert.equal(counters['citations:3'], 1);
  assert.equal(counters['citations:6+'], 1, '97 citations must not become its own label');
  assert.equal(counters['verifiedClaims:2'], 1);
  assert.equal(counters['rejectedClaims:6+'], 1);
  assert.equal(Object.keys(counters).filter((key) => key.startsWith('citations:')).length, 3);
});

test('evidence/scope signals are recorded under fixed labels', () => {
  const store = createMetricsStore();
  store.recordAmbiguousCompany();
  store.recordUnsupportedPeriod();
  store.recordZeroEvidence();
  store.recordQuarantinedRejected();
  store.recordUnsafeEvidenceRejected();

  const { counters } = store.getSnapshot();
  assert.equal(counters['scope:ambiguousCompany'], 1);
  assert.equal(counters['scope:unsupportedPeriod'], 1);
  assert.equal(counters['evidence:zero'], 1);
  assert.equal(counters['evidence:quarantinedRejected'], 1);
  assert.equal(counters['evidence:unsafeRejected'], 1);
});

test('an over-long error category or retrieval mode is rejected rather than stored', () => {
  const store = createMetricsStore();
  store.recordErrorCategory('LLM_TIMEOUT');
  store.recordErrorCategory('x'.repeat(200));
  store.recordErrorCategory({ not: 'a string' });
  store.recordRetrievalMode('hybrid');
  store.recordRetrievalMode('y'.repeat(200));

  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.errorCategoryCounts, { LLM_TIMEOUT: 1 });
  assert.equal(snapshot.counters['retrievalMode:hybrid'], 1);
  assert.equal(Object.keys(snapshot.counters).filter((key) => key.startsWith('retrievalMode:')).length, 1);
});

test('stage latency accepts only known stages and real, non-negative durations', () => {
  const store = createMetricsStore();
  store.recordStageLatency('composeAnswer', 120);
  store.recordStageLatency('composeAnswer', 80);
  store.recordStageLatency('aStageThatDoesNotExist', 50);
  store.recordStageLatency('composeAnswer', -5);
  store.recordStageLatency('composeAnswer', Number.NaN);

  const { latencyByStage } = store.getSnapshot();
  assert.equal(latencyByStage.composeAnswer.sampleCount, 2, 'only the two genuine samples are kept');
  assert.equal(latencyByStage.aStageThatDoesNotExist, undefined);
});

test('percentiles are withheld until there are genuinely enough samples -- never computed from one data point', () => {
  const store = createMetricsStore();
  store.recordStageLatency('retrieval', 42);

  let stage = store.getSnapshot().latencyByStage.retrieval;
  assert.equal(stage.sampleCount, 1);
  assert.equal(stage.p50, null, 'a single sample is not a median');
  assert.equal(stage.p95, null);
  assert.equal(stage.note, 'insufficient samples for percentiles');

  for (let i = 0; i < 24; i += 1) store.recordStageLatency('retrieval', 10 + i);
  stage = store.getSnapshot().latencyByStage.retrieval;
  assert.equal(stage.sampleCount, 25);
  assert.equal(typeof stage.p50, 'number');
  assert.equal(typeof stage.p95, 'number', 'p95 becomes available at 20+ samples');
  assert.equal(stage.p99, null, 'p99 still withheld below 100 samples');
  assert.equal(stage.note, null);
});

test('latency samples are a bounded ring buffer -- the oldest are evicted, memory never grows', () => {
  const store = createMetricsStore();
  const total = MAX_SAMPLES_PER_STAGE_VALUE + 100;
  for (let i = 0; i < total; i += 1) store.recordStageLatency('generation', i);

  const stage = store.getSnapshot().latencyByStage.generation;
  assert.equal(stage.sampleCount, MAX_SAMPLES_PER_STAGE_VALUE, 'the buffer never exceeds its fixed capacity');
  // The retained window is the most recent 500 samples (100..599), so the
  // median is 350 -- proving the OLDEST were dropped, not the newest.
  assert.equal(stage.p50, 350);
});

test('token usage sums real numbers and counts unknown-usage calls separately', () => {
  const store = createMetricsStore();
  store.recordTokenUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5 });
  store.recordTokenUsage({ inputTokens: 50, outputTokens: 10 });
  store.recordTokenUsage({ usageUnknown: true, inputTokens: 999 });
  store.recordTokenUsage({ inputTokens: null, outputTokens: undefined });

  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.tokenTotals, { inputTokens: 150, outputTokens: 30, cachedInputTokens: 40, reasoningTokens: 5 });
  assert.equal(snapshot.unknownUsageCount, 1, 'an unknown-usage call never contributes phantom tokens');
});

test('an unknown cost is counted as unknown, never added as zero', () => {
  const store = createMetricsStore();
  store.recordCost(0.0025);
  store.recordCost(0.0005);
  store.recordCost(null);
  store.recordCost(undefined);

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.estimatedCostTotal, 0.003);
  assert.equal(snapshot.costUnknownCount, 2);
});

test('__resetForTests clears every counter, sample, and total', () => {
  const store = createMetricsStore();
  store.recordRequest({ completionStatus: 'grounded', isResearch: true });
  store.recordStageLatency('retrieval', 10);
  store.recordTokenUsage({ inputTokens: 10, outputTokens: 1 });
  store.recordCost(0.5);
  store.__resetForTests();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.requestTotal, 0);
  assert.deepEqual(snapshot.counters, {});
  assert.equal(snapshot.latencyByStage.retrieval.sampleCount, 0);
  assert.equal(snapshot.tokenTotals.inputTokens, 0);
  assert.equal(snapshot.estimatedCostTotal, 0);
});

test('estimateCallCost prices a known model from its real token counts', () => {
  const cost = estimateCallCost({ model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, PRICE_TABLE['gpt-4o-mini'].inputPer1M + PRICE_TABLE['gpt-4o-mini'].outputPer1M);
});

test('cached input tokens are priced at the cached rate and never double-billed as fresh input', () => {
  const withCache = estimateCallCost({ model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 });
  const withoutCache = estimateCallCost({ model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(withCache, PRICE_TABLE['gpt-4o'].cachedInputPer1M);
  assert.equal(withoutCache, PRICE_TABLE['gpt-4o'].inputPer1M);
  assert.ok(withCache < withoutCache, 'a fully cached prompt must cost less than an uncached one');
});

test('an unknown model or unknown token usage prices as null -- never as free', () => {
  assert.equal(estimateCallCost({ model: 'some-model-released-next-year', inputTokens: 100, outputTokens: 10 }), null);
  assert.equal(estimateCallCost({ model: 'gpt-4o-mini', inputTokens: null, outputTokens: 10 }), null);
  assert.equal(estimateCallCost({ model: 'gpt-4o-mini', inputTokens: 100, outputTokens: undefined }), null);
  assert.equal(estimateCallCost({}), null);
});

test('a null cachedInputTokens (the provider omitted it) is treated as zero cached, not as unknown', () => {
  const cost = estimateCallCost({ model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: null });
  assert.equal(cost, PRICE_TABLE['gpt-4o-mini'].inputPer1M);
});

test('estimateRequestCost sums every priced call and reports the price table version', () => {
  const result = estimateRequestCost([
    { model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 },
    { model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 },
  ]);
  assert.equal(result.estimatedCost, Number((PRICE_TABLE['gpt-4o-mini'].inputPer1M * 2).toFixed(8)));
  assert.equal(result.currency, 'USD');
  assert.equal(result.priceTableVersion, PRICE_TABLE_VERSION);
  assert.equal(result.unknownCallCount, 0);
  assert.equal(result.isEstimate, true, 'never presented as a billed amount');
});

test('a skipped call is genuinely zero calls -- not an unknown cost', () => {
  const result = estimateRequestCost([{ skipped: 'SKIPPED_NO_BUDGET', model: 'gpt-4o-mini' }]);
  assert.equal(result.estimatedCost, null);
  assert.equal(result.unknownCallCount, 0, 'a call that never happened is not a call whose cost we failed to determine');
});

test('a mix of priced and unpriced calls sums only what is known and says how many were excluded', () => {
  const result = estimateRequestCost([
    { model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 },
    { model: 'an-unpriced-model', inputTokens: 500, outputTokens: 100 },
  ]);
  assert.equal(result.estimatedCost, PRICE_TABLE['gpt-4o-mini'].inputPer1M);
  assert.equal(result.unknownCallCount, 1);
});

test('when every call is unpriced, the cost is null rather than a misleading 0', () => {
  const result = estimateRequestCost([{ model: 'an-unpriced-model', inputTokens: 500, outputTokens: 100 }]);
  assert.equal(result.estimatedCost, null);
  assert.equal(result.unknownCallCount, 1);
});

test('no LLM calls at all reports null cost, not zero', () => {
  const result = estimateRequestCost([]);
  assert.equal(result.estimatedCost, null);
  assert.equal(result.unknownCallCount, 0);
});

test('the price table is frozen and carries an explicit as-of date', () => {
  assert.equal(Object.isFrozen(PRICE_TABLE), true);
  assert.match(PRICE_TABLE_ASOF, /^\d{4}-\d{2}-\d{2}$/, 'prices are never presented as permanently current');
  for (const [model, pricing] of Object.entries(PRICE_TABLE)) {
    assert.ok(pricing.inputPer1M > 0, `${model} must have a real input price`);
    assert.ok(pricing.outputPer1M > 0, `${model} must have a real output price`);
    assert.ok(pricing.cachedInputPer1M <= pricing.inputPer1M, `${model} cached input is never dearer than fresh input`);
  }
});
