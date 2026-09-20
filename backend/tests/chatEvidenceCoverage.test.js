import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEvidenceCoverage, EVIDENCE_COVERAGE_STATUS, formatMissingEvidenceForPrompt } from '../graph/evidenceCoverage.js';

const evidenceRecord = (overrides = {}) => ({ claimType: 'LIVE_PRICE', symbol: 'TCS', ...overrides });

test('a requested dimension with matching evidence is COVERED', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: ['TCS'], requestedDimensions: ['PRICE'],
    toolResults: [{ tool: 'getLiveQuote', symbol: 'TCS', status: 'SUCCESS' }],
    evidence: [evidenceRecord({ claimType: 'LIVE_PRICE', symbol: 'TCS' })],
  });
  assert.deepEqual(evidenceCoverage, [{ symbol: 'TCS', dimension: 'PRICE', status: EVIDENCE_COVERAGE_STATUS.COVERED }]);
});

test('the confirmed Phase 0/1 scenario: TCS+INFY with FINANCIALS/GUIDANCE/NEWS resolves a full 2x3 matrix', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: ['TCS', 'INFY'],
    requestedDimensions: ['FINANCIALS', 'GUIDANCE', 'NEWS'],
    toolResults: [{
      tool: 'compareStocks', status: 'SUCCESS',
      data: [
        { symbol: 'TCS', dimensions: { FINANCIALS: { status: 'SUCCESS' }, GUIDANCE: { status: 'EMPTY' }, NEWS: { status: 'SUCCESS' } } },
        { symbol: 'INFY', dimensions: { FINANCIALS: { status: 'SUCCESS' }, GUIDANCE: { status: 'SUCCESS' }, NEWS: { status: 'UNAVAILABLE' } } },
      ],
    }],
    evidence: [
      evidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS' }),
      evidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS' }),
      evidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'INFY' }),
      evidenceRecord({ claimType: 'PROMISE_OUTCOME', symbol: 'INFY' }),
    ],
  });
  assert.equal(evidenceCoverage.length, 6);
  const byKey = Object.fromEntries(evidenceCoverage.map((r) => [`${r.symbol}:${r.dimension}`, r.status]));
  assert.equal(byKey['TCS:FINANCIALS'], EVIDENCE_COVERAGE_STATUS.COVERED);
  assert.equal(byKey['TCS:NEWS'], EVIDENCE_COVERAGE_STATUS.COVERED);
  assert.equal(byKey['TCS:GUIDANCE'], EVIDENCE_COVERAGE_STATUS.EMPTY, 'TCS guidance came back EMPTY and has no evidence');
  assert.equal(byKey['INFY:FINANCIALS'], EVIDENCE_COVERAGE_STATUS.COVERED);
  assert.equal(byKey['INFY:GUIDANCE'], EVIDENCE_COVERAGE_STATUS.COVERED);
  assert.equal(byKey['INFY:NEWS'], EVIDENCE_COVERAGE_STATUS.UNAVAILABLE, 'INFY news attempt failed (UNAVAILABLE), no evidence');
});

test('a dimension with zero attempts at all (never even planned) is reported EMPTY, not silently omitted -- the actionable case for a replan', () => {
  const { evidenceCoverage, missingEvidence } = computeEvidenceCoverage({
    symbols: ['HAL'], requestedDimensions: ['NEWS'], toolResults: [], evidence: [],
  });
  assert.deepEqual(evidenceCoverage, [{ symbol: 'HAL', dimension: 'NEWS', status: EVIDENCE_COVERAGE_STATUS.EMPTY }]);
  assert.equal(missingEvidence.length, 1);
});

test('an UNSUPPORTED tool outcome is reported as UNSUPPORTED, never conflated with EMPTY/UNAVAILABLE', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: ['HAL'], requestedDimensions: ['DOCUMENTS'],
    toolResults: [{ tool: 'searchResearchDocuments', symbol: 'HAL', status: 'UNSUPPORTED' }],
    evidence: [],
  });
  assert.equal(evidenceCoverage[0].status, EVIDENCE_COVERAGE_STATUS.UNSUPPORTED);
});

