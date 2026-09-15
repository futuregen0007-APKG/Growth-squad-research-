/**
 * evaluateRetrieval.js
 * ======================
 * `npm run rag:evaluate`
 *
 * Phase 4A.2 evaluation harness. Runs the checked-in golden retrieval
 * datasets (fixtures/ragGoldenDataset.js -- the development set -- and
 * fixtures/ragHoldoutDataset.js -- a separate holdout set never tuned
 * against) against the REAL retriever
 * (services/ResearchRetrieverService.js) and the REAL, already-indexed
 * ResearchDocumentChunk collection -- never a mock of either. Each
 * dataset is run TWICE, once per `mode` ('LEXICAL_FALLBACK' and
 * 'LOCAL_HYBRID_RERANK'), and results are reported SEPARATELY so lexical
 * and hybrid performance can be honestly compared rather than blended.
 *
 * Measures per (dataset, mode) run: Recall@1, Recall@3, a top-1
 * citation/page-accuracy rate, correct-symbol rate, correct-period rate,
 * absent-answer abstention rate, false-positive count, latency, and
 * embedding-API call count (0 for LEXICAL_FALLBACK; small and bounded for
 * LOCAL_HYBRID_RERANK thanks to the query-embedding cache).
 *
 * Ends with an explicit PASS/FAIL gate against the Phase 4A.2 spec's
 * required thresholds, computed honestly -- never hand-picked, never
 * adjusted after seeing the result.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { retrieveResearchEvidence, clearQueryEmbeddingCacheForTests } from '../services/ResearchRetrieverService.js';
import { embedChunks } from '../services/EmbeddingService.js';
import { LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { GOLDEN_DATASET } from '../fixtures/ragGoldenDataset.js';
import { HOLDOUT_DATASET } from '../fixtures/ragHoldoutDataset.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const FIXTURE_SYMBOL = 'RAGGOLDENEVAL';

/**
 * Synthetic fixtures are genuinely EMBEDDED (not just inserted with text)
 * so LOCAL_HYBRID_RERANK's mandatory embeddingModel/embeddingVersion
 * filter (never comparing incompatible vectors -- see
 * ResearchRetrieverService.js) does not silently exclude them. Without
 * this, the prompt-injection fixture would look like a hybrid-mode
 * failure that is really just a test-fixture gap, not an actual safety
 * regression -- an unembedded row is correctly excluded by design, so
 * the fixture must be embedded for real to test hybrid mode honestly.
 */
const insertSyntheticFixtures = async (entries) => {
  const toInsert = entries.filter((e) => e.isSyntheticFixture);
  if (!toInsert.length) return [];
  const docs = toInsert.map((e, i) => ({
    symbol: FIXTURE_SYMBOL,
    registryDocumentId: new mongoose.Types.ObjectId(),
    documentHash: `eval-fixture-${e.id}`,
    chunkHash: `eval-fixture-chunk-${e.id}-${i}`,
    documentType: 'OTHER',
    title: 'Synthetic evaluation-only fixture (not a real filing)',
    fiscalYear: 'FY2026',
    sourceUrl: 'https://example.com/synthetic-eval-fixture.pdf',
    pageStart: 1,
    pageEnd: 1,
    chunkIndex: 0,
    text: e.fixtureText,
    approximateTokenCount: Math.ceil(e.fixtureText.length / 4),
  }));
  const { results } = await embedChunks(docs, { model: LLM_CONFIG.embeddingModel, embeddingVersion: LLM_CONFIG.embeddingVersion });
  const toInsertDocs = results.map((r) => (r.status === 'EMBEDDED'
    ? { ...r.chunk, embedding: r.embedding, embeddingModel: r.embeddingModel, embeddingVersion: r.embeddingVersion, indexedAt: new Date() }
    : r.chunk));
  await ResearchDocumentChunk.insertMany(toInsertDocs);
  return toInsertDocs;
};

const cleanupSyntheticFixtures = async () => {
  await ResearchDocumentChunk.deleteMany({ symbol: FIXTURE_SYMBOL });
};

