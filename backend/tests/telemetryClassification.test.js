import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOperationalError, OPERATIONAL_ERROR_CATEGORIES } from '../services/telemetry/errorTaxonomy.js';
import { classifyCompletionStatus, isResearchTurn, buildTurnMetrics } from '../services/telemetry/turnClassification.js';
import { SAFE_REASONS } from '../graph/safeReasons.js';

/**
 * Phase 5A Part 6/7 tests. The invariant: an operational category is
 * derived from signals the graph ALREADY produced, and each genuinely
 * different failure keeps its own identity -- a client hanging up is never
 * an application crash, a provider outage is never "insufficient
 * evidence," and an honest no-evidence answer is never an error.
 */

test('an honest, successful turn is classified as NONE -- never as an error', () => {
  assert.equal(classifyOperationalError({ groundingStatus: 'grounded', validationStatus: 'PASSED' }), 'NONE');
  assert.equal(classifyOperationalError({}), 'NONE');
});

test('an honest zero-evidence answer is EVIDENCE_INSUFFICIENT, not a crash', () => {
  const category = classifyOperationalError({ groundingStatus: 'insufficient_evidence', errors: [] });
  assert.equal(category, 'EVIDENCE_INSUFFICIENT');
});

test('a client that hangs up is CLIENT_ABORTED, whatever else was mid-flight', () => {
  assert.equal(classifyOperationalError({ aborted: () => true, errors: ['boom'] }), 'CLIENT_ABORTED');
  assert.equal(classifyOperationalError({ aborted: true, errors: ['boom'] }), 'CLIENT_ABORTED', 'a plain boolean works as well as a function');
  assert.equal(
    classifyOperationalError({ aborted: () => true, llmCalls: [{ timedOut: true }], validationStatus: 'FAILED_SAFE' }),
    'CLIENT_ABORTED',
    'cancellation outranks every downstream symptom it caused',
  );
});

test('the server exhausting its own deadline is distinct from the client hanging up', () => {
  assert.equal(classifyOperationalError({ llmCalls: [{ skipped: 'SKIPPED_NO_BUDGET' }] }), 'REQUEST_DEADLINE_EXCEEDED');
  assert.equal(classifyOperationalError({ toolResults: [{ tool: 'getStockQuote', errorCode: 'DEADLINE_EXCEEDED' }] }), 'REQUEST_DEADLINE_EXCEEDED');
});

test('a turn that ran out of budget but still produced a PASSED answer is not reported as a deadline failure', () => {
  const category = classifyOperationalError({ llmCalls: [{ skipped: 'SKIPPED_NO_BUDGET' }], validationStatus: 'PASSED' });
  assert.equal(category, 'NONE', 'degrading gracefully within budget is a success, not a failure');
});

test('an ambiguous company is a scope outcome -- never an LLM or retrieval failure', () => {
  const category = classifyOperationalError({
    scopeSignal: { ambiguousCompany: true },
    llmCalls: [{ timedOut: true }],
  });
  assert.equal(category, 'AMBIGUOUS_COMPANY');
});

test('a period mismatch comes from the deterministic verifier verdict, not from re-parsing text', () => {
  assert.equal(
    classifyOperationalError({ groundedClaims: [{ reasonCode: 'EVIDENCE_FISCAL_YEAR_MISMATCH' }] }),
    'UNSUPPORTED_PERIOD',
  );
  assert.equal(
    classifyOperationalError({ groundedClaims: [{ reasonCode: 'QUARTERLY_VS_ANNUAL_OR_WRONG_QUARTER' }] }),
    'UNSUPPORTED_PERIOD',
  );
});

test('a company the tools could not resolve is UNSUPPORTED_SYMBOL', () => {
  const category = classifyOperationalError({
    toolResults: [{ tool: 'getEarningsTimeline', warning: SAFE_REASONS.COMPANY_NOT_RESOLVED }],
  });
  assert.equal(category, 'UNSUPPORTED_SYMBOL');
});

test('an LLM timeout is never reported as insufficient evidence', () => {
  const category = classifyOperationalError({
    llmCalls: [{ timedOut: true }],
    groundingStatus: 'insufficient_evidence',
  });
  assert.equal(category, 'LLM_TIMEOUT', 'a provider outage must not masquerade as an honest evidence gap');
});

test('a rate limit is kept distinct from a generic provider failure', () => {
  assert.equal(classifyOperationalError({ toolResults: [{ tool: 'getStockQuote', errorCode: 'RATE_LIMITED' }] }), 'LLM_RATE_LIMITED');
  assert.equal(classifyOperationalError({ llmCalls: [{ error: 'PROVIDER_ERROR' }] }), 'LLM_PROVIDER_FAILURE');
});

