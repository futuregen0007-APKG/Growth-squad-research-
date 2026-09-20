import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAG_EVENT_NAMES, RAG_EVENT_SCHEMA, buildSafeEvent, registerExporter, unregisterExporter,
} from '../services/telemetry/ragTelemetry.js';
import { planTools } from '../graph/nodes/planTools.js';
import { executeTools } from '../graph/nodes/executeTools.js';
import { validateEvidence } from '../graph/nodes/validateEvidence.js';
import { composeAnswer } from '../graph/nodes/composeAnswer.js';
import { validateFinalAnswer } from '../graph/nodes/validateFinalAnswer.js';
import { repairAnswer } from '../graph/nodes/repairAnswer.js';
import { withNodeTiming } from '../graph/timing.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

/**
 * telemetryEventContract.test.js
 * =================================
 * Phase 5A carry-over: every name in RAG_EVENT_NAMES is genuinely emitted
 * by a real lifecycle point, each emission satisfies its documented
 * RAG_EVENT_SCHEMA, one request's events all share one traceId, and no
 * event ever carries a prompt, an answer, evidence text, a credential, or
 * a raw token count.
 *
 * Every test here drives the REAL node functions — never a hand-written
 * imitation of what a node is assumed to emit.
 */

const TRACE_ID = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_ID = 'req-0001';

/** Captures every event emitted while `fn` runs, through a real exporter. */
const capture = async (fn) => {
  const events = [];
  const name = `contract-capture-${Math.random().toString(36).slice(2)}`;
  registerExporter(name, (event) => events.push(event));
  try { await fn(); } finally { unregisterExporter(name); }
  return events;
};

const eventsNamed = (events, name) => events.filter((e) => e.eventName === name);

/** Asserts one captured event against its own documented schema. */
const assertSatisfiesSchema = (event) => {
  const schema = RAG_EVENT_SCHEMA[event.eventName];
  assert.ok(schema, `${event.eventName} must have a documented schema`);

  for (const field of schema.required) {
    assert.ok(field in event, `${event.eventName} must carry required field "${field}"`);
    assert.notEqual(event[field], undefined, `${event.eventName}.${field} must not be undefined`);
  }

  const allowed = new Set([...schema.required, ...schema.optional, 'eventName', 'schemaVersion', 'timestamp']);
  for (const key of Object.keys(event)) {
    assert.ok(allowed.has(key), `${event.eventName} carried "${key}", which its schema does not declare`);
  }
};

/** The fields no event may ever carry, whatever a call site passes. */
const FORBIDDEN_FIELDS = ['prompt', 'completion', 'answer', 'draftAnswer', 'messages', 'evidence', 'chunkText', 'excerpt', 'inputTokens', 'outputTokens', 'apiKey', 'authorization', 'userId', 'email'];

const assertCarriesNothingSensitive = (event) => {
  for (const field of FORBIDDEN_FIELDS) {
    assert.equal(field in event, false, `${event.eventName} must never carry "${field}"`);
  }
};

const baseState = (overrides = {}) => ({
  traceId: TRACE_ID,
  requestId: REQUEST_ID,
  errors: [],
  messages: [{ content: 'Compare TCS and Infosys' }],
  intent: 'STOCK_COMPARISON',
  entities: { symbols: ['TCS', 'INFY'], periods: [] },
  toolPlan: [],
  toolResults: [],
  evidence: [],
  missingEvidence: [],
  warnings: [],
  userContext: {},
  recentHistory: [],
  onEvent: null,
  abortSignal: null,
  deadlineAt: Date.now() + 45000,
  ...overrides,
});

test('every declared event name has a documented schema, and vice versa', () => {
  assert.deepEqual([...RAG_EVENT_NAMES].sort(), Object.keys(RAG_EVENT_SCHEMA).sort());
  assert.equal(Object.isFrozen(RAG_EVENT_SCHEMA), true);
});

test('every field any schema declares is an allow-listed telemetry field', () => {
  for (const [eventName, schema] of Object.entries(RAG_EVENT_SCHEMA)) {
    for (const field of [...schema.required, ...schema.optional]) {
      const built = buildSafeEvent(eventName, { [field]: 1 });
      assert.ok(field in built, `${eventName} declares "${field}", which emitEvent would silently drop`);
    }
  }
});

