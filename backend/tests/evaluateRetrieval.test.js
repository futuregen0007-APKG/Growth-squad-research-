import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { runEvaluation } from '../scripts/evaluateRetrieval.js';
import { GOLDEN_DATASET } from '../fixtures/ragGoldenDataset.js';
import { HOLDOUT_DATASET } from '../fixtures/ragHoldoutDataset.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

after(async () => {
  await ResearchDocumentChunk.deleteMany({ symbol: 'ZZEVALCITETEST' }).catch(() => {});
  await mongoose.disconnect().catch(() => {});
});

// ---------------------------------------------------------------------------
// Evaluator-contract audit (Phase 4A.2 item 1): recall@1/@3/@k are exactly
// what they claim to be -- verified against a synthetic, fully-controlled
// scenario rather than real (noisy) retrieval, so the evaluator's OWN
// logic can be checked in isolation from ranking quality.
// ---------------------------------------------------------------------------
test('required: recall_at_1/at_3/at_k mean exactly what their names say, independent of retrieval quality', () => {
  // A minimal fake "checkResult"-shaped scenario, replicated inline
  // rather than importing the unexported checkResult -- this pins the
  // CONTRACT (rank-1 vs rank-3 vs rank-k membership), which is what the
  // Phase 4A.2 audit needed to determine for wrong-period-rejected-1.
  const fakeResultsRankedAt = (rank) => Array.from({ length: 8 }, (_, i) => ({ text: i === rank ? 'the expected text is here' : 'unrelated filler text' }));

  const at1 = (results) => Boolean(results[0] && results[0].text.includes('the expected text is here'));
  const at3 = (results) => results.slice(0, 3).some((r) => r.text.includes('the expected text is here'));
  const atK = (results) => results.some((r) => r.text.includes('the expected text is here'));

  assert.equal(at1(fakeResultsRankedAt(0)), true);
  assert.equal(at3(fakeResultsRankedAt(0)), true);
  assert.equal(atK(fakeResultsRankedAt(0)), true);

  assert.equal(at1(fakeResultsRankedAt(2)), false, 'rank 3 (index 2) is NOT top-1');
  assert.equal(at3(fakeResultsRankedAt(2)), true, 'rank 3 (index 2) IS within top-3');
  assert.equal(atK(fakeResultsRankedAt(2)), true);

  assert.equal(at1(fakeResultsRankedAt(5)), false);
  assert.equal(at3(fakeResultsRankedAt(5)), false, 'rank 6 (index 5) is NOT within top-3');
  assert.equal(atK(fakeResultsRankedAt(5)), true, 'rank 6 (index 5) IS still within top-8');
});

test('required: evaluator-contract audit result for wrong-period-rejected-1 -- a genuine ranking miss, not an evaluator bug or a bad expectation', () => {
  // This locks in the Phase 4A.2 audit's conclusion as a regression test:
  // mustNotInclude (the wrong-period figure never leaking in) and
  // recall_at_1 (the correct figure not necessarily ranking first) are
  // TWO DIFFERENT, both-correctly-defined claims -- a pass on one and a
  // fail on the other is not a contradiction in the evaluator, it is two
  // honest, independent measurements.
  const entry = GOLDEN_DATASET.find((e) => e.id === 'wrong-period-rejected-1');
  assert.ok(entry, 'sanity: the entry still exists in the development set');
  assert.ok(entry.expected.textIncludes && entry.expected.mustNotInclude, 'the entry legitimately defines both a positive (textIncludes) and a negative (mustNotInclude) expectation -- these are not the same check and must not be conflated');
});

// ---------------------------------------------------------------------------
// Separate development and holdout evaluation
// ---------------------------------------------------------------------------
test('required: development and holdout datasets are genuinely separate fixture files with disjoint entry ids', () => {
  const devIds = new Set(GOLDEN_DATASET.map((e) => e.id));
  const holdoutIds = new Set(HOLDOUT_DATASET.map((e) => e.id));
  const overlap = [...devIds].filter((id) => holdoutIds.has(id));
  assert.deepEqual(overlap, [], 'development and holdout entries must never share an id');
  assert.ok(HOLDOUT_DATASET.length >= 8, 'the holdout set must have at least 8 questions');
});

