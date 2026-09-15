/**
 * evaluateGuidanceCoverage.js
 * ==============================
 * `node scripts/evaluateGuidanceCoverage.js`
 *
 * Phase 4E Part 8: a manually-adjudicated evaluation of the REAL
 * extraction run's output. The adjudication itself
 * (tests/fixtures/guidanceCoverageAdjudication.json) was produced by a human
 * reading each cited sentence directly against the genuine, stored
 * ResearchDocumentChunk text — it is a fixed, versioned judgment file,
 * deliberately kept separate from services/guidanceExtraction.js so the
 * evaluation can never accidentally validate the extractor against its
 * own logic.
 *
 * This script re-reads the CURRENT live ResearchGuidanceAnnotation rows
 * for exactly the chunks named in the adjudication file and reports:
 *   - extraction precision: of annotations the pipeline marked VERIFIED,
 *     what fraction the human adjudicator also labeled TRUE_GUIDANCE.
 *   - false-guidance rate: the complement (FALSE_POSITIVE fraction).
 *   - numeric/period/company/provenance accuracy: measured only over
 *     TRUE_GUIDANCE-labeled VERIFIED annotations (Part 9: gates apply to
 *     ACCEPTED annotations).
 *   - UNRESOLVED items are never counted toward the hallucination rate
 *     (Part 8's explicit instruction) — reported as a separate count.
 *
 * Run this AFTER scripts/enrichGuidanceCorpus.js has populated
 * ResearchGuidanceAnnotation for the adjudicated chunks.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADJUDICATION_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'guidanceCoverageAdjudication.json');

export const runCoverageEvaluation = async () => {
  const adjudication = JSON.parse(readFileSync(ADJUDICATION_PATH, 'utf8'));
  const chunkIds = adjudication.entries.map((e) => e.chunkId);
  const rows = await ResearchGuidanceAnnotation.find({ chunkId: { $in: chunkIds } }).lean();
  const rowByChunkId = new Map(rows.map((r) => [String(r.chunkId), r]));

  const metrics = {
    totalAdjudicated: adjudication.entries.length,
    verifiedCount: 0,
    rejectedCount: 0,
    unresolvedCount: 0,
    trueGuidanceAmongVerified: 0,
    falsePositiveAmongVerified: 0,
    numericAccurateAmongTrue: 0,
    periodAccurateAmongTrue: 0,
    companyAccurateAmongTrue: 0,
    provenanceAccurateAmongTrue: 0,
    revisionAccurateAmongTrue: 0,
    mismatches: [],
  };

  for (const entry of adjudication.entries) {
    const row = rowByChunkId.get(entry.chunkId);
    if (!row) { metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'NO_ANNOTATION_ROW_FOUND' }); continue; }
    const ann = row.annotations.find((a) => a.supportingSpan === entry.supportingSpan) || row.annotations[0];
    if (!ann) { metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'NO_MATCHING_SPAN' }); continue; }

    if (ann.status === 'VERIFIED') {
      metrics.verifiedCount += 1;
      if (entry.expectedLabel === 'TRUE_GUIDANCE') {
        metrics.trueGuidanceAmongVerified += 1;
        if (entry.expectedNumeric == null || (ann.lowerBound === entry.expectedNumeric.lowerBound && ann.upperBound === entry.expectedNumeric.upperBound && ann.exactValue === entry.expectedNumeric.exactValue)) {
          metrics.numericAccurateAmongTrue += 1;
        } else {
          metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'NUMERIC_MISMATCH', got: { lowerBound: ann.lowerBound, upperBound: ann.upperBound, exactValue: ann.exactValue }, expected: entry.expectedNumeric });
        }
        if (!entry.expectedFiscalYear || row.fiscalYear === entry.expectedFiscalYear) metrics.periodAccurateAmongTrue += 1;
        if (!entry.expectedSymbol || row.symbol === entry.expectedSymbol) metrics.companyAccurateAmongTrue += 1;
        if (!entry.expectedSourceUrl || row.sourceUrl === entry.expectedSourceUrl) metrics.provenanceAccurateAmongTrue += 1;
        if (!entry.expectedGuidanceKind || ann.guidanceKind === entry.expectedGuidanceKind) metrics.revisionAccurateAmongTrue += 1;
        else metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'GUIDANCE_KIND_MISMATCH', got: ann.guidanceKind, expected: entry.expectedGuidanceKind });
      } else {
        metrics.falsePositiveAmongVerified += 1;
        metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'FALSE_POSITIVE_ACCEPTED_AS_GUIDANCE', span: ann.supportingSpan });
      }
    } else if (ann.status === 'REJECTED') {
      metrics.rejectedCount += 1;
      if (entry.expectedLabel === 'TRUE_GUIDANCE') metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'FALSE_NEGATIVE_REJECTED', reasons: ann.rejectionReasons, span: ann.supportingSpan });
    } else {
      metrics.unresolvedCount += 1;
      if (entry.expectedLabel === 'TRUE_GUIDANCE') metrics.mismatches.push({ chunkId: entry.chunkId, issue: 'FALSE_NEGATIVE_UNRESOLVED', reason: ann.unresolvedReason, span: ann.supportingSpan });
    }
  }

  const denom = metrics.verifiedCount || 1;
  const trueDenom = metrics.trueGuidanceAmongVerified || 1;
  return {
    ...metrics,
    extractionPrecision: metrics.trueGuidanceAmongVerified / denom,
    falseGuidanceRate: metrics.falsePositiveAmongVerified / denom,
    numericAccuracy: metrics.numericAccurateAmongTrue / trueDenom,
    periodAccuracy: metrics.periodAccurateAmongTrue / trueDenom,
    companyAccuracy: metrics.companyAccurateAmongTrue / trueDenom,
    provenanceAccuracy: metrics.provenanceAccurateAmongTrue / trueDenom,
    revisionAccuracy: metrics.revisionAccurateAmongTrue / trueDenom,
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    const result = await runCoverageEvaluation();
    console.log('Guidance coverage evaluation (manually adjudicated)');
    console.log('='.repeat(60));
    console.log(`Adjudicated entries: ${result.totalAdjudicated}`);
    console.log(`VERIFIED: ${result.verifiedCount}, REJECTED: ${result.rejectedCount}, UNRESOLVED: ${result.unresolvedCount}`);
    console.log(`Extraction precision (TRUE_GUIDANCE among VERIFIED): ${(result.extractionPrecision * 100).toFixed(1)}%`);
    console.log(`False-guidance rate (FALSE_POSITIVE among VERIFIED): ${(result.falseGuidanceRate * 100).toFixed(1)}%`);
    console.log(`Numeric accuracy (accepted TRUE_GUIDANCE): ${(result.numericAccuracy * 100).toFixed(1)}%`);
    console.log(`Period accuracy (accepted TRUE_GUIDANCE): ${(result.periodAccuracy * 100).toFixed(1)}%`);
    console.log(`Company accuracy (accepted TRUE_GUIDANCE): ${(result.companyAccuracy * 100).toFixed(1)}%`);
    console.log(`Provenance accuracy (accepted TRUE_GUIDANCE): ${(result.provenanceAccuracy * 100).toFixed(1)}%`);
    console.log(`Revision-kind accuracy (accepted TRUE_GUIDANCE): ${(result.revisionAccuracy * 100).toFixed(1)}%`);
    if (result.mismatches.length) {
      console.log('-'.repeat(60));
      console.log(`${result.mismatches.length} mismatch(es):`);
      for (const m of result.mismatches) console.log(' -', JSON.stringify(m));
    }

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    console.error('Coverage evaluation failed:', err.message);
    process.exit(1);
  });
}

export default runCoverageEvaluation;
