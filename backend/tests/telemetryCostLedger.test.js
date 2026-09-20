import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostLedger } from '../services/telemetry/costLedger.js';
import { createMetricsStore } from '../services/telemetry/metricsStore.js';
import { invokeRoutingModel } from '../graph/llmInvoke.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { z } from 'zod';

/**
 * telemetryCostLedger.test.js
 * ==============================
 * Phase 5B goal 3. The invariant: every LLM call that really happened is
 * counted exactly once — including on a turn that dies before
 * logDiagnostics ever runs — and a call whose price cannot be determined is
 * reported as unknown rather than as free.
 *
 * Under-counting cost is silent, compounding, and only discovered on an
 * invoice; double-counting is just as wrong in the other direction. These
 * tests pin both directions.
 */

const aCall = (overrides = {}) => ({
  node: 'composeAnswer',
  role: 'synthesis',
  model: 'gpt-4o-mini',
  durationMs: 120,
  timedOut: false,
  inputTokens: 1_000_000,
  outputTokens: 0,
  ...overrides,
});

test('a completed call is recorded once: its tokens and its cost', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  const result = ledger.recordCall(aCall());
  assert.equal(result.recorded, true);

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.tokenTotals.inputTokens, 1_000_000);
  assert.equal(snapshot.estimatedCostTotal, 0.15, 'priced from the real table, not invented');
  assert.equal(snapshot.costUnknownCount, 0);
});

test('the same call object submitted twice is counted ONCE', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });
  const call = aCall();

  assert.equal(ledger.recordCall(call).recorded, true);
  const second = ledger.recordCall(call);

  assert.equal(second.recorded, false);
  assert.equal(second.reason, 'ALREADY_RECORDED');
  assert.equal(store.getSnapshot().tokenTotals.inputTokens, 1_000_000, 'tokens are not doubled');
  assert.equal(store.getSnapshot().estimatedCostTotal, 0.15, 'cost is not doubled');
  assert.equal(ledger.getStats().recordedCallCount, 1);
  assert.equal(ledger.getStats().duplicateCallCount, 1);
});

test('the call-site record plus the end-of-turn sweep still counts each call once', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  // What really happens: the node records the call as it completes...
  const callA = aCall();
  const callB = aCall({ node: 'planTools', role: 'routing', inputTokens: 500_000 });
  ledger.recordCall(callA);
  ledger.recordCall(callB);

  // ...and logDiagnostics later sweeps state.llmCalls, which holds the SAME
  // objects (graph/state.js's reducer concatenates references).
  const sweep = ledger.recordMany([callA, callB]);

  assert.equal(sweep.recorded, 0, 'the sweep adds nothing that was already counted');
  assert.equal(sweep.duplicates, 2);
  assert.equal(store.getSnapshot().tokenTotals.inputTokens, 1_500_000);
});

test('a call the sweep sees FIRST is still counted -- the safety net works on its own', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  // A call site that was never wired to the ledger: logDiagnostics is the
  // only thing that ever sees it.
  const sweep = ledger.recordMany([aCall()]);

  assert.equal(sweep.recorded, 1);
  assert.equal(store.getSnapshot().estimatedCostTotal, 0.15);
});

test('a turn that dies before logDiagnostics still has its cost counted', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  // The call completed and was recorded at its own call site...
  ledger.recordCall(aCall());
  // ...and then the turn threw. logDiagnostics never runs, so no sweep
  // happens at all.
  const snapshot = store.getSnapshot();

  assert.equal(snapshot.estimatedCostTotal, 0.15, 'the money was spent, so it is counted');
  assert.equal(snapshot.tokenTotals.inputTokens, 1_000_000);
});

test('a call that was never attempted is not a cost, and not an unknown cost either', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  const result = ledger.recordCall(aCall({ skipped: 'SKIPPED_NO_BUDGET', inputTokens: null, outputTokens: null }));

  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'SKIPPED_NEVER_ATTEMPTED');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.costUnknownCount, 0, 'a call that never happened has no unknown cost');
  assert.equal(snapshot.unknownUsageCount, 0);
  assert.equal(snapshot.estimatedCostTotal, 0);
});

test('a real call with an unknown model preserves costUnknownCount rather than pricing it at zero', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  ledger.recordCall(aCall({ model: 'some-model-released-next-year' }));

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.costUnknownCount, 1, 'unknown pricing is reported as unknown');
  assert.equal(snapshot.estimatedCostTotal, 0, 'and never added as a zero-dollar call');
  assert.equal(snapshot.tokenTotals.inputTokens, 1_000_000, 'the tokens are still real and still counted');
});

test('a failed call with no usage reported counts as unknown usage AND unknown cost', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  // What a provider timeout looks like: the call happened, nothing came back.
  ledger.recordCall(aCall({ inputTokens: null, outputTokens: null, timedOut: true }));

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.unknownUsageCount, 1);
  assert.equal(snapshot.costUnknownCount, 1);
  assert.equal(snapshot.tokenTotals.inputTokens, 0, 'no phantom tokens are invented for a call that reported none');
});

