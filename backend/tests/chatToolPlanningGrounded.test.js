import test from 'node:test';
import assert from 'node:assert/strict';
import { planTools } from '../graph/nodes/planTools.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

const makeState = (message, overrides = {}) => ({
  messages: [{ content: message }],
  errors: [],
  intent: 'DOCUMENT_RESEARCH',
  entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false },
  userId: 'user-1',
  ...overrides,
});

test('a resolved single-company research question plans retrieveGroundedEvidence, deterministically (no model call)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await planTools(makeState('What was TCS FY2023 guidance?', {
      entities: { symbols: ['TCS'], companyNames: [], periods: ['FY2023'], comparisonMode: false },
    }));
    // Phase 4C: a MANAGEMENT_GUIDANCE question also merges Earnings
    // Intelligence's own structured promise/outcome evidence — see
    // researchScope.js's MERGE_EARNINGS_INTELLIGENCE_TYPES.
    assert.deepEqual(result.toolPlan, [
      {
        tool: 'retrieveGroundedEvidence', args: {
          symbol: 'TCS', fiscalYear: 'FY2023', fiscalQuarter: null, query: 'What was TCS FY2023 guidance?',
        },
      },
      { tool: 'getEarningsTimeline', args: { symbol: 'TCS' } },
    ]);
    assert.equal(called, false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('an ambiguous (zero-symbol) research question plans NO tools -- never guesses a substitute company', async () => {
  const result = await planTools(makeState('What was the guidance?', {
    entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false },
  }));
  assert.deepEqual(result.toolPlan, []);
});

test('a multi-symbol research question (never a legitimate single-company DOCUMENT_RESEARCH case) also plans no tools', async () => {
  const result = await planTools(makeState('What was the guidance for TCS and Infosys?', {
    entities: { symbols: ['TCS', 'INFY'], companyNames: [], periods: [], comparisonMode: false },
  }));
  assert.deepEqual(result.toolPlan, []);
});

test('a quarter-specific question resolves both fiscalYear and fiscalQuarter into the tool args', async () => {
  // A document/filing-shaped question (not a numeric "Q4 revenue" financial
  // question, which Phase 4C deliberately routes to the legacy financials
  // pipeline instead -- see researchScope.js's FINANCIAL_RESULTS category).
  const result = await planTools(makeState('Look through TCS Q4 FY2023 filings for hiring plans', {
    entities: { symbols: ['TCS'], companyNames: [], periods: ['Q4 FY2023'], comparisonMode: false },
  }));
  assert.deepEqual(result.toolPlan, [{
    tool: 'retrieveGroundedEvidence', args: {
      symbol: 'TCS', fiscalYear: 'FY2023', fiscalQuarter: 'Q4', query: 'Look through TCS Q4 FY2023 filings for hiring plans',
    },
  }]);
});

test('a Q4-style financial-results question (numeric figures, not guidance/documents) is NOT routed to grounded RAG -- the legacy financials pipeline stays authoritative for this category', async () => {
  const result = await planTools(makeState('TCS Q4 FY2023 revenue outcome', {
    intent: 'EARNINGS_INTELLIGENCE',
    entities: { symbols: ['TCS'], companyNames: [], periods: ['Q4 FY2023'], comparisonMode: false },
  }));
  assert.ok(result.toolPlan.every((step) => step.tool !== 'retrieveGroundedEvidence'));
});

test('the legacy searchResearchDocuments tool is never planned for DOCUMENT_RESEARCH anymore (grounded RAG replaces it for this intent)', async () => {
  const result = await planTools(makeState('What was TCS guidance?'));
  assert.ok(result.toolPlan.every((step) => step.tool !== 'searchResearchDocuments'));
});
