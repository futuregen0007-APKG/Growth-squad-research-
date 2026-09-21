import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimPlan } from '../services/claimPlan.js';
import {
  resolveEvidenceRef, buildMetricGridBlock, buildComparisonTableBlock, buildCompanyHeaderBlock,
  buildSourceListBlock, buildEvidenceDrawerBlock, buildNewsListBlock, buildChartBlock, buildDataQualityBlock,
  buildSuggestedQuestionsBlock, BLOCK_BUILDERS,
} from '../services/responseBlocks.js';

/**
 * responseBlocks.test.js
 * =========================
 * UI Phase 1B. These exercise the PURE builders directly — plain state in,
 * a validated block (or null) out, no LangGraph, no Mongo. The central
 * property under test is reference validity: a builder must never surface
 * a claim-plan figure whose evidence is not ALSO present in the turn's
 * final, published `citations` array (see services/responseBlocks.js's
 * own module note on why a stale claim-plan entry is a real risk after
 * repairAnswer.js's repairClaimPlan, not a hypothetical one).
 */

// Real evidence-record shape (graph/evidence.js's buildEvidenceRecord) —
// evidenceId is load-bearing here, unlike claimPlanRendering.test.js's
// lighter `ev()` fixture which never needed one.
let evidenceCounter = 0;
const evidenceItem = (symbol, excerpt, overrides = {}) => ({
  evidenceId: overrides.evidenceId || `ev-${(evidenceCounter += 1)}`,
  symbol,
  excerpt,
  claimType: 'FINANCIAL_DATA',
  title: overrides.title || null,
  sourceUrl: overrides.sourceUrl ?? 'https://nsearchives.nseindia.com/doc.xml',
  provider: overrides.provider || 'stored-verified-filings',
  publishedAt: overrides.publishedAt || '2026-05-01',
  reportingPeriod: overrides.reportingPeriod ?? null,
});

test.beforeEach(() => { evidenceCounter = 0; });

// -----------------------------------------------------------------------
// resolveEvidenceRef
// -----------------------------------------------------------------------

test('resolveEvidenceRef resolves a valid citation number to {evidenceId, citationIndex}', () => {
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE')];
  const citations = [evidence[0]];
  const ref = resolveEvidenceRef(1, evidence, citations);
  assert.deepEqual(ref, { evidenceId: evidence[0].evidenceId, citationIndex: 1 });
});

test('resolveEvidenceRef returns null for a citation number the evidence array does not have', () => {
  assert.equal(resolveEvidenceRef(5, [evidenceItem('TCS', 'x')], []), null);
  assert.equal(resolveEvidenceRef(0, [evidenceItem('TCS', 'x')], []), null, 'citation numbers are 1-based');
  assert.equal(resolveEvidenceRef(null, [evidenceItem('TCS', 'x')], []), null);
});

test('resolveEvidenceRef returns null when the evidence exists but never made it into the FINAL citations array', () => {
  // This is the repairClaimPlan staleness case: state.claimPlan can still
  // reference a claim that was pruned from the actually-published answer.
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE')];
  const ref = resolveEvidenceRef(1, evidence, [] /* nothing published */);
  assert.equal(ref, null);
});

test('resolveEvidenceRef derives citationIndex from POSITION in citations, matching SourcesSection\'s own [N] numbering', () => {
  const a = evidenceItem('TCS', 'a');
  const b = evidenceItem('INFY', 'b');
  const evidence = [a, b];
  // citations is a re-ordered/compacted subset, exactly like extractCitations produces.
  const citations = [b, a];
  assert.deepEqual(resolveEvidenceRef(1, evidence, citations), { evidenceId: a.evidenceId, citationIndex: 2 });
  assert.deepEqual(resolveEvidenceRef(2, evidence, citations), { evidenceId: b.evidenceId, citationIndex: 1 });
});

test('resolveEvidenceRef CANNOT resurrect a REMOVED claim when a SURVIVING claim shares its evidenceId -- membership alone is not enough', () => {
  // The adversarial case membership-only checking misses: citation 3 was
  // explicitly rejected (WRONG_PERIOD) by the verifier, but its evidence
  // record's evidenceId ALSO happens to be present in `citations` because
  // a DIFFERENT, surviving claim (citation 7) references the same
  // evidenceId. A membership-only check would wrongly resolve citation 3
  // anyway, since ITS evidenceId is technically "in citations" -- just for
  // an unrelated reason. The verifier's own per-citation verdict must be
  // checked FIRST and independently.
  const sharedId = 'ev-shared';
  const evidence = [];
  evidence[2] = { evidenceId: sharedId, symbol: 'HDFCBANK', excerpt: 'stale' }; // citation 3
  evidence[6] = { evidenceId: sharedId, symbol: 'HDFCBANK', excerpt: 'current' }; // citation 7 (surviving)
  const citations = [evidence[6]]; // only citation 7 is in the FINAL published answer

  const claimValidation = [
    { claimId: 'c1', verdict: 'WRONG_PERIOD', evidenceIndexes: [3], reasonCode: 'stale figure' },
    { claimId: 'c2', verdict: 'SUPPORTED', evidenceIndexes: [7], reasonCode: '' },
  ];

  // Without claimValidation, membership alone WOULD wrongly resolve
  // citation 3 (its evidenceId is technically present in `citations`).
  assert.ok(resolveEvidenceRef(3, evidence, citations), 'sanity: membership alone is satisfied here -- this IS the adversarial condition');

  // With claimValidation, the explicit rejection wins regardless.
  assert.equal(resolveEvidenceRef(3, evidence, citations, claimValidation), null, 'the removed claim is never resurrected');
  assert.deepEqual(
    resolveEvidenceRef(7, evidence, citations, claimValidation),
    { evidenceId: sharedId, citationIndex: 1 },
    'the genuinely surviving claim still resolves normally',
  );
});

