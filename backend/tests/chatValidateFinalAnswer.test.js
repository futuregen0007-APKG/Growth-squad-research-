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
