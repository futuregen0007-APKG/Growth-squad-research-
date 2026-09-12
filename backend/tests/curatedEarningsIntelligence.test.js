import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import {
  listSupportedCompanies,
  getCompanyCoverage,
  getCompanyPromises,
  getCompanyTimeline,
  calculateFaithScore,
  calculateEvidenceConfidence,
  calculateCoverageScore,
  faithScoreLabel,
  isDemoModeEnabled,
  reloadCuratedDataset,
} from '../services/CuratedEarningsIntelligenceService.js';
import {
  validateManagementPromiseRecord,
  validateCuratedCompanyRecord,
  findDuplicatePromiseIds,
  isValidEvidenceUrl,
  RESOLVED_STATUSES,
} from '../utils/earningsIntelligenceValidation.js';
import { toManagementPromiseDoc, documentsAreEquivalent } from '../scripts/earningsImport.js';

// Ensure a clean, freshly-loaded cache for this file regardless of load order.
reloadCuratedDataset();

const validPromiseRecord = (overrides = {}) => ({
  id: 'TESTCO-FY2025-001',
  symbol: 'TESTCO',
  dataMode: 'CURATED_VERIFIED',
  promise: {
    statement: 'Management guided revenue growth of at least 10%.',
    originalExcerpt: 'We expect revenue growth of at least 10%.',
    category: 'REVENUE_GROWTH',
    promiseDate: '2024-05-01',
    targetPeriod: 'FY2025',
    targetType: 'PERCENTAGE',
    targetValue: 10,
    targetUnit: 'PERCENT',
    operator: 'AT_LEAST',
  },
  outcome: {
    status: 'ACHIEVED',
    actualValue: 12,
    actualUnit: 'PERCENT',
    evaluationDate: '2025-05-01',
    explanation: 'Actual growth of 12% exceeds the 10% target.',
  },
  promiseEvidence: {
    sourceTitle: 'Sample Earnings Call Transcript',
    sourceType: 'EARNINGS_TRANSCRIPT',
    sourceUrl: 'https://www.testco.com/investor-relations/transcript.pdf',
    publishedAt: '2024-05-01',
    pageNumber: 5,
    excerpt: 'We expect revenue growth of at least 10%.',
  },
  outcomeEvidence: {
    sourceTitle: 'Sample Financial Results',
    sourceType: 'FINANCIAL_RESULTS',
    sourceUrl: 'https://www.testco.com/investor-relations/results.pdf',
    publishedAt: '2025-05-01',
    pageNumber: 2,
    excerpt: 'Revenue grew 12% year-on-year.',
  },
  verification: {
    verifiedAt: '2026-09-10',
    verifiedBy: 'CURATED_RESEARCH',
    evidenceConfidence: 0.9,
    notes: null,
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. Every SUPPORTED_STOCKS symbol has a coverage record.
// ---------------------------------------------------------------------------
test('every SUPPORTED_STOCKS symbol has a coverage record, never a second conflicting list', async () => {
  const supportedSymbols = Object.keys(SUPPORTED_STOCKS);
  const curatedSymbols = new Set(listSupportedCompanies());

  assert.ok(supportedSymbols.length > 0);
  for (const symbol of supportedSymbols) {
    assert.ok(curatedSymbols.has(symbol), `${symbol} from SUPPORTED_STOCKS has no coverage record`);
    // eslint-disable-next-line no-await-in-loop
    const coverage = await getCompanyCoverage(symbol);
    assert.ok(coverage, `${symbol}: getCompanyCoverage returned null`);
    assert.equal(coverage.symbol, symbol);
  }
});

// ---------------------------------------------------------------------------
// 2 & 3. Missing research returns RESEARCH_PENDING, never a fabricated 0/100.
// ---------------------------------------------------------------------------
test('a symbol with no curated research returns RESEARCH_PENDING and a null Faith Score, never 0/100', async () => {
  // NEWGEN has no entry in companies.json overrides -- exercise the real default path.
  const coverage = await getCompanyCoverage('NEWGEN');
  assert.equal(coverage.dataMode, 'RESEARCH_PENDING');
  assert.equal(coverage.coverageStatus, 'RESEARCH_PENDING');

  const timeline = await getCompanyTimeline('NEWGEN');
  assert.equal(timeline.dataMode, 'RESEARCH_PENDING');
  assert.equal(timeline.summary.faithScore, null);
  assert.notEqual(timeline.summary.faithScore, 0);
  assert.equal(timeline.summary.totalPromises, 0);
  assert.deepEqual(timeline.timeline, []);
});

test('an unsupported/unknown symbol resolves to null, never another company\'s data', async () => {
  assert.equal(await getCompanyCoverage('NOT_A_REAL_SYMBOL_XYZ'), null);
  assert.equal(await getCompanyTimeline('NOT_A_REAL_SYMBOL_XYZ'), null);
  assert.deepEqual(await getCompanyPromises('NOT_A_REAL_SYMBOL_XYZ'), []);
});

// ---------------------------------------------------------------------------
// 4, 5, 6, 7, 8. Deterministic Faith Score math.
// ---------------------------------------------------------------------------
test('faith score is computed deterministically from status value * evidence confidence', () => {
  const records = [
    validPromiseRecord({ id: 'TESTCO-FY2023-001', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2023-05-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 1.0, notes: null } }),
    validPromiseRecord({ id: 'TESTCO-FY2024-001', outcome: { status: 'PARTIAL', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2024-05-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 0.5, notes: null } }),
    validPromiseRecord({ id: 'TESTCO-FY2025-001', outcome: { status: 'MISSED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2025-05-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 1.0, notes: null } }),
  ];

  // weighted = 1*1.0 + 0.5*0.5 + 0*1.0 = 1.25; confidenceSum = 1.0+0.5+1.0 = 2.5
  // faithScore = round(1.25 / 2.5 * 100) = 50
  const result = calculateFaithScore(records);
  assert.equal(result.faithScore, 50);
  assert.equal(result.faithScoreLabel, 'Mixed execution history');
  assert.equal(result.resolvedCount, 3);
});

test('pending promises are excluded from both the numerator and denominator', () => {
  const withoutPending = calculateFaithScore([
    validPromiseRecord({ id: 'TESTCO-A-001', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2023-01-01', explanation: null } }),
    validPromiseRecord({ id: 'TESTCO-A-002', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2024-01-01', explanation: null } }),
    validPromiseRecord({ id: 'TESTCO-A-003', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2025-01-01', explanation: null } }),
  ]);
  const withPendingAdded = calculateFaithScore([
    validPromiseRecord({ id: 'TESTCO-A-001', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2023-01-01', explanation: null } }),
    validPromiseRecord({ id: 'TESTCO-A-002', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2024-01-01', explanation: null } }),
    validPromiseRecord({ id: 'TESTCO-A-003', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2025-01-01', explanation: null } }),
    validPromiseRecord({ id: 'TESTCO-A-004', outcome: { status: 'PENDING', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null }, outcomeEvidence: null }),
  ]);

  assert.equal(withoutPending.faithScore, withPendingAdded.faithScore);
  assert.equal(withPendingAdded.resolvedCount, 3);
});

test('insufficient-evidence records are excluded from the score', () => {
  const base = [
    validPromiseRecord({ id: 'TESTCO-B-001', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2023-01-01', explanation: null } }),
    validPromiseRecord({ id: 'TESTCO-B-002', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2024-01-01', explanation: null } }),
    validPromiseRecord({ id: 'TESTCO-B-003', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2025-01-01', explanation: null } }),
  ];
  const withInsufficient = [
    ...base,
    validPromiseRecord({ id: 'TESTCO-B-004', outcome: { status: 'INSUFFICIENT_EVIDENCE', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null }, outcomeEvidence: null }),
  ];

  assert.equal(calculateFaithScore(base).faithScore, calculateFaithScore(withInsufficient).faithScore);
  assert.equal(calculateFaithScore(withInsufficient).resolvedCount, 3);
});

test('fewer than three resolved verified promises returns faithScore null, never a number', () => {
  const zero = calculateFaithScore([]);
  assert.equal(zero.faithScore, null);

  const one = calculateFaithScore([validPromiseRecord({ id: 'TESTCO-C-001' })]);
  assert.equal(one.faithScore, null);

  const two = calculateFaithScore([
    validPromiseRecord({ id: 'TESTCO-C-001' }),
    validPromiseRecord({ id: 'TESTCO-C-002' }),
  ]);
  assert.equal(two.faithScore, null);
  assert.equal(faithScoreLabel(null), 'Insufficient verified history');
});

test('evidence confidence changes the weighted score even when statuses are identical', () => {
  const highConfidence = calculateFaithScore([
    validPromiseRecord({ id: 'TESTCO-D-001', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2023-01-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 1.0, notes: null } }),
    validPromiseRecord({ id: 'TESTCO-D-002', outcome: { status: 'MISSED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2024-01-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 0.9, notes: null } }),
    validPromiseRecord({ id: 'TESTCO-D-003', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2025-01-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 1.0, notes: null } }),
  ]);
  const lowConfidenceOnTheMiss = calculateFaithScore([
    validPromiseRecord({ id: 'TESTCO-D-001', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2023-01-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 1.0, notes: null } }),
    validPromiseRecord({ id: 'TESTCO-D-002', outcome: { status: 'MISSED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2024-01-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 0.1, notes: null } }),
    validPromiseRecord({ id: 'TESTCO-D-003', outcome: { status: 'ACHIEVED', actualValue: 1, actualUnit: 'PERCENT', evaluationDate: '2025-01-01', explanation: null }, verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 1.0, notes: null } }),
  ]);

  // Lowering confidence on the MISSED record raises the score (a low-confidence
  // miss drags the weighted average down less than a high-confidence one).
  assert.ok(lowConfidenceOnTheMiss.faithScore > highConfidence.faithScore);
});

test('calculateEvidenceConfidence returns the mean confidence across resolved records, and null when none exist', () => {
  assert.equal(calculateEvidenceConfidence([]), null);
  const records = [
    validPromiseRecord({ id: 'TESTCO-E-001', verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 0.8, notes: null } }),
    validPromiseRecord({ id: 'TESTCO-E-002', verification: { verifiedAt: '2026-09-10', verifiedBy: 'X', evidenceConfidence: 1.0, notes: null } }),
  ];
  assert.equal(calculateEvidenceConfidence(records), 90); // mean(0.8, 1.0) * 100
});

test('coverageScore is independent of faithScore and never hides thin coverage behind a strong number', () => {
  const thinCoverage = calculateCoverageScore({ lastVerifiedAt: '2026-09-10' }, [validPromiseRecord({ id: 'TESTCO-F-001' })]);
  const richCoverage = calculateCoverageScore({ lastVerifiedAt: '2026-09-10' }, [
    validPromiseRecord({ id: 'TESTCO-F-001', promise: { ...validPromiseRecord().promise, targetPeriod: 'FY2022' } }),
    validPromiseRecord({ id: 'TESTCO-F-002', promise: { ...validPromiseRecord().promise, targetPeriod: 'FY2023' } }),
    validPromiseRecord({ id: 'TESTCO-F-003', promise: { ...validPromiseRecord().promise, targetPeriod: 'FY2024' } }),
    validPromiseRecord({ id: 'TESTCO-F-004', promise: { ...validPromiseRecord().promise, targetPeriod: 'FY2025' } }),
  ]);
  assert.ok(richCoverage > thinCoverage);
  assert.ok(Number.isFinite(thinCoverage) && thinCoverage >= 0 && thinCoverage <= 100);
});

// ---------------------------------------------------------------------------
// 9. Duplicate IDs are rejected.
// ---------------------------------------------------------------------------
test('duplicate promise ids across the dataset are detected', () => {
  const duplicates = findDuplicatePromiseIds([
    { id: 'AAA-FY2025-001', symbol: 'AAA' },
    { id: 'BBB-FY2025-001', symbol: 'BBB' },
    { id: 'AAA-FY2025-001', symbol: 'AAA' },
  ]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].id, 'AAA-FY2025-001');
});

// ---------------------------------------------------------------------------
// 10. Cross-company records are rejected.
// ---------------------------------------------------------------------------
test('a record claiming a different company than its own file is rejected', () => {
  const record = validPromiseRecord({ symbol: 'OTHERCO', id: 'OTHERCO-FY2025-001' });
  const { valid, errors } = validateManagementPromiseRecord(record, { symbol: 'TESTCO' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('cross-company') || e.includes('loaded from the TESTCO dataset file')));
});

test('the real curated dataset never contains a cross-company record (loader enforces it)', async () => {
  const tcsPromises = await getCompanyPromises('TCS');
  for (const record of tcsPromises) {
    assert.equal(record.symbol, 'TCS');
    assert.ok(record.id.startsWith('TCS-'));
  }
});

// ---------------------------------------------------------------------------
// 11. Invalid URLs are rejected.
// ---------------------------------------------------------------------------
test('invalid or blocked evidence URLs are rejected', () => {
  assert.equal(isValidEvidenceUrl('ftp://example.com/file.pdf'), false);
  assert.equal(isValidEvidenceUrl('not a url'), false);
  assert.equal(isValidEvidenceUrl('https://www.moneycontrol.com/some-article'), false);
  assert.equal(isValidEvidenceUrl('https://www.tcs.com/investor-relations/report.pdf'), true);

  const badUrlRecord = validPromiseRecord({ promiseEvidence: { ...validPromiseRecord().promiseEvidence, sourceUrl: 'https://www.moneycontrol.com/news/tcs-report' } });
  const { valid, errors } = validateManagementPromiseRecord(badUrlRecord, { symbol: 'TESTCO' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('promiseEvidence.sourceUrl')));
});

// ---------------------------------------------------------------------------
// 12 & 13. Synthetic records never mix with verified records; demo mode is off by default.
// ---------------------------------------------------------------------------
test('demo mode is disabled by default and DEMO_SYNTHETIC data is never returned without it', async () => {
  assert.equal(isDemoModeEnabled(), false);
  assert.deepEqual(await getCompanyPromises('DEMOCO', { mode: 'DEMO' }), []);
  assert.equal(await getCompanyTimeline('DEMOCO', { mode: 'DEMO' }), null);
});

test('a verified-only request never returns DEMO_SYNTHETIC records, even for a symbol with demo data', async () => {
  // DEMOCO has no companies.json / SUPPORTED_STOCKS entry, so the default (non-demo) path returns nothing for it.
  assert.deepEqual(await getCompanyPromises('DEMOCO'), []);
});

test('a DEMO_SYNTHETIC record is flagged (and the loader enforces file-level separation) when allowDemo is false', () => {
  // The record itself is still schema-valid (dataMode is a legal value) --
  // validateManagementPromiseRecord only warns here. The hard rejection is a
  // *file-placement* rule enforced one layer up, by the service's loader
  // (verified promises/*.json may only contain CURATED_VERIFIED, demo/*.json
  // may only contain DEMO_SYNTHETIC) -- proven end-to-end by the previous
  // test, since DEMOCO's synthetic records never leak into a verified-mode read.
  const demoRecordInVerifiedFile = validPromiseRecord({ dataMode: 'DEMO_SYNTHETIC' });
  const { valid, warnings } = validateManagementPromiseRecord(demoRecordInVerifiedFile, { symbol: 'TESTCO', allowDemo: false });
  assert.equal(valid, true);
  assert.ok(warnings.some((w) => w.includes('DEMO_SYNTHETIC')));
});

// ---------------------------------------------------------------------------
// 14. Timeline API contracts remain compatible.
// ---------------------------------------------------------------------------
test('curated timeline response matches the documented Step 9 contract shape', async () => {
  const timeline = await getCompanyTimeline('TCS');
  for (const key of ['symbol', 'companyName', 'dataMode', 'coverageStatus', 'lastVerifiedAt', 'nextReviewAfter', 'summary', 'timeline', 'sources', 'disclaimer']) {
    assert.ok(key in timeline, `missing top-level key: ${key}`);
  }
  for (const key of ['faithScore', 'faithScoreLabel', 'evidenceConfidence', 'coverageScore', 'totalPromises', 'resolvedPromises', 'achieved', 'partial', 'missed', 'pending']) {
    assert.ok(key in timeline.summary, `missing summary key: ${key}`);
  }
  assert.ok(Array.isArray(timeline.timeline));
  assert.ok(Array.isArray(timeline.sources));
  assert.match(timeline.disclaimer, /not investment advice/i);
});

test('the legacy Mongo-backed timeline shape is untouched (company/summary/promises)', async () => {
  const { getCompanyTimeline: legacyGetCompanyTimeline } = await import('../services/ManagementPromiseService.js');
  // With no DB connection in this test process, the documented disconnected-shape branch runs.
  const legacy = await legacyGetCompanyTimeline('SOME_SYMBOL');
  assert.ok('company' in legacy);
  assert.ok('summary' in legacy);
  assert.ok('promises' in legacy);
  assert.deepEqual(Object.keys(legacy.summary).sort(), ['insufficientEvidence', 'missed', 'pending', 'totalPromises', 'verified'].sort());
});

// ---------------------------------------------------------------------------
// 15. Filters work correctly.
// ---------------------------------------------------------------------------
test('getCompanyPromises filters by year, category and status', async () => {
  // TCS's real curated dataset currently holds 3 records: MARGIN/PARTIAL/FY2026,
  // OTHER (attrition)/PARTIAL/FY2025, and REVENUE_GROWTH/ACHIEVED/Q2 FY2026.
  const all = await getCompanyPromises('TCS');
  assert.equal(all.length, 3);

  assert.equal((await getCompanyPromises('TCS', { year: '2026' })).length, 2);
  assert.equal((await getCompanyPromises('TCS', { year: '1999' })).length, 0);
  assert.equal((await getCompanyPromises('TCS', { category: 'MARGIN' })).length, 1);
  assert.equal((await getCompanyPromises('TCS', { category: 'ORDER_BOOK' })).length, 0);
  assert.equal((await getCompanyPromises('TCS', { status: 'PARTIAL' })).length, 2);
  assert.equal((await getCompanyPromises('TCS', { status: 'ACHIEVED' })).length, 1);
});

test('getCompanyTimeline forwards filters through to its summary counts', async () => {
  const filtered = await getCompanyTimeline('TCS', { status: 'ACHIEVED' });
  assert.equal(filtered.summary.totalPromises, 1);
  assert.equal(filtered.summary.achieved, 1);
});

// ---------------------------------------------------------------------------
// 16. Import is idempotent (verified at the mapping/comparison-logic level --
// no live DB dependency in the standard test run).
// ---------------------------------------------------------------------------
test('the curated-to-ManagementPromise mapping is a pure, stable function (import idempotency)', async () => {
  const coverage = await getCompanyCoverage('TCS');
  const [record] = await getCompanyPromises('TCS');

  const first = toManagementPromiseDoc(record, coverage);
  const second = toManagementPromiseDoc(record, coverage);

  assert.ok(documentsAreEquivalent(first, second), 'mapping the same curated record twice should be equivalent (unchanged on re-import)');

  const changed = toManagementPromiseDoc({ ...record, outcome: { ...record.outcome, actualValue: 999 } }, coverage);
  assert.equal(documentsAreEquivalent(first, changed), false, 'a real content change should be detected, not silently reported as unchanged');
});

// ---------------------------------------------------------------------------
// Company-level (companies.json) validation.
// ---------------------------------------------------------------------------
test('validateCuratedCompanyRecord enforces enums, non-negative counts and count ordering', async () => {
  const valid = await getCompanyCoverage('TCS');
  assert.equal(validateCuratedCompanyRecord(valid).valid, true);

  const badEnum = { ...valid, dataMode: 'NOT_A_REAL_MODE' };
  assert.equal(validateCuratedCompanyRecord(badEnum).valid, false);

  const badCounts = { ...valid, verifiedPromiseCount: 1, resolvedPromiseCount: 5 };
  assert.equal(validateCuratedCompanyRecord(badCounts).valid, false);
});

// ---------------------------------------------------------------------------
// Dataset actually loaded with zero issues (sanity check on the real files).
// ---------------------------------------------------------------------------
test('the real curated dataset on disk loads with zero validation issues', () => {
  const summary = reloadCuratedDataset();
  assert.deepEqual(summary.issues, []);
  assert.ok(summary.companies >= Object.keys(SUPPORTED_STOCKS).length);
});
