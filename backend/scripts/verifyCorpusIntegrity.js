/**
 * verifyCorpusIntegrity.js
 * ===========================
 * `npm run rag:verify-corpus`
 *
 * Phase 4A.4 Part 4: real, runnable data-integrity checks against the
 * ALREADY-INDEXED ResearchDocumentChunk corpus (TCS/INFY) -- no Atlas
 * access required, everything here runs against this project's real
 * local MongoDB.
 *
 * Checks:
 *   1. Every golden/holdout fixture citation (pin + acceptableCitations)
 *      resolves to a real, currently-stored chunk.
 *   2. Page numbers are sane (pageStart/pageEnd present, >=1, pageEnd >=
 *      pageStart) -- a structural proxy for "matches extracted PDF
 *      pages" (the actual PDF<->page mapping was already verified by
 *      direct human inspection during Phase 4A.3's citation adjudication;
 *      this re-checks the STORED invariant holds for the whole corpus).
 *   3. Every embedded chunk's vector has the expected dimension (1536).
 *   4. Missing/null/malformed/duplicate embeddings.
 *   5. Chunks missing symbol/fiscalYear/registryDocumentId/page metadata.
 *   6. Exactly one (embeddingModel, embeddingVersion) pair is in use
 *      across all embedded chunks -- indexed content and query
 *      embeddings must never come from mixed models.
 *   7. Fiscal-year-scoped chunks carry real, distinct `publishedAt`
 *      dates where more than one chunk shares a (symbol, fiscalYear) --
 *      the real signal the Phase 4A.3 recency fix depends on.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { GOLDEN_DATASET } from '../fixtures/ragGoldenDataset.js';
import { HOLDOUT_DATASET } from '../fixtures/ragHoldoutDataset.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const EXPECTED_DIMENSIONS = 1536;

const collectCitations = (dataset) => dataset.flatMap((entry) => {
  const exp = entry.expected;
  if (!exp) return [];
  const pins = [];
  if (exp.sourceUrlContains) pins.push({ entryId: entry.id, sourceUrlContains: exp.sourceUrlContains, pageIn: exp.pageIn });
  for (const alt of exp.acceptableCitations || []) pins.push({ entryId: entry.id, sourceUrlContains: alt.sourceUrlContains, pageIn: alt.pageIn });
  return pins;
});

export const verifyCorpusIntegrity = async () => {
  const report = {
    checkedAt: new Date().toISOString(),
    citations: { checked: 0, resolved: 0, unresolved: [] },
    pageSanity: { totalChunks: 0, invalid: [] },
    embeddingDimensions: { totalEmbedded: 0, wrongDimension: [] },
    embeddingQuality: {
      missingOrNull: 0, malformed: [], duplicateChunkHashCount: 0,
    },
    metadataCompleteness: { missingSymbol: 0, missingFiscalYear: 0, missingRegistryDocumentId: 0, missingPage: 0 },
    embeddingModelConsistency: { distinctPairs: [], consistent: null },
    recencyMetadata: { symbolFiscalYearGroupsChecked: 0, groupsWithDistinctPublishedAt: 0, groupsAllSamePublishedAt: 0 },
  };

  // 1. Citation resolution against fixtures.
  const allCitations = [...collectCitations(GOLDEN_DATASET), ...collectCitations(HOLDOUT_DATASET)];
  report.citations.checked = allCitations.length;
  for (const citation of allCitations) {
    // eslint-disable-next-line no-await-in-loop
    const match = await ResearchDocumentChunk.findOne({
      sourceUrl: new RegExp(citation.sourceUrlContains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      ...(citation.pageIn ? { pageStart: { $gte: citation.pageIn[0] }, pageEnd: { $lte: citation.pageIn[1] } } : {}),
    }).select('_id').lean();
    if (match) report.citations.resolved += 1;
    else report.citations.unresolved.push(citation);
  }

  // 2. Page sanity across the whole corpus.
  const allChunks = await ResearchDocumentChunk.find({ symbol: { $in: ['TCS', 'INFY'] } })
    .select('symbol fiscalYear registryDocumentId pageStart pageEnd embedding embeddingModel embeddingVersion chunkHash publishedAt')
    .lean();
  report.pageSanity.totalChunks = allChunks.length;
  for (const chunk of allChunks) {
    const ok = Number.isInteger(chunk.pageStart) && chunk.pageStart >= 1 && Number.isInteger(chunk.pageEnd) && chunk.pageEnd >= chunk.pageStart;
    if (!ok) report.pageSanity.invalid.push({ id: String(chunk._id), pageStart: chunk.pageStart, pageEnd: chunk.pageEnd });
  }

  // 3/4. Embedding dimension + quality.
  const chunkHashCounts = new Map();
  for (const chunk of allChunks) {
    chunkHashCounts.set(chunk.chunkHash, (chunkHashCounts.get(chunk.chunkHash) || 0) + 1);
    const hasEmbedding = Array.isArray(chunk.embedding) && chunk.embedding.length > 0;
    if (!hasEmbedding) { report.embeddingQuality.missingOrNull += 1; continue; }
    report.embeddingDimensions.totalEmbedded += 1;
    if (chunk.embedding.length !== EXPECTED_DIMENSIONS) {
      report.embeddingDimensions.wrongDimension.push({ id: String(chunk._id), dims: chunk.embedding.length });
    }
    const malformed = chunk.embedding.some((v) => typeof v !== 'number' || !Number.isFinite(v));
    if (malformed) report.embeddingQuality.malformed.push(String(chunk._id));
  }
  report.embeddingQuality.duplicateChunkHashCount = [...chunkHashCounts.values()].filter((c) => c > 1).length;

  // 5. Metadata completeness.
  for (const chunk of allChunks) {
    if (!chunk.symbol) report.metadataCompleteness.missingSymbol += 1;
    if (!chunk.fiscalYear) report.metadataCompleteness.missingFiscalYear += 1;
    if (!chunk.registryDocumentId) report.metadataCompleteness.missingRegistryDocumentId += 1;
    if (!Number.isInteger(chunk.pageStart)) report.metadataCompleteness.missingPage += 1;
  }

  // 6. Embedding model/version consistency.
  const pairs = new Set(allChunks.filter((c) => c.embeddingModel).map((c) => `${c.embeddingModel}::${c.embeddingVersion}`));
  report.embeddingModelConsistency.distinctPairs = [...pairs];
  report.embeddingModelConsistency.consistent = pairs.size <= 1;

  // 7. Recency metadata -- real, distinct publishedAt within (symbol, fiscalYear) groups.
  const groups = new Map();
  for (const chunk of allChunks) {
    const key = `${chunk.symbol}::${chunk.fiscalYear}::${chunk.registryDocumentId}`;
    if (!groups.has(key)) groups.set(key, chunk.publishedAt ? new Date(chunk.publishedAt).getTime() : null);
  }
  const byPeriod = new Map();
  for (const [key, publishedAt] of groups) {
    const [symbol, fiscalYear] = key.split('::');
    const periodKey = `${symbol}::${fiscalYear}`;
    if (!byPeriod.has(periodKey)) byPeriod.set(periodKey, new Set());
    byPeriod.get(periodKey).add(publishedAt);
  }
  for (const [, publishedAtSet] of byPeriod) {
    if (publishedAtSet.size < 2) continue; // only one document for this period -- nothing to distinguish
    report.recencyMetadata.symbolFiscalYearGroupsChecked += 1;
    const allSame = publishedAtSet.size === 1;
    if (allSame) report.recencyMetadata.groupsAllSamePublishedAt += 1;
    else report.recencyMetadata.groupsWithDistinctPublishedAt += 1;
  }

  report.summary = {
    citationsFullyResolved: report.citations.unresolved.length === 0,
    pagesAllSane: report.pageSanity.invalid.length === 0,
    dimensionsAllCorrect: report.embeddingDimensions.wrongDimension.length === 0,
    noMalformedEmbeddings: report.embeddingQuality.malformed.length === 0,
    noDuplicateChunkHashes: report.embeddingQuality.duplicateChunkHashCount === 0,
    metadataComplete: Object.values(report.metadataCompleteness).every((v) => v === 0),
    singleEmbeddingModelInUse: report.embeddingModelConsistency.consistent,
    recencyMetadataUsable: report.recencyMetadata.groupsWithDistinctPublishedAt > 0,
  };

  return report;
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);
    const report = await verifyCorpusIntegrity();
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    process.exit(Object.values(report.summary).every(Boolean) ? 0 : 1);
  })().catch((err) => {
    logger.error(`[verifyCorpusIntegrity] Failed: ${err.message}`);
    console.error('Corpus integrity verification failed:', err.message);
    process.exit(1);
  });
}

export default verifyCorpusIntegrity;
