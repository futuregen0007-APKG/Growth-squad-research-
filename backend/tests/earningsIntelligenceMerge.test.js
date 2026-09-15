import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEarningsIntelligenceEnvelopeItems, mergeEarningsIntelligenceEvidence, buildResearchEvidenceEnvelope } from '../services/EvidenceEnvelope.js';
import { executeTools } from '../graph/nodes/executeTools.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';

/**
 * earningsIntelligenceMerge.test.js
 * =====================================
 * Phase 4C Part 5/6: Earnings Intelligence's own structured promise/
 * outcome evidence, normalized into the SAME trusted envelope retrieved
 * document chunks use, so a grounded turn that merges both sources still
 * produces exactly ONE combined answer (never two to reconcile).
 */

const timelineFixture = () => ({
  company: 'TCS',
  summary: { totalPromises: 2, verified: 1, missed: 0, pending: 1, insufficientEvidence: 0 },
  promises: [
    {
      id: 'promise-1',
      statement: 'TCS targets 12-14% revenue growth in FY2024',
      period: 'FY2024',
      status: 'PENDING',
      evidence: {
        sourceName: 'Earnings Call', sourceUrl: 'https://example.com/call.pdf', documentTitle: 'TCS FY2024 Earnings Call', publicationDate: '2023-07-01T00:00:00.000Z', page: 5, excerpt: 'We are targeting 12-14% revenue growth in FY2024.',
      },
      outcome: { sourceUrl: null, excerpt: null },
    },
    {
      id: 'promise-2',
      statement: 'TCS targets 25% operating margin in FY2023',
      period: 'FY2023',
      status: 'FULFILLED',
      evidence: {
        sourceName: 'Annual Report', sourceUrl: 'https://example.com/annual.pdf', documentTitle: 'TCS FY2023 Annual Report', publicationDate: '2022-05-01T00:00:00.000Z', page: 8, excerpt: 'We target a 25% operating margin for FY2023.',
      },
      outcome: {
        actualPeriod: 'FY2023', sourceUrl: 'https://example.com/outcome.pdf', sourceDate: '2023-05-01T00:00:00.000Z', excerpt: 'TCS delivered a 25.3% operating margin in FY2023.', provider: 'document-research',
      },
    },
    {
      id: 'promise-3-no-provenance',
      statement: 'An unverifiable promise with no real source',
      period: 'FY2023',
      status: 'PENDING',
      evidence: { sourceUrl: null, excerpt: null },
      outcome: { sourceUrl: null, excerpt: null },
    },
  ],
});

test('buildEarningsIntelligenceEnvelopeItems builds a MANAGEMENT_PROMISE record for a pending promise, no PROMISE_OUTCOME yet', () => {
  const items = buildEarningsIntelligenceEnvelopeItems(timelineFixture(), { symbol: 'TCS', companyName: 'Tata Consultancy Services' });
  const promise1Items = items.filter((i) => i.chunkId.includes('promise-1'));
  assert.equal(promise1Items.length, 1);
  assert.equal(promise1Items[0].documentType, 'MANAGEMENT_PROMISE');
  assert.equal(promise1Items[0].fiscalYear, 'FY2024');
  assert.equal(promise1Items[0].sourceUrl, 'https://example.com/call.pdf');
});

test('buildEarningsIntelligenceEnvelopeItems builds BOTH guidance and outcome records for an evaluated, provenanced promise', () => {
  const items = buildEarningsIntelligenceEnvelopeItems(timelineFixture(), { symbol: 'TCS', companyName: 'Tata Consultancy Services' });
  const promise2Items = items.filter((i) => i.chunkId.includes('promise-2'));
  assert.equal(promise2Items.length, 2);
  const guidance = promise2Items.find((i) => i.documentType === 'MANAGEMENT_PROMISE');
  const outcome = promise2Items.find((i) => i.documentType === 'PROMISE_OUTCOME');
  assert.ok(guidance && outcome);
  assert.match(guidance.text, /25% operating margin/);
  assert.match(outcome.text, /25\.3% operating margin/);
  assert.equal(outcome.sourceUrl, 'https://example.com/outcome.pdf');
});

test('a promise with no real source/excerpt is never fabricated into an envelope item', () => {
  const items = buildEarningsIntelligenceEnvelopeItems(timelineFixture(), { symbol: 'TCS' });
  assert.ok(!items.some((i) => i.chunkId.includes('promise-3')));
});

test('mergeEarningsIntelligenceEvidence continues the SAME "E1"/"E2" numbering after the document envelope, honestly labeled with its own retrievalMode', () => {
  const docEnvelope = buildResearchEvidenceEnvelope([{
    chunkId: 'doc-1', symbol: 'TCS', registryDocumentId: 'reg-1', documentType: 'ANNUAL_REPORT', title: 'Doc', fiscalYear: 'FY2023', sourceUrl: 'https://example.com/doc.pdf', pageStart: 1, pageEnd: 1, text: 'Some document text.', score: 5,
  }], { retrievalMode: 'LOCAL_HYBRID_RERANK' });
  assert.equal(docEnvelope.items[0].evidenceId, 'E1');

  const merged = mergeEarningsIntelligenceEvidence(docEnvelope, timelineFixture(), { symbol: 'TCS', companyName: 'Tata Consultancy Services' });
  assert.ok(merged.items.length > docEnvelope.items.length);
  assert.equal(merged.items[0].evidenceId, 'E1');
  assert.equal(merged.items[0].retrievalMode, 'LOCAL_HYBRID_RERANK');
  const mergedItem = merged.items[merged.items.length - 1];
  assert.equal(mergedItem.evidenceId, `E${merged.items.length}`);
  assert.equal(mergedItem.retrievalMode, 'EARNINGS_INTELLIGENCE_MERGE', 'a merged item must never claim to be a vector/hybrid-retrieved document chunk');
});

