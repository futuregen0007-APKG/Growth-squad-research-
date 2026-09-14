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

// ---------------------------------------------------------------------------
// Phase 2: complete entity resolution. The confirmed Phase 0/1 regression --
// "Compare TCS and Infosys using financial growth, management guidance and
// recent news" only ever resolved TCS -- plus the full required test matrix
// (ticker+ticker, ticker+company, company+company, alias, unknown company,
// duplicates, order preservation). No mocked OpenAI client is installed in
// any of these: every one of them must be answered by the deterministic
// fast path alone (asserted via `called` staying false).
// ---------------------------------------------------------------------------

const assertNoModelCall = async (message, overrides = {}) => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await extractEntities(makeState(message, overrides));
    assert.equal(called, false, 'must resolve deterministically, without an LLM call');
    return result;
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
};

test('Phase 2 regression: "Compare TCS and Infosys" resolves BOTH symbols, not just the ticker', async () => {
  const result = await assertNoModelCall('Compare TCS and Infosys using financial growth, management guidance and recent news');
  assert.deepEqual(result.entities.symbols, ['TCS', 'INFY']);
  assert.ok(result.entities.companyNames.includes('Tata Consultancy Services'));
  assert.ok(result.entities.companyNames.some((name) => name.toLowerCase() === 'infosys'));
  assert.equal(result.entities.comparisonMode, true);
});

test('ticker + ticker: both resolved and ordered as mentioned', async () => {
  const result = await assertNoModelCall('How do HAL and BEL compare on order book growth?');
  assert.deepEqual(result.entities.symbols, ['HAL', 'BEL']);
});

test('ticker + company name (reverse order: company name mentioned first)', async () => {
  const result = await assertNoModelCall('Infosys versus TCS — which has better margins?');
  assert.deepEqual(result.entities.symbols, ['INFY', 'TCS'], 'order of first mention must be preserved: Infosys was named before TCS');
});

test('two company names, no tickers typed at all', async () => {
  const result = await assertNoModelCall('Compare Hindustan Aeronautics and Bharat Electronics on revenue growth');
  assert.deepEqual(result.entities.symbols, ['HAL', 'BEL']);
});

test('a company name is matched via its full real name even with different punctuation/whitespace ("&" vs "and")', async () => {
  const result = await assertNoModelCall('What is the outlook for Larsen and Toubro this quarter?');
  assert.deepEqual(result.entities.symbols, ['LT']);
});

test('a short, genuinely ambiguous prefix (e.g. "HDFC" alone, matching neither "HDFC Bank" nor "HDFC Life" as a whole name) is never guessed deterministically', async () => {
  // HDFC is deliberately NOT resolved by the deterministic layer -- unlike
  // the no-model-call cases above, this message contains no unambiguous
  // ticker or full company name, so it must defer to the model path
  // instead of silently picking one of the two HDFC entities. The model
  // call is mocked (never a real network call from a unit test) and
  // itself returns no symbols, standing in for "the model also found this
  // too ambiguous to resolve" -- the point being proven is that the
  // deterministic layer alone never guesses, not what the model decides.
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => {
    called = true;
    return { chat: { completions: { parse: async () => ({ choices: [{ message: { parsed: { symbols: [], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false } } }] }) } } };
  };
  try {
    const result = await extractEntities(makeState('Tell me about HDFC'));
    assert.equal(called, true, 'the deterministic layer must find nothing for a genuinely ambiguous short form, deferring to the model');
    assert.deepEqual(result.entities.symbols, []);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('an unknown/unsupported company name is never fabricated into a symbol', async () => {
  // Zero deterministic matches correctly defers to the model (same as the
  // HDFC case above) -- the invariant under test is that nothing in the
  // deterministic layer invents a symbol for a company outside our
  // directory; the mocked model here plays the role of "found nothing
  // real either."
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.getClient = () => ({
    chat: { completions: { parse: async () => ({ choices: [{ message: { parsed: { symbols: [], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false } } }] }) } },
  });
  try {
    const result = await extractEntities(makeState('What do you think about Unlisted Startup Ventures Pvt Ltd?'));
    assert.deepEqual(result.entities.symbols, []);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});

test('duplicate mentions of the same company (ticker once, full name again later) collapse into one entry', async () => {
  const result = await assertNoModelCall('Is TCS a good buy? Tata Consultancy Services has been in the news a lot.');
  assert.deepEqual(result.entities.symbols, ['TCS']);
});

test('three symbols mentioned (mixed ticker/company) preserve their first-mention order and dedupe', async () => {
  const result = await assertNoModelCall('Compare HAL, Infosys and BEL, and also mention HAL again later.');
  assert.deepEqual(result.entities.symbols, ['HAL', 'INFY', 'BEL']);
});

test('periods are still extracted deterministically alongside multi-company resolution (not lost by the Phase 2 rewrite)', async () => {
  const result = await assertNoModelCall('Compare TCS and Infosys Q2 FY26 results');
  assert.deepEqual(result.entities.symbols, ['TCS', 'INFY']);
  assert.deepEqual(result.entities.periods, ['Q2 FY2026']);
});

test('a follow-up pronoun still routes to the model even when a company name is also present in the same message', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  let called = false;
  OpenAIClientFactory.getClient = () => {
    called = true;
    return { chat: { completions: { parse: async () => ({ choices: [{ message: { parsed: { symbols: ['INFY'], companyNames: ['Infosys'], periods: [], comparisonMode: false, resolvedFromFollowUp: true } } }] }) } } };
  };
  try {
    await extractEntities(makeState('and what about its debt levels, like Infosys?', { intent: 'FOLLOW_UP' }));
    assert.equal(called, true, 'a follow-up pronoun must still defer to the model for full contextual resolution');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
});