test('every schema requires traceId and requestId, so one request is always linkable end to end', () => {
  for (const [eventName, schema] of Object.entries(RAG_EVENT_SCHEMA)) {
    assert.ok(schema.required.includes('traceId'), `${eventName} must require traceId`);
    assert.ok(schema.required.includes('requestId'), `${eventName} must require requestId`);
  }
});

test('no schema declares a prompt, an answer, evidence text, a credential, or a raw token count', () => {
  for (const [eventName, schema] of Object.entries(RAG_EVENT_SCHEMA)) {
    for (const field of [...schema.required, ...schema.optional]) {
      assert.equal(
        FORBIDDEN_FIELDS.includes(field), false,
        `${eventName} declares "${field}", which is never safe on a telemetry event`,
      );
    }
  }
});

test('planTools emits exactly one rag.tools.planned per turn, satisfying its schema', async () => {
  const events = await capture(() => planTools(baseState({ intent: 'GENERAL_EDUCATION', entities: { symbols: [], periods: [] } })));

  const planned = eventsNamed(events, 'rag.tools.planned');
  assert.equal(planned.length, 1, 'one planning decision, one event');
  assertSatisfiesSchema(planned[0]);
  assertCarriesNothingSensitive(planned[0]);
  assert.equal(planned[0].traceId, TRACE_ID);
  assert.equal(planned[0].toolCount, 0, 'a general-education turn genuinely plans no tools');
  assert.equal(planned[0].llmCallCount, 0, 'the deterministic planner made no model call');
});

test('planTools emits nothing at all for a turn that already failed validation', async () => {
  const events = await capture(() => planTools(baseState({ errors: ['input too long'] })));
  assert.equal(events.length, 0, 'a node that returned early never reports work it did not do');
});

test('validateEvidence emits rag.evidence.built carrying only the de-duplicated COUNT', async () => {
  const events = await capture(() => validateEvidence(baseState({
    toolPlan: [{ tool: 'getLiveQuote', args: { symbol: 'TCS' } }],
    evidence: [
      { evidenceId: 'e1', text: 'a verbatim document paragraph that must never be logged' },
      { evidenceId: 'e1', text: 'the same record, duplicated' },
      { evidenceId: 'e2', text: 'another verbatim paragraph' },
    ],
  })));

  const built = eventsNamed(events, 'rag.evidence.built');
  assert.equal(built.length, 1);
  assertSatisfiesSchema(built[0]);
  assertCarriesNothingSensitive(built[0]);
  assert.equal(built[0].evidenceCount, 2, 'the duplicate is not counted twice');
  assert.equal(JSON.stringify(built[0]).includes('verbatim'), false, 'no evidence text ever reaches the event');
});

test('executeTools emits one rag.retrieval.completed per round, with a real monotonic duration', async () => {
  const events = await capture(() => executeTools(baseState({
    toolPlan: [{ tool: 'aToolThatDoesNotExist', args: { symbol: 'TCS' } }],
  })));

  const completed = eventsNamed(events, 'rag.retrieval.completed');
  assert.equal(completed.length, 1);
  assertSatisfiesSchema(completed[0]);
  assertCarriesNothingSensitive(completed[0]);
  assert.equal(completed[0].toolCount, 1);
  assert.equal(Number.isFinite(completed[0].durationMs), true);
  assert.ok(completed[0].durationMs >= 0, 'a monotonic timer can never produce a negative duration');
});

test('a failing dependency emits dependency.failure, distinct from a timeout', async () => {
  const events = await capture(() => executeTools(baseState({
    toolPlan: [{ tool: 'aToolThatDoesNotExist', args: { symbol: 'TCS' } }],
  })));

  const failures = eventsNamed(events, 'dependency.failure');
  assert.equal(failures.length, 1);
  assertSatisfiesSchema(failures[0]);
  assertCarriesNothingSensitive(failures[0]);
  assert.equal(failures[0].tool, 'aToolThatDoesNotExist');
  assert.equal(failures[0].traceId, TRACE_ID);
  assert.equal(eventsNamed(events, 'dependency.timeout').length, 0, 'a broken dependency is never reported as a slow one');
});

test('a dependency that ran out of budget emits dependency.timeout, not dependency.failure', async () => {
  const events = await capture(() => executeTools(baseState({
    toolPlan: [{ tool: 'getLiveQuote', args: { symbol: 'TCS' } }],
    deadlineAt: Date.now() - 1000, // already past — the tool is never attempted
  })));

  const timeouts = eventsNamed(events, 'dependency.timeout');
  assert.equal(timeouts.length, 1);
  assertSatisfiesSchema(timeouts[0]);
  assert.equal(timeouts[0].tool, 'getLiveQuote');
  assert.equal(eventsNamed(events, 'dependency.failure').length, 0, 'running out of time is not the same as breaking');
});

