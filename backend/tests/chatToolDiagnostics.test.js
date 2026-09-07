import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';

import { graph } from '../graph/graph.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { deterministicIntent, isUnsupportedSectorDiscovery } from '../graph/nodes/classifyIntent.js';
import { extractEntities } from '../graph/nodes/extractEntities.js';
import {
  getLiveQuote, getCompanyResearch, getCompanyFinancials, compareStocks, TOOL_STATUS,
} from '../graph/tools/toolRegistry.js';
import { getLiveMarketDataProvider, getCompanyResearchProvider } from '../providers/ProviderRegistry.js';
import { invalidateCompanyResearchCache } from '../services/CompanyResearchService.js';
import { IndianApiError, INDIAN_API_ERROR_CODES } from '../providers/indian-api/IndianApiErrorMapper.js';
import { SAFE_REASONS } from '../graph/safeReasons.js';

/**
 * chatToolDiagnostics.test.js
 * ============================
 * Integration tests for the root causes diagnosed against "Analyse HAL Q2
 * FY26 results" / "HDFCBANK vs ICICIBANK margin trends" / "Best defence
 * companies by order book":
 *   - period extraction was hardcoded to [] on the deterministic fast path
 *   - IndianAPI's real financial-entry field names (FiscalYear/EndDate/
 *     StatementDate/stockFinancialMap) didn't match the normalizer's
 *     guessed lower-camelCase names, so every evidence excerpt was empty
 *   - compareStocks never fetched financials, so margin comparisons had
 *     nothing to cite
 *   - a real provider error was reported as EMPTY (indistinguishable from
 *     "genuinely no data"), hiding auth/rate-limit/timeout failures
 *   - sector-wide ranking/discovery had no dedicated UNSUPPORTED path and
 *     could reach the LLM tool-planner, risking a hallucinated answer
 *
 * Uses dependency injection via the real provider SINGLETONS (Angel One /
 * IndianAPI instances returned by ProviderRegistry are mutable objects —
 * their methods are swapped for the duration of one test, then restored).
 *
 * IMPORTANT SAFETY NOTE: CompanyResearchService.getCompanyResearchBundle
 * ALWAYS fetches all 7 CompanyResearchProvider capabilities in parallel
 * (getCompanyProfile/getFinancials/getKeyMetrics/getShareholding/
 * getCorporateActions/getAnalystData/getCompanyNews), regardless of which
 * one a given tool ultimately reads. Mocking only ONE of the 7 (e.g. just
 * getFinancials for a getCompanyFinancials test) leaves the other 6
 * UNMOCKED, and they will make real network calls against the real
 * configured IndianAPI key. mockAllResearchMethods() below always installs
 * all 7 (defaulting the ones a test doesn't care about to a same-shape,
 * zero-network "unsupported" stub) specifically to make that mistake
 * impossible to repeat.
 */

const withMockedMethod = (obj, methodName, implementation) => {
  const original = obj[methodName];
  obj[methodName] = implementation;
  return () => { obj[methodName] = original; };
};

const RESEARCH_METHODS = ['getCompanyProfile', 'getFinancials', 'getKeyMetrics', 'getShareholding', 'getCorporateActions', 'getAnalystData', 'getCompanyNews'];
const unsupportedStub = async () => ({ supported: false, capability: 'x', provider: 'indian-api', reason: 'not mocked for this test' });

// DEFENSE IN DEPTH: even with mockAllResearchMethods covering every method,
// blank out the real provider's API key for this entire file's test run.
// Any method that is somehow NOT properly mocked (a future editing mistake,
// a timing edge case) then fails FAST and LOCALLY with CONFIGURATION_ERROR
// (IndianApiProvider._assertConfigured checks `this.apiKey` directly and
// throws before any network call is made) instead of making a real,
// credit-consuming request. Explicitly mocked methods are unaffected
// (they replace the whole method, never reaching apiKey handling).
//
// `isConfigured` is overridden SEPARATELY back to true: it's a plain
// getter derived from apiKey (`get isConfigured() { return
// Boolean(this.apiKey) }`), and CompanyResearchService.getCompanyResearchBundle
// reports `bundle.configured` from it — nulling apiKey alone would make
// every bundle look "not configured" and short-circuit tests before their
// mocked section data is ever read. Restored at the end of the file's run.
const realResearchProvider = getCompanyResearchProvider();
const realApiKey = realResearchProvider.apiKey;
realResearchProvider.apiKey = null;
Object.defineProperty(realResearchProvider, 'isConfigured', { get: () => true, configurable: true });
process.once('exit', () => { realResearchProvider.apiKey = realApiKey; });

