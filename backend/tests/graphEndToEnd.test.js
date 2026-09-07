import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { HumanMessage } from '@langchain/core/messages';
import { graph } from '../graph/graph.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import UserPreference from '../models/UserPreference.js';

/** Fake OpenAI client covering both structured (.parse) and streaming (.create) calls the graph makes. */
const makeFakeOpenAI = ({ intent, entities, streamTokens = ['OK'] }) => ({
  chat: {
    completions: {
      parse: async (args) => {
        const schemaName = args.response_format?.json_schema?.name;
        if (schemaName === 'intent_classification') return { choices: [{ message: { parsed: intent } }] };
        if (schemaName === 'entity_extraction') return { choices: [{ message: { parsed: entities } }] };
        if (schemaName === 'tool_plan') return { choices: [{ message: { parsed: { tools: [] } } }] };
        if (schemaName === 'explicit_preference') return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
        return { choices: [{ message: { parsed: null } }] };
      },
      create: async () => ({
        [Symbol.asyncIterator]: async function* iterate() {
          for (const token of streamTokens) yield { choices: [{ delta: { content: token } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        },
      }),
    },
  },
});

test('end-to-end: a general-education question skips tool execution entirely and streams an answer', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'GENERAL_EDUCATION', confidence: 0.95, reasoning: 'Definitional' },
    entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    streamTokens: ['A P/E ratio ', 'compares price to earnings.'],
  });

  const emitted = [];
  try {
    const finalState = await graph.invoke({
      messages: [new HumanMessage('What is a P/E ratio?')],
      onEvent: (e) => emitted.push(e.type),
    });

    assert.equal(finalState.intent, 'GENERAL_EDUCATION');
    assert.deepEqual(finalState.toolPlan, []);
    assert.deepEqual(finalState.toolResults, []);
    assert.equal(finalState.answer, 'A P/E ratio compares price to earnings.');
    assert.ok(!emitted.includes('tool.started'), 'no tool should run for a general education question');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('end-to-end: a live-price question with thread memory runs the full node chain and persists the assistant message', async () => {
  const USER_ID = new mongoose.Types.ObjectId().toString();
  const THREAD_ID = new mongoose.Types.ObjectId().toString();

  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => makeFakeOpenAI({
    intent: { intent: 'LIVE_MARKET_DATA', confidence: 0.9, reasoning: 'price request' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    streamTokens: ['TCS is at 4120 as of 2026-09-07 [1].'],
  });

  const originalTool = TOOL_REGISTRY.getLiveQuote;
  TOOL_REGISTRY.getLiveQuote = async () => ({
    tool: 'getLiveQuote', status: 'SUCCESS',
    data: { ticker: 'TCS', price: 4120, timestamp: '2026-09-07T10:00:00.000Z' },
    evidence: [{ evidenceId: 'ev-1', claimType: 'LIVE_PRICE', symbol: 'TCS', title: 'TCS live quote', publishedAt: '2026-09-07T10:00:00.000Z', excerpt: 'Price 4120' }],
    fetchedAt: new Date().toISOString(), warning: null,
  });

  const originalThreadFindOne = ChatThread.findOne;
  const originalMessageFind = ChatMessage.find;
  const originalMessageCreate = ChatMessage.create;
  const originalPrefFindOne = UserPreference.findOne;

  const createdMessages = [];
  const savedThreadUpdates = [];

  const threadDoc = {
    _id: THREAD_ID, userId: USER_ID, deletedAt: null, messageCount: 1, title: 'TCS chat',
    summary: null, summaryUpToMessageId: null, activeEntities: { symbols: [], companyNames: [] },
    save: async function save() { savedThreadUpdates.push({ ...this }); return this; },
    toObject: function toObject() { return { _id: this._id, userId: this.userId, title: this.title, activeEntities: this.activeEntities, messageCount: this.messageCount, summary: this.summary }; },
  };

  ChatThread.findOne = () => Promise.resolve(threadDoc);
  ChatMessage.find = () => ({ sort: () => ({ lean: async () => [] }) });
  ChatMessage.create = async (doc) => {
    createdMessages.push(doc);
    return { ...doc, _id: new mongoose.Types.ObjectId(), toObject: function toObject() { return { ...doc, _id: this._id }; } };
  };
  UserPreference.findOne = () => ({ lean: async () => null });

  try {
    const finalState = await graph.invoke({
      messages: [new HumanMessage('What is the current price of TCS?')],
      userId: USER_ID,
      threadId: THREAD_ID,
      currentMessageId: new mongoose.Types.ObjectId().toString(),
      onEvent: () => {},
    });

    assert.equal(finalState.intent, 'LIVE_MARKET_DATA');
    assert.deepEqual(finalState.toolPlan, [{ tool: 'getLiveQuote', args: { symbol: 'TCS' } }]);
    assert.equal(finalState.toolResults[0].status, 'SUCCESS');
    assert.equal(finalState.citations.length, 1);
    assert.equal(finalState.citations[0].evidenceId, 'ev-1');

    // saveMemory persisted the assistant's message with citations attached.
    const assistantMessage = createdMessages.find((m) => m.role === 'assistant');
    assert.ok(assistantMessage, 'assistant message should have been persisted');
    assert.equal(assistantMessage.citations[0].evidenceId, 'ev-1');
    assert.equal(assistantMessage.intent, 'LIVE_MARKET_DATA');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    TOOL_REGISTRY.getLiveQuote = originalTool;
    ChatThread.findOne = originalThreadFindOne;
    ChatMessage.find = originalMessageFind;
    ChatMessage.create = originalMessageCreate;
    UserPreference.findOne = originalPrefFindOne;
  }
});