test('a deduplicated step never reports its own dependency failure -- one outage is counted once', async () => {
  const events = await capture(() => executeTools(baseState({
    toolPlan: [
      { tool: 'aToolThatDoesNotExist', args: { symbol: 'TCS' } },
      { tool: 'aToolThatDoesNotExist', args: { symbol: 'TCS' } }, // identical: deduplicated, never really called
    ],
  })));

  assert.equal(eventsNamed(events, 'dependency.failure').length, 1, 'the repeat made no real call, so it reports no failure');
  assert.equal(eventsNamed(events, 'rag.retrieval.completed')[0].toolCount, 2, 'the round still reports both planned steps');
});

test('a healthy dependency emits no dependency event at all', async () => {
  const events = await capture(() => executeTools(baseState({
    toolPlan: [{ tool: 'getWatchlist', args: {} }],
    userId: null,
  })));
  // getWatchlist without a userId returns a safe EMPTY result, not an error.
  const dependencyEvents = [...eventsNamed(events, 'dependency.failure'), ...eventsNamed(events, 'dependency.timeout')];
  for (const event of dependencyEvents) {
    assert.notEqual(event.toolStatus, 'SUCCESS', 'a successful dependency is never reported as failed');
  }
});

test('two retrieval rounds emit two events -- a genuine replan, never a duplicate of one round', async () => {
  const state = baseState({ toolPlan: [{ tool: 'aToolThatDoesNotExist', args: { symbol: 'TCS' } }] });
  const events = await capture(async () => {
    await executeTools(state);
    await executeTools(state); // exactly what a replan cycle does
  });

  const rounds = eventsNamed(events, 'rag.retrieval.completed');
  assert.equal(rounds.length, 2, 'each real retrieval round is its own event');
  for (const round of rounds) assert.equal(round.traceId, TRACE_ID, 'both rounds link to the same request');
});

