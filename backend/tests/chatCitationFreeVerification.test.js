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

/**
 * chatCitationFreeVerification.test.js
 * =======================================
 * Hardening fix: the structured verifier must run for a citation-free
 * evidence-dependent draft (previously skipped — the exact gap the
 * hardening review flagged with "evidence exists for TCS guidance, draft
 * makes uncited claims about TCS revenue and margins"). These are full
 * graph.invoke pipeline tests (not just the needsClaimVerifier unit tests
 * in chatClaimValidation.test.js) so the whole compose -> verify -> repair
 * -> publish cycle is proven end to end. Every OpenAI call is an injected
 * fake — never live.
 */

// verifierResponses is a QUEUE: validateFinalAnswer legitimately re-runs
// the verifier on the REPAIRED draft too (round 2), and a real verifier
// would naturally return a DIFFERENT (smaller) claim set once a bad claim
// has been removed. A single static claims array would incorrectly
// re-assert the same (now-stale) verdicts on round 2 and defeat the
// repair. Each call shifts the next entry off the queue; once exhausted,
// the LAST entry is reused (so a test that only cares about round 1 can
// still pass a single-element array safely).
const makeFakeOpenAI = ({
  intent, entities, composeTokens = ['OK'], verifierResponses = [[]], repairText = null, verifierCalls,
}) => {
  const queue = [...verifierResponses];
  return {
    chat: {
      completions: {
        parse: async (args) => {
          const schemaName = args.response_format?.json_schema?.name;
          if (schemaName === 'intent_classification') return { choices: [{ message: { parsed: intent } }] };
          if (schemaName === 'entity_extraction') return { choices: [{ message: { parsed: entities } }] };
          if (schemaName === 'tool_plan') return { choices: [{ message: { parsed: { tools: [] } } }] };
          if (schemaName === 'explicit_preference') return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
          if (schemaName === 'claim_verification') {
            if (verifierCalls) verifierCalls.push(true);
            const claims = queue.length > 1 ? queue.shift() : queue[0];
            return { choices: [{ message: { parsed: { claims } } }] };
          }
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
          return { choices: [{ message: { content: repairText } }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
        },
      },
    },
  };
};

const FIN_EVIDENCE = { evidenceId: 'ev-fin', claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS financials', publishedAt: '2026-01-01', excerpt: 'Revenue grew 12%, margins held steady' };

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

const withFakeOpenAI = async (opts, fn) => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  // Built ONCE, not per-call: getClient() is invoked separately by
  // composeAnswer/validateFinalAnswer/repairAnswer, each a fresh call --
  // a naive `getClient = () => makeFakeOpenAI(opts)` would reconstruct a
  // brand-new client (and reset the verifierResponses queue) on every
  // single one of those calls, silently defeating the round-aware queue.
  // Caching the one client instance here mirrors how the REAL
  // OpenAIClientFactory.getClient() caches its own sharedClient.
  const client = makeFakeOpenAI(opts);
  OpenAIClientFactory.getClient = () => client;
  try {
    await fn();
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
};

// ---------------------------------------------------------------------------
// Required tests 1 + 2: evidence exists, citation-free draft, verifier runs
// and repair ADDS a correct citation to the supported claim (never just
// deletes it).
// ---------------------------------------------------------------------------
test('required tests 1+2: a citation-free but genuinely supported claim is verified, then repaired by ADDING a citation, not deleted', async () => {
  const verifierCalls = [];
  const supportedClaim = [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' }];
  await withFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue grew 12% and margins held steady.'], // NO citation marker at all
    // Round 1 sees the citation-free draft, verdict SUPPORTED but
    // uncited (deterministic UNCITED_FACTUAL_CLAIM still fires and forces
    // repair). Round 2 re-verifies the REPAIRED (now-cited) draft, same
    // real claim, same real verdict.
    verifierResponses: [supportedClaim, supportedClaim],
    repairText: 'TCS revenue grew 12% and margins held steady [1].', // repair ADDS the citation
    verifierCalls,
  }, async () => {
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage('Tell me about TCS revenue and margins')], onEvent: () => {} });
      assert.equal(verifierCalls.length, 2, 'the verifier runs on the citation-free draft AND again on the repaired one -- COMPANY_RESEARCH always requires verification, citation state plays no role');
      assert.equal(finalState.repairCount, 1);
      assert.equal(finalState.validationStatus, 'PASSED');
      assert.equal(finalState.answer, 'TCS revenue grew 12% and margins held steady [1].');
      assert.equal(finalState.citations.length, 1, 'the supported claim must end up cited, not dropped');
      assert.equal(finalState.citations[0].evidenceId, 'ev-fin');
    });
  });
});