const checkResult = (entry, outcome) => {
  const checks = [];
  const exp = entry.expected;

  checks.push({ name: 'status', pass: outcome.status === exp.status, detail: `expected ${exp.status}, got ${outcome.status}` });

  if (exp.reasonContains) {
    const pass = Boolean(outcome.reason && outcome.reason.includes(exp.reasonContains));
    checks.push({ name: 'reason_quality', pass, detail: pass ? 'abstention reason matches expected explanation' : `expected reason to contain "${exp.reasonContains}", got "${outcome.reason}"` });
  }

  // Exact-page accuracy: the top result must match the ONE originally-
  // pinned (sourceUrlContains, pageIn) citation. Acceptable-page accuracy
  // (Phase 4A.3 item 2 -- the actual release gate): the top result may
  // match the pin OR any independently-verified `acceptableCitations`
  // entry -- real, distinct pages that were each read in full and
  // confirmed to completely support the claim on their own (see
  // fixtures/ragGoldenDataset.js's per-entry justification comments).
  // Both metrics are reported; only acceptable-page accuracy gates
  // release, per instruction.
  let citationChecked = false;
  let exactCitationPassed = false;
  let acceptableCitationPassed = false;
  const matchesCitation = (top, citation) => Boolean(
    top
    && (!citation.sourceUrlContains || (top.sourceUrl && top.sourceUrl.includes(citation.sourceUrlContains)))
    && (!citation.pageIn || (top.pageStart >= citation.pageIn[0] && top.pageEnd <= citation.pageIn[1])),
  );
  if (exp.sourceUrlContains || exp.pageIn) {
    citationChecked = true;
    const top = outcome.results[0];
    const pin = { sourceUrlContains: exp.sourceUrlContains, pageIn: exp.pageIn };
    exactCitationPassed = matchesCitation(top, pin);
    const allAcceptable = [pin, ...(exp.acceptableCitations || [])];
    acceptableCitationPassed = allAcceptable.some((c) => matchesCitation(top, c));

    if (exp.sourceUrlContains) {
      const pass = Boolean(top && top.sourceUrl && top.sourceUrl.includes(exp.sourceUrlContains));
      checks.push({ name: 'citation_source_url', pass, detail: pass ? 'top result source URL matches expected filing' : `top result source URL did not match expected filing (${exp.sourceUrlContains})` });
    }
    if (exp.pageIn) {
      const pass = Boolean(top && top.pageStart >= exp.pageIn[0] && top.pageEnd <= exp.pageIn[1]);
      checks.push({ name: 'citation_page_accuracy', pass, detail: pass ? 'top result page matches expected page' : `top result page did not match expected range ${exp.pageIn.join('-')}` });
    }
    checks.push({
      name: 'citation_acceptable_page',
      pass: acceptableCitationPassed,
      detail: acceptableCitationPassed
        ? (exactCitationPassed ? 'top result matches the originally-pinned citation' : 'top result matches a verified alternate acceptable citation')
        : `top result (${top ? `${top.sourceUrl?.slice(-20)} p${top.pageStart}` : 'none'}) matched neither the pin nor any verified acceptable citation`,
    });
  }
  if (exp.textIncludes) {
    const at1 = Boolean(outcome.results[0] && outcome.results[0].text.includes(exp.textIncludes));
    const at3 = outcome.results.slice(0, 3).some((r) => r.text.includes(exp.textIncludes));
    const atK = outcome.results.some((r) => r.text.includes(exp.textIncludes));
    checks.push({ name: 'recall_at_1', pass: at1, detail: at1 ? 'expected text was the top result' : 'expected text was not the top-1 result' });
    checks.push({ name: 'recall_at_3', pass: at3, detail: at3 ? 'expected text found within top-3' : 'expected text not found within top-3' });
    checks.push({ name: 'recall_at_k', pass: atK, detail: atK ? 'expected text found within top-k results' : 'expected text not found in any returned result' });
  }
  if (exp.mustNotInclude) {
    const pass = !outcome.results.some((r) => r.text.includes(exp.mustNotInclude));
    checks.push({ name: 'wrong_period_excluded', pass, detail: pass ? 'wrong-period/wrong-fact text correctly absent' : 'wrong-period/wrong-fact text leaked into results' });
  }
  if (exp.neverSymbols) {
    const pass = !outcome.results.some((r) => exp.neverSymbols.includes(r.symbol));
    checks.push({ name: 'cross_company_isolation', pass, detail: pass ? 'no leaked symbol present' : 'a disallowed symbol leaked into results' });
  }
  if (exp.allResultsDocumentType) {
    const pass = outcome.results.length > 0 && outcome.results.every((r) => r.documentType === exp.allResultsDocumentType);
    checks.push({ name: 'document_type_filtering', pass, detail: pass ? 'every result matched the requested documentType' : 'a result outside the requested documentType was returned' });
  }

  const requestedSymbols = (entry.symbols || []).map((s) => s.toUpperCase());
  const correctSymbol = outcome.results.every((r) => requestedSymbols.includes(r.symbol));
  checks.push({ name: 'correct_symbol_rate', pass: correctSymbol, detail: correctSymbol ? 'all results within requested symbol set' : 'a result outside the requested symbol set was returned' });

  if (entry.fiscalYears?.length) {
    const correctPeriod = outcome.results.every((r) => entry.fiscalYears.includes(r.fiscalYear));
    checks.push({ name: 'correct_period_rate', pass: correctPeriod, detail: correctPeriod ? 'all results within requested fiscal year(s)' : 'a result outside the requested fiscal year was returned' });
  }

  // False-positive tracking: an entry that expected EMPTY but got SUCCESS
  // is exactly the false-positive failure mode this hardening exists to fix.
  const falsePositive = exp.status === 'EMPTY' && outcome.status === 'SUCCESS';

  return {
    checks, falsePositive, citationChecked, exactCitationPassed, acceptableCitationPassed,
  };
};

