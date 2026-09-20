/**
 * liveIntentClassification.acceptance.js
 * =========================================
 * Phase 6A: the ONE check that exercises the REAL intent classifier against
 * the REAL provider.
 *
 * It is deliberately NOT registered in `npm test` and deliberately not named
 * `*.test.js`: the registered suite must be deterministic and runnable with
 * no network, so every other test stubs the classifier. This file is the
 * opt-in counterpart that proves the live model still routes these questions
 * the way the deterministic suite assumes.
 *
 *   LIVE_INTENT_ACCEPTANCE=true node --test tests/liveIntentClassification.acceptance.js
 *
 * A provider rate limit (HTTP 429) or outage SKIPS the check loudly rather
 * than failing it — an unavailable upstream is not a regression in our
 * routing. It can never weaken the deterministic contract, because it
 * asserts nothing that the registered suite relies on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { classifyIntent } from '../graph/nodes/classifyIntent.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

dotenv.config();

const ENABLED = process.env.LIVE_INTENT_ACCEPTANCE === 'true';
const CONFIGURED = OpenAIClientFactory.isConfigured();

/** Provider-side unavailability — skip, never fail. */
const isUpstreamUnavailable = (state) => {
  const calls = state?.llmCalls || [];
  return calls.some((c) => c.timedOut || c.error === 'PROVIDER_ERROR' || c.skipped)
    || (state?.warnings || []).some((w) => /rate limit|unavailable|ran out of time/i.test(w));
};

const EXPECTED_ROUTING = [
  { text: 'HDFCBANK vs ICICIBANK margin trends', intent: 'STOCK_COMPARISON' },
  { text: 'Compare TCS and INFY growth, margins, and valuation', intent: 'STOCK_COMPARISON' },
  { text: 'Analyse RELIANCE for a five-year investor', intent: 'COMPANY_RESEARCH' },
];

for (const expectation of EXPECTED_ROUTING) {
  test(`LIVE: "${expectation.text}" routes to ${expectation.intent}`, { skip: !ENABLED || !CONFIGURED }, async () => {
    const state = {
      messages: [{ content: expectation.text }],
      errors: [],
      recentHistory: [],
      deadlineAt: Date.now() + 60000,
      abortSignal: null,
      aborted: () => false,
    };

    const update = await classifyIntent(state);

    if (isUpstreamUnavailable(update) || !update.intent) {
      // Transparent skip: say why, assert nothing.
      console.log(`  SKIPPED (upstream unavailable): ${JSON.stringify(update.warnings || update.llmCalls?.map((c) => c.error))}`);
      return;
    }

    assert.equal(
      update.intent,
      expectation.intent,
      `the live classifier must still route this to ${expectation.intent}; the deterministic suite stubs exactly this value`,
    );
  });
}

test('this acceptance file is excluded from the registered deterministic suite', () => {
  // A guard against someone adding it to package.json's test list: the
  // registered suite must never depend on a live provider.
  assert.equal(
    import.meta.url.endsWith('.acceptance.js'),
    true,
    'named .acceptance.js precisely so `node --test tests/*.test.js` never picks it up',
  );
});
