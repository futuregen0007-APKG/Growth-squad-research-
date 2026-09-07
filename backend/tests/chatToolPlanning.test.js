import test from 'node:test';
import assert from 'node:assert/strict';
import { planTools, MAX_TOOL_CALLS_PER_REQUEST } from '../graph/nodes/planTools.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

const makeState = (message, overrides = {}) => ({
  messages: [{ content: message }],
  errors: [],
  intent: 'COMPANY_RESEARCH',
  entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
  userId: 'user-1',
  ...overrides,
});

test('a general educational question plans zero tools (deterministic, no model call)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await planTools(makeState('What is P/E?', { intent: 'GENERAL_EDUCATION', entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false } }));
    assert.deepEqual(result.toolPlan, []);
    assert.equal(called, false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('a live-price question with a known symbol plans exactly getLiveQuote (deterministic, no model call)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await planTools(makeState('TCS current price?', { intent: 'LIVE_MARKET_DATA' }));
    assert.deepEqual(result.toolPlan, [{ tool: 'getLiveQuote', args: { symbol: 'TCS' } }]);
    assert.equal(called, false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('a watchlist analysis request requires no symbol and plans getWatchlist', async () => {
  const result = await planTools(makeState('Analyse my watchlist', { intent: 'WATCHLIST_ANALYSIS', entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false } }));
  assert.deepEqual(result.toolPlan, [{ tool: 'getWatchlist', args: {} }]);
});

test('watchlist/portfolio tools are stripped for an unauthenticated request, with an explicit warning', async () => {
  const result = await planTools(makeState('Analyse my portfolio', { intent: 'PORTFOLIO_ANALYSIS', userId: null, entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false } }));
  assert.deepEqual(result.toolPlan, []);
  assert.ok(result.warnings.some((w) => w.includes('Sign in')));
});

test('an EARNINGS_INTELLIGENCE question naming a specific period also plans getCompanyFinancials, not just getEarningsTimeline (real manual test found HAL has no Earnings Intelligence promise data, but real financials exist — getEarningsTimeline alone left the answer with zero evidence)', async () => {
  const result = await planTools(makeState('Analyse HAL Q2 FY26 results', {
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['HAL'], companyNames: [], periods: ['Q2 FY2026'], comparisonMode: false },
  }));
  assert.deepEqual(result.toolPlan, [
    { tool: 'getEarningsTimeline', args: { symbol: 'HAL' } },
    { tool: 'getCompanyFinancials', args: { symbol: 'HAL' } },
  ]);
});

test('an EARNINGS_INTELLIGENCE question with no financial/period signal plans only getEarningsTimeline', async () => {
  const result = await planTools(makeState('Has TCS fulfilled its management promises?', {
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
  }));
  assert.deepEqual(result.toolPlan, [{ tool: 'getEarningsTimeline', args: { symbol: 'TCS' } }]);
});

test('a follow-up mentioning debt on an active symbol plans getCompanyFinancials', async () => {
  const result = await planTools(makeState('What about its debt?', { intent: 'FOLLOW_UP' }));
  assert.deepEqual(result.toolPlan, [{ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } }]);
});

test('stock comparison with two symbols plans a single compareStocks call', async () => {
  const result = await planTools(makeState('Compare TCS and INFY', {
    intent: 'STOCK_COMPARISON',
    entities: { symbols: ['TCS', 'INFY'], companyNames: [], periods: [], comparisonMode: true },
  }));
  assert.deepEqual(result.toolPlan, [{ tool: 'compareStocks', args: { symbols: ['TCS', 'INFY'] } }]);
});

test('the tool plan is capped at MAX_TOOL_CALLS_PER_REQUEST, with a warning', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        parse: async () => ({
          choices: [{
            message: {
              parsed: {
                tools: Array.from({ length: 8 }, (_, i) => ({ tool: 'getLiveQuote', args: { symbol: `SYM${i}` }, reason: 'test' })),
              },
            },
          }],
        }),
      },
    },
  });
  try {
    // Force the LLM planning path by using an intent with no deterministic rule for empty symbols.
    const result = await planTools(makeState('Tell me something', { intent: 'COMPANY_RESEARCH', entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false } }));
    assert.equal(result.toolPlan.length, MAX_TOOL_CALLS_PER_REQUEST);
    assert.ok(result.warnings.some((w) => w.includes('Limited tool usage')));
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});
