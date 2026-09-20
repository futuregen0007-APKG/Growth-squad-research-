import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { HumanMessage } from '@langchain/core/messages';
import { graph } from '../graph/graph.js';
import { sendMessage } from '../controllers/ChatController.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import UserPreference from '../models/UserPreference.js';

/**
 * chatAnswerPipeline.test.js
 * ============================
 * Phase 3's full draft -> validate -> repair -> publish/fallback pipeline,
 * exercised through REAL graph.invoke calls (not just individual node unit
 * tests) — the required "one successful repair" / "repair introduces a
 * new claim and is rejected" / "draft never reaches SSE" / "draft never
 * reaches MongoDB" tests all need the real multi-node cycle to be
 * meaningful. Every OpenAI call is a fake, injected response — never live.
 */

const makeFakeOpenAI = ({
  intent, entities, composeTokens = ['OK'], verifierClaims = [], repairText = null,
}) => ({
  chat: {
    completions: {
      parse: async (args) => {
        const schemaName = args.response_format?.json_schema?.name;
        if (schemaName === 'intent_classification') return { choices: [{ message: { parsed: intent } }] };
        if (schemaName === 'entity_extraction') return { choices: [{ message: { parsed: entities } }] };
        if (schemaName === 'tool_plan') return { choices: [{ message: { parsed: { tools: [] } } }] };
        if (schemaName === 'explicit_preference') return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
        if (schemaName === 'claim_verification') return { choices: [{ message: { parsed: { claims: verifierClaims } } }] };
        return { choices: [{ message: { parsed: null } }] };
      },
      create: async (args) => {
        if (args.stream) {
          return {
            [Symbol.asyncIterator]: async function* iterate() {
              for (const token of composeTokens) yield { choices: [{ delta: { content: token } }] };
              yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
            },
          };
        }
        // Non-streaming create() call -- this is repairAnswer's call.
        return { choices: [{ message: { content: repairText } }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
      },
    },
  },
});

// COMPANY_RESEARCH's deterministic plan (planTools.js) plans BOTH
// getCompanyFinancials AND getCompanyResearch — both are mocked here so
// this test suite never makes a real IndianAPI call (see the module note).
const withMockedFinancials = async (evidenceRecord, fn) => {
  const originalFinancials = TOOL_REGISTRY.getCompanyFinancials;
  const originalResearch = TOOL_REGISTRY.getCompanyResearch;
  TOOL_REGISTRY.getCompanyFinancials = async () => ({
    tool: 'getCompanyFinancials', status: 'SUCCESS', data: [{ period: '2026' }],
    evidence: [evidenceRecord], resultCount: 1, evidenceCount: 1, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
  });
  TOOL_REGISTRY.getCompanyResearch = async () => ({
    tool: 'getCompanyResearch', status: 'EMPTY', data: null, evidence: [],
    resultCount: 0, evidenceCount: 0, errorCode: null, fetchedAt: new Date().toISOString(), warning: 'Data not available for requested period',
  });
  try {
    await fn();
  } finally {
    TOOL_REGISTRY.getCompanyFinancials = originalFinancials;
    TOOL_REGISTRY.getCompanyResearch = originalResearch;
  }
};

const FIN_EVIDENCE = { evidenceId: 'ev-fin', claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS financials', publishedAt: '2026-01-01', excerpt: 'Revenue grew 12%' };

test('required test 12: one successful repair -- an uncited draft is repaired, re-verified, and published', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue grew 12%.'], // no citation -> deterministic UNCITED_FACTUAL_CLAIM
    repairText: 'TCS revenue grew 12% [1].', // repaired: now cited
    verifierClaims: [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' }],
  });

  const emitted = [];
  try {
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage('Tell me about TCS revenue')], onEvent: (e) => emitted.push(e) });

      assert.equal(finalState.repairCount, 1);
      assert.equal(finalState.validationStatus, 'PASSED');
      assert.equal(finalState.answer, 'TCS revenue grew 12% [1].');
      assert.equal(finalState.citations.length, 1);

      // The rejected first draft's exact wording ("grew 12%." with no
      // citation) must never appear as a published token stream distinct
      // from the final text -- every token event, concatenated, must
      // equal ONLY the final published answer.
      const tokenText = emitted.filter((e) => e.type === 'token').map((e) => e.token).join('');
      assert.equal(tokenText, finalState.answer);
    });
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('required test 13: repair that still leaves an unsafe draft is rejected -- buildSafeFallback publishes instead, never the bad repair', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue grew 12%.'], // uncited -> REPAIR_REQUIRED
    repairText: 'TCS revenue grew 12% [1] and profit doubled [7].', // repair introduces a NEW out-of-range citation
  });

  const emitted = [];
  try {
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage('Tell me about TCS revenue')], onEvent: (e) => emitted.push(e) });

      assert.equal(finalState.repairCount, 1, 'exactly one repair attempt, never a second');
      assert.notEqual(finalState.answer, 'TCS revenue grew 12% [1] and profit doubled [7].', 'the still-broken repair must never be published');
    // Phase 6A: the zero-evidence abstention is now PRECISE - it names the
    // company and why the data is missing instead of a generic apology - so
    // it carries its own status (ABSTAINED_PRECISE) and is published
    // directly rather than routed through buildSafeFallback. The safety
    // property these tests exist for is unchanged: no LLM synthesis call,
    // no fabricated figure, and an honest statement of the gap.
    assert.ok(
      ['ABSTAINED', 'ABSTAINED_PRECISE'].includes(finalState.validationStatus),
      `expected an abstention, got ${finalState.validationStatus}`,
    );

      const tokenText = emitted.filter((e) => e.type === 'token').map((e) => e.token).join('');
      assert.equal(tokenText, finalState.answer, 'only the final safe fallback text is ever streamed, never the rejected repair');
    });
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('required test 19 + 20: the rejected draft/repair never reaches SSE or MongoDB -- only the final safe text does', async () => {
  const USER_ID = new mongoose.Types.ObjectId().toString();
  const THREAD_ID = new mongoose.Types.ObjectId().toString();

  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue is skyrocketing with no basis whatsoever.'], // uncited, unsafe-sounding draft
    repairText: 'TCS revenue is skyrocketing with no basis whatsoever, guaranteed.', // repair makes it WORSE (adds guarantee language)
  });

  const originalThreadFindOne = ChatThread.findOne;
  const originalMessageFind = ChatMessage.find;
  const originalMessageCreate = ChatMessage.create;
  const originalPrefFindOne = UserPreference.findOne;
  const createdMessages = [];
  const threadDoc = {
    _id: THREAD_ID, userId: USER_ID, deletedAt: null, messageCount: 1, title: 'TCS chat',
    summary: null, summaryUpToMessageId: null, activeEntities: { symbols: [], companyNames: [] },
    save: async function save() { return this; },
    toObject: function toObject() { return { _id: this._id, userId: this.userId, title: this.title, activeEntities: this.activeEntities, messageCount: this.messageCount, summary: this.summary }; },
  };
  ChatThread.findOne = () => Promise.resolve(threadDoc);
  ChatMessage.find = () => ({ sort: () => ({ lean: async () => [] }) });
  ChatMessage.create = async (doc) => {
    createdMessages.push(doc);
    return { ...doc, _id: new mongoose.Types.ObjectId(), toObject: function toObject() { return { ...doc, _id: this._id }; } };
  };
  UserPreference.findOne = () => ({ lean: async () => null });

  const emitted = [];
  try {
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({
        messages: [new HumanMessage('Tell me about TCS revenue')],
        userId: USER_ID, threadId: THREAD_ID, currentMessageId: new mongoose.Types.ObjectId().toString(),
        onEvent: (e) => emitted.push(e),
      });

      // required test 19: draft never reaches SSE.
      const tokenText = emitted.filter((e) => e.type === 'token').map((e) => e.token).join('');
      assert.ok(!tokenText.includes('no basis whatsoever, guaranteed'), 'the guarantee-language repair must never be streamed');
      assert.equal(tokenText, finalState.answer);

      // required test 20: draft never reaches MongoDB.
      const assistantMessage = createdMessages.find((m) => m.role === 'assistant');
      assert.ok(assistantMessage, 'the assistant message must still be persisted (with the safe fallback content)');
      assert.equal(assistantMessage.content, finalState.answer);
      assert.ok(!assistantMessage.content.includes('guaranteed'), 'the unsafe draft/repair text must never be persisted');
    });
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    ChatThread.findOne = originalThreadFindOne;
    ChatMessage.find = originalMessageFind;
    ChatMessage.create = originalMessageCreate;
    UserPreference.findOne = originalPrefFindOne;
  }
});

