import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_CONFIG } from '../llm/OpenAIClientFactory.js';

const ENV_KEYS = ['OPENAI_CHAT_MODEL', 'OPENAI_ROUTING_MODEL', 'OPENAI_SYNTHESIS_MODEL', 'OPENAI_SUMMARY_MODEL'];

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

test('with no model env vars set at all, routing/synthesis/summary all resolve to the same safe default (gpt-4o-mini)', async () => {
  await withEnv({}, () => {
    assert.equal(LLM_CONFIG.routingModel, 'gpt-4o-mini');
    assert.equal(LLM_CONFIG.synthesisModel, 'gpt-4o-mini');
    assert.equal(LLM_CONFIG.summaryModel, 'gpt-4o-mini');
  });
});

test('backward compatibility: the original OPENAI_CHAT_MODEL alone still sets BOTH routing and synthesis (an existing deployment keeps working unchanged)', async () => {
  await withEnv({ OPENAI_CHAT_MODEL: 'gpt-4o' }, () => {
    assert.equal(LLM_CONFIG.routingModel, 'gpt-4o');
    assert.equal(LLM_CONFIG.synthesisModel, 'gpt-4o');
  });
});

test('the new OPENAI_ROUTING_MODEL / OPENAI_SYNTHESIS_MODEL let the two roles diverge independently', async () => {
  await withEnv({ OPENAI_ROUTING_MODEL: 'gpt-4o-mini', OPENAI_SYNTHESIS_MODEL: 'gpt-4o' }, () => {
    assert.equal(LLM_CONFIG.routingModel, 'gpt-4o-mini');
    assert.equal(LLM_CONFIG.synthesisModel, 'gpt-4o');
  });
});

test('the new per-role env vars take priority over the legacy OPENAI_CHAT_MODEL when both are set', async () => {
  await withEnv({ OPENAI_CHAT_MODEL: 'gpt-4o', OPENAI_ROUTING_MODEL: 'gpt-4o-mini' }, () => {
    assert.equal(LLM_CONFIG.routingModel, 'gpt-4o-mini');
    // synthesisModel had no dedicated override -- falls back to the legacy var, not the new routing one.
    assert.equal(LLM_CONFIG.synthesisModel, 'gpt-4o');
  });
});

test('all three roles may be configured to use the exact same model (nothing requires them to differ)', async () => {
  await withEnv({ OPENAI_ROUTING_MODEL: 'gpt-4o', OPENAI_SYNTHESIS_MODEL: 'gpt-4o', OPENAI_SUMMARY_MODEL: 'gpt-4o' }, () => {
    assert.equal(LLM_CONFIG.routingModel, LLM_CONFIG.synthesisModel);
    assert.equal(LLM_CONFIG.synthesisModel, LLM_CONFIG.summaryModel);
  });
});

test('OPENAI_SUMMARY_MODEL is independent of the routing/synthesis config', async () => {
  await withEnv({ OPENAI_CHAT_MODEL: 'gpt-4o', OPENAI_SUMMARY_MODEL: 'gpt-4o-mini' }, () => {
    assert.equal(LLM_CONFIG.summaryModel, 'gpt-4o-mini');
    assert.equal(LLM_CONFIG.routingModel, 'gpt-4o');
  });
});

test('the deprecated chatModel getter still resolves to a real model (aliases routingModel) for any not-yet-migrated caller', async () => {
  await withEnv({ OPENAI_ROUTING_MODEL: 'gpt-4o-mini' }, () => {
    assert.equal(LLM_CONFIG.chatModel, LLM_CONFIG.routingModel);
  });
});
