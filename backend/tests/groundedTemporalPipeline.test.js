import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswer } from '../graph/nodes/composeAnswer.js';
import { validateFinalAnswer } from '../graph/nodes/validateFinalAnswer.js';
import { repairAnswer } from '../graph/nodes/repairAnswer.js';
import { publishFinalAnswer } from '../graph/nodes/publishFinalAnswer.js';
import { buildSafeFallback } from '../graph/nodes/buildSafeFallback.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { buildResearchEvidenceEnvelope, mergeEarningsIntelligenceEvidence, reconcileEvidenceEnvelope } from '../services/EvidenceEnvelope.js';

/**
 * groundedTemporalPipeline.test.js
 * ====================================
 * Phase 4D: end-to-end grounded generate -> verify -> (bounded repair) ->
 * publish/fallback, exercised through the REAL node files, with a REAL
 * reconciled evidence envelope (documents + Earnings Intelligence, real
 * temporalStatus/relationship annotations) -- the exact INFY FY2023
 * operating-margin scenario from the task's own example: an older
 * document chunk (21%-23%) superseded by a later Earnings Intelligence
 * record (21%-22%).
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

/** buildInfyEnvelope - the real reconciled envelope used by every test below: E1 = older document chunk (SUPERSEDED), E2 = newer Earnings-Intelligence record (CURRENT). */
const buildInfyEnvelope = () => {
  const docEnvelope = buildResearchEvidenceEnvelope([{
    chunkId: 'doc-1', symbol: 'INFY', registryDocumentId: 'reg-1', documentType: 'EARNINGS_CALL_TRANSCRIPT',
    title: 'INFY Q1 FY2023 Earnings Call', fiscalYear: 'FY2023', fiscalQuarter: null,
    publishedAt: '2022-07-01T00:00:00.000Z', sourceUrl: 'https://example.com/infy-q1.pdf', pageStart: 4, pageEnd: 4,
    text: 'We are guiding operating margin of 21%-23% for FY2023.', sourceAuthority: 'EARNINGS_CALL_TRANSCRIPT', score: 5,
  }], { retrievalMode: 'LOCAL_HYBRID_RERANK', companyNames: { INFY: 'Infosys' } });

  const timeline = {
    promises: [{
      id: 'p1', statement: 'Revised operating margin guidance', period: 'FY2023', status: 'PENDING',
      metric: 'operating margin', targetValue: 21.5, targetUnit: 'PERCENTAGE',
      evidence: {
        sourceUrl: 'https://example.com/infy-revised.pdf', excerpt: 'Management revised FY2023 operating margin guidance to 21%-22%.', publicationDate: '2023-01-01T00:00:00.000Z', sourceName: 'Q2 Earnings Call',
      },
      outcome: { sourceUrl: null, excerpt: null },
    }],
  };
  const merged = mergeEarningsIntelligenceEvidence(docEnvelope, timeline, { symbol: 'INFY', companyName: 'Infosys' });
  const reconciled = reconcileEvidenceEnvelope(merged);
  return { items: reconciled.items, relationships: reconciled.relationships };
};

const baseState = (envelope, overrides = {}) => ({
  errors: [], messages: [{ content: 'What is the current operating margin guidance for INFY?' }], intent: 'EARNINGS_INTELLIGENCE',
  entities: { symbols: ['INFY'], companyNames: [], periods: ['FY2023'], comparisonMode: false },
  toolPlan: [], toolResults: [], evidence: [], researchEvidence: envelope.items, researchRelationships: envelope.relationships,
  retrievalMode: 'LOCAL_HYBRID_RERANK', missingEvidence: [], warnings: [], userContext: {}, recentHistory: [], onEvent: null,
  abortSignal: null, deadlineAt: Date.now() + 45000, repairCount: 0,
  ...overrides,
});

const runPipeline = async (state) => {
  let s = { ...state, ...(await composeAnswer(state)) };
  let validateUpdate = await validateFinalAnswer(s);
  s = { ...s, ...validateUpdate };
  if (validateUpdate.validationStatus === 'REPAIR_REQUIRED') {
    const repairUpdate = await repairAnswer(s);
    s = { ...s, ...repairUpdate };
    validateUpdate = await validateFinalAnswer(s);
    s = { ...s, ...validateUpdate };
  }
  if (s.validationStatus === 'PASSED') {
    return { ...s, ...(await publishFinalAnswer(s)) };
  }
  return { ...s, ...(await buildSafeFallback(s)) };
};

