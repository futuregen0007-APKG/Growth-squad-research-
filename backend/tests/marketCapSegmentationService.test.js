import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarketCapSegments } from '../services/MarketCapSegmentationService.js';

/**
 * marketCapSegmentationService.test.js
 * =======================================
 * Discovered untested while diagnosing why Goals' "Load Eligible Stocks"
 * still returned zero direct-equity stocks even after the historical-price
 * backfill: CompanyResearchProfile.marketCapCr (the only real source of
 * market cap -- Angel One's live feed never returns one) is currently
 * unpopulated because the BSE scrip-master provider returns HTTP 403 in
 * this environment. That means every stock in production right now gets
 * marketCapSegment: null from this service. These tests pin the one rule
 * that matters most given that fact: a stock with no verified market cap is
 * NEVER guessed into a segment, so it can never silently pass as if it were
 * classified.
 */

const stock = (symbol, marketCapCr) => ({ ticker: symbol, marketCapCr });

test('never mutates the input array or its objects', () => {
  const input = [stock('A', 5000)];
  const inputCopy = JSON.parse(JSON.stringify(input));
  classifyMarketCapSegments(input);
  assert.deepEqual(input, inputCopy);
});

test('a stock with no marketCapCr (null, undefined, 0, or negative) gets marketCapSegment: null, never guessed into a segment', () => {
  const stocks = [stock('NULLCAP', null), stock('UNDEFCAP', undefined), stock('ZEROCAP', 0), stock('NEGCAP', -100), stock('REALCAP', 5000)];
  const classified = classifyMarketCapSegments(stocks);
  const bySymbol = Object.fromEntries(classified.map((s) => [s.ticker, s.marketCapSegment]));
  assert.equal(bySymbol.NULLCAP, null);
  assert.equal(bySymbol.UNDEFCAP, null);
  assert.equal(bySymbol.ZEROCAP, null);
  assert.equal(bySymbol.NEGCAP, null);
  assert.equal(bySymbol.REALCAP, 'LARGE', 'the sole verified stock ranks LARGE among verified peers, unaffected by the unverified ones');
});

test('when every stock lacks a verified market cap (the current production reality), every stock is null -- never defaulted to LARGE or any other segment', () => {
  const stocks = Array.from({ length: 50 }, (_, i) => stock(`SYM${i}`, null));
  const classified = classifyMarketCapSegments(stocks);
  assert.ok(classified.every((s) => s.marketCapSegment === null));
});

test('percentile ranking: top ~25% is LARGE, next ~35% is MID, the rest is SMALL, ranked strictly by marketCapCr descending', () => {
  // 20 stocks, distinct market caps -- LARGE cutoff ceil(20*0.25)=5, MID cutoff ceil(20*0.60)=12.
  const stocks = Array.from({ length: 20 }, (_, i) => stock(`SYM${i}`, 20 - i)); // SYM0 highest cap .. SYM19 lowest
  const classified = classifyMarketCapSegments(stocks);
  const bySymbol = Object.fromEntries(classified.map((s) => [s.ticker, s.marketCapSegment]));
  assert.deepEqual(['SYM0', 'SYM1', 'SYM2', 'SYM3', 'SYM4'].map((s) => bySymbol[s]), Array(5).fill('LARGE'));
  assert.deepEqual(['SYM5', 'SYM6', 'SYM7', 'SYM8', 'SYM9', 'SYM10', 'SYM11'].map((s) => bySymbol[s]), Array(7).fill('MID'));
  assert.deepEqual(['SYM12', 'SYM13', 'SYM19'].map((s) => bySymbol[s]), Array(3).fill('SMALL'));
});

test('an unverified stock never occupies a rank slot -- segment cutoffs are computed only over the verified subset', () => {
  // 4 verified (would split 1 LARGE / rest MID/SMALL at this size) plus 96 unverified -- cutoffs must use the 4, not 100.
  const verified = Array.from({ length: 4 }, (_, i) => stock(`V${i}`, 100 - i));
  const unverified = Array.from({ length: 96 }, (_, i) => stock(`U${i}`, null));
  const classified = classifyMarketCapSegments([...verified, ...unverified]);
  const verifiedSegments = classified.filter((s) => s.ticker.startsWith('V')).map((s) => s.marketCapSegment);
  assert.ok(verifiedSegments.every((seg) => seg !== null), 'the 4 verified stocks must still be classified despite 96 unverified peers');
  assert.ok(classified.filter((s) => s.ticker.startsWith('U')).every((s) => s.marketCapSegment === null));
});

test('an empty input returns an empty array without throwing', () => {
  assert.deepEqual(classifyMarketCapSegments([]), []);
  assert.deepEqual(classifyMarketCapSegments(), []);
});

test('symbol lookup falls back from ticker to symbol field', () => {
  const stocks = [{ symbol: 'NOSYMFIELD', marketCapCr: 1000 }];
  const classified = classifyMarketCapSegments(stocks);
  assert.equal(classified[0].marketCapSegment, 'LARGE');
});