test('resolveEvidenceRef treats an EMPTY/ABSENT claimValidation as "nothing explicitly rejected" -- falls through to membership alone, exactly as before this check existed', () => {
  // Covers the narrow isExactlyDeterministicallyVerified case
  // (graph/claimValidation.js) where the verifier legitimately never runs
  // -- claimValidation stays [] by state.js's own default, and that must
  // not be misread as "everything rejected."
  const evidence = [{ evidenceId: 'e1', symbol: 'TCS', excerpt: 'x' }];
  const citations = [evidence[0]];
  assert.deepEqual(resolveEvidenceRef(1, evidence, citations, []), { evidenceId: 'e1', citationIndex: 1 });
  assert.deepEqual(resolveEvidenceRef(1, evidence, citations, undefined), { evidenceId: 'e1', citationIndex: 1 });
});

test('resolveEvidenceRef end-to-end: buildMetricGridBlock drops a row explicitly rejected by claimValidation even though its evidenceId survives via an unrelated citation', () => {
  const sharedId = 'ev-shared-2';
  const evidence = [];
  evidence[0] = { evidenceId: sharedId, symbol: 'TCS', excerpt: 'REVENUE: 1 INR_CRORE (FY2023) - Revenue' }; // citation 1, stale
  evidence[1] = { evidenceId: 'ev-other', symbol: 'TCS', excerpt: 'PAT: 2 INR_CRORE (FY2024) - PAT' }; // citation 2, survives
  evidence[2] = { evidenceId: sharedId, symbol: 'TCS', excerpt: 'REVENUE: 3 INR_CRORE (FY2024) - Revenue' }; // citation 3, survives, SAME evidenceId as citation 1

  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  // Force one row's chosen claim to point at the STALE citation (1) rather
  // than the surviving one (3), simulating a pre-repair plan whose FY2023
  // figure was the one actually flagged and pruned from the published text.
  const revenueRow = claimPlan.rows.find((r) => r.metric === 'REVENUE');
  revenueRow.values.TCS = { ...revenueRow.values.TCS, citation: 1, value: 1, period: 'FY2023' };

  const citations = [evidence[1], evidence[2]]; // citation 1 never made it into the final answer at all... except evidenceId 1===3
  const claimValidation = [{ claimId: 'c1', verdict: 'WRONG_PERIOD', evidenceIndexes: [1], reasonCode: 'stale period' }];

  const state = { claimPlan, evidence, citations, claimValidation };
  const block = buildMetricGridBlock(state);
  const revenueMetric = block?.metrics.find((m) => m.metric === 'REVENUE');
  assert.equal(revenueMetric, undefined, 'the explicitly-rejected FY2023 revenue claim must not appear in the grid');
  assert.ok(block.metrics.find((m) => m.metric === 'PAT'), 'the unrelated surviving PAT claim is unaffected');
});

// -----------------------------------------------------------------------
// buildMetricGridBlock
// -----------------------------------------------------------------------

test('buildMetricGridBlock builds a single-company grid with resolved evidence refs', () => {
  const evidence = [
    evidenceItem('TCS', 'REVENUE: 240893 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' }),
    evidenceItem('TCS', 'PAT: 46099 INR_CRORE (FY2024) - PAT', { reportingPeriod: 'FY2024' }),
  ];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = { claimPlan, evidence, citations: evidence };

  const block = buildMetricGridBlock(state);
  assert.ok(block, 'a block is produced');
  assert.equal(block.type, 'metric_grid');
  assert.equal(block.symbol, 'TCS');
  assert.ok(block.metrics.length >= 2);
  for (const metric of block.metrics) {
    assert.ok(metric.evidence.length >= 1, `${metric.metric} carries at least one evidence ref`);
    assert.ok(evidence.some((e) => e.evidenceId === metric.evidence[0].evidenceId));
  }
});

test('buildMetricGridBlock returns null for a COMPARISON plan (that is comparison_table\'s job, never both)', () => {
  const evidence = [
    evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' }),
    evidenceItem('INFY', 'REVENUE: 2 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' }),
  ];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS', 'INFY'], sectorKindBySymbol: { TCS: 'GENERAL', INFY: 'GENERAL' } });
  const state = { claimPlan, evidence, citations: evidence };
  assert.equal(buildMetricGridBlock(state), null);
});

test('buildMetricGridBlock returns null when there is no claim plan at all (e.g. the grounded RAG path)', () => {
  assert.equal(buildMetricGridBlock({ claimPlan: null, evidence: [], citations: [] }), null);
});

test('buildMetricGridBlock omits a metric whose evidence never reached the final citations array, and returns null if NONE survive', () => {
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' })];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  // Simulate a post-repair state: the claim plan still references evidence
  // index 1, but the actually-published answer cited nothing from it.
  const state = { claimPlan, evidence, citations: [] };
  assert.equal(buildMetricGridBlock(state), null, 'no valid references survive -> no block, not a block with fabricated refs');
});

// -----------------------------------------------------------------------
// buildComparisonTableBlock
// -----------------------------------------------------------------------

test('buildComparisonTableBlock builds a multi-company table, preserving claimPlan\'s own comparable/commonPeriod decision', () => {
  const evidence = [
    evidenceItem('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2024) - NIM', { reportingPeriod: 'FY2024' }),
    evidenceItem('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2024) - NIM', { reportingPeriod: 'FY2024' }),
  ];
  const claimPlan = buildClaimPlan({
    evidence, symbols: ['HDFCBANK', 'ICICIBANK'], sectorKindBySymbol: { HDFCBANK: 'BANKING', ICICIBANK: 'BANKING' },
  });
  const state = { claimPlan, evidence, citations: evidence };

  const block = buildComparisonTableBlock(state);
  assert.ok(block);
  assert.equal(block.type, 'comparison_table');
  assert.deepEqual(block.symbols, ['HDFCBANK', 'ICICIBANK']);
  const nimRow = block.rows.find((r) => r.metric === 'NIM');
  assert.ok(nimRow);
  assert.equal(nimRow.comparable, true);
  assert.equal(nimRow.commonPeriod, 'FY2024');
  assert.equal(nimRow.values.HDFCBANK.value, 4);
  assert.equal(nimRow.values.ICICIBANK.value, 4.78);
});

