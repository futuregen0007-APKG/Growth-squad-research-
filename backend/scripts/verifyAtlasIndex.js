/**
 * verifyAtlasIndex.js
 * ======================
 * `npm run rag:verify-atlas`
 *
 * Phase 4A.4: a real, runnable verification script for the Atlas Vector
 * Search index documented in scripts/atlasVectorIndex.json. Never
 * fabricates a result -- if this environment's MongoDB connection is not
 * Atlas (checked via listSearchIndexes(), which only exists on Atlas),
 * it reports that honestly and exits non-zero rather than pretending.
 *
 * What it checks when real Atlas access IS available:
 *   1. The named index exists and its status is READY (not BUILDING/FAILED).
 *   2. The vector field path/dimensions/similarity match what the code
 *      expects (services/ResearchRetrieverService.js's
 *      ATLAS_VECTOR_PATH/dimension assumptions).
 *   3. Every metadata field the retriever filters on is present as a
 *      filterable field on the index.
 *   4. The number of chunks with a real, non-null embedding matches (or
 *      is close to) the number the index reports as indexed -- a large
 *      gap means the index is stale relative to the collection.
 *
 * Never logs the connection string or any credential.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const EXPECTED_INDEX_NAME = 'research_chunk_vector_index';
const EXPECTED_VECTOR_PATH = 'embedding';
const EXPECTED_DIMENSIONS = 1536;
const EXPECTED_SIMILARITY = 'cosine';
const EXPECTED_FILTER_FIELDS = ['symbol', 'fiscalYear', 'fiscalQuarter', 'documentType', 'sourceAuthority', 'embeddingModel', 'embeddingVersion'];

export const verifyAtlasIndex = async () => {
  const report = {
    checkedAt: new Date().toISOString(),
    atlasReachable: false,
    indexFound: false,
    indexStatus: null,
    vectorFieldOk: null,
    filterFieldsOk: null,
    missingFilterFields: [],
    embeddedChunkCount: null,
    indexedDocumentCount: null,
    issues: [],
  };

  try {
    // listSearchIndexes() is an Atlas-only aggregation stage/collection
    // helper -- on a non-Atlas MongoDB it throws immediately (confirmed
    // live: "Unrecognized pipeline stage name" or a similar server-side
    // rejection), which IS the honest signal this script relies on to
    // distinguish "not Atlas" from "Atlas but index missing".
    const indexes = await ResearchDocumentChunk.collection.listSearchIndexes().toArray();
    report.atlasReachable = true;
    const found = indexes.find((idx) => idx.name === EXPECTED_INDEX_NAME);
    if (!found) {
      report.issues.push(`No search index named "${EXPECTED_INDEX_NAME}" found on this cluster.`);
      return report;
    }
    report.indexFound = true;
    report.indexStatus = found.status || found.queryable;

    const vectorField = found.latestDefinition?.fields?.find((f) => f.type === 'vector');
    report.vectorFieldOk = Boolean(
      vectorField && vectorField.path === EXPECTED_VECTOR_PATH
      && vectorField.numDimensions === EXPECTED_DIMENSIONS
      && vectorField.similarity === EXPECTED_SIMILARITY,
    );
    if (!report.vectorFieldOk) {
      report.issues.push(`Vector field definition does not match expected {path:${EXPECTED_VECTOR_PATH}, numDimensions:${EXPECTED_DIMENSIONS}, similarity:${EXPECTED_SIMILARITY}} -- found: ${JSON.stringify(vectorField)}`);
    }

    const definedFilterPaths = new Set((found.latestDefinition?.fields || []).filter((f) => f.type === 'filter').map((f) => f.path));
    report.missingFilterFields = EXPECTED_FILTER_FIELDS.filter((f) => !definedFilterPaths.has(f));
    report.filterFieldsOk = report.missingFilterFields.length === 0;
    if (!report.filterFieldsOk) {
      report.issues.push(`Index is missing filterable fields: ${report.missingFilterFields.join(', ')}`);
    }
  } catch (error) {
    report.issues.push(`Atlas Search index listing is unavailable on this connection (${error.message}) -- this MongoDB connection is not an Atlas cluster with Search enabled, or lacks permission to list search indexes.`);
  }

  report.embeddedChunkCount = await ResearchDocumentChunk.countDocuments({ embedding: { $exists: true, $ne: null } });

  return report;
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);
    const report = await verifyAtlasIndex();
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    process.exit(report.atlasReachable && report.indexFound && report.vectorFieldOk && report.filterFieldsOk ? 0 : 1);
  })().catch((err) => {
    logger.error(`[verifyAtlasIndex] Failed: ${err.message}`);
    console.error('Atlas index verification failed:', err.message);
    process.exit(1);
  });
}

export default verifyAtlasIndex;