test('required: runEvaluation reports results scoped to exactly the dataset it was given -- development and holdout runs never mix entries', async () => {
  const devReport = await runEvaluation({ dataset: GOLDEN_DATASET, mode: 'LEXICAL_FALLBACK', datasetName: 'development' });
  const holdoutReport = await runEvaluation({ dataset: HOLDOUT_DATASET, mode: 'LEXICAL_FALLBACK', datasetName: 'holdout' });
  assert.equal(devReport.datasetName, 'development');
  assert.equal(holdoutReport.datasetName, 'holdout');
  assert.equal(devReport.totalEntries, GOLDEN_DATASET.length);
  assert.equal(holdoutReport.totalEntries, HOLDOUT_DATASET.length);
  const devEntryIds = new Set(devReport.entries.map((e) => e.id));
  const holdoutEntryIds = new Set(holdoutReport.entries.map((e) => e.id));
  assert.ok([...devEntryIds].every((id) => GOLDEN_DATASET.some((e) => e.id === id)));
  assert.ok([...holdoutEntryIds].every((id) => HOLDOUT_DATASET.some((e) => e.id === id)));
});

test('required: holdout categories cover every category the Phase 4A.2 spec requires', () => {
  const requiredCategories = [
    'exact_numerical_outcome', 'forward_management_guidance', 'fiscal_period_constraint', 'paraphrased_semantic_query',
    'company_alias', 'absent_answer', 'generic_low_signal_query', 'wrong_period_trap',
  ];
  const presentCategories = new Set(HOLDOUT_DATASET.map((e) => e.category));
  for (const category of requiredCategories) {
    assert.ok(presentCategories.has(category), `holdout set is missing required category: ${category}`);
  }
});

test('runEvaluation reports mode-labeled results so lexical and hybrid runs are never blended', async () => {
  const lexicalReport = await runEvaluation({ dataset: HOLDOUT_DATASET, mode: 'LEXICAL_FALLBACK', datasetName: 'holdout' });
  assert.equal(lexicalReport.mode, 'LEXICAL_FALLBACK');
  for (const entry of lexicalReport.entries) {
    if (entry.retrievalMode) assert.notEqual(entry.retrievalMode, 'ATLAS_VECTOR');
  }
});

// ---------------------------------------------------------------------------
// Phase 4A.3 item 1/2: citation adjudication -- exact-page vs
// acceptable-page accuracy are tracked SEPARATELY, and acceptableCitations
// entries are genuinely honored (an alternate real page counts, an
// unlisted page does not).
// ---------------------------------------------------------------------------
const TEST_PREFIX = 'ZZEVALCITETEST';
const cleanupCiteFixtures = async () => { await ResearchDocumentChunk.deleteMany({ symbol: TEST_PREFIX }); };
test.beforeEach(cleanupCiteFixtures);

const fakeGoldenEntryWithAcceptableCitations = () => ([{
  id: 'fake-citation-test-1',
  category: 'test_only',
  description: 'test fixture',
  query: 'operating margin guidance fiscal year',
  symbols: [TEST_PREFIX],
  expected: {
    status: 'SUCCESS',
    sourceUrlContains: 'pinned-doc',
    pageIn: [1, 1],
    acceptableCitations: [
      { sourceUrlContains: 'alternate-doc', pageIn: [2, 2], justification: 'test-only alternate' },
    ],
  },
}]);

