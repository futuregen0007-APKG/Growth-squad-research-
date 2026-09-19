import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import ManagementPromise from '../models/ManagementPromise.js';
import { runMigration, MIGRATION_VERSION } from '../scripts/migrateEvidenceIntegrity.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZMIGRATIONTEST';
const OTHER_SYMBOL = 'ZZMIGRATIONOTHER';
const cleanup = async () => { await ManagementPromise.deleteMany({ symbol: { $in: [TEST_SYMBOL, OTHER_SYMBOL] } }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

const baseDoc = (symbol, overrides = {}) => ({
  dataOrigin: 'REAL_RESEARCH',
  companyId: symbol,
  symbol,
  companyName: 'Migration Test Co',
  promise: {
    statement: 'Management guided revenue growth of at least 10%.',
    metric: 'REVENUE_GROWTH',
    targetValue: 10,
    targetUnit: 'PERCENTAGE',
    targetPeriod: 'FY2026',
    promiseDate: new Date('2025-04-01'),
    importance: 'MEDIUM',
  },
  outcome: { actualValue: null, actualUnit: null },
  verification: { status: 'PENDING', achievementPercentage: null },
  evidence: {
    promiseSource: { sourceUrl: 'https://example.com/ir/transcript.pdf', sourceDate: new Date('2025-04-01'), title: 'Test transcript', excerpt: 'We expect revenue growth of at least 10%.' },
  },
  status: 'PENDING',
  ...overrides,
});

test('a document with NO evidenceIntegrity field is migrated to UNREVIEWED_LEGACY, with version and timestamp recorded', async () => {
  const doc = await ManagementPromise.create(baseDoc(TEST_SYMBOL));
  const result = await runMigration({ symbol: TEST_SYMBOL });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.migratedCount, 1);

  const reloaded = await ManagementPromise.findById(doc._id).lean();
  assert.equal(reloaded.evidenceIntegrity.status, 'UNREVIEWED_LEGACY');
  assert.equal(reloaded.evidenceIntegrity.migrationVersion, MIGRATION_VERSION);
  assert.ok(reloaded.evidenceIntegrity.migratedAt);
  assert.equal(reloaded.evidenceIntegrity.auditedBy, null, 'UNREVIEWED_LEGACY must never claim a human auditor reviewed it');
});

test('idempotency: running the migration twice in a row is a true no-op the second time', async () => {
  await ManagementPromise.create(baseDoc(TEST_SYMBOL));
  const first = await runMigration({ symbol: TEST_SYMBOL });
  assert.equal(first.migratedCount, 1);

  const second = await runMigration({ symbol: TEST_SYMBOL });
  assert.equal(second.candidateCount, 0);
  assert.equal(second.migratedCount, 0);

  const count = await ManagementPromise.countDocuments({ symbol: TEST_SYMBOL });
  assert.equal(count, 1, 'no duplicate document was created');
});

test('a document already carrying ANY evidenceIntegrity status (even from a prior manual audit) is left completely untouched', async () => {
  const doc = await ManagementPromise.create(baseDoc(TEST_SYMBOL, {
    evidenceIntegrity: { status: 'VERIFIED_PRIMARY', auditedAt: new Date('2026-01-01'), auditedBy: 'a-human-reviewer', notes: 'manually confirmed' },
  }));
  const result = await runMigration({ symbol: TEST_SYMBOL });
  assert.equal(result.candidateCount, 0);
  assert.equal(result.migratedCount, 0);

  const reloaded = await ManagementPromise.findById(doc._id).lean();
  assert.equal(reloaded.evidenceIntegrity.status, 'VERIFIED_PRIMARY');
  assert.equal(reloaded.evidenceIntegrity.auditedBy, 'a-human-reviewer', 'a real human audit must never be overwritten by the migration default');
});

test('dry-run reports exactly what would change without writing anything', async () => {
  const doc = await ManagementPromise.create(baseDoc(TEST_SYMBOL));
  const result = await runMigration({ symbol: TEST_SYMBOL, dryRun: true });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.migratedCount, 0);

  const reloaded = await ManagementPromise.findById(doc._id).lean();
  assert.equal(reloaded.evidenceIntegrity?.status ?? null, null, 'dry-run must never write anything');
});

test('symbol filter scopes the migration -- a different symbol\'s document is never touched', async () => {
  await ManagementPromise.create(baseDoc(TEST_SYMBOL));
  const otherDoc = await ManagementPromise.create(baseDoc(OTHER_SYMBOL));

  await runMigration({ symbol: TEST_SYMBOL });

  const otherReloaded = await ManagementPromise.findById(otherDoc._id).lean();
  assert.equal(otherReloaded.evidenceIntegrity?.status ?? null, null, 'a document for a different symbol must be untouched by a symbol-scoped migration');
});

test('preserves all original data -- only evidenceIntegrity is set, every other field is untouched', async () => {
  const original = baseDoc(TEST_SYMBOL);
  const doc = await ManagementPromise.create(original);
  await runMigration({ symbol: TEST_SYMBOL });

  const reloaded = await ManagementPromise.findById(doc._id).lean();
  assert.equal(reloaded.promise.statement, original.promise.statement);
  assert.equal(reloaded.promise.targetValue, original.promise.targetValue);
  assert.equal(reloaded.evidence.promiseSource.sourceUrl, original.evidence.promiseSource.sourceUrl);
});

test('before/after counts by status are reported accurately', async () => {
  await ManagementPromise.create(baseDoc(TEST_SYMBOL, { promise: { ...baseDoc(TEST_SYMBOL).promise, statement: 'a' } }));
  await ManagementPromise.create(baseDoc(TEST_SYMBOL, {
    promise: { ...baseDoc(TEST_SYMBOL).promise, statement: 'b' },
    evidenceIntegrity: { status: 'VERIFIED_PRIMARY', auditedAt: new Date(), auditedBy: 'x' },
  }));
  const result = await runMigration({ symbol: TEST_SYMBOL });
  assert.equal(result.before['(missing)'], 1);
  assert.equal(result.before.VERIFIED_PRIMARY, 1);
  assert.equal(result.after['(missing)'], undefined);
  assert.equal(result.after.UNREVIEWED_LEGACY, 1);
  assert.equal(result.after.VERIFIED_PRIMARY, 1);
});
