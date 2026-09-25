import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BSE_SCRIP_CODES, resolveBseScripCode, searchExchangeFilings } from '../providers/ExchangeFilingDocumentProvider.js';
import { saveDocument, isPdfPersistenceEnabled } from '../services/DocumentStorageService.js';
import { deriveJobLastError } from '../scripts/backfillUniverse.js';

/**
 * earningsCoveragePipeline.test.js
 * ==================================
 * Covers the changes that let the earnings pipeline reach beyond its nine
 * hand-verified companies: scrip-code resolution from the synced profile, the
 * opt-out for storing PDFs, and the recorded reason for an empty job. None of
 * this needs a database or the network.
 */

test('a verified static scrip code wins and never consults the profile', async () => {
  let consulted = false;
  const code = await resolveBseScripCode('tcs', { findProfile: async () => { consulted = true; return { bseScripCode: '999999' }; } });
  assert.equal(code, BSE_SCRIP_CODES.TCS);
  assert.equal(consulted, false);
});

test('an unmapped symbol resolves from its synced profile', async () => {
  const seen = [];
  const code = await resolveBseScripCode('sbin', { findProfile: async (symbol) => { seen.push(symbol); return { bseScripCode: '500112' }; } });
  assert.equal(code, '500112');
  assert.deepEqual(seen, ['SBIN'], 'the symbol is normalized before the lookup');
});

test('no profile, no scrip code on it, or a failing lookup all yield null, never a guess', async () => {
  assert.equal(await resolveBseScripCode('ZZZ', { findProfile: async () => null }), null);
  assert.equal(await resolveBseScripCode('ZZZ', { findProfile: async () => ({ bseScripCode: null }) }), null);
  assert.equal(await resolveBseScripCode('ZZZ', { findProfile: async () => { throw new Error('db down'); } }), null);
  assert.equal(await resolveBseScripCode('', { findProfile: async () => null }), null);
});

test('discovery for a company with no resolvable scrip code returns nothing and makes no network call', async () => {
  let resolved = 0;
  const filings = await searchExchangeFilings('ZZZ', 'FY2024', { resolveScrip: async () => { resolved += 1; return null; } });
  assert.deepEqual(filings, []);
  assert.equal(resolved, 1);
});

const saved = process.env.EARNINGS_PERSIST_PDFS;
afterEach(() => {
  if (saved === undefined) delete process.env.EARNINGS_PERSIST_PDFS;
  else process.env.EARNINGS_PERSIST_PDFS = saved;
});

test('PDF persistence is on by default and only an explicit "false" turns it off', () => {
  delete process.env.EARNINGS_PERSIST_PDFS;
  assert.equal(isPdfPersistenceEnabled(), true);
  for (const on of ['true', 'TRUE', '1', '', 'yes']) { process.env.EARNINGS_PERSIST_PDFS = on; assert.equal(isPdfPersistenceEnabled(), true, `"${on}"`); }
  for (const off of ['false', 'FALSE', ' false ']) { process.env.EARNINGS_PERSIST_PDFS = off; assert.equal(isPdfPersistenceEnabled(), false, `"${off}"`); }
});

test('with persistence off, saveDocument stores nothing but still returns the content hash', async () => {
  process.env.EARNINGS_PERSIST_PDFS = 'false';
  const buffer = Buffer.from('%PDF-1.4 fake filing bytes');
  const result = await saveDocument(buffer, { symbol: 'AAA', url: 'https://example.test/a.pdf' });
  assert.deepEqual(result, { storageKey: null, storageBackend: null, documentHash: crypto.createHash('sha256').update(buffer).digest('hex') });
});

test('with persistence on (the default), saveDocument still tries to store the document', async () => {
  delete process.env.EARNINGS_PERSIST_PDFS;
  // No S3 config and no Mongo connection in this process: reaching the storage layer is what makes it reject.
  await assert.rejects(saveDocument(Buffer.from('bytes'), { symbol: 'AAA', url: 'https://example.test/a.pdf' }), /MongoDB connection is not ready/);
});

test('an empty job records why: no filings, a discovery failure, or nothing notable', () => {
  assert.equal(deriveJobLastError([{ status: 'NO_FILINGS_FOUND' }, { status: 'NO_FILINGS_FOUND' }]), 'No exchange filings found for any fiscal year in the range');
  assert.equal(deriveJobLastError([{ status: 'NO_FILINGS_FOUND' }, { status: 'DISCOVERY_FAILED' }]), 'One or more fiscal years had a discovery failure');
  assert.equal(deriveJobLastError([{ status: 'NO_FILINGS_FOUND' }, { status: 'PROCESSED' }]), null, 'a year with real work is not "no filings"');
  assert.equal(deriveJobLastError([]), null);
});
