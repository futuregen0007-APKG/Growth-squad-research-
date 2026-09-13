import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { invokeRoutingModel, SKIPPED_NO_BUDGET } from '../graph/llmInvoke.js';

const TestSchema = z.object({ value: z.string() });

const withClient = async (getClientImpl, fn) => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = getClientImpl;
  try {
    await fn();
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    OpenAIClientFactory.getClient = originalGetClient;
  }
};

test('invokeRoutingModel is skipped (never calls the client) once the deadline is already exhausted', async () => {
  let called = false;
  await withClient(() => ({ chat: { completions: { parse: async () => { called = true; return { choices: [{ message: { parsed: { value: 'x' } } } ] }; } } } }), async () => {
    const result = await invokeRoutingModel({
      node: 'test', model: 'gpt-4o-mini', maxTokens: 100, schema: TestSchema, schemaName: 'test', prompt: 'hi',
      deadlineAt: Date.now() - 1000,
    });
    assert.equal(called, false);
    assert.equal(result.parsed, null);
    assert.equal(result.error, SKIPPED_NO_BUDGET);
    assert.equal(result.diagnostic.skipped, SKIPPED_NO_BUDGET);
  });
});

test('invokeRoutingModel proceeds normally when plenty of budget remains, and records a safe diagnostic (no prompt/content)', async () => {
  await withClient(() => ({
    chat: { completions: { parse: async () => ({ choices: [{ message: { parsed: { value: 'ok' } } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }) } },
  }), async () => {
    const result = await invokeRoutingModel({
      node: 'classifyIntent', model: 'gpt-4o-mini', maxTokens: 100, schema: TestSchema, schemaName: 'test', prompt: 'hi',
      deadlineAt: Date.now() + 60000,
    });
    assert.equal(result.parsed.value, 'ok');
    assert.equal(result.diagnostic.node, 'classifyIntent');
    assert.equal(result.diagnostic.role, 'routing');
    assert.equal(result.diagnostic.inputTokens, 12);
    assert.equal(result.diagnostic.outputTokens, 3);
    assert.deepEqual(Object.keys(result.diagnostic).sort(), ['durationMs', 'inputTokens', 'model', 'node', 'outputTokens', 'role', 'timedOut']);
  });
});

test('invokeRoutingModel classifies an already-aborted signal as CANCELLED, not a provider error', async () => {
  const controller = new AbortController();
  controller.abort();
  await withClient(() => ({
    chat: {
      completions: {
        parse: async (body, options) => {
          if (options?.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          return { choices: [{ message: { parsed: { value: 'x' } } }] };
        },
      },
    },
  }), async () => {
    const result = await invokeRoutingModel({
      node: 'test', model: 'gpt-4o-mini', maxTokens: 100, schema: TestSchema, schemaName: 'test', prompt: 'hi',
      signal: controller.signal, deadlineAt: Date.now() + 60000,
    });
    assert.equal(result.parsed, null);
    assert.equal(result.error, 'CANCELLED');
    assert.equal(result.diagnostic.timedOut, true);
  });
});

test('invokeRoutingModel never throws when the client is not configured -- returns a NOT_CONFIGURED result instead', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => false;
  try {
    const result = await invokeRoutingModel({ node: 'test', model: 'gpt-4o-mini', maxTokens: 100, schema: TestSchema, schemaName: 'test', prompt: 'hi' });
    assert.equal(result.parsed, null);
    assert.equal(result.error, 'NOT_CONFIGURED');
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('invokeRoutingModel clears its internal timeout handle after the call settles (no dangling timer keeps the process alive)', async () => {
  const activeTimeoutsBefore = process._getActiveHandles?.().filter((h) => h.constructor?.name === 'Timeout').length ?? null;
  await withClient(() => ({
    chat: { completions: { parse: async () => ({ choices: [{ message: { parsed: { value: 'ok' } } }] }) } },
  }), async () => {
    await invokeRoutingModel({ node: 'test', model: 'gpt-4o-mini', maxTokens: 100, schema: TestSchema, schemaName: 'test', prompt: 'hi', deadlineAt: Date.now() + 60000 });
  });
  if (activeTimeoutsBefore != null) {
    const activeTimeoutsAfter = process._getActiveHandles().filter((h) => h.constructor?.name === 'Timeout').length;
    assert.ok(activeTimeoutsAfter <= activeTimeoutsBefore, 'the per-call timeout must be cleared, not left pending');
  }
});
