import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswer } from '../graph/nodes/composeAnswer.js';
import { validateFinalAnswer } from '../graph/nodes/validateFinalAnswer.js';
import { repairAnswer } from '../graph/nodes/repairAnswer.js';
import { publishFinalAnswer } from '../graph/nodes/publishFinalAnswer.js';
import { buildSafeFallback } from '../graph/nodes/buildSafeFallback.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

/**
 * groundedAnswerPipeline.test.js
 * =================================
 * Phase 4B Part 11: integration tests for the grounded RAG generate ->
 * verify -> (bounded repair) -> publish/fallback flow, exercised through
 * the REAL node files (composeAnswer/validateFinalAnswer/repairAnswer/
 * publishFinalAnswer/buildSafeFallback) exactly as graph.js's existing,
 * UNCHANGED routing would call them — only the OpenAI client is mocked,
 * with deterministic structured responses (per Part 11's instruction to
 * use deterministic mocked LLM responses for graph unit tests). State is
 * hand-built to the exact shape executeTools would have produced (see
 * chatToolRegistryGrounded.test.js for a real-DB test of that step).
 */

const withParseClient = async (parseImpl, fn) => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({ chat: { completions: { parse: parseImpl } } });
  try {
    await fn();
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
    OpenAIClientFactory.getClient = originalGetClient;
  }
};

const envelopeItem = (overrides = {}) => ({
  evidenceId: 'E1', symbol: 'TCS', companyName: 'Tata Consultancy Services', fiscalYear: 'FY2023', fiscalQuarter: null,
  documentId: 'doc-1', chunkId: 'chunk-1', documentTitle: 'TCS FY2023 Annual Report', documentType: 'ANNUAL_REPORT',
  sourceAuthority: 'COMPANY_FILING', publishedAt: '2023-05-01T00:00:00.000Z', sourceUrl: 'https://example.com/tcs.pdf',
  pageStart: 12, pageEnd: 12, text: 'Revenue grew 15% year over year.', retrievalRank: 1, retrievalMode: 'LOCAL_HYBRID_RERANK',
  untrustedContent: true, injectionSignal: { flagged: false, matchedPatterns: [] }, ...overrides,
});

const baseState = (overrides = {}) => ({
  errors: [], messages: [{ content: 'What was TCS FY2023 guidance?' }], intent: 'DOCUMENT_RESEARCH',
  entities: { symbols: ['TCS'], companyNames: [], periods: ['FY2023'], comparisonMode: false },
  toolPlan: [], toolResults: [], evidence: [], researchEvidence: [envelopeItem()], retrievalMode: 'LOCAL_HYBRID_RERANK',
  missingEvidence: [], warnings: [], userContext: {}, recentHistory: [], onEvent: null, abortSignal: null,
  deadlineAt: Date.now() + 45000, repairCount: 0,
  ...overrides,
});

