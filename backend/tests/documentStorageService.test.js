import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  isS3Configured, saveDocument, loadDocument, hashBuffer, getGridFsBucket, resetGridFsBucketForTests,
} from '../services/DocumentStorageService.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const cleanupGridFs = async (documentHash) => {
  const bucket = getGridFsBucket();
  const files = await bucket.find({ filename: documentHash }).toArray();
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    await bucket.delete(file._id);
  }
};

test('isS3Configured returns false when AWS env vars are not set (this test environment has none)', () => {
  const keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET'];
  const originals = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(isS3Configured(), false);
  } finally {
    keys.forEach((k, i) => { if (originals[i] !== undefined) process.env[k] = originals[i]; });
  }
});

test('saveDocument persists via GridFS (S3 not configured) and loadDocument round-trips the exact bytes', async (t) => {
  const buffer = Buffer.from(`ZZTEST-PDF-BYTES-${Date.now()}`);
  const documentHash = hashBuffer(buffer);
  t.after(async () => { await cleanupGridFs(documentHash); });

  const saved = await saveDocument(buffer, { symbol: 'ZZTESTDURABILITY', url: 'https://example.com/zztest.pdf' });
  assert.equal(saved.storageBackend, 'GRIDFS', 'falls back to GridFS when S3 is not configured');
  assert.equal(saved.documentHash, documentHash);
  assert.equal(saved.storageKey, documentHash, 'GridFS storage key is the content hash');

  const loaded = await loadDocument(saved.storageKey, saved.storageBackend);
  assert.ok(loaded, 'loadDocument must return the persisted bytes');
  assert.equal(Buffer.compare(loaded, buffer), 0, 'round-tripped bytes must be byte-identical to what was saved');
});

test('saveDocument is idempotent by content hash: saving identical bytes twice never creates a duplicate GridFS file', async (t) => {
  const buffer = Buffer.from(`ZZTEST-DUPLICATE-CONTENT-${Date.now()}`);
  const documentHash = hashBuffer(buffer);
  t.after(async () => { await cleanupGridFs(documentHash); });

  await saveDocument(buffer, { symbol: 'ZZTESTDUP1', url: 'https://example.com/a.pdf' });
  await saveDocument(buffer, { symbol: 'ZZTESTDUP2', url: 'https://example.com/b.pdf' }); // same bytes, different symbol/url

  const bucket = getGridFsBucket();
  const files = await bucket.find({ filename: documentHash }).toArray();
  assert.equal(files.length, 1, 'the same content hash must only ever be stored once');
});

test('loadDocument never throws and returns null for an unknown storageKey', async () => {
  const result = await loadDocument('does-not-exist-hash', 'GRIDFS');
  assert.equal(result, null);
});

test('loadDocument returns null (not a throw) when storageKey or storageBackend is missing', async () => {
  assert.equal(await loadDocument(null, null), null);
  assert.equal(await loadDocument('somehash', null), null);
});

after(async () => {
  resetGridFsBucketForTests();
  await mongoose.disconnect().catch(() => {});
});
