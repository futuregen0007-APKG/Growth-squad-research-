/**
 * migratePromiseCandidateIndex.js
 * ================================
 * `node scripts/migratePromiseCandidateIndex.js --expect-target <host>/<database> [--dry-run]`
 *
 * Replaces PromiseCandidate's unique index (symbol, period, category, source)
 * with (symbol, period, category, metric, scope, segment, source) -- see
 * models/PromiseCandidate.js for why. Idempotent: creates the new index first
 * (so the collection is never unprotected), then drops the old one if present.
 * Existing candidates are untouched; v1 records have metric/scope null, so
 * they satisfy the new index exactly as they satisfied the old one.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { assertMongoTarget } from '../utils/mongoTarget.js';

const NEW_KEY = {
  symbol: 1, 'promise.targetPeriod': 1, 'promise.category': 1, 'promise.metric': 1, 'promise.scope': 1, 'promise.segment': 1, 'promiseEvidence.sourceUrl': 1,
};

/** migrateIndex - injectable for tests. Returns what it did. */
export const migrateIndex = async (collection, { newName, legacyName, dryRun = false }) => {
  const before = (await collection.indexes()).map((i) => i.name);
  const actions = [];
  if (!before.includes(newName)) {
    actions.push(`create ${newName}`);
    if (!dryRun) await collection.createIndex(NEW_KEY, { unique: true, name: newName });
  }
  if (before.includes(legacyName)) {
    actions.push(`drop ${legacyName}`);
    if (!dryRun) await collection.dropIndex(legacyName);
  }
  return { before, actions };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
    const argv = process.argv.slice(2);
    const expectIdx = argv.indexOf('--expect-target');
    const expect = expectIdx >= 0 ? argv[expectIdx + 1] : (argv.find((a) => a.startsWith('--expect-target=')) || '').split('=')[1];
    if (!expect) throw new Error('--expect-target <host>/<database> is required');
    const target = assertMongoTarget(process.env.MONGODB_URI, expect);
    console.log(`Target database: ${target.label}`);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
    const { CANDIDATE_UNIQUE_INDEX_NAME, LEGACY_CANDIDATE_UNIQUE_INDEX_NAME } = await import('../models/PromiseCandidate.js');
    const result = await migrateIndex(mongoose.connection.db.collection('promisecandidates'), {
      newName: CANDIDATE_UNIQUE_INDEX_NAME, legacyName: LEGACY_CANDIDATE_UNIQUE_INDEX_NAME, dryRun: argv.includes('--dry-run'),
    });
    console.log(`Indexes before: ${result.before.join(', ')}`);
    console.log(result.actions.length ? `${argv.includes('--dry-run') ? 'Would' : 'Did'}: ${result.actions.join('; ')}` : 'Nothing to do.');
    await mongoose.disconnect();
    process.exit(0);
  })().catch(async (error) => {
    console.error('Index migration failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