test('required test 9-equivalent: a clean, well-cited draft passes on the first try with no repair at all', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue grew 12% [1].'],
    verifierClaims: [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' }],
  });
  try {
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage('Tell me about TCS revenue')], onEvent: () => {} });
      assert.equal(finalState.repairCount, 0);
      assert.equal(finalState.validationStatus, 'PASSED');
      assert.equal(finalState.answer, 'TCS revenue grew 12% [1].');
    });
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('required test 1 (full pipeline): a comparison with zero evidence for both symbols abstains honestly, never fabricates', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'STOCK_COMPARISON', confidence: 0.9, reasoning: 'comparison' },
    entities: { symbols: ['HAL', 'BEL'], companyNames: [], periods: [], comparisonMode: true, resolvedFromFollowUp: false },
    composeTokens: ['HAL was founded in 1940 and BEL in 1954, both defence leaders.'], // fabricated general-knowledge answer
  });

  // Every underlying tool a replan round could reach for this scenario is
  // mocked too (not just compareStocks itself) -- otherwise
  // replanMissingEvidence's direct getLiveQuote/getCompanyFinancials/
  // getCompanyResearch calls would hit REAL providers, which this test
  // suite never does (see the module note).
  const emptyResult = (tool) => ({
    tool, status: 'EMPTY', data: null, evidence: [], resultCount: 0, evidenceCount: 0,
    errorCode: null, fetchedAt: new Date().toISOString(), warning: 'Data not available for requested period',
  });
  const originalCompareStocks = TOOL_REGISTRY.compareStocks;
  const originalLiveQuote = TOOL_REGISTRY.getLiveQuote;
  const originalFinancials = TOOL_REGISTRY.getCompanyFinancials;
  const originalResearch = TOOL_REGISTRY.getCompanyResearch;
  TOOL_REGISTRY.compareStocks = async () => ({
    ...emptyResult('compareStocks'), data: [],
    dimensions: ['PRICE', 'FINANCIALS', 'COMPANY_RESEARCH'], operationCount: 6,
  });
  TOOL_REGISTRY.getLiveQuote = async () => emptyResult('getLiveQuote');
  TOOL_REGISTRY.getCompanyFinancials = async () => emptyResult('getCompanyFinancials');
  TOOL_REGISTRY.getCompanyResearch = async () => emptyResult('getCompanyResearch');

  try {
    const finalState = await graph.invoke({ messages: [new HumanMessage('Compare HAL and BEL')], onEvent: () => {} });
    // Phase 6A: the zero-evidence abstention is now PRECISE - it names the
    // company and why the data is missing instead of a generic apology - so
    // it carries its own status (ABSTAINED_PRECISE) and is published
    // directly rather than routed through buildSafeFallback. The safety
    // property these tests exist for is unchanged: no LLM synthesis call,
    // no fabricated figure, and an honest statement of the gap.
    assert.ok(
      ['ABSTAINED', 'ABSTAINED_PRECISE'].includes(finalState.validationStatus),
      `expected an abstention, got ${finalState.validationStatus}`,
    );
    assert.ok(!/1940|1954|founded/i.test(finalState.answer), 'the fabricated founding-year claim must never survive to the final published answer');
    // Phase 6A: a zero-evidence turn now abstains PRECISELY ("I could not
    // answer this from verified data. Specifically: ...") naming each company
    // and why, alongside the legacy generic wording. Both are honest
    // refusals; this assertion exists to prove the answer IS a refusal.
    assert.match(finalState.answer, /don't have verified data|couldn't produce|could not answer this from verified data/i);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    TOOL_REGISTRY.compareStocks = originalCompareStocks;
    TOOL_REGISTRY.getLiveQuote = originalLiveQuote;
    TOOL_REGISTRY.getCompanyFinancials = originalFinancials;
    TOOL_REGISTRY.getCompanyResearch = originalResearch;
  }
});