test('a rate-limited RETRIEVAL tool is a retrieval failure, not an LLM rate limit', () => {
  const category = classifyOperationalError({
    toolResults: [{ tool: 'retrieveGroundedEvidence', errorCode: 'RATE_LIMITED' }],
  });
  assert.equal(category, 'RETRIEVAL_FAILURE', 'the retrieval layer keeps its own identity when it is the layer that failed');
});

test('retrieval timeout and retrieval failure are distinct categories, never conflated', () => {
  assert.equal(classifyOperationalError({ toolResults: [{ tool: 'retrieveGroundedEvidence', errorCode: 'TIMEOUT' }] }), 'RETRIEVAL_TIMEOUT');
  assert.equal(classifyOperationalError({ toolResults: [{ tool: 'retrieveGroundedEvidence', errorCode: 'CANCELLED' }] }), 'RETRIEVAL_TIMEOUT');
  assert.equal(classifyOperationalError({ toolResults: [{ tool: 'retrieveGroundedEvidence', errorCode: 'UPSTREAM_UNAVAILABLE' }] }), 'RETRIEVAL_FAILURE');
  assert.equal(classifyOperationalError({ toolResults: [{ tool: 'getEarningsTimeline', errorCode: 'NETWORK_ERROR' }] }), 'RETRIEVAL_FAILURE');
});

test('a retrieval tool that simply succeeded produces no retrieval category', () => {
  const category = classifyOperationalError({ toolResults: [{ tool: 'retrieveGroundedEvidence', toolStatus: 'OK' }] });
  assert.equal(category, 'NONE');
});

test('an exhausted repair and a failed-safe verification are distinct outcomes', () => {
  assert.equal(classifyOperationalError({ repairAttempted: true, validationStatus: 'REPAIR_REQUIRED' }), 'REPAIR_FAILED');
  assert.equal(classifyOperationalError({ validationStatus: 'FAILED_SAFE' }), 'VERIFICATION_FAILED');
  assert.equal(classifyOperationalError({ repairAttempted: true, validationStatus: 'PASSED' }), 'NONE', 'a repair that worked is not a failure');
});

test('INTERNAL_ERROR is the last resort -- only for an unexplained failure with no other signal', () => {
  assert.equal(classifyOperationalError({ errors: ['something unexpected'] }), 'INTERNAL_ERROR');
  assert.equal(
    classifyOperationalError({ errors: ['something unexpected'], groundingStatus: 'insufficient_evidence' }),
    'EVIDENCE_INSUFFICIENT',
    'a known, explainable outcome is never downgraded to a generic crash',
  );
});

test('every category the classifier can return is declared in the published vocabulary', () => {
  const states = [
    {}, { aborted: () => true }, { llmCalls: [{ skipped: 'SKIPPED_NO_BUDGET' }] }, { scopeSignal: { ambiguousCompany: true } },
    { groundedClaims: [{ reasonCode: 'EVIDENCE_FISCAL_YEAR_MISMATCH' }] },
    { toolResults: [{ tool: 'getEarningsTimeline', warning: SAFE_REASONS.COMPANY_NOT_RESOLVED }] },
    { llmCalls: [{ timedOut: true }] }, { toolResults: [{ tool: 'getStockQuote', errorCode: 'RATE_LIMITED' }] },
    { llmCalls: [{ error: 'PROVIDER_ERROR' }] }, { toolResults: [{ tool: 'retrieveGroundedEvidence', errorCode: 'TIMEOUT' }] },
    { toolResults: [{ tool: 'retrieveGroundedEvidence', errorCode: 'UPSTREAM_ERROR' }] },
    { repairAttempted: true, validationStatus: 'REPAIR_REQUIRED' }, { validationStatus: 'FAILED_SAFE' },
    { groundingStatus: 'insufficient_evidence' }, { errors: ['x'] },
  ];
  for (const state of states) {
    assert.equal(OPERATIONAL_ERROR_CATEGORIES.includes(classifyOperationalError(state)), true);
  }
  assert.equal(Object.isFrozen(OPERATIONAL_ERROR_CATEGORIES), true);
});

test('classifyOperationalError tolerates a completely empty/partial state without throwing', () => {
  assert.doesNotThrow(() => classifyOperationalError());
  assert.doesNotThrow(() => classifyOperationalError({ toolResults: null, llmCalls: null, groundedClaims: null, errors: null }));
});