test('buildComparisonTableBlock returns null for a single-company plan', () => {
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' })];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  assert.equal(buildComparisonTableBlock({ claimPlan, evidence, citations: evidence }), null);
});

test('buildComparisonTableBlock drops only the CELL whose evidence is unresolved, keeping the row if another company\'s cell survives', () => {
  const hdfc = evidenceItem('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2024) - NIM', { reportingPeriod: 'FY2024' });
  const icici = evidenceItem('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2024) - NIM', { reportingPeriod: 'FY2024' });
  const evidence = [hdfc, icici];
  const claimPlan = buildClaimPlan({
    evidence, symbols: ['HDFCBANK', 'ICICIBANK'], sectorKindBySymbol: { HDFCBANK: 'BANKING', ICICIBANK: 'BANKING' },
  });
  // Only HDFC's evidence made it into the final published citations.
  const state = { claimPlan, evidence, citations: [hdfc] };

  const block = buildComparisonTableBlock(state);
  assert.ok(block);
  const nimRow = block.rows.find((r) => r.metric === 'NIM');
  assert.ok(nimRow.values.HDFCBANK, 'the resolvable cell survives');
  assert.equal(nimRow.values.ICICIBANK, undefined, 'the unresolvable cell is dropped, not fabricated with a stale ref');
});

// -----------------------------------------------------------------------
// buildCompanyHeaderBlock
// -----------------------------------------------------------------------

test('buildCompanyHeaderBlock combines verified reference metadata with a cited live price', () => {
  const evidence = [evidenceItem('TCS', 'Price ₹2105.5, change -1.23% as of 2026-09-11T10:15:30.000Z')];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = {
    claimPlan, evidence, citations: evidence,
    companyProfiles: { TCS: { companyName: 'Tata Consultancy Services', sector: 'IT', exchange: 'NSE' } },
  };

  const block = buildCompanyHeaderBlock(state);
  assert.ok(block);
  assert.equal(block.symbol, 'TCS');
  assert.equal(block.companyName, 'Tata Consultancy Services');
  assert.equal(block.sector, 'IT');
  assert.equal(block.exchange, 'NSE');
  assert.equal(block.price.value, 2105.5);
  assert.equal(block.price.currency, 'INR');
  assert.equal(block.price.asOf, '2026-09-11T10:15:30.000Z');
  assert.equal(block.price.evidence[0].evidenceId, evidence[0].evidenceId);
});

test('buildCompanyHeaderBlock prefers a LIVE price over a stored historical close when both are present', () => {
  const live = evidenceItem('TCS', 'Price ₹2105.5, change -1.23% as of 2026-09-11T10:15:30.000Z');
  const historical = evidenceItem('TCS', 'close INR 2080, 1-year return 5%', { reportingPeriod: null });
  const evidence = [live, historical];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = { claimPlan, evidence, citations: evidence, companyProfiles: { TCS: { companyName: 'TCS Ltd', sector: null, exchange: null } } };

  const block = buildCompanyHeaderBlock(state);
  assert.equal(block.price.value, 2105.5, 'the live quote wins, not the stale close');
});

test('buildCompanyHeaderBlock falls back to a stored historical close when no live quote is present, honestly labelled with its real as-of date', () => {
  const historical = evidenceItem('TCS', 'close INR 2080, 1-year return 5%', { reportingPeriod: null, publishedAt: '2026-09-10' });
  const evidence = [historical];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = { claimPlan, evidence, citations: evidence, companyProfiles: { TCS: { companyName: 'TCS Ltd', sector: null, exchange: null } } };

  const block = buildCompanyHeaderBlock(state);
  assert.equal(block.price.value, 2080);
  assert.equal(block.price.asOf, '2026-09-10', 'the real trading-day date, never mislabelled as a live timestamp');
});

test('buildCompanyHeaderBlock has NO price field (not a guess) when no price evidence resolves at all', () => {
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' })];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = { claimPlan, evidence, citations: evidence, companyProfiles: { TCS: { companyName: 'TCS Ltd', sector: null, exchange: null } } };

  const block = buildCompanyHeaderBlock(state);
  assert.ok(block, 'the header still renders on companyName alone');
  assert.equal(block.price, null);
});

test('buildCompanyHeaderBlock returns null (never a header with invented fields) when no verified company name is held', () => {
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' })];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  assert.equal(buildCompanyHeaderBlock({ claimPlan, evidence, citations: evidence, companyProfiles: {} }), null);
  assert.equal(buildCompanyHeaderBlock({ claimPlan, evidence, citations: evidence }), null, 'companyProfiles entirely absent is handled the same way');
});

test('buildCompanyHeaderBlock returns null for a COMPARISON plan (single-company only, Phase 1C.1 scope)', () => {
  const evidence = [
    evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' }),
    evidenceItem('INFY', 'REVENUE: 2 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' }),
  ];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS', 'INFY'], sectorKindBySymbol: { TCS: 'GENERAL', INFY: 'GENERAL' } });
  const state = {
    claimPlan, evidence, citations: evidence,
    companyProfiles: { TCS: { companyName: 'TCS Ltd' }, INFY: { companyName: 'Infosys Ltd' } },
  };
  assert.equal(buildCompanyHeaderBlock(state), null);
});

