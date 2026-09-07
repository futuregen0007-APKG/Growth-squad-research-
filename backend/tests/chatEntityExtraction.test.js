import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../graph/nodes/extractEntities.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

const makeState = (message, overrides = {}) => ({
  messages: [{ content: message }],
  errors: [],
  intent: 'COMPANY_RESEARCH',
  activeEntities: { symbols: [], companyNames: [] },
  ...overrides,
});

test('extractEntities is skipped entirely for GENERAL_EDUCATION intent (no model call, no cost)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await extractEntities(makeState('What is a P/E ratio?', { intent: 'GENERAL_EDUCATION' }));
    assert.deepEqual(result, {});
    assert.equal(called, false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('extractEntities takes the deterministic fast path for an unambiguous known symbol (no model call)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await extractEntities(makeState('Analyse TCS fundamentals'));
    assert.deepEqual(result.entities.symbols, ['TCS']);
    assert.equal(called, false);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('extractEntities resolves a follow-up pronoun ("its debt") using the model with active entities as context', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        parse: async () => ({
          choices: [{
            message: {
              parsed: { symbols: ['TCS'], companyNames: ['Tata Consultancy Services'], periods: [], comparisonMode: false, resolvedFromFollowUp: true },
            },
          }],
        }),
      },
    },
  });
  try {
    const result = await extractEntities(makeState('What about its debt?', { intent: 'FOLLOW_UP', activeEntities: { symbols: ['TCS'], companyNames: ['Tata Consultancy Services'] } }));
    assert.deepEqual(result.entities.symbols, ['TCS']);
    assert.equal(result.entities.resolvedFromFollowUp, true);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('extractEntities falls back to deterministic matches (or a warning) when the model call fails, without crashing', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.getClient = () => ({ chat: { completions: { parse: async () => { throw new Error('upstream down'); } } } });
  try {
    const result = await extractEntities(makeState('What about its debt?', { intent: 'FOLLOW_UP' }));
    assert.deepEqual(result.entities.symbols, []);
    assert.ok(result.warnings?.length);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});