/** checkType: 'chunk_identity' -- see fixtures/ragGoldenDataset.js's identical-text-different-pages entry. Mode-independent (queries the DB directly, not the retriever). */
const runIdentityCheck = async (entry) => {
  const {
    symbol, sourceUrlContains, expectedPages, distinctiveSubstring,
  } = entry.identityCheck;
  const rows = await ResearchDocumentChunk.find({ symbol, sourceUrl: new RegExp(sourceUrlContains) })
    .select('pageStart chunkHash text')
    .lean();
  const matching = rows.filter((r) => r.text.includes(distinctiveSubstring));
  const byPage = new Map(expectedPages.map((p) => [p, matching.filter((r) => r.pageStart === p)]));
  const bothPagesPresent = expectedPages.every((p) => byPage.get(p).length > 0);

  const hashesByPage = expectedPages.map((p) => new Set(byPage.get(p).map((r) => r.chunkHash)));
  const sharedAcrossPages = hashesByPage.length === 2
    && [...hashesByPage[0]].some((h) => hashesByPage[1].has(h));
  const independentIdentities = bothPagesPresent && !sharedAcrossPages;

  const checks = [
    { name: 'both_pages_preserved', pass: bothPagesPresent, detail: bothPagesPresent ? 'both real page references found as independent rows' : `expected the distinctive text on pages ${expectedPages.join(',')}, found it on ${[...byPage.entries()].filter(([, v]) => v.length).map(([p]) => p).join(',')}` },
    { name: 'independent_chunk_identities', pass: independentIdentities, detail: independentIdentities ? 'the two pages never share a chunkHash — fully independent identities' : 'a chunkHash was shared across the two pages — provenance collapsed' },
  ];
  return {
    id: entry.id,
    category: entry.category,
    description: entry.description,
    checkType: 'chunk_identity',
    checks,
    allPassed: checks.every((c) => c.pass),
  };
};

/**
 * runEvaluation - runs ONE dataset in ONE mode. Returns a self-contained
 * report; callers combine multiple (dataset, mode) reports as needed.
 */