test('mergeEarningsIntelligenceEvidence caps how many promise records it appends, never crowding out document evidence', () => {
  const bigTimeline = { promises: Array.from({ length: 10 }, (_, i) => ({
    id: `p${i}`, statement: `Promise ${i}`, period: 'FY2023', status: 'PENDING',
    evidence: { sourceUrl: `https://example.com/${i}.pdf`, excerpt: `Excerpt ${i}` },
    outcome: { sourceUrl: null, excerpt: null },
  })) };
  const docEnvelope = { items: [] };
  const merged = mergeEarningsIntelligenceEvidence(docEnvelope, bigTimeline, { symbol: 'TCS' });
  assert.ok(merged.items.length <= 3, 'merged Earnings Intelligence items must respect their own cap');
});

test('an empty/no-promise timeline merges nothing and returns the envelope unchanged', () => {
  const docEnvelope = { items: [{ evidenceId: 'E1', chunkId: 'doc-1' }] };
  const merged = mergeEarningsIntelligenceEvidence(docEnvelope, { promises: [] }, { symbol: 'TCS' });
  assert.deepEqual(merged.items, docEnvelope.items);
});

// ---------------------------------------------------------------------------
// executeTools.js integration: verifies the ACTUAL wiring merges Earnings
// Intelligence data into state.researchEvidence only when BOTH tools were
// planned for the SAME grounded turn (the shape planTools.js's
// groundedResearchPlan produces for a MANAGEMENT_GUIDANCE/REVISED_GUIDANCE/
// PROMISE_VS_OUTCOME question) -- never for a plain EARNINGS_INTELLIGENCE
// turn with no grounded retrieval step at all.
// ---------------------------------------------------------------------------
const makeState = (toolPlan, overrides = {}) => ({
  errors: [], toolPlan, userId: 'user-1', onEvent: null, ...overrides,
});

test('executeTools merges Earnings Intelligence evidence into researchEvidence when BOTH tools were planned', async () => {
  const originalGrounded = TOOL_REGISTRY.retrieveGroundedEvidence;
  const originalEarnings = TOOL_REGISTRY.getEarningsTimeline;
  TOOL_REGISTRY.retrieveGroundedEvidence = async () => ({
    tool: 'retrieveGroundedEvidence', status: 'SUCCESS', data: null, evidence: [], resultCount: 1, evidenceCount: 0, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
    researchEvidence: [{
      evidenceId: 'E1', symbol: 'TCS', chunkId: 'doc-1', documentType: 'ANNUAL_REPORT', text: 'Document text.', retrievalRank: 1, retrievalMode: 'LOCAL_HYBRID_RERANK',
    }],
    retrievalMode: 'LOCAL_HYBRID_RERANK',
  });
  TOOL_REGISTRY.getEarningsTimeline = async () => ({
    tool: 'getEarningsTimeline', status: 'SUCCESS', data: timelineFixture(), evidence: [{ evidenceId: 'legacy-1' }], resultCount: 3, evidenceCount: 1, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
  });
  try {
    const result = await executeTools(makeState([
      { tool: 'retrieveGroundedEvidence', args: { symbol: 'TCS' } },
      { tool: 'getEarningsTimeline', args: { symbol: 'TCS' } },
    ]));
    assert.ok(result.researchEvidence.length > 1, 'Earnings Intelligence items must be appended to researchEvidence');
    assert.equal(result.researchEvidence[0].evidenceId, 'E1');
    assert.equal(result.researchEvidence[0].chunkId, 'doc-1');
    assert.ok(result.researchEvidence.some((item) => item.retrievalMode === 'EARNINGS_INTELLIGENCE_MERGE'));
    // The legacy `evidence` array (Phase 1-3's own pipeline) is completely
    // unaffected -- it still only ever contains what each tool's OWN
    // `evidence` field returned, never the merged research envelope.
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].evidenceId, 'legacy-1');
  } finally {
    TOOL_REGISTRY.retrieveGroundedEvidence = originalGrounded;
    TOOL_REGISTRY.getEarningsTimeline = originalEarnings;
  }
});

test('executeTools never merges Earnings Intelligence data when retrieveGroundedEvidence was NOT planned (a plain Earnings Intelligence turn stays exactly as before)', async () => {
  const originalEarnings = TOOL_REGISTRY.getEarningsTimeline;
  TOOL_REGISTRY.getEarningsTimeline = async () => ({
    tool: 'getEarningsTimeline', status: 'SUCCESS', data: timelineFixture(), evidence: [{ evidenceId: 'legacy-1' }], resultCount: 3, evidenceCount: 1, errorCode: null, fetchedAt: new Date().toISOString(), warning: null,
  });
  try {
    const result = await executeTools(makeState([{ tool: 'getEarningsTimeline', args: { symbol: 'TCS' } }]));
    assert.deepEqual(result.researchEvidence, []);
    assert.equal(result.retrievalMode, null);
  } finally {
    TOOL_REGISTRY.getEarningsTimeline = originalEarnings;
  }
});
