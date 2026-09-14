import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalAnswer } from '../graph/nodes/validateFinalAnswer.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

/**
 * chatValidateFinalAnswer.test.js
 * ==================================
 * Phase 3: validateFinalAnswer is now the orchestrator (deterministic
 * checks always; the structured claim verifier conditionally) that
 * decides state.validationStatus, not a warnings-only auditor. These
 * tests use INJECTED fake OpenAI responses only — never a live call.
 */

const evidenceItem = (overrides = {}) => ({
  evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS financials',
  excerpt: 'Revenue grew 12%', reportingPeriod: null, ...overrides,
});

const baseState = (overrides = {}) => ({
  messages: [{ content: 'Tell me about TCS' }],
  intent: 'COMPANY_RESEARCH',
  entities: { symbols: ['TCS'], periods: [] },
  evidence: [], toolResults: [], missingEvidence: [], requestedDimensions: [],
  draftAnswer: null, validationStatus: null, repairCount: 0,
  deadlineAt: Date.now() + 45000, abortSignal: null, aborted: () => false,
  ...overrides,
});

const withFakeVerifierClient = (claims, fn) => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  let called = false;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: { completions: { parse: async () => { called = true; return { choices: [{ message: { parsed: { claims } } }] }; } } },
  });
  return Promise.resolve(fn(() => called)).finally(() => {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  });
};

// ---------------------------------------------------------------------------
// Already-terminal pass-through (composeAnswer's own safe/skip paths)
// ---------------------------------------------------------------------------
test('a validationStatus already set to SKIPPED_GENERAL_EDUCATION passes straight through unchanged', async () => {
  const result = await validateFinalAnswer(baseState({ validationStatus: 'SKIPPED_GENERAL_EDUCATION', draftAnswer: 'A P/E ratio is price / EPS.' }));
  assert.deepEqual(result, {});
});

