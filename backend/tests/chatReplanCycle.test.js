import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { graph } from '../graph/graph.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';

/**
 * chatReplanCycle.test.js
 * =========================
 * Phase 2's bounded replan cycle, exercised through a REAL graph.invoke —
 * not just the individual node/reducer unit tests elsewhere. Scenario:
 * planTools' deterministic COMPANY_RESEARCH case only ever plans
 * getCompanyFinancials/getCompanyResearch (never getCompanyNews — that
 * branch's own scope was untouched by Phase 2), while the message's
 * wording resolves NEWS as a requested dimension too (graph/dimensions.js).
 * Round 1 therefore has a genuine, structural gap for NEWS; the replan
 * cycle should fill it in round 2, bounded to exactly one extra round.
 */

const makeFakeOpenAI = ({ intent, entities, streamTokens = ['OK'] }) => ({
  chat: {
    completions: {
      parse: async (args) => {
        const schemaName = args.response_format?.json_schema?.name;
        if (schemaName === 'intent_classification') return { choices: [{ message: { parsed: intent } }] };
        if (schemaName === 'entity_extraction') return { choices: [{ message: { parsed: entities } }] };
        if (schemaName === 'tool_plan') return { choices: [{ message: { parsed: { tools: [] } } }] };
        if (schemaName === 'explicit_preference') return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
        return { choices: [{ message: { parsed: null } }] };
      },
      create: async () => ({
        [Symbol.asyncIterator]: async function* iterate() {
          for (const token of streamTokens) yield { choices: [{ delta: { content: token } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        },
      }),
    },
  },
});

test('a genuine round-1 evidence gap (NEWS never planned by COMPANY_RESEARCH) triggers exactly one replan round that fills it, accumulating evidence from both rounds', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'company research with financial and news wording' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    streamTokens: ['TCS revenue grew and recent news was positive [1][2].'],
  });

  const originalFinancials = TOOL_REGISTRY.getCompanyFinancials;
  const originalResearch = TOOL_REGISTRY.getCompanyResearch;
  const originalNews = TOOL_REGISTRY.getCompanyNews;
  let newsCallCount = 0;

  TOOL_REGISTRY.getCompanyFinancials = async () => ({
    tool: 'getCompanyFinancials', status: 'SUCCESS', data: [{ period: '2026' }],
    evidence: [{ evidenceId: 'ev-fin', claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS financials', publishedAt: '2026-01-01', excerpt: 'Revenue grew 12%' }],
    resultCount: 1, evidenceCount: 1, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
  });
  TOOL_REGISTRY.getCompanyResearch = async () => ({
    tool: 'getCompanyResearch', status: 'EMPTY', data: null, evidence: [],
    resultCount: 0, evidenceCount: 0, errorCode: null, fetchedAt: new Date().toISOString(), warning: 'No data available for this period.',
  });
  TOOL_REGISTRY.getCompanyNews = async () => {
    newsCallCount += 1;
    return {
      tool: 'getCompanyNews', status: 'SUCCESS', data: [{ title: 'TCS wins deal' }],
      evidence: [{ evidenceId: 'ev-news', claimType: 'COMPANY_NEWS', symbol: 'TCS', title: 'TCS wins deal', sourceUrl: 'https://example.com/tcs', publishedAt: '2026-01-02', excerpt: 'TCS won a major deal.' }],
      resultCount: 1, evidenceCount: 1, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
    };
  };

  try {
    const finalState = await graph.invoke({
      messages: [new HumanMessage('Tell me about TCS revenue and recent news')],
      onEvent: () => {},
    });

    assert.equal(finalState.requestedDimensions.includes('FINANCIALS'), true);
    assert.equal(finalState.requestedDimensions.includes('NEWS'), true);

    // Round 2 (replan) is the one that planned getCompanyNews -- round 1's
    // own COMPANY_RESEARCH branch (planTools.js) never includes it. state.
    // toolPlan holds only the LATEST round's plan (by design — each round's
    // plan is a fresh, self-contained instruction; see graph/state.js),
    // so this is checked via the round-2 plan itself, not round 1's.
    assert.deepEqual(finalState.toolPlan, [{ tool: 'getCompanyNews', args: { symbol: 'TCS' } }]);

    // The replan round fetched it exactly once.
    assert.equal(newsCallCount, 1, 'the replan round must fetch the missing dimension exactly once, never looping further');
    assert.equal(finalState.replanCount, 1, 'exactly one replan round, never more');

    // Evidence from BOTH rounds is present -- round 2 must not have erased round 1's financials evidence.
    const claimTypes = finalState.evidence.map((e) => e.claimType);
    assert.ok(claimTypes.includes('FINANCIAL_DATA'), 'round-1 evidence must survive into the final state');
    assert.ok(claimTypes.includes('COMPANY_NEWS'), 'round-2 (replan) evidence must be present in the final state');

    // toolResults reflects both rounds too (getCompanyFinancials + getCompanyNews present).
    const toolNames = finalState.toolResults.map((r) => r.tool);
    assert.ok(toolNames.includes('getCompanyFinancials'));
    assert.ok(toolNames.includes('getCompanyNews'));

    // executeTools ran exactly twice (once per round) -- proof the cycle terminated, not looping.
    const executeToolsRuns = finalState.nodeTimings.filter((t) => t.node === 'executeTools').length;
    assert.equal(executeToolsRuns, 2);
    const assessRuns = finalState.nodeTimings.filter((t) => t.node === 'assessEvidenceSufficiency').length;
    assert.equal(assessRuns, 2, 'assessEvidenceSufficiency runs once per round (the second time correctly decides not to replan again)');

    // The final coverage matrix reflects the fix -- NEWS is COVERED after the replan, not still missing.
    const newsRow = finalState.evidenceCoverage.find((r) => r.symbol === 'TCS' && r.dimension === 'NEWS');
    assert.equal(newsRow.status, 'COVERED');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    TOOL_REGISTRY.getCompanyFinancials = originalFinancials;
    TOOL_REGISTRY.getCompanyResearch = originalResearch;
    TOOL_REGISTRY.getCompanyNews = originalNews;
  }
});

test('when round 1 already fully covers every requested dimension, no replan round runs at all', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'LIVE_MARKET_DATA', confidence: 0.9, reasoning: 'price' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    streamTokens: ['TCS is at 4120 [1].'],
  });

  const originalQuote = TOOL_REGISTRY.getLiveQuote;
  TOOL_REGISTRY.getLiveQuote = async () => ({
    tool: 'getLiveQuote', status: 'SUCCESS', data: { ticker: 'TCS', price: 4120 },
    evidence: [{ evidenceId: 'ev-1', claimType: 'LIVE_PRICE', symbol: 'TCS', title: 'TCS live quote', publishedAt: '2026-01-01', excerpt: 'Price 4120' }],
    resultCount: 1, evidenceCount: 1, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
  });

  try {
    const finalState = await graph.invoke({ messages: [new HumanMessage('What is the current price of TCS?')], onEvent: () => {} });
    assert.equal(finalState.replanCount, 0);
    const executeToolsRuns = finalState.nodeTimings.filter((t) => t.node === 'executeTools').length;
    assert.equal(executeToolsRuns, 1, 'a fully-covered round 1 must never trigger a second round');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    TOOL_REGISTRY.getLiveQuote = originalQuote;
  }
});
