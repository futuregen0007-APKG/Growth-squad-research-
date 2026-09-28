import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { getScripMaster, resolveScripForSymbol, SCRIP_ID_OVERRIDES } from '../providers/BseScripMasterProvider.js';

/**
 * bseScripMasterProvider.test.js
 * =================================
 * This provider is the ONLY real source of market cap in this project
 * (Angel One's live feed never returns one) -- CompanyResearchProfile, and
 * therefore every stock's marketCapSegment for Goals' "Load Eligible
 * Stocks", depends on it. It had zero test coverage, and live-diagnosing
 * why every stock had marketCapSegment: null in production surfaced a real
 * bug: BSE's edge returns HTTP 403 for the original, thinner header set
 * (User-Agent/Referer/Accept only); the fix (Origin + Accept-Language +
 * Sec-Fetch-*) is pinned here so a future edit can't silently drop them and
 * reintroduce the 403. Network is mocked by monkey-patching axios.get, the
 * convention already used elsewhere in this suite.
 */

const originalGet = axios.get;
const restoreAxios = () => { axios.get = originalGet; };

test('getScripMaster normalizes a real BSE response shape, sends the full header set BSE requires, and filters rows missing an id', async (t) => {
  t.after(restoreAxios);
  let capturedHeaders = null;
  axios.get = async (url, config) => {
    capturedHeaders = config.headers;
    return {
      data: [
        { scrip_id: 'TCS', SCRIP_CD: '532540', Issuer_Name: 'Tata Consultancy Services Ltd', Mktcap: '750000.5', ISIN_NUMBER: 'INE467B01029' },
        { scrip_id: 'INFY', SCRIP_CD: '500209', Scrip_Name: 'Infosys', Mktcap: '407000', ISIN_NUMBER: 'INE009A01021' },
        { scrip_id: 'NOID', SCRIP_CD: '', Issuer_Name: 'Missing Scrip Code Co' }, // dropped: no SCRIP_CD
        { scrip_id: '', SCRIP_CD: '999999', Issuer_Name: 'Missing Symbol Co' }, // dropped: no scrip_id
      ],
    };
  };

  const result = await getScripMaster({ forceRefresh: true });
  assert.equal(result.length, 2, 'rows missing scrip_id or SCRIP_CD are dropped, never guessed');
  assert.deepEqual(result[0], {
    scripCode: '532540', symbol: 'TCS', companyName: 'Tata Consultancy Services Ltd', marketCapCr: 750000.5, isin: 'INE467B01029',
  });
  assert.equal(result[1].companyName, 'Infosys', 'falls back to Scrip_Name when Issuer_Name is absent');

  assert.equal(capturedHeaders.Origin, 'https://www.bseindia.com', 'the Origin header that fixed the 403 must not silently regress');
  assert.equal(capturedHeaders['Accept-Language'], 'en-US,en;q=0.9');
  assert.equal(capturedHeaders['sec-fetch-site'], 'same-site');
  assert.equal(capturedHeaders['sec-fetch-mode'], 'cors');
  assert.equal(capturedHeaders['sec-fetch-dest'], 'empty');
});

test('a row with a non-finite Mktcap gets marketCapCr: null, never 0 or NaN', async (t) => {
  t.after(restoreAxios);
  axios.get = async () => ({ data: [{ scrip_id: 'X', SCRIP_CD: '1', Issuer_Name: 'X Ltd', Mktcap: 'not-a-number', ISIN_NUMBER: 'INE000X00000' }] });
  const result = await getScripMaster({ forceRefresh: true });
  assert.equal(result[0].marketCapCr, null);
});

test('a non-array response is treated as a failure: getScripMaster returns [] rather than throwing or guessing', async (t) => {
  t.after(restoreAxios);
  axios.get = async () => ({ data: { error: 'unexpected shape' } });
  assert.deepEqual(await getScripMaster({ forceRefresh: true }), []);
});

test('a network/HTTP failure (e.g. a 403) degrades to an empty list rather than throwing out of the provider', async (t) => {
  t.after(restoreAxios);
  axios.get = async () => { const e = new Error('Request failed with status code 403'); e.response = { status: 403 }; throw e; };
  assert.deepEqual(await getScripMaster({ forceRefresh: true }), []);
});

test('resolveScripForSymbol matches a symbol directly against the master', async () => {
  const scripMaster = [{ scripCode: '532540', symbol: 'TCS', companyName: 'TCS', marketCapCr: 750000, isin: 'X' }];
  const resolved = await resolveScripForSymbol('TCS', scripMaster);
  assert.equal(resolved.scripCode, '532540');
});

test('resolveScripForSymbol uses the explicit override map for a symbol whose BSE ticker differs from SUPPORTED_STOCKS', async () => {
  const [internalSymbol, bseTicker] = Object.entries(SCRIP_ID_OVERRIDES)[0];
  const scripMaster = [{ scripCode: '1', symbol: bseTicker, companyName: 'X', marketCapCr: 100, isin: 'X' }];
  const resolved = await resolveScripForSymbol(internalSymbol, scripMaster);
  assert.ok(resolved, `${internalSymbol} must resolve via its override to BSE ticker ${bseTicker}`);
  assert.equal(resolved.symbol, bseTicker);
});

test('resolveScripForSymbol returns null (never a guess) for a symbol genuinely absent from the master', async () => {
  const resolved = await resolveScripForSymbol('NOTREAL', []);
  assert.equal(resolved, null);
});

test('LTIM and GUJGASLTD resolve via their confirmed 2026 renames (LTM, GUJENERGY), not guessed -- previously left unmapped, verified 2026-09-28 against real BSE/NSE corporate filings', async () => {
  const scripMaster = [
    { scripCode: '540005', symbol: 'LTM', companyName: 'LTM Limited (Formerly LTIMindtree Limited)', marketCapCr: 121318, isin: 'INE214T01019' },
    { scripCode: '539336', symbol: 'GUJENERGY', companyName: 'Gujarat Energy Limited (Erstwhile Gujarat Gas Limited)', marketCapCr: 22085, isin: 'INE844O01030' },
  ];
  const ltim = await resolveScripForSymbol('LTIM', scripMaster);
  assert.equal(ltim.scripCode, '540005');
  const gujgas = await resolveScripForSymbol('GUJGASLTD', scripMaster);
  assert.equal(gujgas.scripCode, '539336');
});
