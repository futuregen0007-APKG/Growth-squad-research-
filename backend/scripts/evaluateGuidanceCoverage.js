/**
 * evaluateGuidanceCoverage.js
 * ==============================
 * `node scripts/evaluateGuidanceCoverage.js [--split=dev|holdout|both]`
 *
 * Phase 4E.1 Part 6: a manually-adjudicated evaluation of the REAL
 * extraction run's output, split into two FIXED fixtures
 * (tests/fixtures/guidanceCoverageDev.json,
 * tests/fixtures/guidanceCoverageHoldout.json) that were separated BEFORE
 * the discourse-aware attribution rule (services/guidanceExtraction.js)
 * was finalized:
 *   - dev: chunks/sentences specifically inspected while diagnosing and
 *     fixing real precision bugs. Expected to score well BY
 *     CONSTRUCTION -- reported for transparency, never as the final
 *     measurement.
 *   - holdout: chunks/sentences never used to tune anything, adjudicated
 *     once as a first look. This is the split whose numbers the Phase
 *     4E.1 gates are actually measured against.
 *
 * Both fixtures carry TWO different kinds of ground truth, at TWO
 * different levels, which this script keeps in entirely separate metric
 * families (never summed against each other -- see Part 3's "reporting
 * units" discipline in scripts/enrichGuidanceCorpus.js):
 *   - chunkLevelEntries: is this CHUNK worth attempting extraction on at
 *     all (expectedIsCandidate)? Measures services/guidanceCandidateDetection.js.
 *   - sentenceLevelEntries: is this SENTENCE genuine, quantified,
 *     forward-looking management guidance (expectedLabel TRUE_GUIDANCE vs
 *     NOT_GUIDANCE)? Measures services/guidanceExtraction.js's accept/reject
 *     decision, plus (for TRUE_GUIDANCE entries that were VERIFIED) the
 *     accuracy of every extracted field.
 *
 * UNRESOLVED sentence-level entries (there are several among the
 * NOT_GUIDANCE holdout entries) are NEVER counted as a hallucination or
 * scored against precision -- only as a true negative for
 * VERIFIED-vs-not, exactly like Part 8's own instruction.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';
import { extractCandidatesFromChunk } from '../services/guidanceExtraction.js';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'tests', 'fixtures');

const loadFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));

const pct = (n, d) => (d === 0 ? null : (n / d) * 100);
const fmt = (v) => (v === null ? 'n/a (no denominator)' : `${v.toFixed(1)}%`);

/**
 * evaluateChunkLevel - candidate precision/recall against
 * detectGuidanceCandidate, re-run live (never cached) via
 * extractCandidatesFromChunk's own chunkCandidate result.
 */
const evaluateChunkLevel = async (entries) => {
  let truePositive = 0; let falsePositive = 0; let trueNegative = 0; let falseNegative = 0;
  const mismatches = [];
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await ResearchDocumentChunk.findById(entry.chunkId).lean();
    if (!chunk) { mismatches.push({ chunkId: entry.chunkId, issue: 'CHUNK_NOT_FOUND' }); continue; }
    const { chunkCandidate } = extractCandidatesFromChunk(chunk);
    const actual = chunkCandidate.isCandidate;
    if (entry.expectedIsCandidate && actual) truePositive += 1;
    else if (!entry.expectedIsCandidate && actual) { falsePositive += 1; mismatches.push({ chunkId: entry.chunkId, issue: 'UNEXPECTED_CANDIDATE' }); }
    else if (entry.expectedIsCandidate && !actual) { falseNegative += 1; mismatches.push({ chunkId: entry.chunkId, issue: 'MISSED_CANDIDATE' }); }
    else trueNegative += 1;
  }
  return {
    truePositive, falsePositive, trueNegative, falseNegative,
    candidatePrecision: pct(truePositive, truePositive + falsePositive),
    candidateRecall: pct(truePositive, truePositive + falseNegative),
    mismatches,
  };
};

/**
 * evaluateSentenceLevel - extraction precision/recall + per-field accuracy
 * on the ACCEPTED (VERIFIED) subset, re-run live against the CURRENT
 * ResearchGuidanceAnnotation rows (extractionVersion is read from each
 * row it finds -- this reports on whatever the most recent enrichment run
 * actually persisted, never a stale in-memory assumption).
 */
