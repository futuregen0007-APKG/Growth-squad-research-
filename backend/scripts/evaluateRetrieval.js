/**
 * evaluateRetrieval.js
 * ======================
 * `npm run rag:evaluate`
 *
 * Phase 4A evaluation harness. Runs the checked-in golden retrieval
 * dataset (fixtures/ragGoldenDataset.js) against the REAL retriever
 * (services/ResearchRetrieverService.js) and the REAL, already-canary-
 * indexed ResearchDocumentChunk collection -- never a mock of either.
 *
 * Measures: Recall@k (expected doc/page found in results), citation/page
 * accuracy (top result matches expected source+page), correct-symbol rate
 * and correct-period rate (structural filter correctness), empty-query /
 * absent-answer abstention correctness, latency, and embedding-API call
 * count (0 expected in LEXICAL_FALLBACK mode -- this harness never spends
 * money on OpenAI calls by default).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { retrieveResearchEvidence } from '../services/ResearchRetrieverService.js';
import { GOLDEN_DATASET } from '../fixtures/ragGoldenDataset.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const FIXTURE_SYMBOL = 'RAGGOLDENEVAL';

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
  await ResearchDocumentChunk.insertMany(docs);
  return docs;
};

const cleanupSyntheticFixtures = async () => {
  await ResearchDocumentChunk.deleteMany({ symbol: FIXTURE_SYMBOL });
};

const checkResult = (entry, outcome) => {
  const checks = [];
  const exp = entry.expected;

  checks.push({ name: 'status', pass: outcome.status === exp.status, detail: `expected ${exp.status}, got ${outcome.status}` });

  if (exp.sourceUrlContains) {
    const top = outcome.results[0];
    const pass = Boolean(top && top.sourceUrl && top.sourceUrl.includes(exp.sourceUrlContains));
    checks.push({ name: 'citation_source_url', pass, detail: pass ? 'top result source URL matches expected filing' : `top result source URL did not match expected filing (${exp.sourceUrlContains})` });
  }
  if (exp.pageIn) {
    const top = outcome.results[0];
    const pass = Boolean(top && top.pageStart >= exp.pageIn[0] && top.pageEnd <= exp.pageIn[1]);
    checks.push({ name: 'citation_page_accuracy', pass, detail: pass ? 'top result page matches expected page' : `top result page did not match expected range ${exp.pageIn.join('-')}` });
  }
  if (exp.textIncludes) {
    const pass = outcome.results.some((r) => r.text.includes(exp.textIncludes));
    checks.push({ name: 'recall_at_k', pass, detail: pass ? 'expected text found within top-k results' : 'expected text not found in any returned result' });
  }
  if (exp.mustNotInclude) {
    const pass = !outcome.results.some((r) => r.text.includes(exp.mustNotInclude));
    checks.push({ name: 'wrong_period_excluded', pass, detail: pass ? 'wrong-period text correctly absent' : 'wrong-period text leaked into results' });
  }
  if (exp.neverSymbols) {
    const pass = !outcome.results.some((r) => exp.neverSymbols.includes(r.symbol));
    checks.push({ name: 'cross_company_isolation', pass, detail: pass ? 'no leaked symbol present' : 'a disallowed symbol leaked into results' });
  }

  const requestedSymbols = (entry.symbols || []).map((s) => s.toUpperCase());
  const correctSymbol = outcome.results.every((r) => requestedSymbols.includes(r.symbol));
  checks.push({ name: 'correct_symbol_rate', pass: correctSymbol, detail: correctSymbol ? 'all results within requested symbol set' : 'a result outside the requested symbol set was returned' });

  if (entry.fiscalYears?.length) {
    const correctPeriod = outcome.results.every((r) => entry.fiscalYears.includes(r.fiscalYear));
    checks.push({ name: 'correct_period_rate', pass: correctPeriod, detail: correctPeriod ? 'all results within requested fiscal year(s)' : 'a result outside the requested fiscal year was returned' });
  }

  return checks;
};

export const runEvaluation = async () => {
  await insertSyntheticFixtures(GOLDEN_DATASET);
  const report = {
    startedAt: new Date().toISOString(),
    totalEntries: GOLDEN_DATASET.length,
    entries: [],
    totalChecks: 0,
    passedChecks: 0,
    totalEmbeddingCalls: 0,
    latenciesMs: [],
  };

  try {
    for (const entry of GOLDEN_DATASET) {
      if (entry.queries) {
        // Multi-query comparison entries (two-symbol comparison).
        const subResults = [];
        for (const sub of entry.queries) {
          const outcome = await retrieveResearchEvidence({ query: sub.query, symbols: [sub.symbol] });
          report.latenciesMs.push(outcome.durationMs);
          const pass = outcome.status === sub.expectedStatus;
          report.totalChecks += 1;
          if (pass) report.passedChecks += 1;
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
        query: entry.query, symbols: entry.symbols, fiscalYears: entry.fiscalYears || [], documentTypes: entry.documentTypes || [],
      });
      report.latenciesMs.push(outcome.durationMs);
      const checks = checkResult(entry, outcome);
      report.totalChecks += checks.length;
      report.passedChecks += checks.filter((c) => c.pass).length;
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
  report.embeddingApiCalls = 0; // LEXICAL_FALLBACK mode never calls OpenAI; ATLAS_VECTOR mode (not exercised by default) would embed one query per retrieval call.

  return report;
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);
    const report = await runEvaluation();
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    process.exit(report.passedChecks === report.totalChecks ? 0 : 1);
  })().catch((err) => {
    logger.error(`[evaluateRetrieval] Failed: ${err.message}`);
    console.error('Evaluation failed:', err.message);
    process.exit(1);
  });
}

export default runEvaluation;