test('completion status prefers the graph grounding verdict, then falls back through real signals', () => {
  assert.equal(classifyCompletionStatus({ groundingStatus: 'grounded' }), 'grounded');
  assert.equal(classifyCompletionStatus({ groundingStatus: 'partially_grounded' }), 'partially_grounded');
  assert.equal(classifyCompletionStatus({ validationStatus: 'FAILED_SAFE' }), 'failed');
  assert.equal(classifyCompletionStatus({ intent: 'UNSUPPORTED' }), 'unsupported');
  assert.equal(classifyCompletionStatus({ scopeSignal: { ambiguousCompany: true } }), 'refused');
});

test('an ordinary non-research answer has no completion bucket at all, rather than a made-up one', () => {
  assert.equal(classifyCompletionStatus({ intent: 'GENERAL_EDUCATION', validationStatus: 'PASSED' }), null);
});

test('a research turn is identified by needing the corpus or by having a grounding verdict', () => {
  assert.equal(isResearchTurn({ scopeSignal: { needsResearchCorpus: true } }), true);
  assert.equal(isResearchTurn({ groundingStatus: 'grounded' }), true);
  assert.equal(isResearchTurn({ intent: 'GENERAL_EDUCATION' }), false);
});

test('buildTurnMetrics reads only already-computed graph fields into bounded labels and counts', () => {
  const metrics = buildTurnMetrics({
    groundingStatus: 'grounded',
    validationStatus: 'PASSED',
    retrievalMode: 'hybrid',
    scopeSignal: { needsResearchCorpus: true, ambiguousCompany: false, symbol: 'TCS', researchQuestionType: 'MANAGEMENT_GUIDANCE' },
    citations: [{ id: 'E1' }, { id: 'E2' }],
    researchEvidence: [{ id: 'E1' }, { id: 'E2' }, { id: 'E3' }],
    groundedClaims: [
      { verificationStatus: 'VERIFIED' },
      { verificationStatus: 'VERIFIED' },
      { verificationStatus: 'REJECTED' },
    ],
    repairAttempted: true,
  });

  assert.equal(metrics.completionStatus, 'grounded');
  assert.equal(metrics.errorCategory, 'NONE');
  assert.equal(metrics.isResearch, true);
  assert.equal(metrics.citationCount, 2);
  assert.equal(metrics.evidenceCount, 3);
  assert.equal(metrics.verifiedClaimCount, 2);
  assert.equal(metrics.rejectedClaimCount, 1);
  assert.equal(metrics.retrievalMode, 'hybrid');
  assert.equal(metrics.repairAttempted, true);
  assert.equal(metrics.repairSucceeded, true, 'a repaired answer that then PASSED is a successful repair');
  assert.equal(metrics.ambiguousCompany, false);
});

test('buildTurnMetrics never invents a repair that did not happen', () => {
  const metrics = buildTurnMetrics({ groundingStatus: 'grounded', validationStatus: 'PASSED' });
  assert.equal(metrics.repairAttempted, false);
  assert.equal(metrics.repairSucceeded, false);
});

test('a repair that ran but never reached PASSED is recorded as attempted and unsuccessful', () => {
  const metrics = buildTurnMetrics({ repairCount: 1, validationStatus: 'REPAIR_REQUIRED', repairAttempted: true });
  assert.equal(metrics.repairAttempted, true);
  assert.equal(metrics.repairSucceeded, false);
  assert.equal(metrics.errorCategory, 'REPAIR_FAILED');
});

test('buildTurnMetrics carries no free text -- only bounded labels and numbers', () => {
  const metrics = buildTurnMetrics({
    groundingStatus: 'grounded',
    messages: [{ content: 'a real user question that must never reach telemetry' }],
    draftAnswer: 'a full model answer that must never reach telemetry',
    researchEvidence: [{ chunkText: 'a verbatim filing paragraph' }],
  });
  const serialized = JSON.stringify(metrics);
  assert.equal(serialized.includes('must never reach telemetry'), false);
  assert.equal(serialized.includes('verbatim filing paragraph'), false);
  assert.equal(metrics.evidenceCount, 1, 'only the COUNT of evidence survives, never its content');
});

test('buildTurnMetrics tolerates an empty state without throwing', () => {
  assert.doesNotThrow(() => buildTurnMetrics());
  const metrics = buildTurnMetrics({});
  assert.equal(metrics.citationCount, 0);
  assert.equal(metrics.evidenceCount, 0);
  assert.equal(metrics.completionStatus, null);
  assert.equal(metrics.errorCategory, 'NONE');
});