test('a validationStatus already set to FAILED_SAFE (composeAnswer cancellation) passes straight through unchanged', async () => {
  const result = await validateFinalAnswer(baseState({ validationStatus: 'FAILED_SAFE', draftAnswer: null }));
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// Required test 18: cancellation stops validation
// ---------------------------------------------------------------------------
test('required test 18: an aborted request never runs the verifier, and fails safe', async () => {
  const result = await withFakeVerifierClient([], (wasCalled) => validateFinalAnswer(baseState({
    draftAnswer: 'TCS revenue grew 12% [1].', evidence: [evidenceItem()], aborted: () => true,
  })).then((r) => { assert.equal(wasCalled(), false); return r; }));
  assert.equal(result.validationStatus, 'FAILED_SAFE');
  assert.ok(result.validationIssues.includes('CANCELLED'));
});

// ---------------------------------------------------------------------------
// Required test 17: deadline exhaustion prevents extra LLM calls
// ---------------------------------------------------------------------------
test('required test 17: an exhausted deadline skips the verifier call and fails safe', async () => {
  const result = await withFakeVerifierClient([], (wasCalled) => validateFinalAnswer(baseState({
    draftAnswer: 'TCS revenue grew 12% [1].', evidence: [evidenceItem()], deadlineAt: Date.now() - 1000,
  })).then((r) => { assert.equal(wasCalled(), false); return r; }));
  assert.equal(result.validationStatus, 'FAILED_SAFE');
  assert.ok(result.validationIssues.some((i) => i.includes('VERIFIER_SKIPPED_NO_BUDGET')));
});

// ---------------------------------------------------------------------------
// Required test 10 / 11: skip verifier for general education / no-data
// ---------------------------------------------------------------------------
test('required test 10: GENERAL_EDUCATION never invokes the verifier and passes', async () => {
  const result = await withFakeVerifierClient([], (wasCalled) => validateFinalAnswer(baseState({
    intent: 'GENERAL_EDUCATION', draftAnswer: 'A P/E ratio compares price to EPS.', evidence: [],
  })).then((r) => { assert.equal(wasCalled(), false); return r; }));
  assert.equal(result.validationStatus, 'PASSED');
});

test('required test 11: a safe no-data answer never invokes the verifier', async () => {
  const result = await withFakeVerifierClient([], (wasCalled) => validateFinalAnswer(baseState({
    intent: 'STOCK_COMPARISON', draftAnswer: "I don't have data for HAL or BEL right now.", evidence: [], entities: { symbols: ['HAL', 'BEL'], periods: [] },
  })).then((r) => { assert.equal(wasCalled(), false); return r; }));
  assert.equal(result.validationStatus, 'PASSED');
});

// ---------------------------------------------------------------------------
// Required test 9: supported claim passes
// ---------------------------------------------------------------------------
test('required test 9: a fully SUPPORTED verifier verdict, with clean deterministic checks, passes', async () => {
  const result = await withFakeVerifierClient(
    [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' }],
    () => validateFinalAnswer(baseState({ draftAnswer: 'TCS revenue grew 12% [1].', evidence: [evidenceItem()] })),
  );
  assert.equal(result.validationStatus, 'PASSED');
  assert.equal(result.claimValidation.length, 1);
});

// ---------------------------------------------------------------------------
// Required test 3: TCS evidence cannot support an INFY claim (verifier-level)
// ---------------------------------------------------------------------------
test('required test 3: a verifier WRONG_SYMBOL verdict forces REPAIR_REQUIRED', async () => {
  const result = await withFakeVerifierClient(
    [{ claimId: 'claim-1', verdict: 'WRONG_SYMBOL', evidenceIndexes: [1], reasonCode: 'SYMBOL_MISMATCH' }],
    () => validateFinalAnswer(baseState({
      draftAnswer: 'Infosys revenue grew 12% [1].',
      evidence: [evidenceItem({ symbol: 'TCS' })],
      entities: { symbols: ['TCS', 'INFY'], periods: [] },
      intent: 'STOCK_COMPARISON',
    })),
  );
  assert.equal(result.validationStatus, 'REPAIR_REQUIRED');
  assert.ok(result.validationIssues.some((i) => i.includes('WRONG_SYMBOL')));
});

// ---------------------------------------------------------------------------
// Required test 4: FY2024 evidence cannot support FY2026 actuals (verifier-level)
// ---------------------------------------------------------------------------
test('required test 4: a verifier WRONG_PERIOD verdict forces REPAIR_REQUIRED', async () => {
  const result = await withFakeVerifierClient(
    [{ claimId: 'claim-1', verdict: 'WRONG_PERIOD', evidenceIndexes: [1], reasonCode: 'PERIOD_MISMATCH' }],
    () => validateFinalAnswer(baseState({
      draftAnswer: 'TCS FY2026 revenue grew 12% [1].',
      evidence: [evidenceItem({ reportingPeriod: 'FY2024' })],
    })),
  );
  assert.equal(result.validationStatus, 'REPAIR_REQUIRED');
  assert.ok(result.validationIssues.some((i) => i.includes('WRONG_PERIOD')));
});

// ---------------------------------------------------------------------------
// Required test 2: price evidence cannot support a news claim (verifier-level)
// ---------------------------------------------------------------------------
test('required test 2: a verifier WRONG_DIMENSION verdict (price evidence used for a news claim) forces REPAIR_REQUIRED', async () => {
  const result = await withFakeVerifierClient(
    [{ claimId: 'claim-1', verdict: 'WRONG_DIMENSION', evidenceIndexes: [1], reasonCode: 'PRICE_NOT_NEWS' }],
    () => validateFinalAnswer(baseState({
      draftAnswer: 'TCS was in the news for its price movement [1].',
      evidence: [evidenceItem({ claimType: 'LIVE_PRICE' })],
    })),
  );
  assert.equal(result.validationStatus, 'REPAIR_REQUIRED');
  assert.ok(result.validationIssues.some((i) => i.includes('WRONG_DIMENSION')));
});

// ---------------------------------------------------------------------------
// Required test 6: analyst forecast cannot be presented as actual (verifier-level)
// ---------------------------------------------------------------------------
test('required test 6: a verifier FORECAST_AS_ACTUAL verdict forces REPAIR_REQUIRED', async () => {
  const result = await withFakeVerifierClient(
    [{ claimId: 'claim-1', verdict: 'FORECAST_AS_ACTUAL', evidenceIndexes: [1], reasonCode: 'FORECAST_NOT_ACTUAL' }],
    () => validateFinalAnswer(baseState({
      draftAnswer: 'TCS delivered 15% growth as analysts predicted [1].',
      evidence: [evidenceItem({ claimType: 'ANALYST_FORECAST' })],
    })),
  );
  assert.equal(result.validationStatus, 'REPAIR_REQUIRED');
  assert.ok(result.validationIssues.some((i) => i.includes('FORECAST_AS_ACTUAL')));
});

// ---------------------------------------------------------------------------
// Required test 15: verifier timeout fails safely
// ---------------------------------------------------------------------------
test('required test 15: a verifier call that returns no parsed result fails safe (FAILED_SAFE), never PASSED', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({ chat: { completions: { parse: async () => { throw new Error('upstream timeout'); } } } });
  try {
    const result = await validateFinalAnswer(baseState({ draftAnswer: 'TCS revenue grew 12% [1].', evidence: [evidenceItem()] }));
    assert.equal(result.validationStatus, 'FAILED_SAFE');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

// ---------------------------------------------------------------------------
// Deterministic-only path still forces REPAIR_REQUIRED (no verifier needed to catch it)
// ---------------------------------------------------------------------------
test('a deterministic-only issue (guarantee language) forces REPAIR_REQUIRED even for GENERAL_EDUCATION (no verifier call)', async () => {
  const result = await withFakeVerifierClient([], (wasCalled) => validateFinalAnswer(baseState({
    intent: 'GENERAL_EDUCATION', draftAnswer: 'TCS is guaranteed to double next year.', evidence: [],
  })).then((r) => { assert.equal(wasCalled(), false, 'deterministic checks alone are enough here, no verifier needed'); return r; }));
  assert.equal(result.validationStatus, 'REPAIR_REQUIRED');
  assert.ok(result.validationIssues.includes('GUARANTEE_LANGUAGE'));
});

test('zero evidence with a fabricated-looking comparison draft (the live-found HAL/BEL bug) forces REPAIR_REQUIRED', async () => {
  const result = await validateFinalAnswer(baseState({
    intent: 'STOCK_COMPARISON',
    draftAnswer: 'HAL was founded in 1940 and BEL in 1954, both leaders in Indian defence.',
    evidence: [], entities: { symbols: ['HAL', 'BEL'], periods: [] },
  }));
  assert.equal(result.validationStatus, 'REPAIR_REQUIRED');
  assert.ok(result.validationIssues.includes('ZERO_EVIDENCE_FACTUAL_CLAIM'));
});
