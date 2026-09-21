import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicIntent, classifyIntent } from '../graph/nodes/classifyIntent.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

test('deterministicIntent recognizes an explicit watchlist request without a model call', () => {
  assert.equal(deterministicIntent('Show me my watchlist').intent, 'WATCHLIST_ANALYSIS');
});

test('deterministicIntent recognizes an explicit portfolio request without a model call', () => {
  assert.equal(deterministicIntent('Analyse my portfolio risk').intent, 'PORTFOLIO_ANALYSIS');
});

test('deterministicIntent recognizes an explicit price request for a known symbol', () => {
  assert.equal(deterministicIntent('What is the current price of TCS?').intent, 'LIVE_MARKET_DATA');
});

// UI Phase 1D fix: a confirmed live bug -- "Show me a chart of TCS price
// history for the last 90 days" was classified GENERAL_EDUCATION,
// DOCUMENT_RESEARCH, and FOLLOW_UP on three separate live runs (the LLM
// classifier is non-deterministic for this exact phrasing). GENERAL_
// EDUCATION was the worst outcome: composeAnswer.js discards ANY evidence
// for that intent by design. Mirrors PRICE_PHRASES's own deterministic
// rule immediately above.
test('deterministicIntent recognizes an explicit chart/historical-price request for a known symbol, never leaving it to the flaky LLM classifier', () => {
  assert.equal(deterministicIntent('Show me a chart of TCS price history for the last 90 days').intent, 'LIVE_MARKET_DATA');
  assert.equal(deterministicIntent('What is the historical price trend for INFY?').intent, 'LIVE_MARKET_DATA');
});

test('deterministicIntent leaves a genuinely general chart question (no known symbol) to the model', () => {
  assert.equal(deterministicIntent('What is a candlestick chart?'), null);
});

test('deterministicIntent recognizes known Earnings Intelligence phrasing', () => {
  assert.equal(deterministicIntent('Was the NEWGEN revenue guidance fulfilled?').intent, 'EARNINGS_INTELLIGENCE');
});

test('deterministicIntent returns null (defers to the model) for an ambiguous general question', () => {
  assert.equal(deterministicIntent('What is a P/E ratio?'), null);
});

test('deterministicIntent marks empty input UNSUPPORTED', () => {
  assert.equal(deterministicIntent('   ').intent, 'UNSUPPORTED');
});

const makeState = (overrides = {}) => ({
  messages: [{ content: 'What is a P/E ratio?' }],
  errors: [],
  conversationSummary: null,
  activeEntities: { symbols: [], companyNames: [] },
  ...overrides,
});

test('classifyIntent falls back to UNSUPPORTED with a warning when OpenAI is not configured', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => false;
  try {
    const result = await classifyIntent(makeState());
    assert.equal(result.intent, 'UNSUPPORTED');
    assert.ok(result.warnings[0].includes('not configured'));
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('classifyIntent retries once on a malformed model response, then falls back to UNSUPPORTED without crashing', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.isConfigured = () => true;
  let calls = 0;
  OpenAIClientFactory.getClient = () => ({
    chat: { completions: { parse: async () => { calls += 1; return { choices: [{ message: { parsed: null } }] }; } } },
  });
  try {
    const result = await classifyIntent(makeState());
    assert.equal(calls, 2); // exactly one retry
    assert.equal(result.intent, 'UNSUPPORTED');
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('classifyIntent accepts a valid structured response from the model', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: { completions: { parse: async () => ({ choices: [{ message: { parsed: { intent: 'GENERAL_EDUCATION', confidence: 0.95, reasoning: 'Definitional question.' } } }] }) } },
  });
  try {
    const result = await classifyIntent(makeState());
    assert.equal(result.intent, 'GENERAL_EDUCATION');
    assert.equal(result.intentConfidence, 0.95);
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('classifyIntent skips the model entirely when validateInput already rejected the turn', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await classifyIntent(makeState({ errors: ['Message cannot be empty.'] }));
    assert.deepEqual(result, {});
    assert.equal(called, false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});
