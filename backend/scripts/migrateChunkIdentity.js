/**
 * migrateChunkIdentity.js
 * ==========================
 * `npm run rag:migrate-identity`
 * `npm run rag:migrate-identity -- --dry-run`
 *
 * Phase 4A.1 hardening: backfills existing ResearchDocumentChunk rows
 * (indexed under the Phase 4A chunkHash-only identity scheme) onto the
 * new compound structural identity — see models/ResearchDocumentChunk.js
 * and services/DocumentChunkingService.js's identity notes for the full
 * rationale.
 *
 * NON-DESTRUCTIVE BY DESIGN: this script only ever `updateOne`s existing
 * rows by their own `_id` (recomputing `normalizedTextHash`, `chunkHash`,
 * and backfilling the new `documentTruncated`/`documentExtractionCoveragePct`
 * defaults) — it never deletes a row. Before touching the unique index it
 * verifies there are no duplicate (documentHash, pageStart, chunkIndex)
 * tuples among the EXISTING data (which would violate the new compound
 * unique index); if any are found, the migration stops and reports them
 * without modifying anything, rather than silently dropping one side of
 * a collision.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { computeNormalizedTextHash, computeChunkHash } from '../services/DocumentChunkingService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const findIdentityCollisions = async () => {
  const groups = await ResearchDocumentChunk.aggregate([
    { $group: { _id: { documentHash: '$documentHash', pageStart: '$pageStart', chunkIndex: '$chunkIndex' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  return groups;
};

export const run = async (options = {}) => {
  const dryRun = Boolean(options.dryRun);
  const summary = {
    dryRun, rowsExamined: 0, rowsUpdated: 0, rowsAlreadyCurrent: 0, collisions: [], indexMigrated: false,
  };

  const collisions = await findIdentityCollisions();
  summary.collisions = collisions;
  if (collisions.length) {
    logger.warn(`[migrateChunkIdentity] Found ${collisions.length} (documentHash, pageStart, chunkIndex) collision(s) in EXISTING data — stopping without modifying anything or touching the index. Resolve these manually first.`);
    return summary;
  }

  const cursor = ResearchDocumentChunk.find({}).cursor();
  // eslint-disable-next-line no-restricted-syntax
  for await (const doc of cursor) {
    summary.rowsExamined += 1;
    const normalizedTextHash = computeNormalizedTextHash(doc.text);
    const chunkHash = computeChunkHash({
      documentHash: doc.documentHash, pageStart: doc.pageStart, pageEnd: doc.pageEnd, chunkIndex: doc.chunkIndex, text: doc.text,
    });
    const needsUpdate = doc.normalizedTextHash !== normalizedTextHash
      || doc.chunkHash !== chunkHash
      || doc.documentTruncated === undefined
      || doc.documentExtractionCoveragePct === undefined;

    if (!needsUpdate) { summary.rowsAlreadyCurrent += 1; continue; }
    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await ResearchDocumentChunk.updateOne(
        { _id: doc._id },
        {
          $set: {
            normalizedTextHash,
            chunkHash,
            documentTruncated: doc.documentTruncated ?? false,
            documentExtractionCoveragePct: doc.documentExtractionCoveragePct ?? 100,
          },
        },
      );
    }
    summary.rowsUpdated += 1;
  }

  if (!dryRun) {
    // Drop the old single-field unique index (if still present) and let
    // Mongoose create the new compound unique index defined on the
    // schema — an index change, never a data deletion.
    try {
      const indexes = await ResearchDocumentChunk.collection.indexes();
      if (indexes.some((idx) => idx.name === 'unique_chunk_hash')) {
        await ResearchDocumentChunk.collection.dropIndex('unique_chunk_hash');
      }
      await ResearchDocumentChunk.syncIndexes();
      summary.indexMigrated = true;
    } catch (error) {
      logger.warn(`[migrateChunkIdentity] Index migration failed: ${error.message}`);
      summary.indexMigrationError = error.message;
    }
  }

  return summary;
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);
    const dryRun = process.argv.includes('--dry-run');
    const summary = await run({ dryRun });
    console.log(JSON.stringify(summary, null, 2));
    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[migrateChunkIdentity] Failed: ${err.message}`);
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}

export default run;