// ---------------------------------------------------------------------------
// Required test 3: citation-free UNSUPPORTED claim is removed by repair.
// ---------------------------------------------------------------------------
test('required test 3: a citation-free UNSUPPORTED claim is removed by repair, never published', async () => {
  const unsupportedClaim = [{ claimId: 'claim-1', verdict: 'UNSUPPORTED', evidenceIndexes: [], reasonCode: 'NO_MATCHING_EVIDENCE' }];
  await withFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS is expanding aggressively into the European insurance market.'], // fabricated, no matching evidence
    verifierResponses: [unsupportedClaim, []], // round 2's repaired draft has no claims left to flag
    repairText: "I don't have verified data about TCS's European insurance market expansion.",
  }, async () => {
    // "performance" triggers planTools.js's FINANCIALS_KEYWORDS, so the
    // deterministic COMPANY_RESEARCH plan calls getCompanyFinancials (not
    // just getCompanyResearch) -- giving this turn real, nonzero evidence
    // (otherwise Phase 4A's zero-evidence fast path -- composeAnswer.js --
    // would abstain directly without ever reaching compose/repair at all,
    // which defeats what THIS test is specifically checking).
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage("Tell me about TCS's performance and European expansion")], onEvent: () => {} });
      assert.equal(finalState.repairCount, 1);
      // The honest "I don't have data about X" abstention legitimately
      // still names the topic -- what must never survive is the FABRICATED
      // ASSERTION itself ("expanding aggressively"), not the topic mention.
      assert.ok(!/expanding aggressively/i.test(finalState.answer), 'the unsupported fabricated claim must never survive to the published answer');
      assert.equal(finalState.validationStatus, 'PASSED');
    });
  });
});

// ---------------------------------------------------------------------------
// Required test 4: mixed supported + unsupported citation-free claims.
// ---------------------------------------------------------------------------
test('required test 4: a mix of citation-free supported and unsupported claims -- supported is kept+cited, unsupported is removed', async () => {
  await withFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue grew 12%. TCS also just acquired a European insurance firm.'],
    verifierResponses: [
      [
        { claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' },
        { claimId: 'claim-2', verdict: 'UNSUPPORTED', evidenceIndexes: [], reasonCode: 'NO_MATCHING_EVIDENCE' },
      ],
      // Round 2 re-verifies the REPAIRED draft, which no longer contains
      // the removed insurance claim -- only the real, supported one remains.
      [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' }],
    ],
    repairText: 'TCS revenue grew 12% [1].',
  }, async () => {
    // "performance" triggers planTools.js's FINANCIALS_KEYWORDS, so the
    // deterministic COMPANY_RESEARCH plan calls getCompanyFinancials (not
    // just getCompanyResearch), giving this turn real evidence.
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage("Tell me about TCS's performance")], onEvent: () => {} });
      assert.equal(finalState.answer, 'TCS revenue grew 12% [1].');
      assert.ok(!/insurance/i.test(finalState.answer), 'the unsupported claim must be dropped');
      assert.equal(finalState.citations[0].evidenceId, 'ev-fin', 'the supported claim must be preserved and correctly cited');
      assert.equal(finalState.validationStatus, 'PASSED');
    });
  });
});