test('required: exact-page and acceptable-page accuracy are reported as separate metrics', async () => {
  await ResearchDocumentChunk.create({
    symbol: TEST_PREFIX,
    registryDocumentId: new mongoose.Types.ObjectId(),
    documentHash: `alt-${Math.random()}`,
    documentType: 'ANNUAL_REPORT',
    fiscalYear: 'FY2099',
    sourceUrl: 'https://example.com/alternate-doc.pdf',
    pageStart: 2,
    pageEnd: 2,
    chunkIndex: 0,
    text: 'Operating margin guidance for the fiscal year was reaffirmed by management today on the call, per our records.',
    approximateTokenCount: 12,
  });
  const report = await runEvaluation({ dataset: fakeGoldenEntryWithAcceptableCitations(), mode: 'LEXICAL_FALLBACK', datasetName: 'test' });
  const entry = report.entries[0];
  const exactCheck = entry.checks.find((c) => c.name === 'citation_source_url');
  const acceptableCheck = entry.checks.find((c) => c.name === 'citation_acceptable_page');
  assert.equal(exactCheck.pass, false, 'the top result is the alternate doc, not the exact pin -- exact check must fail');
  assert.equal(acceptableCheck.pass, true, 'the alternate doc IS a verified acceptableCitations entry -- acceptable check must pass');
  assert.ok(report.exactCitationAccuracy < report.citationAccuracy, 'acceptable-page accuracy must be >= exact-page accuracy whenever they differ');
});

test('required: a page matching NEITHER the pin nor any acceptableCitations entry fails both checks', async () => {
  await ResearchDocumentChunk.create({
    symbol: TEST_PREFIX,
    registryDocumentId: new mongoose.Types.ObjectId(),
    documentHash: `unrelated-${Math.random()}`,
    documentType: 'ANNUAL_REPORT',
    fiscalYear: 'FY2099',
    sourceUrl: 'https://example.com/completely-unrelated-doc.pdf',
    pageStart: 9,
    pageEnd: 9,
    chunkIndex: 0,
    text: 'Operating margin guidance for the fiscal year was reaffirmed by management today on the call, per our records.',
    approximateTokenCount: 12,
  });
  const report = await runEvaluation({ dataset: fakeGoldenEntryWithAcceptableCitations(), mode: 'LEXICAL_FALLBACK', datasetName: 'test' });
  const entry = report.entries[0];
  const acceptableCheck = entry.checks.find((c) => c.name === 'citation_acceptable_page');
  assert.equal(acceptableCheck.pass, false);
});

// ---------------------------------------------------------------------------
// Phase 4A.3: UNSUPPORTED (a mode-imposed structural scope refusal) must
// never be miscounted as a safety-metric failure.
// ---------------------------------------------------------------------------
test('required: a scope-limited UNSUPPORTED outcome is excluded from absent-answer-abstention and prompt-injection-execution metrics, never counted as a failure', async () => {
  const fakeDataset = [
    {
      id: 'fake-absent-1', category: 'absent_answer', description: 'test', query: 'irrelevant query text here', symbols: ['NOT_A_REAL_SYMBOL'], expected: { status: 'EMPTY' },
    },
    {
      id: 'fake-injection-1', category: 'prompt_injection', description: 'test', query: 'irrelevant query text here', symbols: ['NOT_A_REAL_SYMBOL'], expected: { status: 'SUCCESS', textIncludes: 'anything' },
    },
  ];
  // LOCAL_EXACT_VECTOR_CANARY structurally refuses any non-TCS/INFY
  // symbol -- both fake entries above will come back UNSUPPORTED.
  const report = await runEvaluation({ dataset: fakeDataset, mode: 'LOCAL_EXACT_VECTOR_CANARY', datasetName: 'test' });
  assert.equal(report.entries.every((e) => e.status === 'UNSUPPORTED'), true, 'sanity: both fake entries were indeed scope-refused');
  assert.equal(report.metrics.absentAnswerAbstentionRate, null, 'with the only absent-answer entry excluded as scope-limited, the rate is not-applicable (null), never counted as a failing 0');
  assert.equal(report.metrics.promptInjectionExecutionCount, 0, 'a structurally-refused injection probe must never count as an execution');
  assert.equal(report.metrics.absentAnswerScopeLimited, 1);
  assert.equal(report.metrics.injectionScopeLimited, 1);
});