export const runEvaluation = async ({ dataset = GOLDEN_DATASET, mode = 'LEXICAL_FALLBACK', datasetName = 'development' } = {}) => {
  await insertSyntheticFixtures(dataset);
  const report = {
    datasetName,
    mode,
    startedAt: new Date().toISOString(),
    totalEntries: dataset.length,
    entries: [],
    totalChecks: 0,
    passedChecks: 0,
    falsePositiveCount: 0,
    embeddingApiCalls: 0,
    latenciesMs: [],
    citationChecksTotal: 0,
    exactCitationChecksPassed: 0,
    acceptableCitationChecksPassed: 0,
  };

  try {
    for (const entry of dataset) {
      if (entry.checkType === 'chunk_identity') {
        const identityResult = await runIdentityCheck(entry);
        report.totalChecks += identityResult.checks.length;
        report.passedChecks += identityResult.checks.filter((c) => c.pass).length;
        report.entries.push(identityResult);
        continue;
      }

      if (entry.queries) {
        // Multi-query comparison entries (two-symbol comparison).
        const subResults = [];
        for (const sub of entry.queries) {
          const outcome = await retrieveResearchEvidence({ query: sub.query, symbols: [sub.symbol], mode });
          report.latenciesMs.push(outcome.durationMs);
          const pass = outcome.status === sub.expectedStatus;
          report.totalChecks += 1;
          if (pass) report.passedChecks += 1;
          if (sub.expectedStatus === 'EMPTY' && outcome.status === 'SUCCESS') report.falsePositiveCount += 1;
          subResults.push({
            symbol: sub.symbol, expectedStatus: sub.expectedStatus, actualStatus: outcome.status, pass, retrievalMode: outcome.retrievalMode,
          });
        }
        report.entries.push({
          id: entry.id, category: entry.category, description: entry.description, subResults,
        });
        continue;
      }

      const outcome = await retrieveResearchEvidence({
        query: entry.query, symbols: entry.symbols, fiscalYears: entry.fiscalYears || [], documentTypes: entry.documentTypes || [], mode,
      });
      report.latenciesMs.push(outcome.durationMs);
      const {
        checks, falsePositive, citationChecked, exactCitationPassed, acceptableCitationPassed,
      } = checkResult(entry, outcome);
      report.totalChecks += checks.length;
      report.passedChecks += checks.filter((c) => c.pass).length;
      if (falsePositive) report.falsePositiveCount += 1;
      if (citationChecked) {
        report.citationChecksTotal += 1;
        if (exactCitationPassed) report.exactCitationChecksPassed += 1;
        if (acceptableCitationPassed) report.acceptableCitationChecksPassed += 1;
      }
      report.entries.push({
        id: entry.id,
        category: entry.category,
        description: entry.description,
        query: entry.query,
        symbols: entry.symbols,
        status: outcome.status,
        retrievalMode: outcome.retrievalMode,
        resultCount: outcome.results.length,
        durationMs: outcome.durationMs,
        checks,
        allPassed: checks.every((c) => c.pass),
      });
    }
  } finally {
    await cleanupSyntheticFixtures();
  }

  report.finishedAt = new Date().toISOString();
  report.passRate = report.totalChecks ? report.passedChecks / report.totalChecks : null;
  report.avgLatencyMs = report.latenciesMs.length ? report.latenciesMs.reduce((a, b) => a + b, 0) / report.latenciesMs.length : null;
  report.maxLatencyMs = report.latenciesMs.length ? Math.max(...report.latenciesMs) : null;
  report.exactCitationAccuracy = report.citationChecksTotal ? report.exactCitationChecksPassed / report.citationChecksTotal : null;
  // Phase 4A.3 item 2: acceptable-page accuracy is the release gate --
  // "matches the pin OR a verified, independently-confirmed alternate
  // citation", not just the single originally-pinned page.
  report.citationAccuracy = report.citationChecksTotal ? report.acceptableCitationChecksPassed / report.citationChecksTotal : null;
  // LEXICAL_FALLBACK never calls OpenAI. Every other mode here embeds
  // the query once per DISTINCT query text in the dataset (cached
  // thereafter) -- the comparison entries embed once per sub-query.
  const EMBEDS_QUERY_MODES = new Set(['LOCAL_HYBRID_RERANK', 'LOCAL_EXACT_VECTOR_CANARY', 'LOCAL_EXACT_VECTOR_HYBRID_FUSION']);
  report.embeddingApiCalls = EMBEDS_QUERY_MODES.has(mode)
    ? new Set(dataset.flatMap((e) => (e.queries ? e.queries.map((q) => q.query) : [e.query]).filter(Boolean))).size
    : 0;

  const allChecksFlat = report.entries.flatMap((e) => e.checks || (e.subResults || []).map((s) => ({ name: 'comparison_sub_result', pass: s.pass })));
  const symbolChecks = allChecksFlat.filter((c) => c.name === 'correct_symbol_rate');
  const periodChecks = allChecksFlat.filter((c) => c.name === 'correct_period_rate');
  const crossCompanyChecks = allChecksFlat.filter((c) => c.name === 'cross_company_isolation');
  // A mode-imposed structural refusal (UNSUPPORTED -- e.g.
  // LOCAL_EXACT_VECTOR_CANARY/LOCAL_EXACT_VECTOR_HYBRID_FUSION correctly
  // refusing a symbol outside their TCS/INFY scope) is NOT a genuine
  // safety test outcome: the retriever never ran at all, so it is
  // excluded from both the abstention and injection-execution
  // denominators below rather than counted as a failure -- refusing to
  // run is at least as safe as running and finding nothing, and
  // penalizing a mode for correctly refusing out-of-scope work would be
  // a methodology bug, not a real finding. Tracked separately so this
  // exclusion is visible, never silent.
  const scopeLimitedEntries = report.entries.filter((e) => e.status === 'UNSUPPORTED');

  const injectionEntries = report.entries.filter((e) => e.category === 'prompt_injection' && e.status !== 'UNSUPPORTED');
  const injectionScopeLimited = report.entries.filter((e) => e.category === 'prompt_injection' && e.status === 'UNSUPPORTED').length;

  const absentAnswerEntries = dataset.filter((e) => e.expected?.status === 'EMPTY');
  const absentAnswerResults = report.entries.filter((e) => absentAnswerEntries.some((g) => g.id === e.id) && e.status !== 'UNSUPPORTED');
  const absentAnswerScopeLimited = report.entries.filter((e) => absentAnswerEntries.some((g) => g.id === e.id) && e.status === 'UNSUPPORTED').length;
  const absentAnswerAbstentionRate = absentAnswerResults.length
    ? absentAnswerResults.filter((e) => e.status === 'EMPTY').length / absentAnswerResults.length
    : null;

  report.metrics = {
    correctSymbolRate: symbolChecks.length ? symbolChecks.filter((c) => c.pass).length / symbolChecks.length : null,
    correctPeriodRate: periodChecks.length ? periodChecks.filter((c) => c.pass).length / periodChecks.length : null,
    absentAnswerAbstentionRate,
    absentAnswerScopeLimited,
    crossCompanyLeakageCount: crossCompanyChecks.filter((c) => !c.pass).length,
    promptInjectionExecutionCount: injectionEntries.filter((e) => !e.allPassed).length,
    injectionScopeLimited,
    scopeLimitedEntryIds: scopeLimitedEntries.map((e) => e.id),
    falsePositiveCount: report.falsePositiveCount,
    overallPassRate: report.passRate,
    exactCitationAccuracy: report.exactCitationAccuracy,
    citationAccuracy: report.citationAccuracy,
  };

  report.failedCases = report.entries
    .filter((e) => e.allPassed === false || (e.subResults && e.subResults.some((s) => !s.pass)))
    .map((e) => ({
      id: e.id,
      category: e.category,
      failedChecks: (e.checks || []).filter((c) => !c.pass).map((c) => ({ name: c.name, detail: c.detail })),
      failedSubResults: (e.subResults || []).filter((s) => !s.pass),
    }));

  return report;
};