test('buildCompanyHeaderBlock never resurrects a price the verifier explicitly rejected, even if its evidenceId survives via an unrelated citation', () => {
  const sharedId = 'ev-shared-price';
  const evidence = [];
  evidence[0] = { evidenceId: sharedId, symbol: 'TCS', excerpt: 'Price ₹1999, change 0% as of 2026-01-01T00:00:00.000Z' }; // stale, citation 1
  evidence[1] = { evidenceId: 'ev-other', symbol: 'TCS', excerpt: 'REVENUE: 1 INR_CRORE (FY2024) - Revenue' }; // citation 2
  evidence[2] = { evidenceId: sharedId, symbol: 'TCS', excerpt: 'Price ₹2105.5, change -1.23% as of 2026-09-11T10:15:30.000Z' }; // current, citation 3

  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  claimPlan.livePrice.TCS = { ...claimPlan.livePrice.TCS, citation: 1, value: 1999 }; // force the STALE citation

  const citations = [evidence[1], evidence[2]];
  const claimValidation = [{ claimId: 'c1', verdict: 'WRONG_PERIOD', evidenceIndexes: [1], reasonCode: 'stale price' }];
  const state = {
    claimPlan, evidence, citations, claimValidation,
    companyProfiles: { TCS: { companyName: 'TCS Ltd' } },
  };

  const block = buildCompanyHeaderBlock(state);
  assert.ok(block);
  assert.equal(block.price, null, 'the stale, explicitly-rejected price is never shown -- and it is not silently swapped for the current one, since the plan never pointed at it');
});

// -----------------------------------------------------------------------
// buildChartBlock -- UI Phase 1C.3
// -----------------------------------------------------------------------

const priceHistoryEvidenceItem = (symbol, series, overrides = {}) => ({
  evidenceId: overrides.evidenceId || `ev-${(evidenceCounter += 1)}`,
  symbol,
  claimType: 'MARKET_HISTORY',
  chartSeries: series,
  excerpt: `PRICE_HISTORY: ${series.length} points, INR, NSE_BHAVCOPY, NOT_REQUIRED (${series[0]?.date} to ${series[series.length - 1]?.date})`,
  sourceUrl: overrides.sourceUrl ?? 'https://nsearchives.nseindia.com/bhavcopy.csv',
  provider: overrides.provider || 'NSE_BHAVCOPY',
  publishedAt: overrides.publishedAt || '2026-08-03',
  title: overrides.title || null,
});

const SERIES = [
  { date: '2026-08-01', close: 100 },
  { date: '2026-08-02', close: 101 },
  { date: '2026-08-03', close: 102 },
];