test('current-guidance answer: citing the CURRENT (Earnings-Intelligence) record passes on the first attempt, never citing the superseded chunk as current', async () => {
  const envelope = buildInfyEnvelope();
  const currentItem = envelope.items.find((i) => i.temporalStatus === 'CURRENT');
  await withParseClient(async () => ({
    choices: [{
      message: {
        parsed: {
          answer: `INFY's current operating margin guidance for FY2023 is 21%-22% [${currentItem.evidenceId}].`,
          claims: [{
            claimId: 'C1', text: 'INFY revised its FY2023 operating margin guidance to 21%-22%.', claimType: 'revised_guidance', evidenceIds: [currentItem.evidenceId], relationshipId: null,
          }],
          groundingStatus: 'grounded',
          coverage: { requestedSymbol: 'INFY', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [] },
        },
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), async () => {
    const result = await runPipeline(baseState(envelope));
    assert.equal(result.validationStatus, 'PASSED');
    assert.equal(result.groundingStatus, 'grounded');
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].evidenceId, currentItem.evidenceId);
    assert.equal(result.citations[0].temporalStatus, 'CURRENT');
  });
});

test('original-guidance answer: a management_guidance claim MAY cite the SUPERSEDED document chunk, clearly labeled as original', async () => {
  const envelope = buildInfyEnvelope();
  const supersededItem = envelope.items.find((i) => i.temporalStatus === 'SUPERSEDED');
  await withParseClient(async () => ({
    choices: [{
      message: {
        parsed: {
          answer: `INFY originally guided FY2023 operating margin of 21%-23% [${supersededItem.evidenceId}].`,
          claims: [{
            claimId: 'C1', text: 'INFY originally guided FY2023 operating margin of 21%-23%.', claimType: 'management_guidance', evidenceIds: [supersededItem.evidenceId], relationshipId: null,
          }],
          groundingStatus: 'grounded',
          coverage: { requestedSymbol: 'INFY', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [] },
        },
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), async () => {
    const result = await runPipeline(baseState(envelope, {
      messages: [{ content: 'What margin guidance did INFY originally give for FY2023?' }],
    }));
    assert.equal(result.validationStatus, 'PASSED');
    assert.equal(result.citations[0].evidenceId, supersededItem.evidenceId);
    assert.equal(result.citations[0].temporalStatus, 'SUPERSEDED');
  });
});

test('compare-original-and-revised answer: cites BOTH the original and the revised evidence, each its own claim', async () => {
  const envelope = buildInfyEnvelope();
  const supersededItem = envelope.items.find((i) => i.temporalStatus === 'SUPERSEDED');
  const currentItem = envelope.items.find((i) => i.temporalStatus === 'CURRENT');
  await withParseClient(async () => ({
    choices: [{
      message: {
        parsed: {
          answer: `INFY originally guided 21%-23% [${supersededItem.evidenceId}], later revised to 21%-22% [${currentItem.evidenceId}].`,
          claims: [
            { claimId: 'C1', text: 'INFY originally guided FY2023 operating margin of 21%-23%.', claimType: 'management_guidance', evidenceIds: [supersededItem.evidenceId], relationshipId: null },
            { claimId: 'C2', text: 'INFY revised its FY2023 operating margin guidance to 21%-22%.', claimType: 'revised_guidance', evidenceIds: [currentItem.evidenceId], relationshipId: null },
          ],
          groundingStatus: 'grounded',
          coverage: { requestedSymbol: 'INFY', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [] },
        },
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), async () => {
    const result = await runPipeline(baseState(envelope, {
      messages: [{ content: 'Compare the original and revised operating margin guidance for INFY.' }],
    }));
    assert.equal(result.validationStatus, 'PASSED');
    assert.equal(result.citations.length, 2);
    const ids = result.citations.map((c) => c.evidenceId).sort();
    assert.deepEqual(ids, [supersededItem.evidenceId, currentItem.evidenceId].sort());
  });
});

test('superseded-as-current rejection then a correct bounded repair: the first draft wrongly presents the SUPERSEDED chunk as a current fact, one repair fixes it, never more than one repair', async () => {
  const envelope = buildInfyEnvelope();
  const supersededItem = envelope.items.find((i) => i.temporalStatus === 'SUPERSEDED');
  const currentItem = envelope.items.find((i) => i.temporalStatus === 'CURRENT');
  let call = 0;
  await withParseClient(async () => {
    call += 1;
    if (call === 1) {
      return {
        choices: [{
          message: {
            parsed: {
              answer: `INFY's operating margin guidance for FY2023 is 21%-23% [${supersededItem.evidenceId}].`,
              claims: [{
                claimId: 'C1', text: 'INFY operating margin guidance for FY2023 is 21%-23%.', claimType: 'historical_fact', evidenceIds: [supersededItem.evidenceId], relationshipId: null,
              }],
              groundingStatus: 'grounded',
              coverage: { requestedSymbol: 'INFY', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [] },
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
            answer: `INFY's current operating margin guidance for FY2023 is 21%-22% [${currentItem.evidenceId}].`,
            claims: [{
              claimId: 'C1', text: 'INFY current operating margin guidance for FY2023 is 21%-22%.', claimType: 'historical_fact', evidenceIds: [currentItem.evidenceId], relationshipId: null,
            }],
            groundingStatus: 'grounded',
            coverage: { requestedSymbol: 'INFY', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [] },
          },
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }, async () => {
    let s = baseState(envelope);
    s = { ...s, ...(await composeAnswer(s)) };
    let validateUpdate = await validateFinalAnswer(s);
    assert.equal(validateUpdate.validationStatus, 'REPAIR_REQUIRED');
    assert.ok(validateUpdate.validationIssues[0].includes('SUPERSEDED_AS_CURRENT'));
    s = { ...s, ...validateUpdate };

    const repairUpdate = await repairAnswer(s);
    assert.equal(repairUpdate.repairCount, 1);
    s = { ...s, ...repairUpdate };

    validateUpdate = await validateFinalAnswer(s);
    assert.equal(validateUpdate.validationStatus, 'PASSED');
    s = { ...s, ...validateUpdate };

    const publishUpdate = await publishFinalAnswer(s);
    assert.equal(publishUpdate.citations[0].evidenceId, currentItem.evidenceId);
    assert.equal(publishUpdate.citations[0].temporalStatus, 'CURRENT');
  });
});

test('failed repair (still presents superseded as current) falls to honest abstention, never publishing the unverified claim', async () => {
  const envelope = buildInfyEnvelope();
  const supersededItem = envelope.items.find((i) => i.temporalStatus === 'SUPERSEDED');
  await withParseClient(async () => ({
    choices: [{
      message: {
        parsed: {
          answer: `INFY's operating margin guidance for FY2023 is 21%-23% [${supersededItem.evidenceId}].`,
          claims: [{
            claimId: 'C1', text: 'INFY operating margin guidance for FY2023 is 21%-23%.', claimType: 'historical_fact', evidenceIds: [supersededItem.evidenceId], relationshipId: null,
          }],
          groundingStatus: 'grounded',
          coverage: { requestedSymbol: 'INFY', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [] },
        },
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), async () => {
    let s = baseState(envelope);
    s = { ...s, ...(await composeAnswer(s)) };
    let validateUpdate = await validateFinalAnswer(s);
    s = { ...s, ...validateUpdate };
    const repairUpdate = await repairAnswer(s); // mock always returns the same bad claim
    s = { ...s, ...repairUpdate };
    validateUpdate = await validateFinalAnswer(s);
    assert.equal(validateUpdate.validationStatus, 'REPAIR_REQUIRED');
    assert.equal(s.repairCount, 1);
    s = { ...s, ...validateUpdate };

    const fallback = await buildSafeFallback(s);
    assert.equal(fallback.groundingStatus, 'insufficient_evidence');
    assert.deepEqual(fallback.citations, []);
  });
});

test('undisclosed-conflict rejection: a CONFLICTING evidence pair with no explicit disclosure fails verification', async () => {
  // Two same-date, differing-value document chunks for the same scope --
  // detectRelationships flags them CONFLICTING (no reliable ordering).
  const docEnvelope = buildResearchEvidenceEnvelope([
    {
      chunkId: 'doc-a', symbol: 'INFY', registryDocumentId: 'reg-a', documentType: 'EARNINGS_CALL_TRANSCRIPT', title: 'Call A',
      fiscalYear: 'FY2023', fiscalQuarter: null, publishedAt: '2023-01-01T00:00:00.000Z', sourceUrl: 'https://example.com/a.pdf',
      pageStart: 1, pageEnd: 1, text: 'Operating margin guidance of 21%-23% for FY2023.', sourceAuthority: 'EARNINGS_CALL_TRANSCRIPT', score: 5,
    },
    {
      chunkId: 'doc-b', symbol: 'INFY', registryDocumentId: 'reg-b', documentType: 'PRESS_RELEASE', title: 'Release B',
      fiscalYear: 'FY2023', fiscalQuarter: null, publishedAt: '2023-01-01T00:00:00.000Z', sourceUrl: 'https://example.com/b.pdf',
      pageStart: 1, pageEnd: 1, text: 'Operating margin guidance of 18%-20% for FY2023.', sourceAuthority: 'PRESS_RELEASE', score: 4,
    },
  ]);
  const reconciled = reconcileEvidenceEnvelope(docEnvelope);
  const conflictingItem = reconciled.items.find((i) => i.temporalStatus === 'CONFLICTING');
  assert.ok(conflictingItem, 'expected the two differing same-date sources to be flagged CONFLICTING');

  await withParseClient(async () => ({
    choices: [{
      message: {
        parsed: {
          answer: `INFY's operating margin guidance for FY2023 is 21%-23% [${conflictingItem.evidenceId}].`,
          claims: [{
            claimId: 'C1', text: 'INFY operating margin guidance for FY2023 is 21%-23%.', claimType: 'historical_fact', evidenceIds: [conflictingItem.evidenceId], relationshipId: null,
          }],
          groundingStatus: 'grounded',
          coverage: { requestedSymbol: 'INFY', requestedPeriod: 'FY2023', evidenceCount: 2, limitations: [] },
        },
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), async () => {
    const s0 = baseState({ items: reconciled.items, relationships: reconciled.relationships });
    const s1 = { ...s0, ...(await composeAnswer(s0)) };
    const validateUpdate = await validateFinalAnswer(s1);
    assert.equal(validateUpdate.validationStatus, 'REPAIR_REQUIRED');
    assert.ok(validateUpdate.validationIssues[0].includes('UNDISCLOSED_CONFLICT'));
  });
});