test('PORTFOLIO/WATCHLIST are account-scoped (symbol: null), never duplicated per mentioned company symbol', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: ['TCS', 'INFY'], requestedDimensions: ['PORTFOLIO'], userId: 'user-1',
    toolResults: [{ tool: 'getPortfolio', status: 'SUCCESS' }],
    evidence: [{ claimType: 'PORTFOLIO_DATA', symbol: null }],
  });
  assert.deepEqual(evidenceCoverage, [{ symbol: null, dimension: 'PORTFOLIO', status: EVIDENCE_COVERAGE_STATUS.COVERED }]);
});

test('PORTFOLIO/WATCHLIST without a signed-in user is AUTH_REQUIRED, never attempted', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: [], requestedDimensions: ['WATCHLIST'], userId: null, toolResults: [], evidence: [],
  });
  assert.deepEqual(evidenceCoverage, [{ symbol: null, dimension: 'WATCHLIST', status: EVIDENCE_COVERAGE_STATUS.AUTH_REQUIRED }]);
});

test('GENERAL is never materialized in the matrix -- it names no specific data type to check', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: [], requestedDimensions: ['GENERAL'], toolResults: [], evidence: [],
  });
  assert.deepEqual(evidenceCoverage, []);
});

test('a dimension never requested is absent from the matrix entirely (not materialized as NOT_REQUESTED)', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: ['TCS'], requestedDimensions: ['PRICE'], toolResults: [], evidence: [],
  });
  assert.equal(evidenceCoverage.every((r) => r.dimension === 'PRICE'), true);
});

test('missingEvidence contains every row that is not COVERED, and only those', () => {
  const { evidenceCoverage, missingEvidence } = computeEvidenceCoverage({
    symbols: ['TCS'], requestedDimensions: ['PRICE', 'NEWS'],
    toolResults: [{ tool: 'getLiveQuote', symbol: 'TCS', status: 'SUCCESS' }],
    evidence: [evidenceRecord({ claimType: 'LIVE_PRICE', symbol: 'TCS' })],
  });
  assert.equal(evidenceCoverage.length, 2);
  assert.deepEqual(missingEvidence, [{ symbol: 'TCS', dimension: 'NEWS', status: EVIDENCE_COVERAGE_STATUS.EMPTY }]);
});

test('formatMissingEvidenceForPrompt renders a plain-language, per-gap note the composer prompt can hand to the model', () => {
  const notes = formatMissingEvidenceForPrompt([
    { symbol: 'INFY', dimension: 'NEWS', status: EVIDENCE_COVERAGE_STATUS.UNAVAILABLE },
    { symbol: 'TCS', dimension: 'GUIDANCE', status: EVIDENCE_COVERAGE_STATUS.EMPTY },
    { symbol: null, dimension: 'WATCHLIST', status: EVIDENCE_COVERAGE_STATUS.AUTH_REQUIRED },
  ]);
  assert.equal(notes.length, 3);
  // Phase 6A: the UNAVAILABLE phrasing changed from "temporarily
  // unavailable" to "not available from any source this turn". The old
  // wording implied a retry would help, which was untrue for a company we
  // simply hold no data for. The test's intent - a plain-language, per-gap,
  // per-symbol note - is unchanged.
  assert.match(notes[0], /INFY.*news.*not available/i);
  assert.equal(/temporar/i.test(notes[0]), false, 'never promise the gap is temporary');
  assert.match(notes[1], /TCS.*guidance.*no data/i);
  assert.match(notes[2], /watchlist.*signed in/i);
});

test('formatMissingEvidenceForPrompt returns an empty list for full coverage', () => {
  assert.deepEqual(formatMissingEvidenceForPrompt([]), []);
});

test('a direct (non-compareStocks) tool result is matched to its symbol correctly', () => {
  const { evidenceCoverage } = computeEvidenceCoverage({
    symbols: ['HAL', 'BEL'], requestedDimensions: ['PRICE'],
    toolResults: [
      { tool: 'getLiveQuote', symbol: 'HAL', status: 'SUCCESS' },
      { tool: 'getLiveQuote', symbol: 'BEL', status: 'UNAVAILABLE' },
    ],
    evidence: [evidenceRecord({ claimType: 'LIVE_PRICE', symbol: 'HAL' })],
  });
  const byKey = Object.fromEntries(evidenceCoverage.map((r) => [r.symbol, r.status]));
  assert.equal(byKey.HAL, EVIDENCE_COVERAGE_STATUS.COVERED);
  assert.equal(byKey.BEL, EVIDENCE_COVERAGE_STATUS.UNAVAILABLE);
});