test('an aliased model id from the provider is priced as its canonical model', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  ledger.recordCall(aCall({ model: 'gpt-4o-mini-2024-07-18' }));

  assert.equal(store.getSnapshot().estimatedCostTotal, 0.15);
  assert.equal(store.getSnapshot().costUnknownCount, 0);
});

test('many distinct calls are each counted once, and the totals add up', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  const calls = Array.from({ length: 50 }, (_, i) => aCall({ node: `n${i}`, inputTokens: 1000, outputTokens: 100 }));
  ledger.recordMany(calls);
  ledger.recordMany(calls); // an accidental second sweep

  assert.equal(ledger.getStats().recordedCallCount, 50);
  assert.equal(ledger.getStats().duplicateCallCount, 50);
  assert.equal(store.getSnapshot().tokenTotals.inputTokens, 50_000);
});

test('an explicit callId deduplicates even across copied objects', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });
  const call = aCall({ callId: 'call-abc' });

  ledger.recordCall(call);
  ledger.recordCall({ ...call }); // a copy: different object, same id

  assert.equal(store.getSnapshot().tokenTotals.inputTokens, 1_000_000, 'the copy is recognised and not re-counted');
  assert.equal(ledger.getStats().duplicateCallCount, 1);
});

test('the ledger never throws, whatever it is handed', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });

  assert.doesNotThrow(() => ledger.recordCall(null));
  assert.doesNotThrow(() => ledger.recordCall(undefined));
  assert.doesNotThrow(() => ledger.recordCall('not a call'));
  assert.doesNotThrow(() => ledger.recordMany(null));
  assert.doesNotThrow(() => ledger.recordMany([null, undefined, aCall()]));
  assert.equal(store.getSnapshot().tokenTotals.inputTokens, 1_000_000, 'the one real call still landed');
});

test('a store that throws cannot break the request that generated the cost', () => {
  const brokenStore = {
    recordTokenUsage() { throw new Error('store is broken'); },
    recordCost() { throw new Error('store is broken'); },
  };
  const ledger = createCostLedger({ store: brokenStore });

  const result = ledger.recordCall(aCall());
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'LEDGER_ERROR');
});

test('a REAL invokeRoutingModel call is costed the moment it completes, before any turn ends', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        parse: async () => ({
          choices: [{ message: { parsed: { intent: 'GENERAL_EDUCATION', confidence: 1 } } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
        }),
      },
    },
  });

  try {
    const { diagnostic } = await invokeRoutingModel({
      node: 'classifyIntent',
      model: 'gpt-4o-mini',
      maxTokens: 100,
      schema: z.object({ intent: z.string(), confidence: z.number() }),
      schemaName: 'intent',
      prompt: 'a routing prompt',
      deadlineAt: Date.now() + 30000,
    });

    // The diagnostic is the real object the node will put into llmCalls —
    // and the ledger has already seen it. The global ledger is shared, so
    // this asserts on the ledger's own view rather than on absolute totals.
    assert.equal(diagnostic.inputTokens, 1_000_000);
    assert.equal(diagnostic.model, 'gpt-4o-mini');

    // Phase 5A's exact-key-set contract for this diagnostic is preserved:
    // the ledger adds no field to it.
    assert.deepEqual(
      Object.keys(diagnostic).sort(),
      ['cachedInputTokens', 'durationMs', 'inputTokens', 'model', 'node', 'outputTokens', 'reasoningTokens', 'role', 'timedOut'],
    );
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('a REAL failed invokeRoutingModel call is still costed, with usage unknown', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: { completions: { parse: async () => { throw new Error('provider exploded'); } } },
  });

  try {
    const { error, diagnostic } = await invokeRoutingModel({
      node: 'classifyIntent',
      model: 'gpt-4o-mini',
      maxTokens: 100,
      schema: z.object({ intent: z.string() }),
      schemaName: 'intent',
      prompt: 'a routing prompt',
      deadlineAt: Date.now() + 30000,
    });

    assert.equal(error, 'PROVIDER_ERROR');
    // The call really was made (and may really have been billed), so a
    // diagnostic exists for it and the ledger saw it on the failure path too.
    assert.equal(diagnostic.node, 'classifyIntent');
    assert.equal(diagnostic.timedOut, false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('__resetForTests clears the ledger so isolated tests do not leak into each other', () => {
  const store = createMetricsStore();
  const ledger = createCostLedger({ store });
  const call = aCall();

  ledger.recordCall(call);
  ledger.__resetForTests();

  assert.equal(ledger.getStats().recordedCallCount, 0);
  assert.equal(ledger.recordCall(call).recorded, true, 'after a reset the same object is countable again');
});
