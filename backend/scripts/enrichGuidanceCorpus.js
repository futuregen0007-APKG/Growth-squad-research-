/**
 * enrichGuidanceCorpus.js
 * ==========================
 * `node scripts/enrichGuidanceCorpus.js [--dry-run] [--symbol=TCS]
 *   [--fiscal-year=FY2026] [--document-type=EARNINGS_CALL_TRANSCRIPT]
 *   [--max-chunks=500] [--concurrency=4] [--extraction-version=1] [--resume]`
 *
 * Phase 4E Part 11: the offline batch driver for
 * services/guidanceExtraction.js. Reads REAL ResearchDocumentChunk rows,
 * runs the deterministic candidate-detection + extraction + verification
 * pipeline over each one, and idempotently upserts the result into
 * models/ResearchGuidanceAnnotation.js.
 *
 * There is NO LLM call anywhere in this run (services/guidanceExtraction.js
 * is 100% deterministic) — concurrency/retry/timeout below exist purely as
 * forward-looking safeguards for a future LLM_STRUCTURED extraction path
 * (Part 3: "if a genuine configured OpenAI key is available, use strict
 * structured output ONLY for candidate chunks deterministic parsing cannot
 * resolve safely" — not exercised by this script today), and to keep this
 * script safe to point at an arbitrarily large corpus without an
 * unbounded, un-cancellable run. Because the actual work here is a pure
 * in-process regex pass with no external API cost, running it over the
 * WHOLE real corpus (2,274 chunks as of this run) is itself the safe,
 * bounded default --max-chunks already caps it further for anyone who
 * wants an even smaller first look.
 *
 * Idempotent: --resume skips chunks that already have a row at the target
 * --extraction-version; without --resume, every matched chunk is
 * reprocessed but still upserts onto the SAME (chunkId, extractionVersion)
 * row (never a duplicate) unless the version was bumped.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';
import { extractCandidatesFromChunk, EXTRACTION_VERSION } from '../services/guidanceExtraction.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const PER_CHUNK_TIMEOUT_MS = 5000; // generous for a pure regex pass; a real safety net, never expected to fire.
const DEFAULT_MAX_CHUNKS = 5000;
const DEFAULT_CONCURRENCY = 4;
const MAX_RETRIES = 2;

const withTimeout = (promiseValue, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promiseValue, timeout]).finally(() => clearTimeout(timer));
};

const withRetries = async (fn, retries) => {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

/**
 * processChunk - runs extraction for ONE chunk and, unless dryRun, upserts
 * EXACTLY ONE ResearchGuidanceAnnotation row for it (Part 5's identity is
 * per chunk+version, not per candidate sentence) — every candidate
 * sentence extracted from this chunk (a chunk can carry more than one
 * distinct guidance statement, e.g. a transcript page discussing both
 * margin and revenue guidance in consecutive sentences) becomes one entry
 * in that row's `annotations` array. Every write copies chunk identity
 * fields verbatim (Part 5: "never re-derived from this annotation's own
 * extracted text").
 */
const processChunk = async (chunk, { extractionVersion, dryRun }) => {
  const { chunkCandidate, annotations } = extractCandidatesFromChunk(chunk);
  const counts = { candidate: chunkCandidate.isCandidate ? 1 : 0, verified: 0, rejected: 0, unresolved: 0, written: 0 };
  for (const ann of annotations) {
    if (ann.status === 'VERIFIED') counts.verified += 1;
    else if (ann.status === 'REJECTED') counts.rejected += 1;
    else counts.unresolved += 1;
  }

  // A chunk that was never even a candidate, or that produced no
  // candidate sentences at all, has nothing worth persisting — no row is
  // written, exactly like before this pipeline ever ran for it.
  if (!chunkCandidate.isCandidate && !annotations.length) return counts;
  if (dryRun) return counts;

  const doc = {
    chunkId: chunk._id,
    chunkHash: chunk.chunkHash,
    extractionVersion,
    symbol: chunk.symbol,
    documentType: chunk.documentType,
    fiscalYear: chunk.fiscalYear,
    fiscalQuarter: chunk.fiscalQuarter || null,
    sourceUrl: chunk.sourceUrl,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    publishedAt: chunk.publishedAt || null,
    isCandidateChunk: chunkCandidate.isCandidate,
    candidateSignals: chunkCandidate.signals || [],
    candidateReason: chunkCandidate.reason || null,
    annotations: annotations.map((ann) => ({
      status: ann.status,
      candidateSignals: ann.candidateSignals,
      metric: ann.metric,
      metricKey: ann.metricKey,
      guidanceKind: ann.guidanceKind,
      valueType: ann.valueType,
      lowerBound: ann.lowerBound,
      upperBound: ann.upperBound,
      exactValue: ann.exactValue,
      unit: ann.unit,
      currency: ann.currency,
      supportingSpan: ann.supportingSpan,
      extractionMethod: ann.extractionMethod,
      confidence: ann.confidence,
      rejectionReasons: ann.rejectionReasons,
      unresolvedReason: ann.unresolvedReason,
    })),
    hasVerifiedAnnotation: annotations.some((ann) => ann.status === 'VERIFIED'),
    extractedAt: new Date(),
  };
  await ResearchGuidanceAnnotation.findOneAndUpdate(
    { chunkId: chunk._id, extractionVersion },
    { $set: doc },
    { upsert: true, new: true },
  );
  counts.written += 1;
  return counts;
};