const evaluateSentenceLevel = async (entries) => {
  const metrics = {
    totalEntries: entries.length,
    trueGuidanceEntries: 0,
    notGuidanceEntries: 0,
    verifiedCount: 0,
    rejectedCount: 0,
    unresolvedCount: 0,
    trueGuidanceAmongVerified: 0,
    notGuidanceAmongVerified: 0, // false-guidance acceptance
    trueGuidanceMissedByVerified: 0, // extraction recall false negatives
    numericAccurate: 0,
    metricAccurate: 0,
    periodAccurate: 0,
    companyAccurate: 0,
    provenanceAccurate: 0,
    revisionAccurate: 0,
    mismatches: [],
  };

  for (const entry of entries) {
    if (entry.expectedLabel === 'TRUE_GUIDANCE') metrics.trueGuidanceEntries += 1;
    else metrics.notGuidanceEntries += 1;

    // A chunk can have rows at more than one extractionVersion (an older
    // pre-fix run left its row in place for audit -- Part 9: "old
    // extraction versions remain auditable"); this evaluation must always
    // read the CURRENT (highest-numbered) version, exactly like
    // services/guidanceAnnotationLookup.js does for production traffic,
    // never whichever row Mongo happens to return first.
    // eslint-disable-next-line no-await-in-loop
    const candidateRows = await ResearchGuidanceAnnotation.find({ chunkId: entry.chunkId }).lean();
    const row = candidateRows.sort((a, b) => Number(b.extractionVersion) - Number(a.extractionVersion))[0];
    if (!row) { metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'NO_ANNOTATION_ROW_FOUND', span: entry.supportingSpan }); continue; }
    const ann = row.annotations.find((a) => a.supportingSpan === entry.supportingSpan);
    if (!ann) { metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'NO_MATCHING_SPAN', span: entry.supportingSpan }); continue; }

    if (ann.status === 'VERIFIED') metrics.verifiedCount += 1;
    else if (ann.status === 'REJECTED') metrics.rejectedCount += 1;
    else metrics.unresolvedCount += 1;

    if (entry.expectedLabel === 'TRUE_GUIDANCE') {
      if (ann.status === 'VERIFIED') {
        metrics.trueGuidanceAmongVerified += 1;
        const numericOk = (entry.expectedNumeric?.lowerBound ?? null) === (ann.lowerBound ?? null)
          && (entry.expectedNumeric?.upperBound ?? null) === (ann.upperBound ?? null)
          && (entry.expectedNumeric?.exactValue ?? null) === (ann.exactValue ?? null);
        if (numericOk) metrics.numericAccurate += 1;
        else metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'NUMERIC_MISMATCH', got: { lowerBound: ann.lowerBound, upperBound: ann.upperBound, exactValue: ann.exactValue }, expected: entry.expectedNumeric });

        if (!entry.expectedMetricKey || ann.metricKey === entry.expectedMetricKey) metrics.metricAccurate += 1;
        else metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'METRIC_MISMATCH', got: ann.metricKey, expected: entry.expectedMetricKey });

        if (!entry.expectedFiscalYear || row.fiscalYear === entry.expectedFiscalYear) metrics.periodAccurate += 1;
        else metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'PERIOD_MISMATCH' });

        if (!entry.expectedSymbol || row.symbol === entry.expectedSymbol) metrics.companyAccurate += 1;
        else metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'COMPANY_MISMATCH' });

        if (!entry.expectedSourceUrl || row.sourceUrl === entry.expectedSourceUrl) metrics.provenanceAccurate += 1;
        else metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'PROVENANCE_MISMATCH' });

        if (!entry.expectedGuidanceKind || ann.guidanceKind === entry.expectedGuidanceKind) metrics.revisionAccurate += 1;
        else metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'GUIDANCE_KIND_MISMATCH', got: ann.guidanceKind, expected: entry.expectedGuidanceKind });
      } else {
        metrics.trueGuidanceMissedByVerified += 1;
        metrics.mismatches.push({ chunkId: entry.chunkId, issue: `FALSE_NEGATIVE_${ann.status}`, reasons: ann.rejectionReasons || ann.unresolvedReason, span: entry.supportingSpan });
      }
    } else if (ann.status === 'VERIFIED') {
      metrics.notGuidanceAmongVerified += 1;
      metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'FALSE_GUIDANCE_ACCEPTANCE', span: entry.supportingSpan });
    }
  }

  const trueGuidanceDenom = metrics.trueGuidanceAmongVerified || 1;
  return {
    ...metrics,
    extractionPrecision: pct(metrics.trueGuidanceAmongVerified, metrics.verifiedCount),
    extractionRecall: pct(metrics.trueGuidanceAmongVerified, metrics.trueGuidanceEntries),
    falseGuidanceAcceptanceRate: pct(metrics.notGuidanceAmongVerified, metrics.verifiedCount),
    numericAccuracy: pct(metrics.numericAccurate, trueGuidanceDenom),
    metricAccuracy: pct(metrics.metricAccurate, trueGuidanceDenom),
    periodAccuracy: pct(metrics.periodAccurate, trueGuidanceDenom),
    companyAccuracy: pct(metrics.companyAccurate, trueGuidanceDenom),
    provenanceAccuracy: pct(metrics.provenanceAccurate, trueGuidanceDenom),
    revisionAccuracy: pct(metrics.revisionAccurate, trueGuidanceDenom),
    unresolvedRate: pct(metrics.unresolvedCount, metrics.totalEntries),
  };
};