/**
 * mockAllResearchMethods - installs a same-shape stub for EVERY
 * CompanyResearchProvider method the bundle fetcher calls, so a test can
 * override only the ones it cares about (via `overrides`) without ever
 * leaving a gap that reaches the real network. Returns a restore function.
 */
const mockAllResearchMethods = (overrides = {}) => {
  const provider = getCompanyResearchProvider();
  const restores = RESEARCH_METHODS.map((method) => withMockedMethod(provider, method, overrides[method] || unsupportedStub));
  return () => restores.forEach((r) => r());
};

// ---------------------------------------------------------------------------
// 1) Entity extraction: HAL / HDFCBANK / ICICIBANK + Q2 FY26 period
// ---------------------------------------------------------------------------
test('extractEntities: HAL is correctly extracted, and "Q2 FY26" is now extracted as a period (previously hardcoded to [])', async () => {
  const state = {
    messages: [new HumanMessage('Analyse HAL Q2 FY26 results')],
    errors: [], intent: 'COMPANY_RESEARCH', activeEntities: { symbols: [], companyNames: [] },
  };
  const result = await extractEntities(state);
  assert.deepEqual(result.entities.symbols, ['HAL']);
  assert.deepEqual(result.entities.periods, ['Q2 FY2026']);
});

test('extractEntities: HDFCBANK and ICICIBANK are both correctly extracted for a comparison message', async () => {
  const state = {
    messages: [new HumanMessage('HDFCBANK vs ICICIBANK margin trends')],
    errors: [], intent: 'STOCK_COMPARISON', activeEntities: { symbols: [], companyNames: [] },
  };
  const result = await extractEntities(state);
  assert.deepEqual(result.entities.symbols.sort(), ['HDFCBANK', 'ICICIBANK']);
  assert.equal(result.entities.comparisonMode, true);
});

// ---------------------------------------------------------------------------
// 8) Unsupported sector ranking — deterministic UNSUPPORTED classification
// ---------------------------------------------------------------------------
test('classifyIntent: "Best defence companies by order book" is deterministically UNSUPPORTED (no sector/ranking tool exists)', () => {
  assert.equal(isUnsupportedSectorDiscovery('Best defence companies by order book'), true);
  const classified = deterministicIntent('Best defence companies by order book');
  assert.equal(classified.intent, 'UNSUPPORTED');
});

test('classifyIntent: a genuine two-symbol comparison is NOT misclassified as unsupported sector discovery', () => {
  assert.equal(isUnsupportedSectorDiscovery('Compare HDFCBANK vs ICICIBANK'), false);
  assert.equal(deterministicIntent('Compare HDFCBANK vs ICICIBANK').intent, 'STOCK_COMPARISON');
});