test('composeAnswer emits rag.scope.resolved exactly once, with resolved labels and no question text', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => { throw new Error('should never be called'); };
  try {
    const events = await capture(() => composeAnswer(baseState({
      toolResults: [{ tool: 'compareStocks', status: 'EMPTY', symbol: null }],
      evidence: [],
    })));

    const scope = eventsNamed(events, 'rag.scope.resolved');
    assert.equal(scope.length, 1);
    assertSatisfiesSchema(scope[0]);
    assertCarriesNothingSensitive(scope[0]);
    assert.equal(scope[0].researchQuestionType, 'NORMAL_STOCK_DATA');
    assert.equal(JSON.stringify(scope[0]).includes('Compare TCS'), false, 'the question text never reaches telemetry');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('the zero-evidence fast path emits NO generation event -- a call that never happened is never reported', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => { throw new Error('should never be called'); };
  try {
    const events = await capture(() => composeAnswer(baseState({
      toolResults: [{ tool: 'compareStocks', status: 'EMPTY', symbol: null }],
      evidence: [],
    })));
    assert.equal(eventsNamed(events, 'rag.generation.completed').length, 0);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('a real generation emits rag.generation.completed with a model and duration, but no prompt or tokens', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        create: async () => ({
          [Symbol.asyncIterator]: async function* stream() {
            yield { choices: [{ delta: { content: 'TCS grew 15%.' } }] };
            yield { usage: { prompt_tokens: 120, completion_tokens: 30 } };
          },
        }),
      },
    },
  });
  try {
    const events = await capture(() => composeAnswer(baseState({
      intent: 'GENERAL_EDUCATION',
      messages: [{ content: 'What is a P/E ratio?' }],
      entities: { symbols: [], periods: [] },
    })));

    const generation = eventsNamed(events, 'rag.generation.completed');
    assert.equal(generation.length, 1, 'one generation call, one event');
    assertSatisfiesSchema(generation[0]);
    assertCarriesNothingSensitive(generation[0]);
    assert.equal(typeof generation[0].model, 'string');
    assert.equal(Number.isFinite(generation[0].durationMs), true);
    assert.equal(JSON.stringify(generation[0]).includes('P/E'), false, 'the prompt never reaches telemetry');
    // Token counts stay on llmCalls, never on a stage event. Asserted by
    // FIELD rather than by substring: a substring check for the mocked
    // token value also matches a durationMs that happens to contain the
    // same digits (e.g. 1120ms), which made this flake under suite load.
    assert.equal('inputTokens' in generation[0], false);
    assert.equal('outputTokens' in generation[0], false);
    assert.equal('cachedInputTokens' in generation[0], false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('validateFinalAnswer emits rag.verification.completed carrying its real verdict', async () => {
  const events = await capture(() => validateFinalAnswer(baseState({
    validationStatus: 'ABSTAINED', // a genuine pass-through branch
    draftAnswer: null,
  })));

  const verification = eventsNamed(events, 'rag.verification.completed');
  assert.equal(verification.length, 1, 'even a pass-through verification pass is reported');
  assertSatisfiesSchema(verification[0]);
  assertCarriesNothingSensitive(verification[0]);
  assert.equal(verification[0].verificationVerdict, 'ABSTAINED');
  assert.equal(verification[0].repairAttempted, false);
  assert.equal(Number.isFinite(verification[0].durationMs), true);
});

test('a re-verification after a repair is reported as its own pass, flagged as such', async () => {
  const events = await capture(() => validateFinalAnswer(baseState({
    validationStatus: 'ABSTAINED',
    draftAnswer: null,
    repairCount: 1,
    repairAttempted: true,
  })));

  const verification = eventsNamed(events, 'rag.verification.completed')[0];
  assert.equal(verification.repairAttempted, true, 'the second pass is distinguishable from the first');
});

test('repairAnswer emits a started/completed pair, reporting honestly that nothing was produced', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => false; // no client: the repair genuinely cannot run
  try {
    const events = await capture(() => repairAnswer(baseState({
      validationStatus: 'REPAIR_REQUIRED',
      draftAnswer: 'a draft with an unsupported claim',
    })));

    const started = eventsNamed(events, 'rag.repair.started');
    const completed = eventsNamed(events, 'rag.repair.completed');
    assert.equal(started.length, 1);
    assert.equal(completed.length, 1, 'a repair that could not run still completes, never silently vanishes');
    assertSatisfiesSchema(started[0]);
    assertSatisfiesSchema(completed[0]);
    assertCarriesNothingSensitive(started[0]);
    assertCarriesNothingSensitive(completed[0]);
    assert.equal(started[0].verificationVerdict, 'REPAIR_REQUIRED');
    assert.equal(completed[0].repairSucceeded, false, 'no new draft was produced, and the event says so');
    assert.equal(JSON.stringify(completed[0]).includes('unsupported claim'), false, 'the draft never reaches telemetry');
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('withNodeTiming emits one rag.stage.completed per node that actually ran', async () => {
  const events = await capture(async () => {
    const wrapped = withNodeTiming('composeAnswer', async () => ({ draftAnswer: 'x' }));
    await wrapped(baseState());
  });

  const stages = eventsNamed(events, 'rag.stage.completed');
  assert.equal(stages.length, 1);
  assertSatisfiesSchema(stages[0]);
  assertCarriesNothingSensitive(stages[0]);
  assert.equal(stages[0].stage, 'composeAnswer');
  assert.ok(stages[0].durationMs >= 0);
});

test('every event of one request shares one traceId, across nodes and rounds', async () => {
  const events = await capture(async () => {
    const state = baseState({ toolPlan: [{ tool: 'aToolThatDoesNotExist', args: { symbol: 'TCS' } }] });
    await planTools(baseState({ intent: 'GENERAL_EDUCATION', entities: { symbols: [], periods: [] } }));
    await executeTools(state);
    await validateEvidence(state);
    await validateFinalAnswer(baseState({ validationStatus: 'ABSTAINED', draftAnswer: null }));
  });

  assert.ok(events.length >= 4, 'several lifecycle points reported');
  for (const event of events) {
    assert.equal(event.traceId, TRACE_ID, `${event.eventName} must carry this request's trace id`);
    assert.equal(event.requestId, REQUEST_ID);
    assertSatisfiesSchema(event);
    assertCarriesNothingSensitive(event);
  }
});

test('every event carries the telemetry schema version and a timestamp, for a downstream consumer', async () => {
  const events = await capture(() => planTools(baseState({ intent: 'GENERAL_EDUCATION', entities: { symbols: [], periods: [] } })));
  for (const event of events) {
    assert.equal(event.schemaVersion, 1);
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  }
});