// ---------------------------------------------------------------------------
// Required test 7: a semantic factual claim the deterministic regex layer
// cannot recognize (no numbers, no dimension-keyword match) is still
// caught, because the verifier runs regardless of what the regex found.
// ---------------------------------------------------------------------------
test('required test 7: a semantic (non-numeric, regex-invisible) unsupported claim is still caught by the verifier', async () => {
  const verifierCalls = [];
  const unsupportedClaim = [{ claimId: 'claim-1', verdict: 'UNSUPPORTED', evidenceIndexes: [], reasonCode: 'NO_MATCHING_EVIDENCE' }];
  await withFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    // No numbers, no ₹/%, no PRICE/FINANCIALS/NEWS keyword pattern match --
    // runDeterministicChecks alone would find ZERO issues here.
    composeTokens: ['TCS has fundamentally shifted its entire business model toward pure consulting.'],
    verifierResponses: [unsupportedClaim, []], // round 2's repaired draft has nothing left to flag
    repairText: "I don't have verified data confirming a shift in TCS's business model.",
    verifierCalls,
  }, async () => {
    // "performance" is a FINANCIALS_KEYWORDS trigger (planTools.js), so
    // the deterministic COMPANY_RESEARCH plan calls getCompanyFinancials
    // (not just getCompanyResearch) -- giving this turn real evidence to
    // verify against. The message driving tool planning is independent of
    // the (fake, injected) draft text itself.
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage("Tell me about TCS's performance and business model")], onEvent: () => {} });
      assert.equal(verifierCalls.length, 2, 'the verifier must run even though deterministic regex found nothing to flag, both before and after repair');
      assert.ok(!/fundamentally shifted/i.test(finalState.answer), 'the semantic hallucination must never survive to the published answer');
      assert.equal(finalState.validationStatus, 'PASSED');
    });
  });
});

// ---------------------------------------------------------------------------
// Required test 12: final citations after repair map ONLY to real evidence.
// ---------------------------------------------------------------------------
test('required test 12: citations in the final published answer all map to real evidence records, none fabricated', async () => {
  const supportedClaim = [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: 'MATCH' }];
  await withFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS revenue grew 12%.'], // citation-free -> repair adds the real citation
    verifierResponses: [supportedClaim, supportedClaim],
    repairText: 'TCS revenue grew 12% [1].',
  }, async () => {
    await withMockedFinancials(FIN_EVIDENCE, async () => {
      const finalState = await graph.invoke({ messages: [new HumanMessage('Tell me about TCS revenue')], onEvent: () => {} });
      assert.equal(finalState.validationStatus, 'PASSED');
      assert.equal(finalState.citations.length, 1);
      assert.equal(finalState.citations[0].evidenceId, 'ev-fin');
    });
  });
});

