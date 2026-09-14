import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZIDENTITYTEST';
const cleanup = async () => { await ResearchDocumentChunk.deleteMany({ symbol: new RegExp(`^${TEST_PREFIX}`) }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

const baseChunk = (overrides = {}) => ({
  symbol: TEST_PREFIX,
  registryDocumentId: new mongoose.Types.ObjectId(),
  documentHash: 'doc-hash-shared',
  documentType: 'ANNUAL_REPORT',
  fiscalYear: 'FY2026',
  sourceUrl: 'https://example.com/filing.pdf',
  pageStart: 1,
  pageEnd: 1,
  chunkIndex: 0,
  text: 'Real chunk text for identity testing.',
  approximateTokenCount: 10,
  ...overrides,
});

test('required (Phase 4A.1): the database itself rejects a duplicate (documentHash, pageStart, chunkIndex) — the compound identity is enforced, not just hoped for', async () => {
  await ResearchDocumentChunk.create(baseChunk());
  await assert.rejects(
    () => ResearchDocumentChunk.create(baseChunk({ text: 'Different text at the exact same identity position.' })),
    (error) => error.code === 11000 && /unique_chunk_identity/.test(error.message),
  );
});

test('required (Phase 4A.1): identical text in two different documents inserts as two independent, independently citable rows', async () => {
  const sharedText = 'The exact same disclosure paragraph appears in two unrelated filings.';
  await ResearchDocumentChunk.create(baseChunk({ documentHash: 'doc-A', text: sharedText }));
  await ResearchDocumentChunk.create(baseChunk({ documentHash: 'doc-B', text: sharedText }));
  const rows = await ResearchDocumentChunk.find({ symbol: TEST_PREFIX }).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.documentHash)), new Set(['doc-A', 'doc-B']));
});

test('required (Phase 4A.1): identical text on two different pages of the SAME document inserts as two independent rows, both page numbers preserved', async () => {
  const sharedText = 'A boilerplate risk-factors sentence repeated verbatim on two pages of one filing.';
  await ResearchDocumentChunk.create(baseChunk({ pageStart: 3, pageEnd: 3, chunkIndex: 0, text: sharedText }));
  await ResearchDocumentChunk.create(baseChunk({ pageStart: 47, pageEnd: 47, chunkIndex: 1, text: sharedText }));
  const rows = await ResearchDocumentChunk.find({ symbol: TEST_PREFIX }).sort({ pageStart: 1 }).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.pageStart), [3, 47]);
});

test('required (Phase 4A.1): re-indexing an unchanged document (upsert by compound key) is a true no-op — same row, same content', async () => {
  const chunk = baseChunk();
  await ResearchDocumentChunk.updateOne(
    { documentHash: chunk.documentHash, pageStart: chunk.pageStart, chunkIndex: chunk.chunkIndex },
    { $set: chunk },
    { upsert: true },
  );
  await ResearchDocumentChunk.updateOne(
    { documentHash: chunk.documentHash, pageStart: chunk.pageStart, chunkIndex: chunk.chunkIndex },
    { $set: chunk },
    { upsert: true },
  );
  const rows = await ResearchDocumentChunk.find({ symbol: TEST_PREFIX }).lean();
  assert.equal(rows.length, 1, 'an unchanged re-index must never create a second row');
});

test('required (Phase 4A.1): a re-chunk that changes text at the SAME (document, page, index) position updates the existing row in place rather than orphaning it', async () => {
  const identity = { documentHash: 'doc-rechunk', pageStart: 5, chunkIndex: 2 };
  await ResearchDocumentChunk.updateOne(identity, { $set: baseChunk({ ...identity, text: 'Original extraction text before an algorithm improvement.' }) }, { upsert: true });
  await ResearchDocumentChunk.updateOne(identity, { $set: baseChunk({ ...identity, text: 'Improved extraction text after a chunking algorithm change.' }) }, { upsert: true });
  const rows = await ResearchDocumentChunk.find({ symbol: TEST_PREFIX, ...identity }).lean();
  assert.equal(rows.length, 1, 'a changed chunk at the same structural position updates in place, never accumulates a duplicate');
  assert.equal(rows[0].text, 'Improved extraction text after a chunking algorithm change.');
});

test('normalizedTextHash and chunkHash are auto-filled by the model when omitted, without overriding an explicitly-provided value', async () => {
  const auto = await ResearchDocumentChunk.create(baseChunk({ pageStart: 9, chunkIndex: 9 }));
  assert.ok(auto.normalizedTextHash);
  assert.ok(auto.chunkHash);

  const explicit = await ResearchDocumentChunk.create(baseChunk({ pageStart: 10, chunkIndex: 10, chunkHash: 'caller-provided-marker' }));
  assert.equal(explicit.chunkHash, 'caller-provided-marker', 'an explicitly-provided chunkHash must never be silently overwritten');
});