// Required test 22: exactly one terminal SSE event, even through a repair
// round -- via the REAL controller + REAL graph (not a fake graph.invoke
// stub), so a genuine double-emission bug in the new nodes would show up.
test('required test 22: a repaired turn still produces exactly one message.completed event, never two, never a permanently open stream', async () => {
  const USER_ID = new mongoose.Types.ObjectId().toString();
  const THREAD_ID = new mongoose.Types.ObjectId().toString();

  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue grew 12%.'],
    repairText: 'TCS revenue grew 12% [1].',
    verifierClaims: [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' }],
  });

  const originalThreadFindOne = ChatThread.findOne;
  const originalMessageFind = ChatMessage.find;
  const originalMessageFindOne = ChatMessage.findOne;
  const originalMessageCreate = ChatMessage.create;
  const originalPrefFindOne = UserPreference.findOne;
  const threadDoc = {
    _id: THREAD_ID, userId: USER_ID, deletedAt: null, messageCount: 0, title: 'New chat',
    activeEntities: { symbols: [], companyNames: [] },
    save: async function save() { return this; },
    toObject: function toObject() { return { _id: this._id, userId: this.userId, title: this.title, activeEntities: this.activeEntities }; },
  };
  ChatThread.findOne = () => Promise.resolve(threadDoc);
  ChatMessage.find = () => ({ sort: () => ({ lean: async () => [] }) });
  ChatMessage.findOne = () => Promise.resolve(null);
  ChatMessage.create = async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId(), toObject: function toObject() { return { ...doc, _id: this._id }; } });
  UserPreference.findOne = () => ({ lean: async () => null });

  const frames = [];
  const res = {
    frames,
    writeHead: () => {},
    write: (chunk) => { frames.push(chunk); },
    end: () => {},
    on: () => {},
  };
  const req = { body: { message: 'Tell me about TCS revenue' }, params: { threadId: THREAD_ID }, userId: USER_ID, on: () => {} };

  try {
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      await sendMessage(req, res, (err) => { throw err; });
    });
    const events = frames.filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice('data: '.length).trim()).type);
    const terminalEvents = events.filter((t) => t === 'message.completed' || t === 'message.error');
    assert.equal(terminalEvents.length, 1, `expected exactly one terminal event, got: ${JSON.stringify(events)}`);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    ChatThread.findOne = originalThreadFindOne;
    ChatMessage.find = originalMessageFind;
    ChatMessage.findOne = originalMessageFindOne;
    ChatMessage.create = originalMessageCreate;
    UserPreference.findOne = originalPrefFindOne;
  }
});