// ---------------------------------------------------------------------------
// Required test 13: a rejected citation-free draft never reaches SSE or MongoDB.
// ---------------------------------------------------------------------------
test('required test 13: a rejected citation-free draft (repair also fails to fix it) never reaches SSE or MongoDB', async () => {
  const USER_ID = new mongoose.Types.ObjectId().toString();
  const THREAD_ID = new mongoose.Types.ObjectId().toString();

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
    await withFakeOpenAI({
      intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
      entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
      composeTokens: ['TCS secretly controls a shadow subsidiary worth billions.'], // fabricated
      verifierResponses: [[{ claimId: 'claim-1', verdict: 'UNSUPPORTED', evidenceIndexes: [], reasonCode: 'NO_MATCHING_EVIDENCE' }]],
      // Repair STILL produces an unsafe claim (guarantee language) --
      // deterministic checks alone catch this on round 2, and repair is
      // already exhausted (repairCount 1), so this must fall to buildSafeFallback.
      repairText: 'TCS secretly controls a shadow subsidiary, guaranteed to be worth billions.',
    }, async () => {
      // "performance" triggers getCompanyFinancials being planned (see the
      // Phase 4A comment on test 3 above) -- gives this turn real, nonzero
      // evidence so it reaches compose/repair instead of the zero-evidence
      // fast path abstaining directly.
      await withMockedFinancials(FIN_EVIDENCE, async () => {
        const finalState = await graph.invoke({
          messages: [new HumanMessage("Tell me about TCS's performance")],
          userId: USER_ID, threadId: THREAD_ID, currentMessageId: new mongoose.Types.ObjectId().toString(),
          onEvent: (e) => emitted.push(e),
        });

        const tokenText = emitted.filter((e) => e.type === 'token').map((e) => e.token).join('');
        assert.ok(!tokenText.includes('shadow subsidiary'), 'the fabricated/unsafe repair must never be streamed');
        assert.equal(tokenText, finalState.answer);

        const assistantMessage = createdMessages.find((m) => m.role === 'assistant');
        assert.ok(assistantMessage);
        assert.equal(assistantMessage.content, finalState.answer);
        assert.ok(!assistantMessage.content.includes('shadow subsidiary'), 'the fabricated/unsafe repair must never be persisted');
        assert.equal(finalState.repairCount, 1, 'never a second repair');
      });
    });
  } finally {
    ChatThread.findOne = originalThreadFindOne;
    ChatMessage.find = originalMessageFind;
    ChatMessage.create = originalMessageCreate;
    UserPreference.findOne = originalPrefFindOne;
  }
});

// ---------------------------------------------------------------------------
// Required test 11: a zero-evidence factual answer is never published, even
// for a plain (non-comparison) COMPANY_RESEARCH turn.
// ---------------------------------------------------------------------------
test('required test 11: a zero-evidence COMPANY_RESEARCH turn never publishes a fabricated factual answer', async () => {
  await withFakeOpenAI({
    intent: { intent: 'COMPANY_RESEARCH', confidence: 0.9, reasoning: 'financials' },
    entities: { symbols: ['TCS'], companyNames: [], periods: [], comparisonMode: false, resolvedFromFollowUp: false },
    composeTokens: ['TCS was founded in 1968 and is India\'s largest IT services exporter.'],
  }, async () => {
    const originalFinancials = TOOL_REGISTRY.getCompanyFinancials;
    const originalResearch = TOOL_REGISTRY.getCompanyResearch;
    TOOL_REGISTRY.getCompanyFinancials = async () => ({
      tool: 'getCompanyFinancials', status: 'EMPTY', data: [], evidence: [], resultCount: 0, evidenceCount: 0,
      errorCode: null, fetchedAt: new Date().toISOString(), warning: 'Data not available for requested period',
    });
    TOOL_REGISTRY.getCompanyResearch = async () => ({
      tool: 'getCompanyResearch', status: 'UNAVAILABLE', data: null, evidence: [], resultCount: 0, evidenceCount: 0,
      errorCode: 'RATE_LIMITED', fetchedAt: new Date().toISOString(), warning: 'Provider unavailable',
    });
    try {
      const finalState = await graph.invoke({ messages: [new HumanMessage('Tell me about TCS')], onEvent: () => {} });
      assert.ok(!/1968|founded/i.test(finalState.answer), 'the fabricated founding fact must never survive to the published answer');
      // Phase 6A: a zero-evidence turn may now abstain PRECISELY, naming each
    // company and why its data is missing. That is a third honest,
    // non-fabricating terminal state alongside the two this test already
    // accepted - the property under test (never publishes a fabricated
    // factual answer) is unchanged and asserted below.
    assert.ok(['ABSTAINED', 'ABSTAINED_PRECISE', 'PASSED'].includes(finalState.validationStatus));
    } finally {
      TOOL_REGISTRY.getCompanyFinancials = originalFinancials;
      TOOL_REGISTRY.getCompanyResearch = originalResearch;
    }
  });
});
