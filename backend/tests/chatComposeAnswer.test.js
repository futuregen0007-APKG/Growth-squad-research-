import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswer } from '../graph/nodes/composeAnswer.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

const makeFakeStreamingClient = (capture) => ({
  chat: {
    completions: {
      create: async (args) => {
        capture.push(args);
        return {
          [Symbol.asyncIterator]: async function* iterate() {
            yield { choices: [{ delta: { content: 'answer text' } }] };
            yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
          },
        };
      },
    },
  },
});

const baseState = (overrides = {}) => ({
  errors: [], messages: [{ content: 'Compare HAL and BEL' }], intent: 'STOCK_COMPARISON',
  toolPlan: [], toolResults: [], evidence: [], missingEvidence: [], warnings: [],
  userContext: {}, recentHistory: [], onEvent: null, abortSignal: null, deadlineAt: Date.now() + 45000,
  ...overrides,
});

test('Phase 2 regression: a replan round that legitimately ends with an empty toolPlan must NOT be treated as "no tools were needed" when real toolResults exist', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  const capturedCalls = [];
  OpenAIClientFactory.getClient = () => makeFakeStreamingClient(capturedCalls);

  try {
    // Simulates exactly the live-found scenario: round 2's replan found
    // nothing actionable and returned toolPlan: [], but toolResults (from
    // round 1, accumulated via state.js's mergeToolResults) is non-empty.
    await composeAnswer(baseState({
      toolPlan: [], // the LATEST round's plan -- legitimately empty
      toolResults: [{ tool: 'compareStocks', status: 'EMPTY', symbol: null }], // but tools DID run
    }));

    const userMessage = capturedCalls[0].messages.find((m) => m.role === 'user');
    assert.ok(
      !userMessage.content.includes('no citations needed since no company-specific tool data was used'),
      'must not fall back to the "no tools were needed" general-education framing when tools genuinely ran this turn',
    );
    assert.ok(userMessage.content.includes('Compare HAL and BEL'));
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('a genuinely tool-less question (planTools decided none were needed, toolResults empty too) still uses the general-education framing', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  const capturedCalls = [];
  OpenAIClientFactory.getClient = () => makeFakeStreamingClient(capturedCalls);

  try {
    await composeAnswer(baseState({
      intent: 'GENERAL_EDUCATION', messages: [{ content: 'What is a P/E ratio?' }],
      toolPlan: [], toolResults: [],
    }));
    const userMessage = capturedCalls[0].messages.find((m) => m.role === 'user');
    assert.ok(userMessage.content.includes('no citations needed since no company-specific tool data was used'));
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('when real evidence exists, the full evidence-grounded prompt is used, including any missingDataNotes', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  const capturedCalls = [];
  OpenAIClientFactory.getClient = () => makeFakeStreamingClient(capturedCalls);

  try {
    await composeAnswer(baseState({
      toolPlan: [{ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } }],
      toolResults: [{ tool: 'getCompanyFinancials', status: 'SUCCESS', symbol: 'TCS' }],
      evidence: [{ evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS financials', excerpt: 'Revenue grew' }],
      missingEvidence: [{ symbol: 'TCS', dimension: 'NEWS', status: 'EMPTY' }],
    }));
    const userMessage = capturedCalls[0].messages.find((m) => m.role === 'user');
    assert.ok(userMessage.content.includes('FINANCIAL_DATA'));
    assert.ok(userMessage.content.includes('TCS news: no data was found'));
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});