test('buildChartBlock builds a real chart from a cited price-history claim, with one resolved evidence ref', () => {
  const evidence = [priceHistoryEvidenceItem('TCS', SERIES)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = { claimPlan, evidence, citations: evidence };

  const block = buildChartBlock(state);
  assert.ok(block);
  assert.equal(block.type, 'chart');
  assert.equal(block.version, 1);
  assert.equal(block.symbol, 'TCS');
  assert.equal(block.currency, 'INR');
  assert.equal(block.priceBasis, 'NOT_REQUIRED');
  assert.deepEqual(block.points.map((p) => [p.date, p.close]), [['2026-08-01', 100], ['2026-08-02', 101], ['2026-08-03', 102]]);
  assert.equal(block.rangeStart, '2026-08-01');
  assert.equal(block.rangeEnd, '2026-08-03');
  assert.equal(block.evidence[0].evidenceId, evidence[0].evidenceId);
});

test('buildChartBlock returns null for a COMPARISON plan (single-company only, matching buildCompanyHeaderBlock\'s own scope)', () => {
  const evidence = [priceHistoryEvidenceItem('TCS', SERIES), priceHistoryEvidenceItem('INFY', SERIES)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS', 'INFY'], sectorKindBySymbol: { TCS: 'GENERAL', INFY: 'GENERAL' } });
  assert.equal(buildChartBlock({ claimPlan, evidence, citations: evidence }), null);
});

test('buildChartBlock returns null when there is no claim plan, or the plan has no price-history claim', () => {
  assert.equal(buildChartBlock({}), null);
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' })];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  assert.equal(buildChartBlock({ claimPlan, evidence, citations: evidence }), null);
});

test('buildChartBlock returns null when the price-history claim was never actually published (not in the final citations array)', () => {
  const evidence = [priceHistoryEvidenceItem('TCS', SERIES)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  assert.equal(buildChartBlock({ claimPlan, evidence, citations: [] }), null);
});

test('buildChartBlock never resurrects a price-history claim the verifier explicitly rejected, even if its evidenceId survives via an unrelated citation', () => {
  const sharedId = 'ev-shared-history';
  const evidence = [];
  evidence[0] = priceHistoryEvidenceItem('TCS', SERIES, { evidenceId: sharedId }); // citation 1 -- this is the one the plan points at
  evidence[1] = evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' }); // citation 2
  evidence[2] = { ...priceHistoryEvidenceItem('TCS', SERIES), evidenceId: sharedId }; // citation 3 -- shares the SAME evidenceId

  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  // buildClaimPlan's own last-write-wins would naturally point priceHistory
  // at citation 3 (the LAST PRICE_HISTORY claim parsed) -- forced back to
  // citation 1 here, exactly like buildCompanyHeaderBlock's own equivalent
  // test, to construct the adversarial condition under test: the plan
  // points at a citation whose evidenceId ALSO appears, unrelatedly, at a
  // later citation that DID survive publication.
  claimPlan.priceHistory.TCS = { ...claimPlan.priceHistory.TCS, citation: 1 };

  const citations = [evidence[1], evidence[2]]; // citation 1 (the actual plan target) did NOT survive publication
  const claimValidation = [{ claimId: 'c1', verdict: 'UNSUPPORTED', evidenceIndexes: [1], reasonCode: 'stale series' }];
  const state = { claimPlan, evidence, citations, claimValidation };

  assert.equal(buildChartBlock(state), null, 'the rejected claim is never resurrected via the unrelated citation-3 evidenceId match');
});

test('buildChartBlock drops individually invalid points (non-finite/zero/negative close, malformed date) but keeps the valid ones', () => {
  const dirtySeries = [
    { date: '2026-08-01', close: 100 },
    { date: '2026-08-02', close: NaN },
    { date: '2026-08-03', close: 0 },
    { date: '2026-08-04', close: -5 },
    { date: 'not-a-date', close: 105 },
    { date: '2026-08-05', close: 106 },
  ];
  const evidence = [priceHistoryEvidenceItem('TCS', dirtySeries)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block = buildChartBlock({ claimPlan, evidence, citations: evidence });
  assert.ok(block);
  assert.deepEqual(block.points.map((p) => p.date), ['2026-08-01', '2026-08-05']);
});

test('buildChartBlock drops a duplicate date, never silently overwriting one point with another', () => {
  const dupSeries = [
    { date: '2026-08-01', close: 100 },
    { date: '2026-08-02', close: 101 },
    { date: '2026-08-02', close: 999 }, // duplicate date, different value
    { date: '2026-08-03', close: 102 },
  ];
  const evidence = [priceHistoryEvidenceItem('TCS', dupSeries)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block = buildChartBlock({ claimPlan, evidence, citations: evidence });
  assert.equal(block.points.length, 3);
  assert.equal(block.points.find((p) => p.date === '2026-08-02').close, 101, 'the FIRST occurrence is kept, never overwritten');
});

test('buildChartBlock re-sorts an out-of-order series chronologically rather than trusting upstream ordering as the only guarantee', () => {
  const outOfOrder = [
    { date: '2026-08-03', close: 102 },
    { date: '2026-08-01', close: 100 },
    { date: '2026-08-02', close: 101 },
  ];
  const evidence = [priceHistoryEvidenceItem('TCS', outOfOrder)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block = buildChartBlock({ claimPlan, evidence, citations: evidence });
  assert.deepEqual(block.points.map((p) => p.date), ['2026-08-01', '2026-08-02', '2026-08-03']);
});

test('buildChartBlock omits the whole chart (returns null) when fewer than two valid points survive cleaning -- the rest of the answer is unaffected', () => {
  const almostEmpty = [{ date: '2026-08-01', close: 100 }, { date: 'bad-date', close: 101 }];
  const evidence = [priceHistoryEvidenceItem('TCS', almostEmpty)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  assert.equal(buildChartBlock({ claimPlan, evidence, citations: evidence }), null);
});

test('buildChartBlock bounds the series to MAX_CHART_POINTS, keeping the MOST RECENT points', async () => {
  const { MAX_CHART_POINTS } = await import('../graph/schemas.js');
  const base = new Date('2020-01-01T00:00:00Z');
  const longSeries = Array.from({ length: MAX_CHART_POINTS + 50 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86400000);
    return { date: d.toISOString().slice(0, 10), close: 100 + i };
  });
  const evidence = [priceHistoryEvidenceItem('TCS', longSeries)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block = buildChartBlock({ claimPlan, evidence, citations: evidence });
  assert.equal(block.points.length, MAX_CHART_POINTS);
  assert.equal(block.points[0].date, longSeries[50].date, 'the OLDEST 50 points are dropped, keeping the most recent window');
  assert.equal(block.points[block.points.length - 1].date, longSeries[longSeries.length - 1].date);
});

test('buildChartBlock preserves a real gapBefore flag mid-series, but forces the FIRST rendered point\'s gapBefore to false (nothing precedes it in the shown window)', () => {
  const withGap = [
    { date: '2026-08-01', close: 100, gapBefore: true }, // should be forced false -- it's the first point
    { date: '2026-08-05', close: 104, gapBefore: true }, // a real, preserved gap
    { date: '2026-08-06', close: 105, gapBefore: false },
  ];
  const evidence = [priceHistoryEvidenceItem('TCS', withGap)];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block = buildChartBlock({ claimPlan, evidence, citations: evidence });
  assert.deepEqual(block.points.map((p) => p.gapBefore), [false, true, false]);
});

test('buildChartBlock sanitizes an unsafe sourceUrl to null rather than failing the whole chart', () => {
  const evidence = [priceHistoryEvidenceItem('TCS', SERIES, { sourceUrl: 'javascript:alert(1)' })];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block = buildChartBlock({ claimPlan, evidence, citations: evidence });
  assert.ok(block);
  assert.equal(block.sourceUrl, null);
});

test('buildChartBlock states the real requestedRangeDays when one was named, and honestly null when it was not', () => {
  const evidence = [{ ...priceHistoryEvidenceItem('TCS', SERIES), requestedRangeDays: 90 }];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block = buildChartBlock({ claimPlan, evidence, citations: evidence });
  assert.equal(block.requestedRangeDays, 90);

  const evidence2 = [priceHistoryEvidenceItem('TCS', SERIES)]; // no requestedRangeDays at all
  const claimPlan2 = buildClaimPlan({ evidence: evidence2, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const block2 = buildChartBlock({ claimPlan: claimPlan2, evidence: evidence2, citations: evidence2 });
  assert.equal(block2.requestedRangeDays, null);
});

// -----------------------------------------------------------------------
// buildSourceListBlock
// -----------------------------------------------------------------------

test('buildSourceListBlock mirrors the final citations array 1:1, numbered by position', () => {
  const a = evidenceItem('TCS', 'a', { title: 'TCS filing', sourceUrl: 'https://nsearchives.nseindia.com/a.xml' });
  const b = evidenceItem('INFY', 'b', { title: 'INFY filing', sourceUrl: 'https://nsearchives.nseindia.com/b.xml' });
  const block = buildSourceListBlock({ citations: [a, b] });
  assert.ok(block);
  assert.equal(block.sources.length, 2);
  assert.equal(block.sources[0].citationIndex, 1);
  assert.equal(block.sources[1].citationIndex, 2);
  assert.equal(block.sources[0].evidenceId, a.evidenceId);
});

test('buildSourceListBlock returns null for zero citations', () => {
  assert.equal(buildSourceListBlock({ citations: [] }), null);
  assert.equal(buildSourceListBlock({}), null);
});

test('buildSourceListBlock sanitizes an unsafe sourceUrl to null rather than dropping the whole source', () => {
  const bad = evidenceItem('TCS', 'a', { sourceUrl: 'javascript:alert(1)', title: 'Suspicious title' });
  const block = buildSourceListBlock({ citations: [bad] });
  assert.ok(block, 'the source itself is kept');
  assert.equal(block.sources[0].sourceUrl, null, 'only the unsafe URL is stripped');
  assert.equal(block.sources[0].title, 'Suspicious title', 'other real fields are preserved');
});

test('buildSourceListBlock reads BOTH citation shapes -- legacy (title/provider) and grounded (documentTitle/sourceAuthority)', () => {
  const legacy = evidenceItem('TCS', 'a', { title: 'Legacy title', provider: 'stored-verified-filings' });
  const grounded = { evidenceId: 'g1', documentTitle: 'Grounded title', sourceAuthority: 'NSE', sourceUrl: 'https://nse.example/doc', publishedAt: '2026-01-01', reportingPeriod: 'Q1 FY2026' };
  const block = buildSourceListBlock({ citations: [legacy, grounded] });
  assert.equal(block.sources[0].title, 'Legacy title');
  assert.equal(block.sources[1].title, 'Grounded title');
  assert.equal(block.sources[1].provider, 'NSE');
});

// -----------------------------------------------------------------------
// buildEvidenceDrawerBlock
// -----------------------------------------------------------------------

test('buildEvidenceDrawerBlock preserves excerpt, source link, reporting period and page range from a LEGACY citation', () => {
  const legacy = { evidenceId: 'e1', title: 'TCS Q1 FY2026 filing', excerpt: 'Revenue grew 15% YoY.', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'NSE', publishedAt: '2026-07-10', reportingPeriod: 'Q1 FY2026', pageNumber: 4 };
  const block = buildEvidenceDrawerBlock({ citations: [legacy] });
  assert.ok(block);
  const entry = block.entries[0];
  assert.equal(entry.excerpt, 'Revenue grew 15% YoY.');
  assert.equal(entry.sourceUrl, 'https://nsearchives.nseindia.com/x.xml');
  assert.equal(entry.reportingPeriod, 'Q1 FY2026');
  assert.equal(entry.pageStart, 4, 'a single legacy pageNumber becomes a one-page range');
  assert.equal(entry.pageEnd, 4);
});

test('buildEvidenceDrawerBlock preserves documentType, page RANGE, temporalStatus and canonicalGuidance from a GROUNDED citation', () => {
  const grounded = {
    evidenceId: 'g1', documentTitle: 'INFY Revised Guidance', excerpt: 'Revenue growth revised to 21-22%.',
    sourceUrl: 'https://example.com/infy.pdf', sourceAuthority: 'EARNINGS_CALL', publishedAt: '2026-05-01',
    reportingPeriod: 'Q4 FY2026', documentType: 'EARNINGS_CALL_TRANSCRIPT', pageStart: 3, pageEnd: 5,
    temporalStatus: 'CURRENT', canonicalGuidance: { valueType: 'range', lowerBound: 21, upperBound: 22, unit: 'PERCENTAGE' },
  };
  const block = buildEvidenceDrawerBlock({ citations: [grounded] });
  const entry = block.entries[0];
  assert.equal(entry.excerpt, 'Revenue growth revised to 21-22%.');
  assert.equal(entry.documentType, 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(entry.pageStart, 3);
  assert.equal(entry.pageEnd, 5);
  assert.equal(entry.temporalStatus, 'CURRENT');
  assert.equal(entry.canonicalGuidance.lowerBound, 21);
  assert.equal(entry.canonicalGuidance.upperBound, 22);
});

test('buildEvidenceDrawerBlock returns null for zero citations', () => {
  assert.equal(buildEvidenceDrawerBlock({ citations: [] }), null);
  assert.equal(buildEvidenceDrawerBlock({}), null);
});

test('buildEvidenceDrawerBlock sanitizes an unsafe sourceUrl to null without dropping the entry', () => {
  const bad = { evidenceId: 'e1', title: 'x', sourceUrl: 'javascript:alert(1)' };
  const block = buildEvidenceDrawerBlock({ citations: [bad] });
  assert.ok(block);
  assert.equal(block.entries[0].sourceUrl, null);
});

test('buildEvidenceDrawerBlock numbers entries the SAME way source_list does (position in citations + 1)', () => {
  const a = { evidenceId: 'e1', title: 'a' };
  const b = { evidenceId: 'e2', title: 'b' };
  const block = buildEvidenceDrawerBlock({ citations: [a, b] });
  assert.equal(block.entries[0].citationIndex, 1);
  assert.equal(block.entries[1].citationIndex, 2);
});

// -----------------------------------------------------------------------
// buildNewsListBlock
// -----------------------------------------------------------------------

// UI Phase 1D audit fix: citations no longer carry imageUrl at all (see
// graph/citations.js's citationFromLegacyEvidence) -- buildNewsListBlock
// now sources it from state.evidence, matched by evidenceId, exactly like
// production's real evidence/citations pair. `newsFixture` builds BOTH the
// citation-shaped object (no imageUrl) and its matching evidence-shaped
// object (which DOES carry imageUrl) from one set of inputs, and
// `stateFor` assembles the {citations, evidence} state these tests need.
const newsCitation = (overrides = {}) => ({
  evidenceId: `news-${Math.random().toString(36).slice(2)}`,
  claimType: 'COMPANY_NEWS',
  symbol: 'TCS',
  title: 'TCS wins major deal',
  sourceUrl: 'https://reuters.com/tcs-deal',
  provider: 'Reuters',
  publishedAt: '2026-09-01T00:00:00.000Z',
  imageUrl: 'https://reuters.com/img.jpg',
  ...overrides,
});

/** citations reflect the REAL post-fix shape (no imageUrl); evidence carries it, matched by evidenceId. */
const stateFor = (citationsWithImage) => ({
  citations: citationsWithImage.map(({ imageUrl, ...rest }) => rest),
  evidence: citationsWithImage.map((c) => ({ evidenceId: c.evidenceId, imageUrl: c.imageUrl })),
});

test('buildNewsListBlock builds a card from a real, cited COMPANY_NEWS citation, preserving title/url/publisher/date/image', () => {
  const citation = newsCitation();
  const block = buildNewsListBlock(stateFor([citation]));
  assert.ok(block);
  assert.equal(block.type, 'news_list');
  const [article] = block.articles;
  assert.equal(article.evidenceId, citation.evidenceId);
  assert.equal(article.citationIndex, 1);
  assert.equal(article.symbol, 'TCS');
  assert.equal(article.title, 'TCS wins major deal');
  assert.equal(article.url, 'https://reuters.com/tcs-deal');
  assert.equal(article.publisher, 'Reuters');
  assert.equal(article.publishedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(article.imageUrl, 'https://reuters.com/img.jpg');
});

test('buildNewsListBlock returns null for zero citations or citations with no news', () => {
  assert.equal(buildNewsListBlock({ citations: [] }), null);
  assert.equal(buildNewsListBlock({}), null);
  assert.equal(buildNewsListBlock({ citations: [{ evidenceId: 'e1', claimType: 'FINANCIAL_DATA', title: 'x' }] }), null);
});

test('buildNewsListBlock is built ONLY from state.citations -- irrelevant, uncited news evidence never appears, matching "only when relevant to the answer"', () => {
  // A COMPANY_NEWS item that exists in evidence but was never cited in the
  // published answer would simply never reach state.citations in the
  // first place; this test documents that the builder trusts ONLY
  // citations, mirroring buildSourceListBlock/buildEvidenceDrawerBlock.
  const block = buildNewsListBlock({ citations: [] });
  assert.equal(block, null);
});

test('buildNewsListBlock requires a real evidenceId, a real headline, and a safe URL -- never a card with an invented/missing link', () => {
  assert.equal(buildNewsListBlock(stateFor([newsCitation({ evidenceId: null })])), null);
  assert.equal(buildNewsListBlock(stateFor([newsCitation({ title: null })])), null);
  assert.equal(buildNewsListBlock(stateFor([newsCitation({ sourceUrl: null })])), null);
  assert.equal(buildNewsListBlock(stateFor([newsCitation({ sourceUrl: 'javascript:alert(1)' })])), null);
});

test('buildNewsListBlock omits the image field rather than inventing one, and rejects an unsafe image URL the same way it rejects an unsafe article URL', () => {
  const noImage = buildNewsListBlock(stateFor([newsCitation({ imageUrl: null })]));
  assert.equal(noImage.articles[0].imageUrl, null);

  const unsafeImage = buildNewsListBlock(stateFor([newsCitation({ imageUrl: 'javascript:alert(1)' })]));
  assert.equal(unsafeImage.articles[0].imageUrl, null, 'the article itself is still shown -- only the bad image field is dropped');
});

test('buildNewsListBlock never reads imageUrl off the citation object itself, even if one is (wrongly) present there -- evidence is the only trusted source', () => {
  const citation = { ...newsCitation(), imageUrl: 'https://citation-object.example.com/should-be-ignored.jpg' };
  const block = buildNewsListBlock({ citations: [citation], evidence: [{ evidenceId: citation.evidenceId, imageUrl: 'https://real-evidence.example.com/real.jpg' }] });
  assert.equal(block.articles[0].imageUrl, 'https://real-evidence.example.com/real.jpg');
});

test('buildNewsListBlock never substitutes today\'s date for a missing publishedAt', () => {
  const block = buildNewsListBlock(stateFor([newsCitation({ publishedAt: null })]));
  assert.equal(block.articles[0].publishedAt, null);
});

test('buildNewsListBlock deduplicates articles by NORMALIZED url (tracking params, trailing slash, case do not create a duplicate)', () => {
  const a = newsCitation({ evidenceId: 'e1', sourceUrl: 'https://reuters.com/tcs-deal?utm_source=x' });
  const b = newsCitation({ evidenceId: 'e2', sourceUrl: 'https://REUTERS.com/tcs-deal/' }); // same article, different case/trailing slash
  const c = newsCitation({ evidenceId: 'e3', sourceUrl: 'https://reuters.com/a-different-article' });
  const block = buildNewsListBlock(stateFor([a, b, c]));
  assert.equal(block.articles.length, 2, 'a and b collapse to one card; c is genuinely different');
  assert.equal(block.articles[0].evidenceId, 'e1', 'the FIRST occurrence is kept');
});

test('buildNewsListBlock caps at MAX_NEWS_ARTICLES (5) even when more real, cited, distinct articles exist', () => {
  const citations = Array.from({ length: 8 }, (_, i) => newsCitation({
    evidenceId: `e${i}`, sourceUrl: `https://reuters.com/article-${i}`,
  }));
  const block = buildNewsListBlock(stateFor(citations));
  assert.equal(block.articles.length, 5);
});

test('buildNewsListBlock ignores non-news citations mixed in with real news citations', () => {
  const news = newsCitation();
  const metric = { evidenceId: 'm1', claimType: 'FINANCIAL_DATA', title: 'REVENUE: 1 INR_CRORE' };
  const block = buildNewsListBlock({ citations: [metric, ...stateFor([news]).citations], evidence: stateFor([news]).evidence });
  assert.equal(block.articles.length, 1);
  assert.equal(block.articles[0].evidenceId, news.evidenceId);
  // citationIndex reflects the article's REAL position in the citations array (2nd), not a re-numbering of news alone.
  assert.equal(block.articles[0].citationIndex, 2);
});

// -----------------------------------------------------------------------
// buildDataQualityBlock
// -----------------------------------------------------------------------

test('buildDataQualityBlock is OMITTED (null) when there is genuinely nothing to report', () => {
  const state = { groundingStatus: null, claimPlan: null, valuationCoverage: [], coverage: null };
  assert.equal(buildDataQualityBlock(state), null);
});

test('buildDataQualityBlock reports groundingStatus alone', () => {
  const block = buildDataQualityBlock({ groundingStatus: 'partially_grounded', claimPlan: null, valuationCoverage: [], coverage: null });
  assert.ok(block);
  assert.equal(block.groundingStatus, 'partially_grounded');
  assert.deepEqual(block.valuationGaps, []);
});

test('buildDataQualityBlock surfaces unmatchedRequestedPeriods from the claim plan', () => {
  const block = buildDataQualityBlock({
    groundingStatus: null, valuationCoverage: [], coverage: null,
    claimPlan: { unmatchedRequestedPeriods: ['FY2015'] },
  });
  assert.ok(block);
  assert.deepEqual(block.unmatchedRequestedPeriods, ['FY2015']);
});

test('buildDataQualityBlock flattens valuationCoverage into named gaps with their reason', () => {
  const block = buildDataQualityBlock({
    groundingStatus: null, claimPlan: null, coverage: null,
    valuationCoverage: [
      { symbol: 'HAL', available: [], unavailable: [{ metric: 'PE', reason: 'no per-share earnings are held for a compatible period' }] },
      { symbol: 'BEL', available: [{ metric: 'PB', value: 1.2 }], unavailable: [] },
    ],
  });
  assert.ok(block);
  assert.equal(block.valuationGaps.length, 1);
  assert.equal(block.valuationGaps[0].symbol, 'HAL');
  assert.equal(block.valuationGaps[0].metric, 'PE');
});

test('buildDataQualityBlock surfaces coverage.limitations (Phase 4B, already shown directly in production today)', () => {
  const block = buildDataQualityBlock({
    groundingStatus: null, claimPlan: null, valuationCoverage: [],
    coverage: { limitations: ['Only Q1 FY2026 was available.'] },
  });
  assert.ok(block);
  assert.deepEqual(block.limitations, ['Only Q1 FY2026 was available.']);
});

// -----------------------------------------------------------------------
// buildSuggestedQuestionsBlock
// -----------------------------------------------------------------------

test('buildSuggestedQuestionsBlock is fully deterministic -- same intent+symbols always produce the exact same questions', () => {
  const state = { intent: 'COMPANY_RESEARCH', entities: { symbols: ['tcs'] } };
  const a = buildSuggestedQuestionsBlock(state);
  const b = buildSuggestedQuestionsBlock(state);
  assert.deepEqual(a, b);
  assert.ok(a.questions.every((q) => q.includes('TCS')), 'symbol is uppercased and substituted, never invented');
});

test('buildSuggestedQuestionsBlock returns null for an intent with no template (e.g. GENERAL_EDUCATION, UNSUPPORTED)', () => {
  assert.equal(buildSuggestedQuestionsBlock({ intent: 'GENERAL_EDUCATION', entities: { symbols: [] } }), null);
  assert.equal(buildSuggestedQuestionsBlock({ intent: 'UNSUPPORTED', entities: {} }), null);
  assert.equal(buildSuggestedQuestionsBlock({ intent: null, entities: {} }), null);
});

test('buildSuggestedQuestionsBlock returns null when the template needs a symbol and none was resolved', () => {
  assert.equal(buildSuggestedQuestionsBlock({ intent: 'COMPANY_RESEARCH', entities: { symbols: [] } }), null);
});

test('buildSuggestedQuestionsBlock produces a comparison template only with 2+ symbols', () => {
  assert.equal(buildSuggestedQuestionsBlock({ intent: 'STOCK_COMPARISON', entities: { symbols: ['TCS'] } }), null);
  const block = buildSuggestedQuestionsBlock({ intent: 'STOCK_COMPARISON', entities: { symbols: ['TCS', 'INFY'] } });
  assert.ok(block);
  assert.ok(block.questions[0].includes('TCS') && block.questions[0].includes('INFY'));
});

test('buildSuggestedQuestionsBlock never calls a model -- it is a plain synchronous function', () => {
  // If this were ever backed by an LLM it would need to be async; pinning
  // the synchronous return type is itself a guard against that regressing.
  const result = buildSuggestedQuestionsBlock({ intent: 'WATCHLIST_ANALYSIS', entities: {} });
  assert.equal(result instanceof Promise, false);
});

// -----------------------------------------------------------------------
// BLOCK_BUILDERS aggregate
// -----------------------------------------------------------------------

test('BLOCK_BUILDERS lists exactly the nine Phase 1B/1C builders, none more', () => {
  assert.equal(BLOCK_BUILDERS.length, 9);
  assert.deepEqual(
    BLOCK_BUILDERS.map((fn) => fn.name).sort(),
    [
      'buildChartBlock', 'buildCompanyHeaderBlock', 'buildComparisonTableBlock', 'buildDataQualityBlock', 'buildEvidenceDrawerBlock',
      'buildMetricGridBlock', 'buildNewsListBlock', 'buildSourceListBlock', 'buildSuggestedQuestionsBlock',
    ],
  );
});

test('every builder is a pure function of its `state` argument -- no shared mutable module state leaks between calls', () => {
  const evidence = [evidenceItem('TCS', 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', { reportingPeriod: 'FY2024' })];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = { claimPlan, evidence, citations: evidence, groundingStatus: null, valuationCoverage: [], coverage: null, intent: 'COMPANY_RESEARCH', entities: { symbols: ['TCS'] } };

  const before = JSON.stringify(state);
  for (const builder of BLOCK_BUILDERS) builder(state);
  assert.equal(JSON.stringify(state), before, 'no builder mutated the state it was given');
});