/**
 * Task 3 (Phase 4E.1): three DIFFERENT counting units live in this report,
 * and they must never be summed or compared against each other as if they
 * were the same thing:
 *   - CHUNK-level: chunksScanned, candidateChunks, nonCandidateChunks,
 *     chunkRowsWritten, chunksFailed — one count per ResearchDocumentChunk.
 *   - SENTENCE-level: candidateSentences (and its three-way split,
 *     verifiedSentences/rejectedSentences/unresolvedSentences) — one count
 *     per candidate SENTENCE inside a candidate chunk (a single chunk can
 *     contribute zero, one, or several sentence-level outcomes).
 * `candidateChunks` (chunk-level) and `candidateSentences` (sentence-level)
 * are DIFFERENT numbers measuring different things and must be reported
 * side by side, never combined.
 */
const runBatch = async (chunks, { extractionVersion, dryRun, concurrency, onProgress }) => {
  const totals = {
    chunksScanned: 0,
    candidateChunks: 0,
    chunkRowsWritten: 0,
    chunksFailed: 0,
    verifiedSentences: 0,
    rejectedSentences: 0,
    unresolvedSentences: 0,
  };
  let index = 0;

  const worker = async () => {
    while (index < chunks.length) {
      const myIndex = index;
      index += 1;
      const chunk = chunks[myIndex];
      try {
        // eslint-disable-next-line no-await-in-loop
        const counts = await withRetries(
          () => withTimeout(processChunk(chunk, { extractionVersion, dryRun }), PER_CHUNK_TIMEOUT_MS),
          MAX_RETRIES,
        );
        totals.chunksScanned += 1;
        totals.candidateChunks += counts.candidate;
        totals.verifiedSentences += counts.verified;
        totals.rejectedSentences += counts.rejected;
        totals.unresolvedSentences += counts.unresolved;
        totals.chunkRowsWritten += counts.written;
      } catch (error) {
        totals.chunksFailed += 1;
        logger.warn(`[enrichGuidanceCorpus] chunk ${chunk._id} failed: ${error.message}`);
      }
      if (onProgress && (myIndex + 1) % 200 === 0) onProgress(myIndex + 1, chunks.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(chunks.length, 1)) }, worker));
  return {
    ...totals,
    nonCandidateChunks: totals.chunksScanned - totals.candidateChunks,
    candidateSentences: totals.verifiedSentences + totals.rejectedSentences + totals.unresolvedSentences,
  };
};

/**
 * runGuidanceEnrichment - the exported, testable entry point. Builds the
 * query from the operational filters, prints a pre-execution estimate
 * (Part 11: "cost/request estimate before execution" — always $0 here
 * since no LLM is ever called, but the chunk count itself is the
 * meaningful estimate for a future LLM path), then runs the bounded batch.
 */