const parsedResponse = (parsed) => async () => ({ choices: [{ message: { parsed } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

test('ambiguous company: composeAnswer asks for clarification, with no OpenAI call at all', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await composeAnswer(baseState({ entities: { symbols: [], companyNames: [], periods: [], comparisonMode: false } }));
    assert.equal(called, false);
    assert.equal(result.validationStatus, 'SKIPPED_GENERAL_EDUCATION');
    assert.match(result.draftAnswer, /which company/i);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('zero retrieved evidence abstains directly, with no OpenAI call (mirrors the legacy zero-evidence fast path)', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  let called = false;
  OpenAIClientFactory.getClient = () => { called = true; throw new Error('should not be called'); };
  try {
    const result = await composeAnswer(baseState({ researchEvidence: [] }));
    assert.equal(called, false);
    assert.deepEqual(result, { validationStatus: 'ABSTAINED' });
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('end-to-end: a fully grounded, correctly-cited claim passes verification on the first attempt and publishes real citations from the trusted envelope', async () => {
  await withParseClient(parsedResponse({
    answer: 'TCS guided FY2023 revenue growth of 15% [E1].',
    claims: [{
      claimId: 'C1', text: 'Revenue grew 15%.', claimType: 'historical_fact', evidenceIds: ['E1'],
    }],
    groundingStatus: 'grounded',
    coverage: {
      requestedSymbol: 'TCS', requestedPeriod: 'FY2023', evidenceCount: 1, limitations: [],
    },
  }), async () => {
    let state = baseState();
    const composeUpdate = await composeAnswer(state);
    assert.ok(composeUpdate.groundedAnswer);
    state = { ...state, ...composeUpdate };

    const validateUpdate = await validateFinalAnswer(state);
    assert.equal(validateUpdate.validationStatus, 'PASSED');
    assert.equal(validateUpdate.groundedClaims[0].verificationStatus, 'VERIFIED');
    state = { ...state, ...validateUpdate };

    const publishUpdate = await publishFinalAnswer(state);
    assert.equal(publishUpdate.answer, 'TCS guided FY2023 revenue growth of 15% [E1].');
    assert.equal(publishUpdate.citations.length, 1);
    assert.equal(publishUpdate.citations[0].evidenceId, 'E1');
    assert.equal(publishUpdate.citations[0].sourceUrl, 'https://example.com/tcs.pdf');
    assert.equal(publishUpdate.citations[0].pageStart, 12);
    assert.equal(publishUpdate.groundingStatus, 'grounded');
  });
});

test('a model-honest zero-claims (insufficient_evidence) answer passes straight through without spending a repair', async () => {
  let repairCalls = 0;
  await withParseClient(async (args) => {
    if (args.messages[0].content.includes('failed deterministic verification')) repairCalls += 1;
    return {
      choices: [{
        message: {
          parsed: {
            answer: 'The available evidence does not cover FY2023 guidance for TCS.',
            claims: [],
            groundingStatus: 'insufficient_evidence',
            coverage: {
              requestedSymbol: 'TCS', requestedPeriod: 'FY2023', evidenceCount: 1, limitations: ['No guidance disclosure found for FY2023'],
            },
          },
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }, async () => {
    let state = baseState();
    state = { ...state, ...(await composeAnswer(state)) };
    const validateUpdate = await validateFinalAnswer(state);
    assert.equal(validateUpdate.validationStatus, 'PASSED');
    assert.equal(repairCalls, 0);
    state = { ...state, ...validateUpdate };
    const publishUpdate = await publishFinalAnswer(state);
    assert.equal(publishUpdate.groundingStatus, 'insufficient_evidence');
    assert.deepEqual(publishUpdate.citations, []);
  });
});

test('an unknown evidenceId fails verification, is corrected by the one bounded repair, and then publishes successfully', async () => {
  let call = 0;
  await withParseClient(async () => {
    call += 1;
    if (call === 1) {
      return {
        choices: [{
          message: {
            parsed: {
              answer: 'TCS guided FY2023 revenue growth of 15% [E9].',
              claims: [{
                claimId: 'C1', text: 'Revenue grew 15%.', claimType: 'historical_fact', evidenceIds: ['E9'],
              }],
              groundingStatus: 'grounded',
              coverage: {
                requestedSymbol: 'TCS', requestedPeriod: 'FY2023', evidenceCount: 1, limitations: [],
              },
            },
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    }
    return {
      choices: [{
        message: {
          parsed: {
            answer: 'TCS guided FY2023 revenue growth of 15% [E1].',
            claims: [{
              claimId: 'C1', text: 'Revenue grew 15%.', claimType: 'historical_fact', evidenceIds: ['E1'],
            }],
            groundingStatus: 'grounded',
            coverage: {
              requestedSymbol: 'TCS', requestedPeriod: 'FY2023', evidenceCount: 1, limitations: [],
            },
          },
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }, async () => {
    let state = baseState();
    state = { ...state, ...(await composeAnswer(state)) };

    let validateUpdate = await validateFinalAnswer(state);
    assert.equal(validateUpdate.validationStatus, 'REPAIR_REQUIRED');
    assert.ok(validateUpdate.validationIssues[0].includes('UNKNOWN_EVIDENCE_ID'));
    state = { ...state, ...validateUpdate };

    const repairUpdate = await repairAnswer(state);
    assert.equal(repairUpdate.repairCount, 1);
    assert.equal(repairUpdate.repairAttempted, true);
    state = { ...state, ...repairUpdate };

    validateUpdate = await validateFinalAnswer(state);
    assert.equal(validateUpdate.validationStatus, 'PASSED');
    state = { ...state, ...validateUpdate };

    const publishUpdate = await publishFinalAnswer(state);
    assert.equal(publishUpdate.citations[0].evidenceId, 'E1');
  });
});

test('a repair that still fails never publishes an unverified claim -- falls to the honest safe fallback, with never more than one repair', async () => {
  await withParseClient(parsedResponse({
    answer: 'TCS guided FY2023 revenue growth of 15% [E9].',
    claims: [{
      claimId: 'C1', text: 'Revenue grew 15%.', claimType: 'historical_fact', evidenceIds: ['E9'],
    }],
    groundingStatus: 'grounded',
    coverage: {
      requestedSymbol: 'TCS', requestedPeriod: 'FY2023', evidenceCount: 1, limitations: [],
    },
  }), async () => {
    let state = baseState();
    state = { ...state, ...(await composeAnswer(state)) };

    let validateUpdate = await validateFinalAnswer(state);
    assert.equal(validateUpdate.validationStatus, 'REPAIR_REQUIRED');
    state = { ...state, ...validateUpdate };

    const repairUpdate = await repairAnswer(state);
    assert.equal(repairUpdate.repairCount, 1);
    state = { ...state, ...repairUpdate };

    validateUpdate = await validateFinalAnswer(state);
    // Still failing (the mock always returns the same bad evidenceId) --
    // routeAfterValidation would now send this to buildSafeFallback since
    // repairCount is already 1, never attempt a second repair.
    assert.equal(validateUpdate.validationStatus, 'REPAIR_REQUIRED');
    assert.equal(state.repairCount, 1);
    state = { ...state, ...validateUpdate };

    const fallbackUpdate = await buildSafeFallback(state);
    assert.equal(fallbackUpdate.groundingStatus, 'insufficient_evidence');
    assert.deepEqual(fallbackUpdate.citations, []);
    assert.match(fallbackUpdate.answer, /couldn't find|don't have verified/i);
  });
});

test('a partially-grounded repair result (some claims fixed, none left unverified) publishes only the verified claims\' citations', async () => {
  const secondEnvelope = [envelopeItem(), envelopeItem({ evidenceId: 'E2', chunkId: 'chunk-2', text: 'Profit grew 8% for the period.' })];
  let call = 0;
  await withParseClient(async () => {
    call += 1;
    return {
      choices: [{
        message: {
          parsed: {
            answer: call === 1
              ? 'Revenue grew 15% [E1] and profit grew 40% [E2].'
              : 'Revenue grew 15% [E1].',
            claims: call === 1
              ? [
                { claimId: 'C1', text: 'Revenue grew 15%.', claimType: 'historical_fact', evidenceIds: ['E1'] },
                { claimId: 'C2', text: 'Profit grew 40%.', claimType: 'historical_fact', evidenceIds: ['E2'] },
              ]
              : [{ claimId: 'C1', text: 'Revenue grew 15%.', claimType: 'historical_fact', evidenceIds: ['E1'] }],
            groundingStatus: 'grounded',
            coverage: {
              requestedSymbol: 'TCS', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [],
            },
          },
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }, async () => {
    let state = baseState({ researchEvidence: secondEnvelope });
    state = { ...state, ...(await composeAnswer(state)) };

    let validateUpdate = await validateFinalAnswer(state); // C2's "40%" is not supported by "8%" evidence -> NUMERIC_MISMATCH
    assert.equal(validateUpdate.validationStatus, 'REPAIR_REQUIRED');
    state = { ...state, ...validateUpdate };

    const repairUpdate = await repairAnswer(state);
    state = { ...state, ...repairUpdate };

    validateUpdate = await validateFinalAnswer(state);
    assert.equal(validateUpdate.validationStatus, 'PASSED');
    state = { ...state, ...validateUpdate };

    const publishUpdate = await publishFinalAnswer(state);
    assert.equal(publishUpdate.citations.length, 1);
    assert.equal(publishUpdate.citations[0].evidenceId, 'E1');
  });
});

test('non-research chat (a different intent) is completely unaffected by the grounded branch', async () => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        create: async () => ({
          [Symbol.asyncIterator]: async function* iterate() {
            yield { choices: [{ delta: { content: 'A P/E ratio is price divided by earnings per share.' } }] };
            yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
          },
        }),
      },
    },
  });
  try {
    const result = await composeAnswer(baseState({
      intent: 'GENERAL_EDUCATION', researchEvidence: [], toolResults: [], evidence: [],
      messages: [{ content: 'What is a P/E ratio?' }],
    }));
    assert.equal(result.groundedAnswer, undefined);
    assert.equal(result.draftAnswer, 'A P/E ratio is price divided by earnings per share.');
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});
