import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import {
  run, status, isGenuinePdf, looksLikeChallengePage, classifyFetchFailure,
} from '../scripts/recoverTcsDurability.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZTCSRECOVERTEST';
const cleanup = async () => { await CompanyDocumentRegistry.deleteMany({ symbol: TEST_PREFIX }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

const fakeRegistryDoc = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  symbol: TEST_PREFIX,
  companyName: 'Test Co',
  fiscalYear: 'FY2026',
  sourceType: 'ANNUAL_REPORT',
  url: 'https://example.com/doc.pdf',
  publicationDate: new Date('2026-01-01'),
  pdfHash: null,
  storageKey: null,
  storageBackend: null,
  ...overrides,
});

test('required: this recovery script is explicitly scoped to TCS only -- refuses any other symbol', async () => {
  await assert.rejects(() => run({ symbol: 'INFY' }), /explicitly scoped to TCS/);
});

test('isGenuinePdf validates a real %PDF- magic-byte header', () => {
  assert.equal(isGenuinePdf(Buffer.from('%PDF-1.4 real content')), true);
  assert.equal(isGenuinePdf(Buffer.from('<html><body>not a pdf</body></html>')), false);
  assert.equal(isGenuinePdf(Buffer.alloc(0)), false);
});

test('looksLikeChallengePage detects an HTML/challenge interstitial, never flags real PDF bytes', () => {
  assert.equal(looksLikeChallengePage(Buffer.from('<!doctype html><title>Access Denied</title>')), true);
  assert.equal(looksLikeChallengePage(Buffer.from('%PDF-1.4 genuine binary-ish content here')), false);
});

test('classifyFetchFailure categorizes stale/404, timeout, and generic network errors separately', () => {
  assert.equal(classifyFetchFailure({ response: { status: 404 } }), 'STALE_URL_404');
  assert.equal(classifyFetchFailure({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' }), 'TIMEOUT');
  assert.equal(classifyFetchFailure({ response: { status: 403 } }), 'HTTP_403');
  assert.equal(classifyFetchFailure({ message: 'socket hang up' }), 'NETWORK_ERROR');
});

test('dry-run reports WOULD_ATTEMPT_FETCH without ever downloading or writing anything', async () => {
  const docs = [fakeRegistryDoc(), fakeRegistryDoc({ url: 'https://example.com/doc2.pdf' })];
  const summary = await run({ registryDocs: docs, dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.ok(summary.perDocument.every((d) => d.outcome === 'WOULD_ATTEMPT_FETCH'));
});

test('required: never overwrites a record that already has storageKey+storageBackend set -- the query/guard excludes it', async () => {
  const doc = fakeRegistryDoc({ storageKey: 'already-there', storageBackend: 'GRIDFS' });
  const summary = await run({ registryDocs: [doc], dryRun: true });
  assert.equal(summary.perDocument[0].outcome, 'ALREADY_DURABLE');
  assert.equal(summary.alreadyDurable, 1);
});

test('batch-size bounds how many registry records are examined per run', async () => {
  const docs = Array.from({ length: 5 }, (_, i) => fakeRegistryDoc({ url: `https://example.com/doc-${i}.pdf` }));
  const summary = await run({ registryDocs: docs, dryRun: true, batchSize: 2 });
  assert.equal(summary.perDocument.length, 2);
});

test('status() reports real registry durability counts without writing anything', async () => {
  await CompanyDocumentRegistry.create(fakeRegistryDoc({ storageKey: 'k1', storageBackend: 'GRIDFS' }));
  await CompanyDocumentRegistry.create(fakeRegistryDoc({ url: 'https://example.com/doc2.pdf' }));
  const report = await status({ symbol: TEST_PREFIX });
  assert.equal(report.total, 2);
  assert.equal(report.durable, 1);
  assert.equal(report.missing, 1);
});
