import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDeterministicChecks, needsClaimVerifier, extractCitationIndexes, SAFE_VALIDATION_REASONS,
} from '../graph/claimValidation.js';

const evidenceItem = (overrides = {}) => ({
  evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS financials',
  excerpt: 'Revenue grew 12%', reportingPeriod: null, ...overrides,
});

// ---------------------------------------------------------------------------
// extractCitationIndexes
// ---------------------------------------------------------------------------
test('extractCitationIndexes splits valid vs out-of-range markers', () => {
  const { valid, outOfRange } = extractCitationIndexes('Revenue grew [1]. Also see [2] and [9].', 2);
  assert.deepEqual([...valid].sort(), [1, 2]);
  assert.deepEqual([...outOfRange], [9]);
});

// ---------------------------------------------------------------------------
// Required test 8 / 7: citation + uncited-claim checks
// ---------------------------------------------------------------------------
test('required test 7: an invalid citation index is rejected (CITATION_OUT_OF_RANGE)', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS revenue grew 12% [1] and margins improved [5].',
    evidence: [evidenceItem()],
    entities: { symbols: ['TCS'] },
    intent: 'COMPANY_RESEARCH',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.CITATION_OUT_OF_RANGE));
});

test('required test 8: an uncited financial claim (real evidence exists, but nothing is cited) is rejected', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS revenue grew 12% year over year.',
    evidence: [evidenceItem()],
    entities: { symbols: ['TCS'] },
    intent: 'COMPANY_RESEARCH',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.UNCITED_FACTUAL_CLAIM));
});

test('a properly cited numeric claim is never flagged as uncited', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS revenue grew 12% [1] year over year.',
    evidence: [evidenceItem()],
    entities: { symbols: ['TCS'] },
    intent: 'COMPANY_RESEARCH',
  });
  assert.ok(!issues.includes(SAFE_VALIDATION_REASONS.UNCITED_FACTUAL_CLAIM));
});

// ---------------------------------------------------------------------------
// Required test 1: no evidence -> abstention
// ---------------------------------------------------------------------------
test('required test 1: zero evidence with a factual-sounding draft is flagged (must force abstention/repair)', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'HAL was founded in 1940 and BEL focuses on defence electronics.',
    evidence: [],
    entities: { symbols: ['HAL', 'BEL'] },
    intent: 'STOCK_COMPARISON',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.ZERO_EVIDENCE_FACTUAL_CLAIM));
});

test('zero evidence with an already-honest abstention is NOT flagged', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: "I don't have data available for HAL or BEL right now.",
    evidence: [],
    entities: { symbols: ['HAL', 'BEL'] },
    intent: 'STOCK_COMPARISON',
  });
  assert.ok(!issues.includes(SAFE_VALIDATION_REASONS.ZERO_EVIDENCE_FACTUAL_CLAIM));
});

test('zero evidence is never flagged for GENERAL_EDUCATION (no citations required for ordinary educational statements)', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'A P/E ratio compares a company\'s share price to its earnings per share.',
    evidence: [],
    entities: {},
    intent: 'GENERAL_EDUCATION',
  });
  assert.deepEqual(issues, []);
});

// ---------------------------------------------------------------------------
// Required test 5: guidance cannot be presented as achieved
// ---------------------------------------------------------------------------
test('required test 5: guidance/promise language presented as achieved with no PROMISE_OUTCOME evidence is rejected', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS achieved its revenue growth guidance for FY2026 [1].',
    evidence: [evidenceItem({ claimType: 'MANAGEMENT_PROMISE' })],
    entities: { symbols: ['TCS'] },
    intent: 'EARNINGS_INTELLIGENCE',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.GUIDANCE_AS_ACHIEVED_WITHOUT_OUTCOME));
});

test('achievement language backed by a real PROMISE_OUTCOME record is not flagged', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS achieved its revenue growth guidance for FY2026 [1].',
    evidence: [evidenceItem({ claimType: 'PROMISE_OUTCOME' })],
    entities: { symbols: ['TCS'] },
    intent: 'EARNINGS_INTELLIGENCE',
  });
  assert.ok(!issues.includes(SAFE_VALIDATION_REASONS.GUIDANCE_AS_ACHIEVED_WITHOUT_OUTCOME));
});

// ---------------------------------------------------------------------------
// Dimension/claim-type mismatch: price/financials/news language without evidence
// ---------------------------------------------------------------------------
test('price-language with no LIVE_PRICE evidence is rejected (PRICE_WITHOUT_EVIDENCE)', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS is trading at ₹4,120 [1].',
    evidence: [evidenceItem({ claimType: 'COMPANY_NEWS' })],
    entities: { symbols: ['TCS'] },
    intent: 'LIVE_MARKET_DATA',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.PRICE_WITHOUT_EVIDENCE));
});

test('news-language with no COMPANY_NEWS evidence is rejected (NEWS_WITHOUT_EVIDENCE)', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'According to a recent news report, TCS won a major deal [1].',
    evidence: [evidenceItem({ claimType: 'FINANCIAL_DATA' })],
    entities: { symbols: ['TCS'] },
    intent: 'NEWS_RESEARCH',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.NEWS_WITHOUT_EVIDENCE));
});