export const runCoverageEvaluation = async (split = 'both') => {
  const results = {};
  const splits = split === 'both' ? ['dev', 'holdout'] : [split];
  for (const s of splits) {
    const fixture = loadFixture(s === 'dev' ? 'guidanceCoverageDev.json' : 'guidanceCoverageHoldout.json');
    // eslint-disable-next-line no-await-in-loop
    const chunkLevel = await evaluateChunkLevel(fixture.chunkLevelEntries);
    // eslint-disable-next-line no-await-in-loop
    const sentenceLevel = await evaluateSentenceLevel(fixture.sentenceLevelEntries);
    results[s] = { meta: fixture._meta, chunkLevel, sentenceLevel };
  }
  return results;
};

const printSplit = (name, result) => {
  console.log('='.repeat(70));
  console.log(`SPLIT: ${name.toUpperCase()} -- ${result.meta.purpose}`);
  console.log('-'.repeat(70));
  console.log('[CHUNK-level: candidate detection]');
  console.log(`  Candidate precision: ${fmt(result.chunkLevel.candidatePrecision)} (TP=${result.chunkLevel.truePositive} FP=${result.chunkLevel.falsePositive})`);
  console.log(`  Candidate recall:    ${fmt(result.chunkLevel.candidateRecall)} (TP=${result.chunkLevel.truePositive} FN=${result.chunkLevel.falseNegative})`);
  console.log('[SENTENCE-level: extraction]');
  console.log(`  Extraction precision:        ${fmt(result.sentenceLevel.extractionPrecision)}`);
  console.log(`  Extraction recall:           ${fmt(result.sentenceLevel.extractionRecall)}`);
  console.log(`  False-guidance acceptance:   ${fmt(result.sentenceLevel.falseGuidanceAcceptanceRate)}`);
  console.log(`  Metric accuracy (accepted):  ${fmt(result.sentenceLevel.metricAccuracy)}`);
  console.log(`  Numeric accuracy (accepted): ${fmt(result.sentenceLevel.numericAccuracy)}`);
  console.log(`  Period accuracy (accepted):  ${fmt(result.sentenceLevel.periodAccuracy)}`);
  console.log(`  Company accuracy (accepted): ${fmt(result.sentenceLevel.companyAccuracy)}`);
  console.log(`  Provenance accuracy:         ${fmt(result.sentenceLevel.provenanceAccuracy)}`);
  console.log(`  Revision-kind accuracy:      ${fmt(result.sentenceLevel.revisionAccuracy)}`);
  console.log(`  Unresolved rate:             ${fmt(result.sentenceLevel.unresolvedRate)} (never scored as hallucination)`);
  if (result.sentenceLevel.mismatches.length || result.chunkLevel.mismatches.length) {
    console.log(`  ${result.sentenceLevel.mismatches.length + result.chunkLevel.mismatches.length} mismatch(es):`);
    for (const m of [...result.chunkLevel.mismatches, ...result.sentenceLevel.mismatches]) console.log('   -', JSON.stringify(m));
  }
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const splitArg = (process.argv.find((a) => a.startsWith('--split=')) || '').split('=')[1] || 'both';
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    console.log('Guidance coverage evaluation (dev vs holdout, manually adjudicated)');
    const results = await runCoverageEvaluation(splitArg);
    for (const [name, result] of Object.entries(results)) printSplit(name, result);

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    console.error('Coverage evaluation failed:', err.message, err.stack);
    process.exit(1);
  });
}

export default runCoverageEvaluation;
