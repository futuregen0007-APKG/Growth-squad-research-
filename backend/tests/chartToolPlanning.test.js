import test from 'node:test';
import assert from 'node:assert/strict';
import { planTools, parseRequestedRangeDays } from '../graph/nodes/planTools.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

/**
 * chartToolPlanning.test.js
 * ============================
 * UI Phase 1C.3: getPriceHistory is planned ONLY for a genuine chart/
 * historical-price-trend request — never for a plain "what's the price"
 * question (getLiveQuote already covers that), matching the brief's
 * "fetch only for relevant historical-price/chart requests."
 */

const makeState = (message, overrides = {}) => ({
  messages: [{ content: message }],
  errors: [],
  intent: 'COMPANY_RESEARCH',
  entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
  userId: 'user-1',
  ...overrides,
});

const withNoModelCall = async (fn) => {
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.getClient = () => { throw new Error('should not be called -- this case must be fully deterministic'); };
  try {
    await fn();
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
};

// ---------------------------------------------------------------------------
// parseRequestedRangeDays -- pure, deterministic parsing.
// ---------------------------------------------------------------------------

test('parseRequestedRangeDays reads "last N days/weeks/months/years" into a calendar-day count', () => {
  assert.equal(parseRequestedRangeDays('TCS price chart for the last 30 days'), 30);
  assert.equal(parseRequestedRangeDays('show the past 2 weeks'), 14);
  assert.equal(parseRequestedRangeDays('chart for the last 6 months'), 180);
  assert.equal(parseRequestedRangeDays('past 1 year price trend'), 365);
});

test('parseRequestedRangeDays returns null when the question names no explicit range', () => {
  assert.equal(parseRequestedRangeDays('TCS price chart'), null);
});

test('parseRequestedRangeDays resolves YTD to the real number of days elapsed this year, never a fixed guess', () => {
  const days = parseRequestedRangeDays('TCS price chart YTD');
  assert.ok(Number.isInteger(days) && days >= 1 && days <= 366);
});

// ---------------------------------------------------------------------------
// planTools -- chart keyword gating, per intent.
// ---------------------------------------------------------------------------

test('a plain live-price question plans ONLY getLiveQuote -- no chart nobody asked for', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('TCS current price?', { intent: 'LIVE_MARKET_DATA' }));
    assert.deepEqual(result.toolPlan, [{ tool: 'getLiveQuote', args: { symbol: 'TCS' } }]);
  });
});

test('a LIVE_MARKET_DATA chart request plans getLiveQuote AND getPriceHistory, with the parsed range', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('Show me TCS price chart for the last 90 days', { intent: 'LIVE_MARKET_DATA' }));
    assert.deepEqual(result.toolPlan, [
      { tool: 'getLiveQuote', args: { symbol: 'TCS' } },
      { tool: 'getPriceHistory', args: { symbol: 'TCS', days: 90 } },
    ]);
  });
});

test('a chart request with no explicit range plans getPriceHistory with days: null (the tool applies its own default)', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('Show me the TCS price chart', { intent: 'LIVE_MARKET_DATA' }));
    assert.deepEqual(result.toolPlan[1], { tool: 'getPriceHistory', args: { symbol: 'TCS', days: null } });
  });
});

test('a plain COMPANY_RESEARCH question plans no chart', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('Tell me about TCS', { intent: 'COMPANY_RESEARCH' }));
    assert.equal(result.toolPlan.some((s) => s.tool === 'getPriceHistory'), false);
  });
});

test('a COMPANY_RESEARCH chart request plans getPriceHistory alongside getCompanyResearch', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('Show me a chart of TCS price history', { intent: 'COMPANY_RESEARCH' }));
    assert.deepEqual(result.toolPlan, [
      { tool: 'getCompanyResearch', args: { symbol: 'TCS' } },
      { tool: 'getPriceHistory', args: { symbol: 'TCS', days: null } },
    ]);
  });
});

test('a FOLLOW_UP chart request ("show its chart") plans ONLY getPriceHistory, not a redundant getCompanyResearch call', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('Now show its price chart', { intent: 'FOLLOW_UP' }));
    assert.deepEqual(result.toolPlan, [{ tool: 'getPriceHistory', args: { symbol: 'TCS', days: null } }]);
  });
});

test('a FOLLOW_UP financials request is unaffected by the chart wiring (no chart planned)', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('What was its revenue?', { intent: 'FOLLOW_UP' }));
    assert.deepEqual(result.toolPlan, [{ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } }]);
  });
});

test('a multi-symbol LIVE_MARKET_DATA chart request charts only the first resolved symbol, matching metric_grid/company_header\'s own single-company boundary', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('Prices and a chart for TCS, INFY', {
      intent: 'LIVE_MARKET_DATA',
      entities: { symbols: ['TCS', 'INFY'], companyNames: [], periods: [], comparisonMode: false },
    }));
    const chartSteps = result.toolPlan.filter((s) => s.tool === 'getPriceHistory');
    assert.equal(chartSteps.length, 1);
    assert.equal(chartSteps[0].args.symbol, 'TCS');
  });
});

test('getPriceHistory is an approved tool the LLM planning fallback may itself select', async () => {
  const { APPROVED_TOOLS } = await import('../graph/schemas.js');
  assert.ok(APPROVED_TOOLS.includes('getPriceHistory'));
});

// ---------------------------------------------------------------------------
// Regression: a real live check for this phase found classifyIntent.js's
// LLM call label "Show me a chart of TCS price history for the last 90
// days" as DOCUMENT_RESEARCH -- and deterministicPlan's own DOCUMENT_
// RESEARCH case ALWAYS returns [] whenever resolveResearchScope decided the
// grounded corpus isn't needed (which, for a plain price/chart question,
// classifyResearchQuestionType correctly decides), because
// resolveResearchScope UNCONDITIONALLY returns symbol: null whenever
// needsResearchCorpus is false -- so `!scope.symbol` is always true on that
// path, and the DOCUMENT_RESEARCH case can never reach its own "resolved
// symbol" branch when deterministicPlan is even reached at all. The fix:
// chart-tool wiring reads entities.symbols directly (never scope.symbol),
// applied AFTER the intent-keyed switch, independent of whichever specific
// intent bucket the LLM call happened to land on -- see planTools.js's own
// note at the fix site.
// ---------------------------------------------------------------------------

test('a chart request mislabeled DOCUMENT_RESEARCH by the intent classifier still plans getPriceHistory (the exact failure mode found via live testing)', async () => {
  await withNoModelCall(async () => {
    const result = await planTools(makeState('Show me a chart of TCS price history for the last 90 days', { intent: 'DOCUMENT_RESEARCH' }));
    assert.deepEqual(result.toolPlan, [{ tool: 'getPriceHistory', args: { symbol: 'TCS', days: 90 } }]);
  });
});

test('a genuine research-corpus question that ALSO contains real chart keywords is NOT chart-routed -- the research corpus still wins', async () => {
  await withNoModelCall(async () => {
    // Contains BOTH a genuine research-corpus signal ("filings"/"guidance")
    // AND a genuine chart signal ("chart", "last 6 months") -- proving the
    // needsResearchCorpus guard actually suppresses chart-adding here,
    // rather than this case simply never having a chart keyword to begin
    // with.
    const result = await planTools(makeState('Search TCS filings for revised guidance, and also show a price chart for the last 6 months', { intent: 'DOCUMENT_RESEARCH' }));
    assert.equal(result.toolPlan.some((s) => s.tool === 'getPriceHistory'), false);
    assert.equal(result.toolPlan.some((s) => s.tool === 'retrieveGroundedEvidence'), true);
  });
});