// ---------------------------------------------------------------------------
// Evidence cited for a symbol never requested
// ---------------------------------------------------------------------------
test('citing an evidence item for a symbol never part of this request is rejected (CITED_EVIDENCE_SYMBOL_NOT_REQUESTED)', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS revenue grew 12% [1].',
    evidence: [evidenceItem({ symbol: 'RELIANCE' })],
    entities: { symbols: ['TCS'] },
    intent: 'COMPANY_RESEARCH',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.CITED_EVIDENCE_SYMBOL_NOT_REQUESTED));
});

test('citing evidence for a symbol that IS part of a multi-symbol request (e.g. a comparison) is never flagged', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS revenue grew 12% [1], while Infosys grew 8% [2].',
    evidence: [evidenceItem({ symbol: 'TCS' }), evidenceItem({ symbol: 'INFY', evidenceId: 'e2' })],
    entities: { symbols: ['TCS', 'INFY'] },
    intent: 'STOCK_COMPARISON',
  });
  assert.ok(!issues.includes(SAFE_VALIDATION_REASONS.CITED_EVIDENCE_SYMBOL_NOT_REQUESTED));
});

// ---------------------------------------------------------------------------
// Explicit period mismatch
// ---------------------------------------------------------------------------
test('required test 4 (deterministic half): citing evidence from a period other than the one explicitly requested is rejected', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS delivered these results [1].',
    evidence: [evidenceItem({ reportingPeriod: 'FY2024' })],
    entities: { symbols: ['TCS'], periods: ['FY2026'] },
    intent: 'EARNINGS_INTELLIGENCE',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.CITED_EVIDENCE_PERIOD_MISMATCH));
});

test('no period mismatch is flagged when the user never named a specific period', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS delivered these results [1].',
    evidence: [evidenceItem({ reportingPeriod: 'FY2024' })],
    entities: { symbols: ['TCS'], periods: [] },
    intent: 'EARNINGS_INTELLIGENCE',
  });
  assert.ok(!issues.includes(SAFE_VALIDATION_REASONS.CITED_EVIDENCE_PERIOD_MISMATCH));
});

// ---------------------------------------------------------------------------
// Pre-existing checks (guarantee / buy-sell / timestamp) still work post-refactor
// ---------------------------------------------------------------------------
test('guarantee-style language is always flagged, regardless of evidence', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS is guaranteed to double in value next year.',
    evidence: [], entities: {}, intent: 'GENERAL_EDUCATION',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.GUARANTEE_LANGUAGE));
});

test('an unqualified "buy now" directive with no risk/evidence context is flagged', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'Buy now before the price rises further.',
    evidence: [], entities: {}, intent: 'GENERAL_EDUCATION',
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.UNSAFE_BUY_SELL_DIRECTIVE));
});

test('a live price claim missing a visible timestamp is flagged', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS is trading at ₹4,120.',
    evidence: [evidenceItem({ claimType: 'LIVE_PRICE' })],
    entities: { symbols: ['TCS'] },
    intent: 'LIVE_MARKET_DATA',
    toolResults: [{ tool: 'getLiveQuote', status: 'SUCCESS' }],
  });
  assert.ok(issues.includes(SAFE_VALIDATION_REASONS.MISSING_LIVE_PRICE_TIMESTAMP));
});

test('a live price claim WITH a visible timestamp is not flagged', () => {
  const { issues } = runDeterministicChecks({
    draftAnswer: 'TCS is trading at ₹4,120 as of 2026-09-07 15:30 [1].',
    evidence: [evidenceItem({ claimType: 'LIVE_PRICE' })],
    entities: { symbols: ['TCS'] },
    intent: 'LIVE_MARKET_DATA',
    toolResults: [{ tool: 'getLiveQuote', status: 'SUCCESS' }],
  });
  assert.ok(!issues.includes(SAFE_VALIDATION_REASONS.MISSING_LIVE_PRICE_TIMESTAMP));
});

test('an empty draft answer produces no issues and no crash', () => {
  const { issues, citedIndexes } = runDeterministicChecks({ draftAnswer: '', evidence: [], entities: {}, intent: 'GENERAL_EDUCATION' });
  assert.deepEqual(issues, []);
  assert.equal(citedIndexes.size, 0);
});

// ---------------------------------------------------------------------------
// needsClaimVerifier — HARDENING: eligibility is intent + genuine-evidence
// based; citation presence/absence/validity plays NO role. This is the
// fix for the unsafe gating the hardening review flagged: "evidence
// exists for TCS guidance, draft makes uncited claims about TCS revenue
// and margins" MUST still be verified.
// ---------------------------------------------------------------------------
test('required test 10: GENERAL_EDUCATION never needs the claim verifier', () => {
  assert.equal(needsClaimVerifier({ evidence: [], intent: 'GENERAL_EDUCATION' }), false);
});