test('end-to-end: sector-ranking question plans zero tools and never lets the model answer from its own knowledge', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.isConfigured = () => true;
  let capturedPrompt = null;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        create: async (args) => {
          capturedPrompt = args.messages.find((m) => m.role === 'user')?.content || '';
          return {
            [Symbol.asyncIterator]: async function* iterate() {
              yield { choices: [{ delta: { content: `${SAFE_REASONS.CAPABILITY_NOT_SUPPORTED}.` } }] };
            },
          };
        },
      },
    },
  });
  try {
    // deterministicIntent handles this message directly (no .parse() call
    // needed), so a fake client with only `.create()` is sufficient here.
    const finalState = await graph.invoke({ messages: [new HumanMessage('Best defence companies by order book')] });
    assert.equal(finalState.intent, 'UNSUPPORTED');
    assert.deepEqual(finalState.toolPlan, []);
    assert.deepEqual(finalState.toolResults, []);
    assert.match(capturedPrompt, /does not currently have/);
    assert.doesNotMatch(capturedPrompt, /HAL|BEL|BDL|MAZDOCK/); // never seeded with a guessed company list
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

// ---------------------------------------------------------------------------
// 2) Successful live-price lookup
// ---------------------------------------------------------------------------
test('getLiveQuote: SUCCESS with real evidence when the provider returns a quote', async () => {
  const provider = getLiveMarketDataProvider();
  const restore = withMockedMethod(provider, 'getStock', async () => ({
    ticker: 'HAL', price: 4856, changePct: 1.2, timestamp: '2026-09-08T10:00:00.000Z', name: 'HAL', exchange: 'NSE',
  }));
  try {
    const res = await getLiveQuote({ symbol: 'HAL' });
    assert.equal(res.status, TOOL_STATUS.SUCCESS);
    assert.equal(res.evidenceCount, 1);
    assert.equal(res.evidence[0].claimType, 'LIVE_PRICE');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 3) Successful company profile
// ---------------------------------------------------------------------------
test('getCompanyResearch: SUCCESS with a real, non-empty excerpt when the profile section returns data', async () => {
  invalidateCompanyResearchCache('HAL');
  const restore = mockAllResearchMethods({
    getCompanyProfile: async () => ({
      supported: true, provider: 'indian-api',
      data: { identity: { companyName: 'Hindustan Aeronautics' }, profile: { description: 'Aerospace and defence manufacturer.' } },
      provenance: { fetchedAt: new Date().toISOString() },
    }),
  });
  try {
    const res = await getCompanyResearch({ symbol: 'HAL' });
    assert.equal(res.status, TOOL_STATUS.SUCCESS);
    assert.ok(res.evidenceCount >= 1);
    const profileEvidence = res.evidence.find((e) => e.claimType === 'COMPANY_PROFILE');
    assert.ok(profileEvidence);
    assert.equal(profileEvidence.excerpt, 'Aerospace and defence manufacturer.');
  } finally {
    restore();
    invalidateCompanyResearchCache('HAL');
  }
});

// ---------------------------------------------------------------------------
// 4) Empty financial response (genuinely no data, not an error)
// ---------------------------------------------------------------------------
test('getCompanyFinancials: EMPTY (never ERROR) when the provider succeeds but returns no financial line items', async () => {
  invalidateCompanyResearchCache('NEWCO');
  const restore = mockAllResearchMethods({
    getFinancials: async () => ({ supported: true, provider: 'indian-api', data: [], provenance: { fetchedAt: new Date().toISOString() } }),
  });
  try {
    const res = await getCompanyFinancials({ symbol: 'NEWCO' });
    assert.equal(res.status, TOOL_STATUS.EMPTY);
    assert.equal(res.warning, SAFE_REASONS.DATA_NOT_AVAILABLE_FOR_PERIOD);
    assert.equal(res.evidenceCount, 0);
  } finally {
    restore();
    invalidateCompanyResearchCache('NEWCO');
  }
});

// ---------------------------------------------------------------------------
// 5) Provider authentication failure — the key "ERROR must not become EMPTY" case
// ---------------------------------------------------------------------------
test('getCompanyFinancials: UNAVAILABLE with errorCode AUTHENTICATION_ERROR (never EMPTY) when the provider throws an auth failure', async () => {
  invalidateCompanyResearchCache('HAL');
  const authFailure = async () => { throw new IndianApiError(INDIAN_API_ERROR_CODES.AUTHENTICATION_ERROR, 'IndianAPI rejected the API key'); };
  const restore = mockAllResearchMethods({ getFinancials: authFailure });
  try {
    const res = await getCompanyFinancials({ symbol: 'HAL' });
    assert.equal(res.status, TOOL_STATUS.UNAVAILABLE);
    assert.notEqual(res.status, TOOL_STATUS.EMPTY);
    assert.equal(res.errorCode, 'AUTHENTICATION_ERROR');
    assert.equal(res.warning, SAFE_REASONS.PROVIDER_UNAVAILABLE);
    assert.equal(res.warning.includes('IndianAPI'), false); // never the raw provider message
  } finally {
    restore();
    invalidateCompanyResearchCache('HAL');
  }
});

test('getCompanyResearch: when EVERY section fails with a real provider error, the outcome is UNAVAILABLE, not EMPTY', async () => {
  invalidateCompanyResearchCache('HAL');
  const authFailure = async () => { throw new IndianApiError(INDIAN_API_ERROR_CODES.AUTHENTICATION_ERROR, 'auth failed'); };
  const restore = mockAllResearchMethods(Object.fromEntries(RESEARCH_METHODS.map((m) => [m, authFailure])));
  try {
    const res = await getCompanyResearch({ symbol: 'HAL' });
    assert.notEqual(res.status, TOOL_STATUS.EMPTY);
    assert.equal(res.status, TOOL_STATUS.UNAVAILABLE);
    assert.equal(res.errorCode, 'AUTHENTICATION_ERROR');
  } finally {
    restore();
    invalidateCompanyResearchCache('HAL');
  }
});

// ---------------------------------------------------------------------------
// 6/7) compareStocks: two-symbol comparison with compatible data, and a
// missing-metric case
// ---------------------------------------------------------------------------
test('compareStocks: fetches financials for BOTH symbols (previously only quote+profile — margin comparisons had no evidence)', async () => {
  invalidateCompanyResearchCache('HDFCBANK');
  invalidateCompanyResearchCache('ICICIBANK');
  const marketProvider = getLiveMarketDataProvider();

  const restoreQuote = withMockedMethod(marketProvider, 'getStock', async (symbol) => ({
    ticker: symbol, price: 1000, changePct: 0.5, timestamp: new Date().toISOString(),
  }));
  // getFinancials here mocks the PROVIDER method — i.e. it must return
  // what IndianApiProvider.getFinancials() itself returns AFTER
  // normalization (see IndianApiNormalizer.normalizeFinancialEntry),
  // which is { date, period, fiscalPeriodNumber, statementType, title,
  // sourceUrl, lineItems, raw, unitHint } entries — NOT raw IndianAPI JSON
  // (stockFinancialMap/FiscalYear/etc, which is what the real provider
  // method itself consumes internally before this point).
  const restoreResearch = mockAllResearchMethods({
    getFinancials: async (symbol) => ({
      supported: true, provider: 'indian-api',
      data: [{
        date: '2026-03-31T00:00:00.000Z', period: '2026', fiscalPeriodNumber: 4, statementType: 'Annual',
        title: null, sourceUrl: null, unitHint: 'INR_CRORE',
        lineItems: [{ statementType: 'INC', statementLabel: 'Income Statement', displayName: 'Net Margin', key: 'NetMargin', value: symbol === 'HDFCBANK' ? 21.5 : 19.8 }],
        raw: {},
      }],
      provenance: { fetchedAt: new Date().toISOString() },
    }),
  });

  try {
    const res = await compareStocks({ symbols: ['HDFCBANK', 'ICICIBANK'] });
    assert.equal(res.status, TOOL_STATUS.SUCCESS);
    const financialEvidence = res.evidence.filter((e) => e.claimType === 'FINANCIAL_DATA');
    const symbolsWithFinancials = new Set(financialEvidence.map((e) => e.symbol));
    assert.deepEqual([...symbolsWithFinancials].sort(), ['HDFCBANK', 'ICICIBANK']);
    assert.ok(financialEvidence[0].excerpt.includes('Net Margin'));
  } finally {
    restoreQuote(); restoreResearch();
    invalidateCompanyResearchCache('HDFCBANK'); invalidateCompanyResearchCache('ICICIBANK');
  }
});

test('compareStocks: a missing comparison metric (financials EMPTY for both) still returns SUCCESS on the strength of live quotes, with zero financial evidence — never fabricated', async () => {
  invalidateCompanyResearchCache('HDFCBANK');
  invalidateCompanyResearchCache('ICICIBANK');
  const marketProvider = getLiveMarketDataProvider();

  const restoreQuote = withMockedMethod(marketProvider, 'getStock', async (symbol) => ({ ticker: symbol, price: 1000, changePct: 0.1, timestamp: new Date().toISOString() }));
  const restoreResearch = mockAllResearchMethods({
    getFinancials: async () => ({ supported: true, provider: 'indian-api', data: [], provenance: { fetchedAt: new Date().toISOString() } }),
  });

  try {
    const res = await compareStocks({ symbols: ['HDFCBANK', 'ICICIBANK'] });
    assert.equal(res.status, TOOL_STATUS.SUCCESS); // quotes succeeded
    assert.equal(res.evidence.filter((e) => e.claimType === 'FINANCIAL_DATA').length, 0); // but no invented margin evidence
  } finally {
    restoreQuote(); restoreResearch();
    invalidateCompanyResearchCache('HDFCBANK'); invalidateCompanyResearchCache('ICICIBANK');
  }
});

// ---------------------------------------------------------------------------
// 9) Tool evidence reaching the answer composer
// ---------------------------------------------------------------------------
test('end-to-end: real tool evidence excerpt text reaches the composer prompt verbatim (via validateEvidence)', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  const originalGetClient = OpenAIClientFactory.getClient;
  const { TOOL_REGISTRY } = await import('../graph/tools/toolRegistry.js');
  const originalFinancialsTool = TOOL_REGISTRY.getCompanyFinancials;
  const originalResearchTool = TOOL_REGISTRY.getCompanyResearch;

  // "Analyse HAL Q2 FY26 results" now plans BOTH getCompanyFinancials and
  // getCompanyResearch (see planTools.js's PERIOD_MENTIONED fix) — mock
  // both at the TOOL_REGISTRY level so neither reaches the real provider.
  TOOL_REGISTRY.getCompanyFinancials = async () => ({
    tool: 'getCompanyFinancials', status: 'SUCCESS',
    data: [{}],
    evidence: [{
      evidenceId: 'test-ev-1', claimType: 'FINANCIAL_DATA', symbol: 'HAL', title: 'HAL financial statement',
      sourceUrl: null, provider: 'indian-api', publishedAt: '2026-05-15T00:00:00.000Z', reportingPeriod: 'Q2 FY2026',
      excerpt: 'Total Revenue: 29500.5 INR_CRORE; Net Income: 5200.3 INR_CRORE',
      pageNumber: null, retrievedAt: new Date().toISOString(), evidenceQuality: null,
    }],
    resultCount: 1, evidenceCount: 1, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
  });
  TOOL_REGISTRY.getCompanyResearch = async () => ({
    tool: 'getCompanyResearch', status: 'EMPTY', data: null, evidence: [],
    resultCount: 0, evidenceCount: 0, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
  });

  OpenAIClientFactory.isConfigured = () => true;
  let capturedPrompt = null;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        // classifyIntent/extractEntities/planTools all call .parse() for
        // structured output — this message ("Analyse HAL...") isn't caught
        // by any deterministicIntent rule, so classifyIntent WILL call
        // .parse(); it must be mocked too or the graph silently falls back
        // to UNSUPPORTED (which is exactly what happened before this fix
        // was added — the first version of this test asserted on the
        // wrong prompt because of this exact gap).
        parse: async (args) => {
          const schemaName = args.response_format?.json_schema?.name;
          if (schemaName === 'intent_classification') return { choices: [{ message: { parsed: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financial results question' } } }] };
          if (schemaName === 'explicit_preference') return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
          return { choices: [{ message: { parsed: null } }] };
        },
        create: async (args) => {
          capturedPrompt = args.messages.find((m) => m.role === 'user')?.content || '';
          return { [Symbol.asyncIterator]: async function* iterate() { yield { choices: [{ delta: { content: 'Revenue was 29500.5 crore [1].' } }] }; } };
        },
      },
    },
  });

  try {
    const finalState = await graph.invoke({
      messages: [new HumanMessage('Analyse HAL Q2 FY26 results')],
      onEvent: () => {},
    });
    assert.equal(finalState.intent, 'COMPANY_RESEARCH');
    assert.ok(capturedPrompt.includes('Total Revenue: 29500.5 INR_CRORE'));
    assert.equal(finalState.citations.length, 1);
    assert.equal(finalState.citations[0].evidenceId, 'test-ev-1');
  } finally {
    TOOL_REGISTRY.getCompanyFinancials = originalFinancialsTool;
    TOOL_REGISTRY.getCompanyResearch = originalResearchTool;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

// ---------------------------------------------------------------------------
// 10) ERROR not silently converted to EMPTY, at the executeTools fan-out level
// ---------------------------------------------------------------------------
test('executeTools: a tool that throws is reported as ERROR in toolResults, never coerced to EMPTY', async () => {
  const { executeTools } = await import('../graph/nodes/executeTools.js');
  const { TOOL_REGISTRY } = await import('../graph/tools/toolRegistry.js');
  const original = TOOL_REGISTRY.getLiveQuote;
  TOOL_REGISTRY.getLiveQuote = async () => { throw new Error('simulated hard failure'); };
  try {
    const state = { errors: [], toolPlan: [{ tool: 'getLiveQuote', args: { symbol: 'HAL' } }], userId: null, onEvent: null };
    const result = await executeTools(state);
    assert.equal(result.toolResults[0].status, 'ERROR');
    assert.notEqual(result.toolResults[0].status, 'EMPTY');
    assert.equal(result.toolResults[0].resultCount, 0);
  } finally {
    TOOL_REGISTRY.getLiveQuote = original;
  }
});
