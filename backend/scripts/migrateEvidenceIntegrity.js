/**
 * migrateEvidenceIntegrity.js
 * ==============================
 * `node scripts/migrateEvidenceIntegrity.js [--dry-run] [--symbol=TCS]`
 *
 * Phase 4F.1 Part 3: backfills every REAL_RESEARCH ManagementPromise
 * document that has NO evidenceIntegrity field at all to an explicit
 * UNREVIEWED_LEGACY status -- turning silent absence (which, before this
 * migration, meant a document was fail-open-visible for any symbol never
 * touched by a manual audit) into an honest, auditable "we have not
 * checked this yet" marker that is itself NOT public-safe (see
 * isPubliclyVisibleRecord in utils/earningsIntelligenceValidation.js).
 *
 * Safety properties (Task 3's own requirements):
 *   - Idempotent: only ever touches a document whose evidenceIntegrity is
 *     completely absent; a document already carrying ANY status (even
 *     UNREVIEWED_LEGACY from a prior run) is left untouched. Re-running
 *     this script twice in a row is a true no-op the second time.
 *   - Never marks anything verified: the ONLY status this script ever
 *     writes is UNREVIEWED_LEGACY -- it makes no claim about correctness,
 *     only about whether a human/audit has looked at the record yet.
 *   - Preserves all original data: only the evidenceIntegrity subdocument
 *     is set; every other field on the document is untouched.
 *   - Never creates a duplicate: this is a plain $set update on existing
 *     documents matched by _id, never an insert.
 *   - Records migration version + timestamp on every document it
 *     touches (evidenceIntegrity.migrationVersion/migratedAt), so a
 *     later migration revision can distinguish "untouched by any
 *     migration" from "touched by migration version N" if the policy
 *     ever needs to change.
 *   - --dry-run reports exactly what WOULD change with no writes.
 *   - --symbol=X scopes the migration to one symbol (omit for all).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import ManagementPromise from '../models/ManagementPromise.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const MIGRATION_VERSION = '1';

/**
 * runMigration - the exported, testable core. Returns before/after counts
 * by evidenceIntegrity.status (Task 3: "reports before/after counts"),
 * plus how many documents were touched.
 */
export const runMigration = async ({ dryRun = false, symbol = null } = {}) => {
  const baseFilter = { dataOrigin: 'REAL_RESEARCH', ...(symbol ? { symbol: String(symbol).toUpperCase() } : {}) };

  const countByStatus = async () => {
    const rows = await ManagementPromise.aggregate([
      { $match: baseFilter },
      { $group: { _id: '$evidenceIntegrity.status', n: { $sum: 1 } } },
    ]);
    const counts = {};
    for (const row of rows) counts[row._id ?? '(missing)'] = row.n;
    return counts;
  };

  const before = await countByStatus();

  // The ONLY documents this migration ever touches: REAL_RESEARCH,
  // evidenceIntegrity.status missing or null. Mongoose's own schema
  // default means a document saved without ever setting evidenceIntegrity
  // still has the subdocument present with every field defaulted to null
  // (confirmed live) -- so `evidenceIntegrity: { $exists: false }` alone
  // would never match anything; querying the leaf field
  // `evidenceIntegrity.status: null` correctly matches BOTH a genuinely
  // absent subdocument and one present with a null status, which is
  // exactly "never migrated" either way.
  const candidateFilter = { ...baseFilter, 'evidenceIntegrity.status': null };
  const candidateCount = await ManagementPromise.countDocuments(candidateFilter);

  let migratedCount = 0;
  if (!dryRun && candidateCount > 0) {
    const result = await ManagementPromise.updateMany(candidateFilter, {
      $set: {
        evidenceIntegrity: {
          status: 'UNREVIEWED_LEGACY',
          auditedAt: null,
          auditedBy: null,
          notes: 'Backfilled by scripts/migrateEvidenceIntegrity.js -- no human/automated audit has reviewed this record\'s primary-source evidence yet.',
          migrationVersion: MIGRATION_VERSION,
          migratedAt: new Date(),
        },
      },
    });
    migratedCount = result.modifiedCount;
  }

  const after = dryRun ? before : await countByStatus();

  return {
    dryRun,
    symbol: symbol || 'ALL',
    candidateCount,
    migratedCount,
    before,
    after,
  };
};

const parseArgs = (argv) => ({
  dryRun: argv.includes('--dry-run'),
  symbol: (argv.find((a) => a.startsWith('--symbol=')) || '').split('=')[1] || null,
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    console.log('Evidence integrity migration (Phase 4F.1)');
    console.log('='.repeat(60));
    console.log(`Scope: symbol=${opts.symbol || 'ALL'} dryRun=${opts.dryRun} migrationVersion=${MIGRATION_VERSION}`);

    const result = await runMigration(opts);

    console.log('-'.repeat(60));
    console.log('BEFORE:', JSON.stringify(result.before));
    console.log(`Candidates (evidenceIntegrity missing entirely): ${result.candidateCount}`);
    console.log(`Migrated to UNREVIEWED_LEGACY: ${result.migratedCount}${opts.dryRun ? ' (DRY RUN -- no writes made)' : ''}`);
    console.log('AFTER: ', JSON.stringify(result.after));

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[migrateEvidenceIntegrity] Failed: ${err.message}`);
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}

export default runMigration;
