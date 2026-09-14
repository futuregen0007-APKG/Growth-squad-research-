import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { composeAnswer } from '../graph/nodes/composeAnswer.js';
import { graph } from '../graph/graph.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';

/**
 * chatZeroEvidenceFastPath.test.js
 * ===================================
 * Phase 4A item 9: the Phase 3 hardening benchmark showed the primary
 * comparison question needed a full compose -> verify/repair round trip
 * in 10/10 runs, purely to arrive back at the same deterministic
 * buildSafeFallback answer it would have produced anyway. These tests
 * prove: no OpenAI compose call, no repair call, no unsupported claims,
 * no leaked draft -- and that general-education answers are unaffected.
 */

const baseState = (overrides = {}) => ({
  errors: [], messages: [{ content: 'Compare TCS and Infosys' }], intent: 'STOCK_COMPARISON',
  toolPlan: [], toolResults: [], evidence: [], missingEvidence: [], warnings: [],
  userContext: {}, recentHistory: [], onEvent: null, abortSignal: null, deadlineAt: Date.now() + 45000,
  ...overrides,
});

test('composeAnswer: evidence-dependent intent, tools genuinely ran, zero evidence -> ABSTAINED with NO OpenAI call at all', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  let called = false;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should never be called'); };
  try {
    const result = await composeAnswer(baseState({
      toolResults: [{ tool: 'compareStocks', status: 'EMPTY', symbol: null }],
      evidence: [],
    }));
    assert.equal(called, false, 'composeAnswer must not call OpenAI at all for a genuinely zero-evidence evidence-dependent turn');
    assert.deepEqual(result, { validationStatus: 'ABSTAINED' });
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('the fast path never fires when SOME evidence exists (a partial answer still has real content worth composing)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  let called = false;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => { called = true; return { chat: { completions: { create: async () => ({ [Symbol.asyncIterator]: async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; yield { choices: [{ delta: {} }], usage: {} }; } }) } } }; };
  try {
    await composeAnswer(baseState({
      toolResults: [{ tool: 'getCompanyFinancials', status: 'SUCCESS', symbol: 'TCS' }],
      evidence: [{ evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'TCS' }],
    }));
    assert.equal(called, true, 'partial evidence must still go through the normal compose path');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('the fast path never fires when no tools ran at all (a different, pre-existing case handled by isGeneralEducation)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  let called = false;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => { called = true; return { chat: { completions: { create: async () => ({ [Symbol.asyncIterator]: async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; yield { choices: [{ delta: {} }], usage: {} }; } }) } } }; };
  try {
    const result = await composeAnswer(baseState({ toolResults: [], evidence: [] }));
    assert.equal(called, true);
    assert.notEqual(result.validationStatus, 'ABSTAINED');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('does not interfere with general-education answers, even with zero evidence and toolResults present', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  let called = false;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => { called = true; return { chat: { completions: { create: async () => ({ [Symbol.asyncIterator]: async function* () { yield { choices: [{ delta: { content: 'A P/E ratio...' } }] }; yield { choices: [{ delta: {} }], usage: {} }; } }) } } }; };
  try {
    const result = await composeAnswer(baseState({
      intent: 'GENERAL_EDUCATION', messages: [{ content: 'What is a P/E ratio?' }],
      toolResults: [{ tool: 'getLiveQuote', status: 'SUCCESS', symbol: 'TCS' }], // hypothetical, still irrelevant for GENERAL_EDUCATION
      evidence: [],
    }));
    assert.equal(called, true, 'GENERAL_EDUCATION must always go through the normal compose path, never the zero-evidence fast path');
    assert.notEqual(result.validationStatus, 'ABSTAINED');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

// ---------------------------------------------------------------------------
// Full pipeline: proves zero OpenAI compose/repair calls end to end, and the
// published answer is the deterministic buildSafeFallback content.
// ---------------------------------------------------------------------------
test('full pipeline: a zero-evidence comparison makes NO synthesis or repair LLM call, publishes the deterministic fallback directly', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        parse: async (args) => {
          const schemaName = args.response_format?.json_schema?.name;
          if (schemaName === 'intent_classification') return { choices: [{ message: { parsed: { intent: 'STOCK_COMPARISON', confidence: 0.9, reasoning: 'comparison' } } }] };
          if (schemaName === 'entity_extraction') return { choices: [{ message: { parsed: { symbols: ['HAL', 'BEL'], companyNames: [], periods: [], comparisonMode: true, resolvedFromFollowUp: false } } }] };
          if (schemaName === 'tool_plan') return { choices: [{ message: { parsed: { tools: [] } } }] };
          if (schemaName === 'explicit_preference') return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
          throw new Error('unexpected structured call: ' + schemaName);
        },
        create: async () => { throw new Error('composeAnswer/repairAnswer must never call chat.completions.create for a zero-evidence turn'); },
      },
    },
  });

  const emptyResult = (toolName) => ({
    tool: toolName, status: 'EMPTY', data: null, evidence: [], resultCount: 0, evidenceCount: 0,
    errorCode: null, fetchedAt: new Date().toISOString(), warning: 'Data not available for requested period',
  });
  const originalCompareStocks = TOOL_REGISTRY.compareStocks;
  const originalLiveQuote = TOOL_REGISTRY.getLiveQuote;
  const originalFinancials = TOOL_REGISTRY.getCompanyFinancials;
  const originalResearch = TOOL_REGISTRY.getCompanyResearch;
  TOOL_REGISTRY.compareStocks = async () => ({ ...emptyResult('compareStocks'), data: [], dimensions: ['PRICE', 'FINANCIALS', 'COMPANY_RESEARCH'], operationCount: 6 });
  TOOL_REGISTRY.getLiveQuote = async () => emptyResult('getLiveQuote');
  TOOL_REGISTRY.getCompanyFinancials = async () => emptyResult('getCompanyFinancials');
  TOOL_REGISTRY.getCompanyResearch = async () => emptyResult('getCompanyResearch');

  const emitted = [];
  try {
    const finalState = await graph.invoke({ messages: [new HumanMessage('Compare HAL and BEL')], onEvent: (e) => emitted.push(e) });

    assert.equal(finalState.validationStatus, 'ABSTAINED');
    assert.equal(finalState.repairCount, 0, 'no repair call was ever needed or attempted');
    assert.ok(!finalState.llmCalls.some((c) => c.role === 'synthesis'), 'no compose call');
    assert.ok(!finalState.llmCalls.some((c) => c.role === 'repair'), 'no repair call');
    assert.ok(!finalState.llmCalls.some((c) => c.role === 'verification'), 'no verifier call');
    assert.match(finalState.answer, /don't have verified data|couldn't produce/i);
    assert.ok(!/founded|1940|1954/i.test(finalState.answer), 'no unsupported/fabricated claim');

    const tokenText = emitted.filter((e) => e.type === 'token').map((e) => e.token).join('');
    assert.equal(tokenText, finalState.answer, 'no leaked draft -- only the final safe text is ever streamed');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    TOOL_REGISTRY.compareStocks = originalCompareStocks;
    TOOL_REGISTRY.getLiveQuote = originalLiveQuote;
    TOOL_REGISTRY.getCompanyFinancials = originalFinancials;
    TOOL_REGISTRY.getCompanyResearch = originalResearch;
  }
});

test('full pipeline: preserves requested symbol/dimension coverage in the deterministic fallback response', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        parse: async (args) => {
          const schemaName = args.response_format?.json_schema?.name;
          if (schemaName === 'intent_classification') return { choices: [{ message: { parsed: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' } } }] };
          if (schemaName === 'entity_extraction') return { choices: [{ message: { parsed: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false } } }] };
          if (schemaName === 'tool_plan') return { choices: [{ message: { parsed: { tools: [] } } }] };
          if (schemaName === 'explicit_preference') return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
          throw new Error('unexpected: ' + schemaName);
        },
        create: async () => { throw new Error('must never be called'); },
      },
    },
  });
  const originalFinancials = TOOL_REGISTRY.getCompanyFinancials;
  const originalResearch = TOOL_REGISTRY.getCompanyResearch;
  TOOL_REGISTRY.getCompanyFinancials = async () => ({
    tool: 'getCompanyFinancials', status: 'EMPTY', data: [], evidence: [], resultCount: 0, evidenceCount: 0,
    errorCode: null, fetchedAt: new Date().toISOString(), warning: 'Data not available for requested period',
  });
  TOOL_REGISTRY.getCompanyResearch = async () => ({
    tool: 'getCompanyResearch', status: 'UNAVAILABLE', data: null, evidence: [], resultCount: 0, evidenceCount: 0,
    errorCode: 'RATE_LIMITED', fetchedAt: new Date().toISOString(), warning: 'Provider unavailable',
  });
  try {
    const finalState = await graph.invoke({ messages: [new HumanMessage("Tell me about TCS's performance")], onEvent: () => {} });
    assert.equal(finalState.evidenceCoverage.length, 1);
    assert.equal(finalState.evidenceCoverage[0].symbol, 'TCS');
    assert.equal(finalState.evidenceCoverage[0].dimension, 'FINANCIALS');
    assert.match(finalState.answer, /TCS/);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    TOOL_REGISTRY.getCompanyFinancials = originalFinancials;
    TOOL_REGISTRY.getCompanyResearch = originalResearch;
  }
});
