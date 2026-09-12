import test from 'node:test';
import assert from 'node:assert/strict';
import { StockService } from '../services/StockService.js';

/**
 * These target the fix for the reported "search fires live-provider
 * requests on every keystroke" symptom (typing TATA, IRCT, IRCTC, hd, hdfc
 * each triggered a fetch): searchStocks previously always added the raw
 * typed fragment as a literal ticker guess *in addition to* any static-
 * directory matches, so an incomplete fragment like "IRCT" both matched
 * IRCTC in the directory AND separately tried to live-fetch a nonexistent
 * "IRCT" ticker. The fix only falls back to that literal-ticker guess when
 * the directory found nothing at all.
 */
const makeServiceWithSpy = () => {
  const service = new StockService({ getStock: async () => { throw new Error('provider should not be called directly in these tests'); } });
  const calls = [];
  service.getMultipleStocks = async (symbols) => { calls.push(symbols); return symbols.map((s) => ({ ticker: s })); };
  return { service, calls };
};

test('a query matching known directory entries never also speculatively fetches the raw typed fragment as a ticker', async () => {
  const { service, calls } = makeServiceWithSpy();
  await service.searchStocks('tata');
  assert.equal(calls.length, 1);
  // "TATA" itself is not a real NSE ticker (TATAMOTORS/TATAPOWER/etc. are) --
  // it must never appear in the fetched symbol list even though it's a
  // valid-looking 2-15 char alnum fragment.
  assert.equal(calls[0].includes('TATA'), false);
  assert.ok(calls[0].length > 0, 'directory matches for "tata" should still be found');
});

test('a query matching nothing in the directory falls back to a literal ticker guess (e.g. a real but unlisted symbol)', async () => {
  const { service, calls } = makeServiceWithSpy();
  await service.searchStocks('zzqqxx');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['ZZQQXX']);
});

test('partial fragments of a known ticker (e.g. "IRCT" before "IRCTC" is fully typed) only fetch real directory matches, not the fragment itself', async () => {
  const { service, calls } = makeServiceWithSpy();
  await service.searchStocks('IRCT');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('IRCT'), false);
});

test('an empty/whitespace-only search query never calls getMultipleStocks at all', async () => {
  const { service, calls } = makeServiceWithSpy();
  await assert.rejects(() => service.searchStocks('   '));
  assert.equal(calls.length, 0);
});