test('UNSUPPORTED never needs the claim verifier', () => {
  assert.equal(needsClaimVerifier({ evidence: [], intent: 'UNSUPPORTED' }), false);
});

test('required test 11 / test 10 (skip-condition list): a safe no-data answer (zero evidence) never needs the claim verifier -- deterministic ZERO_EVIDENCE_FACTUAL_CLAIM already governs this case', () => {
  assert.equal(needsClaimVerifier({ evidence: [], intent: 'STOCK_COMPARISON' }), false);
});

// required test 1: evidence exists, draft has factual claims but NO
// citations at all -- this must now REQUIRE the verifier, not skip it.
test('required test 1: an evidence-dependent intent with real evidence and NO citation markers at all still needs the claim verifier', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem()], intent: 'COMPANY_RESEARCH', entities: { symbols: ['TCS'] },
    deterministicIssues: ['UNCITED_FACTUAL_CLAIM'], citedIndexes: new Set(),
  });
  assert.equal(result, true, 'a citation-free evidence-dependent draft is one of the STRONGEST reasons to verify, never a reason to skip');
});

// required test 5/6 context: an invalid citation must also still trigger
// the verifier (not just "no citation at all").
test('an evidence-dependent draft with an INVALID citation marker still needs the claim verifier', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem()], intent: 'COMPANY_RESEARCH', entities: { symbols: ['TCS'] },
    deterministicIssues: ['CITATION_OUT_OF_RANGE'], citedIndexes: new Set(),
  });
  assert.equal(result, true);
});

test('a company-specific answer WITH real evidence and valid citations still needs the claim verifier (unchanged from before)', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem()], intent: 'COMPANY_RESEARCH', entities: { symbols: ['TCS'] },
    deterministicIssues: [], citedIndexes: new Set([1]),
  });
  assert.equal(result, true);
});

test('WATCHLIST_ANALYSIS and PORTFOLIO_ANALYSIS with real evidence need the claim verifier (added to the evidence-dependent set)', () => {
  assert.equal(needsClaimVerifier({
    evidence: [evidenceItem({ claimType: 'WATCHLIST_DATA', symbol: null })], intent: 'WATCHLIST_ANALYSIS', entities: {},
    deterministicIssues: [], citedIndexes: new Set(),
  }), true);
  assert.equal(needsClaimVerifier({
    evidence: [evidenceItem({ claimType: 'PORTFOLIO_DATA', symbol: null })], intent: 'PORTFOLIO_ANALYSIS', entities: {},
    deterministicIssues: [], citedIndexes: new Set(),
  }), true);
});

// required test 9: the ONLY legitimate skip for an evidence-dependent
// intent with real evidence -- a fully, deterministically verified simple
// price lookup (exactly one evidence item, exactly one correct citation,
// exactly the one requested symbol, zero deterministic issues).
test('required test 9: an exactly-mapped simple LIVE_MARKET_DATA response (one evidence item, one correct citation, clean deterministic pass) skips the verifier', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem({ claimType: 'LIVE_PRICE', symbol: 'TCS' })], intent: 'LIVE_MARKET_DATA',
    entities: { symbols: ['TCS'] }, deterministicIssues: [], citedIndexes: new Set([1]),
  });
  assert.equal(result, false);
});

test('required test 9 (negative): the SAME simple-price shape still needs the verifier once there is more than one evidence item', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem({ claimType: 'LIVE_PRICE', symbol: 'TCS' }), evidenceItem({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', evidenceId: 'e2' })],
    intent: 'LIVE_MARKET_DATA', entities: { symbols: ['TCS'] }, deterministicIssues: [], citedIndexes: new Set([1]),
  });
  assert.equal(result, true);
});

test('required test 9 (negative): a simple-price shape with ANY deterministic issue (e.g. missing timestamp) still needs the verifier', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem({ claimType: 'LIVE_PRICE', symbol: 'TCS' })], intent: 'LIVE_MARKET_DATA',
    entities: { symbols: ['TCS'] }, deterministicIssues: ['MISSING_LIVE_PRICE_TIMESTAMP'], citedIndexes: new Set([1]),
  });
  assert.equal(result, true);
});

test('required test 9 (negative): a simple-price shape with NO citation still needs the verifier -- the exact-mapping exception requires an actual correct citation, not just one evidence item', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem({ claimType: 'LIVE_PRICE', symbol: 'TCS' })], intent: 'LIVE_MARKET_DATA',
    entities: { symbols: ['TCS'] }, deterministicIssues: [], citedIndexes: new Set(),
  });
  assert.equal(result, true);
});

test('the exact-mapping skip never applies outside LIVE_MARKET_DATA -- e.g. a single-evidence COMPANY_RESEARCH answer still needs the verifier', () => {
  const result = needsClaimVerifier({
    evidence: [evidenceItem()], intent: 'COMPANY_RESEARCH', entities: { symbols: ['TCS'] },
    deterministicIssues: [], citedIndexes: new Set([1]),
  });
  assert.equal(result, true);
});
