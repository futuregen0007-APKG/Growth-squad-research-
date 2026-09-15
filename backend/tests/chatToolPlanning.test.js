import test from 'node:test';
import assert from 'node:assert/strict';
import { planTools, MAX_TOOL_CALLS_PER_REQUEST } from '../graph/nodes/planTools.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { DEFAULT_COMPARISON_DIMENSIONS } from '../graph/dimensions.js';

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

test('Phase 4C: a promise-vs-outcome question ("has TCS fulfilled its promises?") now also plans grounded RAG retrieval alongside getEarningsTimeline, deterministically', async () => {
  // Pre-Phase-4C, this planned ONLY getEarningsTimeline. Phase 4C's
  // deterministic research-routing policy (graph/researchScope.js)
  // recognizes this exact phrasing as a PROMISE_VS_OUTCOME research
  // question (independent of the EARNINGS_INTELLIGENCE intent label) and
  // ALSO retrieves grounded document evidence, merged into the same
  // trusted envelope as Earnings Intelligence's own structured promise/
  // outcome data -- getEarningsTimeline itself is still planned unchanged
  // (its existing timeline/cards data is never removed), so this is a
  // strict addition, not a replacement.
  const result = await planTools(makeState('Has TCS fulfilled its management promises?', {
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
  }));
  assert.deepEqual(result.toolPlan, [
    {
      tool: 'retrieveGroundedEvidence', args: {
        symbol: 'TCS', fiscalYear: null, fiscalQuarter: null, query: 'Has TCS fulfilled its management promises?',
      },
    },
    { tool: 'getEarningsTimeline', args: { symbol: 'TCS' } },
  ]);
});

test('a follow-up mentioning debt on an active symbol plans getCompanyFinancials', async () => {
  const result = await planTools(makeState('What about its debt?', { intent: 'FOLLOW_UP' }));
  assert.deepEqual(result.toolPlan, [{ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } }]);
});

// Phase 2: canonical comparison planning. A bare "compare X and Y" (no
// requestedDimensions resolved -- see graph/dimensions.js) plans a SINGLE
// compareStocks call carrying the documented DEFAULT_COMPARISON_DIMENSIONS,
// never a second, separate top-level call for the same data.
test('stock comparison with two symbols and no explicit dimension plans a single compareStocks call with the default dimensions', async () => {
  const result = await planTools(makeState('Compare TCS and INFY', {
    intent: 'STOCK_COMPARISON',
    entities: { symbols: ['TCS', 'INFY'], companyNames: [], periods: [], comparisonMode: true },
  }));
  assert.deepEqual(result.toolPlan, [{ tool: 'compareStocks', args: { symbols: ['TCS', 'INFY'], dimensions: [...DEFAULT_COMPARISON_DIMENSIONS] } }]);
});

// Phase 2 regression: "Compare TCS and Infosys using financial growth,
// management guidance and recent news" previously planned compareStocks
// (which never fetched news/guidance) with no way to ask for what was
// actually requested. Now the resolved dimensions (extractEntities, run
// before planTools) flow straight into the ONE compareStocks call, and
// planTools never adds a redundant separate getCompanyFinancials/
// getCompanyNews/getEarningsTimeline step for a symbol already inside it.
test('stock comparison with explicit requestedDimensions plans a single compareStocks call carrying exactly those dimensions -- never a duplicate top-level call', async () => {
  const result = await planTools(makeState('Compare TCS and Infosys using financial growth, management guidance and recent news', {
    intent: 'STOCK_COMPARISON',
    entities: { symbols: ['TCS', 'INFY'], companyNames: ['Tata Consultancy Services', 'Infosys'], periods: [], comparisonMode: true },
    requestedDimensions: ['FINANCIALS', 'GUIDANCE', 'NEWS'],
  }));
  assert.deepEqual(result.toolPlan, [{ tool: 'compareStocks', args: { symbols: ['TCS', 'INFY'], dimensions: ['FINANCIALS', 'GUIDANCE', 'NEWS'] } }]);
  assert.equal(result.toolPlan.length, 1, 'exactly one planned step -- no separate duplicate getCompanyFinancials/getCompanyNews call alongside it');
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