export const runGuidanceEnrichment = async ({
  symbol = null, fiscalYear = null, documentType = null, maxChunks = DEFAULT_MAX_CHUNKS,
  concurrency = DEFAULT_CONCURRENCY, extractionVersion = EXTRACTION_VERSION, dryRun = false, resume = false,
  onProgress = null,
} = {}) => {
  const query = {};
  if (symbol) query.symbol = String(symbol).toUpperCase();
  if (fiscalYear) query.fiscalYear = fiscalYear;
  if (documentType) query.documentType = documentType;

  let candidateChunkIds = null;
  if (resume) {
    const alreadyProcessed = await ResearchGuidanceAnnotation.find({ extractionVersion }).distinct('chunkId');
    candidateChunkIds = new Set(alreadyProcessed.map(String));
  }

  const allMatching = await ResearchDocumentChunk.find(query).sort({ _id: 1 }).limit(maxChunks * 2).lean();
  const chunks = (candidateChunkIds
    ? allMatching.filter((c) => !candidateChunkIds.has(String(c._id)))
    : allMatching
  ).slice(0, maxChunks);

  const estimate = {
    chunksMatched: allMatching.length,
    chunksToProcess: chunks.length,
    llmCallsPlanned: 0,
    estimatedCostUsd: 0,
  };

  if (!chunks.length) {
    return {
      estimate,
      totals: {
        chunksScanned: 0, candidateChunks: 0, nonCandidateChunks: 0, chunkRowsWritten: 0, chunksFailed: 0,
        candidateSentences: 0, verifiedSentences: 0, rejectedSentences: 0, unresolvedSentences: 0,
      },
    };
  }

  const totals = await runBatch(chunks, { extractionVersion, dryRun, concurrency, onProgress });
  return { estimate, totals };
};

const parseArgs = (argv) => ({
  symbol: (argv.find((a) => a.startsWith('--symbol=')) || '').split('=')[1] || null,
  fiscalYear: (argv.find((a) => a.startsWith('--fiscal-year=')) || '').split('=')[1] || null,
  documentType: (argv.find((a) => a.startsWith('--document-type=')) || '').split('=')[1] || null,
  maxChunks: Number((argv.find((a) => a.startsWith('--max-chunks=')) || '').split('=')[1]) || DEFAULT_MAX_CHUNKS,
  concurrency: Number((argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || DEFAULT_CONCURRENCY,
  extractionVersion: (argv.find((a) => a.startsWith('--extraction-version=')) || '').split('=')[1] || EXTRACTION_VERSION,
  dryRun: argv.includes('--dry-run'),
  resume: argv.includes('--resume'),
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));

    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    console.log('Guidance corpus enrichment');
    console.log('='.repeat(60));
    console.log(`Filters: symbol=${opts.symbol || 'ALL'} fiscalYear=${opts.fiscalYear || 'ALL'} documentType=${opts.documentType || 'ALL'}`);
    console.log(`maxChunks=${opts.maxChunks} concurrency=${opts.concurrency} extractionVersion=${opts.extractionVersion} dryRun=${opts.dryRun} resume=${opts.resume}`);

    const { estimate, totals } = await runGuidanceEnrichment({
      ...opts,
      onProgress: (done, total) => console.log(`  ...${done}/${total} chunks scanned`),
    });

    console.log('-'.repeat(60));
    console.log(`Chunks matched by filter: ${estimate.chunksMatched}`);
    console.log(`Chunks selected to process: ${estimate.chunksToProcess}`);
    console.log(`Planned LLM calls: ${estimate.llmCallsPlanned} (estimated cost: $${estimate.estimatedCostUsd.toFixed(2)})`);
    console.log('-'.repeat(60));
    console.log('[CHUNK-level counts -- one count per ResearchDocumentChunk]');
    console.log(`  Total chunks scanned:     ${totals.chunksScanned}`);
    console.log(`  Candidate chunks:         ${totals.candidateChunks}`);
    console.log(`  Non-candidate chunks:     ${totals.nonCandidateChunks}`);
    console.log(`  Chunk rows written:       ${totals.chunkRowsWritten}`);
    console.log(`  Chunks failed:            ${totals.chunksFailed}`);
    console.log('[SENTENCE-level counts -- one count per candidate sentence, NEVER add to the chunk counts above]');
    console.log(`  Candidate sentences:      ${totals.candidateSentences}`);
    console.log(`    VERIFIED annotations:   ${totals.verifiedSentences}`);
    console.log(`    REJECTED annotations:   ${totals.rejectedSentences}`);
    console.log(`    UNRESOLVED annotations: ${totals.unresolvedSentences}`);
    if (opts.dryRun) console.log('DRY RUN — no annotations were written to the database.');

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[enrichGuidanceCorpus] Failed: ${err.message}`);
    console.error('Guidance corpus enrichment failed:', err.message);
    process.exit(1);
  });
}

export default runGuidanceEnrichment;
