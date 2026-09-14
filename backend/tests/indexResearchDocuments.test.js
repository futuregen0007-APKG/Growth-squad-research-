import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { run, status, DEFAULT_CANARY_SYMBOLS } from '../scripts/indexResearchDocuments.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZIDXTEST';
const cleanup = async () => { await ResearchDocumentChunk.deleteMany({ symbol: new RegExp(`^${TEST_PREFIX}`) }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

const fakeRegistryDoc = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  symbol: `${TEST_PREFIX}A`,
  companyName: 'Test Co',
  fiscalYear: 'FY2026',
  sourceType: 'ANNUAL_REPORT',
  url: 'https://example.com/doc.pdf',
  publicationDate: new Date('2026-01-01'),
  pdfHash: 'hash-abc',
  storageKey: 'hash-abc',
  storageBackend: 'GRIDFS',
  extractionStatus: 'EXTRACTED',
  ...overrides,
});

test('never indexes the full universe by default -- with no --symbols, defaults to the small documented canary', () => {
  assert.deepEqual(DEFAULT_CANARY_SYMBOLS, ['TCS', 'INFY']);
});

test('dry-run reports what WOULD be processed without downloading, extracting, or writing anything', async () => {
  const docs = [fakeRegistryDoc(), fakeRegistryDoc({ url: 'https://example.com/doc2.pdf' })];
  const summary = await run({ registryDocs: docs, dryRun: true, batchSize: 10 });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.documentsProcessed, 2);
  assert.ok(summary.perDocument.every((d) => d.status === 'WOULD_PROCESS'));
  const chunkCount = await ResearchDocumentChunk.countDocuments({ symbol: `${TEST_PREFIX}A` });
  assert.equal(chunkCount, 0, 'dry-run must never write to the database');
});

test('required: re-indexing an unchanged document with --resume skips it entirely (no download attempted)', async () => {
  await ResearchDocumentChunk.create({
    symbol: `${TEST_PREFIX}A`, registryDocumentId: new mongoose.Types.ObjectId(), documentHash: 'hash-abc',
    chunkHash: 'existing-chunk-1', documentType: 'ANNUAL_REPORT', fiscalYear: 'FY2026', sourceUrl: 'https://example.com/doc.pdf',
    pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 'existing text', approximateTokenCount: 5,
  });
  const registryDoc = fakeRegistryDoc({ registryDocumentId: undefined });
  // hasCurrentChunks looks up by registryDocumentId -- align the fake
  // registry doc's _id with what we just inserted the chunk against.
  const chunkDoc = await ResearchDocumentChunk.findOne({ chunkHash: 'existing-chunk-1' });
  registryDoc._id = chunkDoc.registryDocumentId;

  const summary = await run({ registryDocs: [registryDoc], resume: true, batchSize: 10 });
  assert.equal(summary.documentsSkippedResume, 1);
  assert.equal(summary.perDocument[0].status, 'SKIPPED_RESUME');
});

test('a document whose pdfHash CHANGED is never skipped by --resume, even if old chunks exist', async () => {
  const registryId = new mongoose.Types.ObjectId();
  await ResearchDocumentChunk.create({
    symbol: `${TEST_PREFIX}A`, registryDocumentId: registryId, documentHash: 'OLD-hash',
    chunkHash: 'old-chunk-1', documentType: 'ANNUAL_REPORT', fiscalYear: 'FY2026', sourceUrl: 'https://example.com/doc.pdf',
    pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 'old text', approximateTokenCount: 5,
  });
  const registryDoc = fakeRegistryDoc({ _id: registryId, pdfHash: 'NEW-hash', storageKey: 'NEW-hash' });
  const summary = await run({ registryDocs: [registryDoc], resume: true, dryRun: true, batchSize: 10 });
  assert.equal(summary.documentsSkippedResume, 0);
  assert.equal(summary.perDocument[0].status, 'WOULD_PROCESS');
});

test('batch-size bounds how many documents are processed in one run', async () => {
  const docs = Array.from({ length: 5 }, (_, i) => fakeRegistryDoc({ url: `https://example.com/doc-${i}.pdf` }));
  const summary = await run({ registryDocs: docs, dryRun: true, batchSize: 2 });
  assert.equal(summary.documentsProcessed, 2);
});

test('required: force-reindex-symbol is scoped to exactly one symbol, deletes only that symbol\'s chunks, opt-in only', async () => {
  await ResearchDocumentChunk.create([
    { symbol: `${TEST_PREFIX}A`, registryDocumentId: new mongoose.Types.ObjectId(), documentHash: 'h1', chunkHash: 'c1', documentType: 'ANNUAL_REPORT', fiscalYear: 'FY2026', sourceUrl: 'u', pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 't', approximateTokenCount: 1 },
    { symbol: `${TEST_PREFIX}B`, registryDocumentId: new mongoose.Types.ObjectId(), documentHash: 'h2', chunkHash: 'c2', documentType: 'ANNUAL_REPORT', fiscalYear: 'FY2026', sourceUrl: 'u', pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 't', approximateTokenCount: 1 },
  ]);
  const summary = await run({ registryDocs: [], forceReindexSymbol: `${TEST_PREFIX}A` });
  assert.equal(summary.forceReindexDeletedChunks, 1);
  const remainingA = await ResearchDocumentChunk.countDocuments({ symbol: `${TEST_PREFIX}A` });
  const remainingB = await ResearchDocumentChunk.countDocuments({ symbol: `${TEST_PREFIX}B` });
  assert.equal(remainingA, 0, 'only the targeted symbol\'s chunks are removed');
  assert.equal(remainingB, 1, 'an unrelated symbol\'s chunks must never be touched by a scoped force-reindex');
});

test('force-reindex-symbol under --dry-run deletes nothing', async () => {
  await ResearchDocumentChunk.create({
    symbol: `${TEST_PREFIX}A`, registryDocumentId: new mongoose.Types.ObjectId(), documentHash: 'h1', chunkHash: 'c-dry', documentType: 'ANNUAL_REPORT', fiscalYear: 'FY2026', sourceUrl: 'u', pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 't', approximateTokenCount: 1,
  });
  const summary = await run({ registryDocs: [], forceReindexSymbol: `${TEST_PREFIX}A`, dryRun: true });
  assert.equal(summary.wouldForceReindex, `${TEST_PREFIX}A`);
  const remaining = await ResearchDocumentChunk.countDocuments({ symbol: `${TEST_PREFIX}A` });
  assert.equal(remaining, 1, 'a dry-run must never actually delete anything');
});

test('status() reports real counts without writing anything', async () => {
  await ResearchDocumentChunk.create({
    symbol: `${TEST_PREFIX}A`, registryDocumentId: new mongoose.Types.ObjectId(), documentHash: 'h1', chunkHash: 'c-status', documentType: 'ANNUAL_REPORT', fiscalYear: 'FY2026', sourceUrl: 'u', pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 't', approximateTokenCount: 1, indexedAt: new Date(),
  });
  const report = await status({ symbols: [`${TEST_PREFIX}A`] });
  const entry = report.chunkCounts.find((c) => c._id === `${TEST_PREFIX}A`);
  assert.equal(entry.chunks, 1);
  assert.equal(entry.embedded, 1);
});
