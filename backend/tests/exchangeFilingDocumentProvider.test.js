import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import {
  classifyDocumentType, fiscalYearToDateRange, validateAnnouncementsResponse, getDocumentBuffer, alternateBseUrl,
} from '../providers/ExchangeFilingDocumentProvider.js';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import {
  saveDocument, getGridFsBucket, resetGridFsBucketForTests,
} from '../services/DocumentStorageService.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

test('classifyDocumentType recognizes real TCS and Infosys transcript phrasings via SUBCATNAME, never guessing from subject alone', () => {
  assert.equal(classifyDocumentType({ CATEGORYNAME: 'Company Update', SUBCATNAME: 'Earnings Call Transcript', NEWSSUB: 'Announcement under Regulation 30 (LODR)-Earnings Call Transcript' }), 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(classifyDocumentType({ CATEGORYNAME: 'Company Update', SUBCATNAME: 'General', NEWSSUB: 'Transcript of the Earnings Conference Call held on Apr 12, 2024' }), 'EARNINGS_CALL_TRANSCRIPT');
});

test('classifyDocumentType distinguishes a mere Board Meeting notice (no figures) from real results', () => {
  assert.equal(classifyDocumentType({ CATEGORYNAME: 'Board Meeting', SUBCATNAME: 'Board Meeting', NEWSSUB: 'Board Meeting Intimation for Notice Of Board Meeting' }), null);
  assert.equal(classifyDocumentType({ CATEGORYNAME: 'Result', SUBCATNAME: 'Financial Results', NEWSSUB: 'Results For The Quarter Ended December 31, 2024' }), 'FINANCIAL_RESULTS');
  assert.equal(classifyDocumentType({ CATEGORYNAME: 'Integrated Filing', SUBCATNAME: 'Integrated Filing (Financial)', NEWSSUB: 'Integrated Filing (Financial)' }), 'FINANCIAL_RESULTS');
});

test('classifyDocumentType returns null for an unrecognized announcement rather than guessing', () => {
  assert.equal(classifyDocumentType({ CATEGORYNAME: 'Company Update', SUBCATNAME: 'General', NEWSSUB: 'Infosys Announces New Office In GIFT City' }), null);
});

test('fiscalYearToDateRange produces a real Apr-to-Jun window spanning the fiscal year plus its results-announcement lag', () => {
  const { from, to } = fiscalYearToDateRange('FY2025');
  assert.equal(from.toISOString().slice(0, 10), '2024-04-01');
  assert.equal(to.toISOString().slice(0, 10), '2025-06-30');
});

// --- Task 4: schema validation / PROVIDER_CHANGED detection ---

test('validateAnnouncementsResponse accepts a real, well-formed response', () => {
  const response = { headers: { 'content-type': 'application/json' }, data: { Table: [{ NEWSSUB: 'x' }], Table1: [{ ROWCNT: 1 }] } };
  assert.doesNotThrow(() => validateAnnouncementsResponse(response));
});

test('validateAnnouncementsResponse accepts an empty result set (Table present but empty) without requiring Table1', () => {
  const response = { headers: { 'content-type': 'application/json' }, data: { Table: [], Table1: [] } };
  assert.doesNotThrow(() => validateAnnouncementsResponse(response));
});

test('validateAnnouncementsResponse treats a real API-level rejection (Status:false) as a normal error, not PROVIDER_CHANGED', () => {
  const response = { headers: {}, data: { Status: false, Message: 'Date range cannot exceed 12 months.' } };
  const body = validateAnnouncementsResponse(response);
  assert.equal(body.Status, false);
});

test('validateAnnouncementsResponse raises PROVIDER_CHANGED for an HTML/challenge page instead of JSON', () => {
  const response = { headers: { 'content-type': 'text/html; charset=utf-8' }, data: '<!DOCTYPE html><html><body>Just a moment...</body></html>' };
  assert.throws(() => validateAnnouncementsResponse(response), (err) => err.errorCode === 'PROVIDER_CHANGED');
});

test('validateAnnouncementsResponse raises PROVIDER_CHANGED when the Table field disappears from the schema', () => {
  const response = { headers: { 'content-type': 'application/json' }, data: { SomethingElse: [] } };
  assert.throws(() => validateAnnouncementsResponse(response), (err) => err.errorCode === 'PROVIDER_CHANGED');
});

test('validateAnnouncementsResponse raises PROVIDER_CHANGED when Table1/ROWCNT disappears despite real rows existing', () => {
  const response = { headers: { 'content-type': 'application/json' }, data: { Table: [{ NEWSSUB: 'x' }] } };
  assert.throws(() => validateAnnouncementsResponse(response), (err) => err.errorCode === 'PROVIDER_CHANGED');
});

// --- Durability: getDocumentBuffer (durable-storage-first document access) ---

test('getDocumentBuffer reuses a persisted document via storageKey/storageBackend, never touching the network', async (t) => {
  const buffer = Buffer.from(`ZZTEST-DURABLE-REUSE-${Date.now()}`);
  const saved = await saveDocument(buffer, { symbol: 'ZZTESTREUSE', url: 'https://example.com/reuse.pdf' });
  t.after(async () => {
    const bucket = getGridFsBucket();
    const files = await bucket.find({ filename: saved.documentHash }).toArray();
    for (const file of files) await bucket.delete(file._id); // eslint-disable-line no-await-in-loop
  });

  // The URL is deliberately unroutable (reserved TEST-NET-1 address, RFC
  // 5737) -- if getDocumentBuffer ever fell through to a source re-fetch
  // instead of using the durable copy, this call would hang/fail, proving
  // the durable path was actually taken rather than merely returning bytes
  // that happen to look right.
  const registryDoc = {
    symbol: 'ZZTESTREUSE', url: 'http://127.0.0.1:1/unroutable-should-never-be-fetched.pdf', storageKey: saved.storageKey, storageBackend: saved.storageBackend,
  };
  const result = await getDocumentBuffer(registryDoc);
  assert.equal(result.source, 'DURABLE_STORAGE');
  assert.equal(Buffer.compare(result.buffer, buffer), 0);
});

test('getDocumentBuffer falls back to a source re-fetch when no durable copy exists, and reports UNAVAILABLE (never throws) for an expired/unreachable URL', async () => {
  const registryDoc = {
    symbol: 'ZZTESTNOSTORAGE', url: 'http://127.0.0.1:1/expired-attachlive-link.pdf', storageKey: null, storageBackend: null,
  };
  const result = await getDocumentBuffer(registryDoc);
  assert.equal(result.buffer, null);
  assert.equal(result.source, 'UNAVAILABLE');
});

test('alternateBseUrl swaps AttachLive<->AttachHis for the same attachment, and returns null for an unrecognized URL shape', () => {
  assert.equal(
    alternateBseUrl('https://www.bseindia.com/xml-data/corpfiling/AttachLive/abc-123.pdf'),
    'https://www.bseindia.com/xml-data/corpfiling/AttachHis/abc-123.pdf',
  );
  assert.equal(
    alternateBseUrl('https://www.bseindia.com/xml-data/corpfiling/AttachHis/abc-123.pdf'),
    'https://www.bseindia.com/xml-data/corpfiling/AttachLive/abc-123.pdf',
  );
  assert.equal(alternateBseUrl('https://example.com/some-other-host.pdf'), null);
  assert.equal(alternateBseUrl(null), null);
});

test('getDocumentBuffer recovers via the alternate BSE path when the primary URL 404s, durably stores the result, and a second call then needs no network access at all', async (t) => {
  const http = await import('node:http');
  const pdfBytes = Buffer.from(`ZZTEST-ALT-PATH-PDF-${Date.now()}`);

  const server = http.createServer((req, res) => {
    if (req.url.includes('/AttachHis/')) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdfBytes); return; }
    res.writeHead(404); res.end('Not Found'); // /AttachLive/ (the "stale" primary path) always 404s
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const symbol = 'ZZTESTALTPATH';
  const primaryUrl = `http://127.0.0.1:${port}/xml-data/corpfiling/AttachLive/does-not-exist.pdf`;
  await CompanyDocumentRegistry.deleteMany({ symbol });
  t.after(async () => {
    await CompanyDocumentRegistry.deleteMany({ symbol });
    const bucket = getGridFsBucket();
    const files = await bucket.find({ 'metadata.symbol': symbol }).toArray().catch(() => []);
    for (const file of files) await bucket.delete(file._id); // eslint-disable-line no-await-in-loop
  });

  await CompanyDocumentRegistry.create({
    symbol, companyName: 'ZZ Test Alt Path Co', fiscalYear: 'FY2024', sourceType: 'EARNINGS_CALL_TRANSCRIPT',
    url: primaryUrl, publicationDate: new Date('2024-04-01'), extractionStatus: 'EXTRACTED',
  });

  const registryDoc = await CompanyDocumentRegistry.findOne({ symbol }).lean();
  const result = await getDocumentBuffer(registryDoc);
  assert.equal(result.source, 'ALTERNATE_BSE_PATH');
  assert.equal(Buffer.compare(result.buffer, pdfBytes), 0);

  const updated = await CompanyDocumentRegistry.findOne({ symbol }).lean();
  assert.equal(updated.storageBackend, 'GRIDFS', 'a successful alternate-path re-fetch must be durably stored immediately');
  assert.ok(updated.storageKey);

  await server.close();
  const secondCall = await getDocumentBuffer(updated); // server is now closed -- only the durable copy can satisfy this
  assert.equal(secondCall.source, 'DURABLE_STORAGE');
  assert.equal(Buffer.compare(secondCall.buffer, pdfBytes), 0);
});

after(async () => {
  resetGridFsBucketForTests();
  await mongoose.disconnect().catch(() => {});
});
