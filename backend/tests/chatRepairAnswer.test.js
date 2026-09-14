import test from 'node:test';
import assert from 'node:assert/strict';
import { repairAnswer } from '../graph/nodes/repairAnswer.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

const baseState = (overrides = {}) => ({
  messages: [{ content: 'Compare TCS and Infosys' }],
  requestedDimensions: ['FINANCIALS'], evidenceCoverage: [], evidence: [], missingEvidence: [],
  draftAnswer: 'TCS revenue grew 12%.', validationIssues: ['UNCITED_FACTUAL_CLAIM'], claimValidation: [],
  repairCount: 0, deadlineAt: Date.now() + 45000, abortSignal: null, aborted: () => false, onEvent: null,
  ...overrides,
});

test('repairAnswer increments repairCount and replaces draftAnswer on a successful call', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: 'TCS revenue grew 12% [1].' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }) } },
  });
  try {
    const result = await repairAnswer(baseState());
    assert.equal(result.repairCount, 1);
    assert.equal(result.draftAnswer, 'TCS revenue grew 12% [1].');
    assert.equal(result.llmCalls[0].role, 'repair');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

// Required test 16: repair timeout fails safely
test('required test 16: a repair call that throws/times out leaves draftAnswer UNCHANGED and still increments repairCount', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({ chat: { completions: { create: async () => { throw new Error('upstream timeout'); } } } });
  try {
    const result = await repairAnswer(baseState());
    assert.equal(result.repairCount, 1, 'repairCount must still advance so the router never retries a second repair');
    assert.equal(result.draftAnswer, undefined, 'draftAnswer must be left unchanged (not overwritten with a failure), so the caller keeps the original draft');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('required test 17-equivalent: an exhausted deadline skips the repair call entirely (no OpenAI call attempted)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await repairAnswer(baseState({ deadlineAt: Date.now() - 1000 }));
    assert.equal(called, false);
    assert.equal(result.repairCount, 1);
    assert.equal(result.draftAnswer, undefined);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('a cancelled request skips the repair call entirely', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await repairAnswer(baseState({ aborted: () => true }));
    assert.equal(called, false);
    assert.equal(result.repairCount, 1);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('repairAnswer never emits a token event (repair output is still a private draft, not published)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Repaired text [1].' } }], usage: {} }) } },
  });
  const emitted = [];
  try {
    await repairAnswer(baseState({ onEvent: (e) => emitted.push(e.type) }));
    assert.ok(!emitted.includes('token'));
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});
