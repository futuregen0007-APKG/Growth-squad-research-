import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalAnswer } from '../graph/nodes/validateFinalAnswer.js';

test('flags guarantee-style return language', async () => {
  const result = await validateFinalAnswer({ answer: 'This stock offers guaranteed returns of 20%.', intent: 'COMPANY_RESEARCH', toolResults: [] });
  assert.ok(result.warnings[0].includes('guarantee'));
});

test('flags a live price claim missing a visible timestamp', async () => {
  const result = await validateFinalAnswer({
    answer: 'TCS is trading at ₹4120.',
    intent: 'LIVE_MARKET_DATA',
    toolResults: [{ tool: 'getLiveQuote', status: 'SUCCESS' }],
  });
  assert.ok(result.warnings[0].includes('timestamp'));
});

test('does not flag a live price claim that does include a timestamp', async () => {
  const result = await validateFinalAnswer({
    answer: 'TCS is trading at ₹4120 as of 2026-09-07 15:30.',
    intent: 'LIVE_MARKET_DATA',
    toolResults: [{ tool: 'getLiveQuote', status: 'SUCCESS' }],
  });
  assert.deepEqual(result, {});
});

test('a clean, evidence-appropriate answer produces no warnings', async () => {
  const result = await validateFinalAnswer({
    answer: 'A P/E ratio compares a company\'s share price to its earnings per share.',
    intent: 'GENERAL_EDUCATION',
    toolResults: [],
  });
  assert.deepEqual(result, {});
});

test('returns {} immediately when there is no answer to validate', async () => {
  const result = await validateFinalAnswer({ answer: null, intent: 'GENERAL_EDUCATION', toolResults: [] });
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// Phase 2 item 8: evidence/section mismatch prevention (deterministic
// detection only — never a repair/regeneration loop, see the module note).
// ---------------------------------------------------------------------------

test('flags an answer that talks about recent news with no COMPANY_NEWS evidence backing it', async () => {
  const result = await validateFinalAnswer({
    answer: 'According to a recent news report, TCS won a major deal.',
    intent: 'COMPANY_RESEARCH',
    toolResults: [],
    evidence: [{ claimType: 'FINANCIAL_DATA', symbol: 'TCS' }],
  });
  assert.ok(result.warnings[0].includes('COMPANY_NEWS'));
});

test('does not flag news language when real COMPANY_NEWS evidence is present', async () => {
  const result = await validateFinalAnswer({
    answer: 'According to a recent news report, TCS won a major deal [1].',
    intent: 'COMPANY_RESEARCH',
    toolResults: [],
    evidence: [{ claimType: 'COMPANY_NEWS', symbol: 'TCS' }],
  });
  assert.deepEqual(result, {});
});

test('flags an answer that presents a promise/guidance as achieved with no PROMISE_OUTCOME evidence (forecast presented as fact)', async () => {
  const result = await validateFinalAnswer({
    answer: 'TCS achieved its revenue growth guidance for FY2026.',
    intent: 'EARNINGS_INTELLIGENCE',
    toolResults: [],
    evidence: [{ claimType: 'MANAGEMENT_PROMISE', symbol: 'TCS' }],
  });
  assert.ok(result.warnings[0].includes('PROMISE_OUTCOME'));
});

test('does not flag achievement language when a real PROMISE_OUTCOME record backs it', async () => {
  const result = await validateFinalAnswer({
    answer: 'TCS achieved its revenue growth guidance for FY2026 [1].',
    intent: 'EARNINGS_INTELLIGENCE',
    toolResults: [],
    evidence: [{ claimType: 'PROMISE_OUTCOME', symbol: 'TCS' }],
  });
  assert.deepEqual(result, {});
});