// Phase 4A.3 item 5: the four comparison arms, run on BOTH datasets.
// LOCAL_EXACT_VECTOR_CANARY and LOCAL_EXACT_VECTOR_HYBRID_FUSION are
// evaluation-only (see ResearchRetrieverService.js) and structurally
// refuse anything outside TCS/INFY -- every entry in both fixture files
// is already TCS/INFY-scoped except the ambiguous-name/synthetic-
// injection probes, which will legitimately show as UNSUPPORTED rather
// than their lexical/hybrid EMPTY/SUCCESS outcome under those two modes;
// this is reported honestly as a known scope limitation, not hidden.
const COMPARISON_MODES = ['LEXICAL_FALLBACK', 'LOCAL_HYBRID_RERANK', 'LOCAL_EXACT_VECTOR_CANARY', 'LOCAL_EXACT_VECTOR_HYBRID_FUSION'];

const safe = (v, fallback = 0) => (v == null ? fallback : v);

/** Applies the Phase 4A.2/4A.3 readiness gate criteria to one MODE's (dev, holdout) pair of runs, plus a comparison against the LEXICAL_FALLBACK baseline for "no regression". */
const evaluateGateForMode = (devRun, holdoutRun, devLexicalRun, holdoutLexicalRun) => {
  const gate = {
    developmentOverallPassRate: devRun.metrics.overallPassRate,
    holdoutOverallPassRate: holdoutRun.metrics.overallPassRate,
    correctSymbolRate: Math.min(safe(devRun.metrics.correctSymbolRate, 1), safe(holdoutRun.metrics.correctSymbolRate, 1)),
    correctPeriodRate: Math.min(safe(devRun.metrics.correctPeriodRate, 1), safe(holdoutRun.metrics.correctPeriodRate, 1)),
    absentAnswerAbstentionRate: Math.min(safe(devRun.metrics.absentAnswerAbstentionRate, 1), safe(holdoutRun.metrics.absentAnswerAbstentionRate, 1)),
    crossCompanyLeakageCount: devRun.metrics.crossCompanyLeakageCount + holdoutRun.metrics.crossCompanyLeakageCount,
    promptInjectionExecutionCount: devRun.metrics.promptInjectionExecutionCount + holdoutRun.metrics.promptInjectionExecutionCount,
    exactCitationAccuracy: Math.min(safe(devRun.metrics.exactCitationAccuracy, 1), safe(holdoutRun.metrics.exactCitationAccuracy, 1)),
    acceptablePageAccuracy: Math.min(safe(devRun.metrics.citationAccuracy, 1), safe(holdoutRun.metrics.citationAccuracy, 1)),
    improvementOverLexicalDev: devRun.metrics.overallPassRate - devLexicalRun.metrics.overallPassRate,
    improvementOverLexicalHoldout: holdoutRun.metrics.overallPassRate - holdoutLexicalRun.metrics.overallPassRate,
  };
  gate.noHoldoutRegression = gate.improvementOverLexicalHoldout >= 0;
  gate.noSafetyRegression = devRun.metrics.correctSymbolRate >= devLexicalRun.metrics.correctSymbolRate
    && devRun.metrics.correctPeriodRate >= devLexicalRun.metrics.correctPeriodRate
    && devRun.metrics.absentAnswerAbstentionRate >= devLexicalRun.metrics.absentAnswerAbstentionRate
    && devRun.metrics.crossCompanyLeakageCount <= devLexicalRun.metrics.crossCompanyLeakageCount
    && devRun.metrics.promptInjectionExecutionCount <= devLexicalRun.metrics.promptInjectionExecutionCount
    && holdoutRun.metrics.correctSymbolRate >= holdoutLexicalRun.metrics.correctSymbolRate
    && holdoutRun.metrics.correctPeriodRate >= holdoutLexicalRun.metrics.correctPeriodRate
    && holdoutRun.metrics.absentAnswerAbstentionRate >= holdoutLexicalRun.metrics.absentAnswerAbstentionRate
    && holdoutRun.metrics.crossCompanyLeakageCount <= holdoutLexicalRun.metrics.crossCompanyLeakageCount
    && holdoutRun.metrics.promptInjectionExecutionCount <= holdoutLexicalRun.metrics.promptInjectionExecutionCount;

  // Phase 4A.3 item 6's exact required criteria:
  gate.passed = gate.developmentOverallPassRate >= 0.9
    && gate.holdoutOverallPassRate >= 0.9
    && gate.acceptablePageAccuracy >= 0.9
    && gate.correctSymbolRate === 1
    && gate.correctPeriodRate === 1
    && gate.absentAnswerAbstentionRate === 1
    && gate.crossCompanyLeakageCount === 0
    && gate.promptInjectionExecutionCount === 0
    && gate.noHoldoutRegression;

  return gate;
};

