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

test('Phase 2 regression + Phase 4A fast path: a replan round that legitimately ends with an empty toolPlan and zero evidence abstains directly, with NO OpenAI call at all', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  const capturedCalls = [];
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; return makeFakeStreamingClient(capturedCalls); };

  try {
    // Simulates exactly the live-found scenario: round 2's replan found
    // nothing actionable and returned toolPlan: [], but toolResults (from
    // round 1, accumulated via state.js's mergeToolResults) is non-empty.
    // Phase 4A's zero-evidence fast path (see composeAnswer.js) now
    // intercepts this exact shape BEFORE any prompt is even built — a
    // strictly stronger guarantee than the original Phase 2 fix (which
    // only ensured the RIGHT prompt was used; now no LLM call happens at
    // all when there is genuinely nothing to compose from).
    const result = await composeAnswer(baseState({
      toolPlan: [], // the LATEST round's plan -- legitimately empty
      toolResults: [{ tool: 'compareStocks', status: 'EMPTY', symbol: null }], // but tools DID run
      evidence: [], // and came back with nothing
    }));

    assert.equal(called, false, 'the zero-evidence fast path must skip the OpenAI call entirely, not just pick a different prompt');
    // Phase 5A: composeAnswer now always additionally returns a
    // `scopeSignal` mirror of its own internal resolveResearchScope call
    // (for operational telemetry's error-category classification — see
    // services/telemetry/errorTaxonomy.js) alongside whatever
    // composeAnswerInner's branching logic decided — never a change to
    // that branching logic or its own returned fields.
    assert.equal(result.validationStatus, 'ABSTAINED');
    assert.deepEqual(result.scopeSignal, {
      researchQuestionType: 'NORMAL_STOCK_DATA', needsResearchCorpus: false, ambiguousCompany: false, symbol: null, fiscalYear: null, fiscalQuarter: null,
    });
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('Phase 2 regression (nonzero evidence): a replan round ending with an empty toolPlan but real toolResults/evidence still uses the evidence-grounded prompt, never the "no tools were needed" framing', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  const capturedCalls = [];
  OpenAIClientFactory.getClient = () => makeFakeStreamingClient(capturedCalls);

  try {
    // Same "empty latest toolPlan" shape as above, but this time SOME real
    // evidence exists (e.g. price came through even though financials
    // didn't) -- the zero-evidence fast path must NOT fire here, and the
    // original Phase 2 prompt-selection fix must still hold.
    await composeAnswer(baseState({
      toolPlan: [],
      toolResults: [{ tool: 'compareStocks', status: 'SUCCESS', symbol: null }],
      evidence: [{ evidenceId: 'e1', claimType: 'LIVE_PRICE', symbol: 'HAL', title: 'HAL price', excerpt: 'Price 4905' }],
    }));

    const userMessage = capturedCalls[0].messages.find((m) => m.role === 'user');
    assert.ok(
      !userMessage.content.includes('no citations needed since no company-specific tool data was used'),
      'must not fall back to the "no tools were needed" general-education framing when tools genuinely ran and produced real evidence',
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
