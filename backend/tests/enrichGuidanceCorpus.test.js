import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';
import { runGuidanceEnrichment } from '../scripts/enrichGuidanceCorpus.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZGUIDANCETEST';

const cleanup = async () => {
  const chunks = await ResearchDocumentChunk.find({ symbol: TEST_SYMBOL }).select('_id').lean();
  await ResearchGuidanceAnnotation.deleteMany({ chunkId: { $in: chunks.map((c) => c._id) } });
  await ResearchDocumentChunk.deleteMany({ symbol: TEST_SYMBOL });
};
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

const insertChunk = async (overrides = {}) => ResearchDocumentChunk.create({
  symbol: TEST_SYMBOL,
  registryDocumentId: new mongoose.Types.ObjectId(),
  documentHash: `doc-${Math.random()}`,
  documentType: 'EARNINGS_CALL_TRANSCRIPT',
  fiscalYear: 'FY2026',
  fiscalQuarter: 'Q2',
  sourceUrl: 'https://example.com/f.pdf',
  pageStart: 7,
  pageEnd: 7,
  chunkIndex: 0,
  text: 'We are targeting operating margin of 26% to 28% for FY2026.',
  approximateTokenCount: 20,
  ...overrides,
});

test('bounded real extraction: a genuine guidance chunk produces exactly one VERIFIED annotation with provenance copied verbatim from the chunk', async () => {
  const chunk = await insertChunk();
  const { totals } = await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1' });
  assert.equal(totals.chunkRowsWritten, 1);
  assert.equal(totals.verifiedSentences, 1);

  const row = await ResearchGuidanceAnnotation.findOne({ chunkId: chunk._id }).lean();
  assert.ok(row);
  assert.equal(row.hasVerifiedAnnotation, true);
  assert.equal(row.annotations.length, 1);
  assert.equal(row.annotations[0].status, 'VERIFIED');
  assert.equal(row.symbol, 'ZZGUIDANCETEST');
  assert.equal(row.pageStart, 7);
  assert.equal(row.pageEnd, 7);
  assert.equal(row.sourceUrl, 'https://example.com/f.pdf');
  assert.equal(row.fiscalYear, 'FY2026');
  assert.equal(row.fiscalQuarter, 'Q2');
  assert.ok(chunk.text.includes(row.annotations[0].supportingSpan));
});

test('idempotency: rerunning the SAME extraction version over an unchanged chunk never creates a duplicate row', async () => {
  await insertChunk();
  await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1' });
  const afterFirst = await ResearchGuidanceAnnotation.countDocuments({ symbol: TEST_SYMBOL });

  await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1' });
  const afterSecond = await ResearchGuidanceAnnotation.countDocuments({ symbol: TEST_SYMBOL });

  assert.equal(afterFirst, afterSecond);
  assert.ok(afterFirst > 0);
});

test('version reprocessing: bumping extractionVersion inserts a NEW row alongside the old one rather than overwriting it', async () => {
  await insertChunk();
  await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1' });
  await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '2' });

  const rows = await ResearchGuidanceAnnotation.find({ symbol: TEST_SYMBOL }).lean();
  const versions = new Set(rows.map((r) => r.extractionVersion));
  assert.deepEqual(versions, new Set(['1', '2']));
});

test('dry-run mode: no annotations are written to the database', async () => {
  await insertChunk();
  const { totals } = await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1', dryRun: true });
  assert.ok(totals.verifiedSentences >= 1);
  const count = await ResearchGuidanceAnnotation.countDocuments({ symbol: TEST_SYMBOL });
  assert.equal(count, 0);
});

test('operational safeguards: --max-chunks bounds how many chunks are processed even when more match the filter', async () => {
  await insertChunk({ documentHash: 'doc-a', pageStart: 1, pageEnd: 1 });
  await insertChunk({ documentHash: 'doc-b', pageStart: 2, pageEnd: 2 });
  const { estimate } = await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1', maxChunks: 1 });
  assert.equal(estimate.chunksToProcess, 1);
});

test('operational safeguards: symbol/fiscalYear/documentType filters are honored', async () => {
  await insertChunk({ documentHash: 'doc-c', fiscalYear: 'FY2023' });
  const resultWrongYear = await runGuidanceEnrichment({ symbol: TEST_SYMBOL, fiscalYear: 'FY2026', extractionVersion: '1' });
  assert.equal(resultWrongYear.estimate.chunksMatched, 0);

  const resultRightYear = await runGuidanceEnrichment({ symbol: TEST_SYMBOL, fiscalYear: 'FY2023', extractionVersion: '1' });
  assert.equal(resultRightYear.estimate.chunksMatched, 1);
});

test('wrong-page/provenance rejection: an annotation NEVER carries a page/source different from the chunk it was extracted from', async () => {
  const chunkA = await insertChunk({ documentHash: 'doc-x', pageStart: 3, pageEnd: 3, sourceUrl: 'https://example.com/a.pdf' });
  const chunkB = await insertChunk({ documentHash: 'doc-y', pageStart: 9, pageEnd: 9, sourceUrl: 'https://example.com/b.pdf' });
  await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1' });

  const rowA = await ResearchGuidanceAnnotation.findOne({ chunkId: chunkA._id }).lean();
  const rowB = await ResearchGuidanceAnnotation.findOne({ chunkId: chunkB._id }).lean();
  assert.equal(rowA.pageStart, 3);
  assert.equal(rowA.sourceUrl, 'https://example.com/a.pdf');
  assert.equal(rowB.pageStart, 9);
  assert.equal(rowB.sourceUrl, 'https://example.com/b.pdf');
});

test('company isolation: a chunk for a different symbol never contaminates another symbol\'s annotations', async () => {
  await insertChunk({ documentHash: 'doc-z' });
  await ResearchDocumentChunk.create({
    symbol: 'ZZGUIDANCEOTHER', registryDocumentId: new mongoose.Types.ObjectId(), documentHash: 'doc-other',
    documentType: 'EARNINGS_CALL_TRANSCRIPT', fiscalYear: 'FY2026', sourceUrl: 'https://example.com/o.pdf',
    pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 'We are targeting operating margin of 10% to 12% for FY2026.', approximateTokenCount: 20,
  });

  await runGuidanceEnrichment({ symbol: TEST_SYMBOL, extractionVersion: '1' });
  const otherSymbolRows = await ResearchGuidanceAnnotation.countDocuments({ symbol: 'ZZGUIDANCEOTHER' });
  assert.equal(otherSymbolRows, 0);

  await ResearchDocumentChunk.deleteMany({ symbol: 'ZZGUIDANCEOTHER' });
});