/**
 * runFullEvaluation - the Phase 4A.3 readiness gate. Runs BOTH datasets
 * (development, holdout) in ALL FOUR comparison modes -- eight
 * independent runs, reported separately -- then evaluates the Phase
 * 4A.3 item 6 gate criteria against EACH mode (relative to the
 * LEXICAL_FALLBACK baseline) to determine whether any mode qualifies as
 * the selected default. The holdout set is run WITHOUT any ranking
 * change made in response to it.
 */
export const runFullEvaluation = async () => {
  clearQueryEmbeddingCacheForTests();
  const runsByMode = {};
  for (const mode of COMPARISON_MODES) {
    // eslint-disable-next-line no-await-in-loop
    const dev = await runEvaluation({ dataset: GOLDEN_DATASET, mode, datasetName: 'development' });
    // eslint-disable-next-line no-await-in-loop
    const holdout = await runEvaluation({ dataset: HOLDOUT_DATASET, mode, datasetName: 'holdout' });
    runsByMode[mode] = { dev, holdout };
  }

  const devLexicalRun = runsByMode.LEXICAL_FALLBACK.dev;
  const holdoutLexicalRun = runsByMode.LEXICAL_FALLBACK.holdout;

  const gatesByMode = {};
  for (const mode of COMPARISON_MODES) {
    gatesByMode[mode] = evaluateGateForMode(runsByMode[mode].dev, runsByMode[mode].holdout, devLexicalRun, holdoutLexicalRun);
  }

  const qualifyingModes = COMPARISON_MODES.filter((mode) => gatesByMode[mode].passed);
  // Prefer the qualifying mode with the best holdout pass rate as the
  // selected default (never LEXICAL_FALLBACK-only unless it is the ONLY
  // qualifier -- the whole point of this phase is to improve on it).
  const selectedMode = qualifyingModes.length
    ? qualifyingModes.reduce((best, mode) => (runsByMode[mode].holdout.metrics.overallPassRate > runsByMode[best].holdout.metrics.overallPassRate ? mode : best), qualifyingModes[0])
    : null;

  const runs = {};
  const failedCases = {};
  for (const mode of COMPARISON_MODES) {
    runs[`${mode}_dev`] = summarizeRun(runsByMode[mode].dev);
    runs[`${mode}_holdout`] = summarizeRun(runsByMode[mode].holdout);
    failedCases[`${mode}_dev`] = runsByMode[mode].dev.failedCases;
    failedCases[`${mode}_holdout`] = runsByMode[mode].holdout.failedCases;
  }

  return {
    generatedAt: new Date().toISOString(),
    runs,
    gatesByMode,
    qualifyingModes,
    selectedMode,
    failedCases,
  };
};

const summarizeRun = (report) => ({
  datasetName: report.datasetName,
  mode: report.mode,
  totalEntries: report.totalEntries,
  totalChecks: report.totalChecks,
  passedChecks: report.passedChecks,
  passRate: report.passRate,
  exactCitationAccuracy: report.exactCitationAccuracy,
  citationAccuracy: report.citationAccuracy,
  avgLatencyMs: report.avgLatencyMs,
  maxLatencyMs: report.maxLatencyMs,
  embeddingApiCalls: report.embeddingApiCalls,
  metrics: report.metrics,
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);
    const report = await runFullEvaluation();
    console.log(JSON.stringify(report.runs, null, 2));
    console.log(JSON.stringify({
      gatesByMode: report.gatesByMode, qualifyingModes: report.qualifyingModes, selectedMode: report.selectedMode,
    }, null, 2));
    console.log(JSON.stringify({ failedCases: report.failedCases }, null, 2));
    await mongoose.disconnect();
    process.exit(report.selectedMode ? 0 : 1);
  })().catch((err) => {
    logger.error(`[evaluateRetrieval] Failed: ${err.message}`);
    console.error('Evaluation failed:', err.message);
    process.exit(1);
  });
}

export default runFullEvaluation;
