import test from 'node:test';
import assert from 'node:assert/strict';

// getStockNews reads process.env.NEWS_API_KEY at call time, not at import
// time — set it before any test runs so behavior doesn't depend on whether
// a real .env happens to be present.
process.env.NEWS_API_KEY = process.env.NEWS_API_KEY || 'test-key';

import {
  processArticlesResponse,
  canonicalizeArticleUrl,
  deduplicate,
  sortNewestFirst,
  clearNewsCache,
  NewsAPIError,
  getStockNews,
} from '../services/NewsAPIService.js';
import { mergeAcrossSymbols, fetchNewsForSymbols } from '../routes/news.js';
import axios from 'axios';

const article = (overrides = {}) => ({
  title: 'Company beats quarterly estimates',
  url: 'https://example.com/article-1',
  dateTimePub: '2026-01-05T10:00:00Z',
  source: { title: 'Example News' },
  body: 'Some article body mentioning Acme Corp in detail.',
  ...overrides,
});

const COMPANY = { symbol: 'ACME', companyName: 'Acme Corp' };

// ---------------------------------------------------------------------------
// processArticlesResponse — pure response validation/normalization
// ---------------------------------------------------------------------------

test('rejects an HTTP-200 provider quota/error payload instead of treating it as zero results', () => {
  assert.throws(
    () => processArticlesResponse({ error: 'Daily quota exceeded' }, COMPANY),
    (error) => error instanceof NewsAPIError && error.statusCode === 429,
  );
});

test('rejects articles with a non-HTTP(S) or malformed URL', () => {
  const results = processArticlesResponse({
    articles: { results: [
      article({ title: 'Acme Corp wins contract', url: 'javascript:alert(1)' }),
      article({ title: 'Acme Corp opens new plant', url: 'not a url' }),
      article({ title: 'Acme Corp reports on Acme Corp results', url: 'https://example.com/valid' }),
    ] },
  }, COMPANY);
  assert.deepEqual(results.map((r) => r.url), ['https://example.com/valid']);
});

test('rejects articles with an empty title', () => {
  const results = processArticlesResponse({
    articles: { results: [article({ title: '   ', url: 'https://example.com/no-title' })] },
  }, COMPANY);
  assert.equal(results.length, 0);
});

test('rejects articles whose supplied publish date does not parse, but keeps articles with no date at all', () => {
  const results = processArticlesResponse({
    articles: { results: [
      article({ title: 'Acme Corp bad date', url: 'https://example.com/bad-date', dateTimePub: 'not-a-real-date' }),
      article({ title: 'Acme Corp no date', url: 'https://example.com/no-date', dateTimePub: undefined, dateTime: undefined }),
    ] },
  }, COMPANY);
  assert.deepEqual(results.map((r) => r.url), ['https://example.com/no-date']);
  assert.equal(results[0].publishedAt, null);
});

test('missing publisher image yields imageUrl: null, never a fabricated stock photo', () => {
  const results = processArticlesResponse({
    articles: { results: [article({ title: 'Acme Corp no image', url: 'https://example.com/no-image', image: undefined })] },
  }, COMPANY);
  assert.equal(results[0].imageUrl, null);
});

test('a valid publisher image is preserved as-is', () => {
  const results = processArticlesResponse({
    articles: { results: [article({ title: 'Acme Corp with image', url: 'https://example.com/with-image', image: 'https://cdn.example.com/photo.jpg' })] },
  }, COMPANY);
  assert.equal(results[0].imageUrl, 'https://cdn.example.com/photo.jpg');
});

test('deduplicates near-identical titles within a single response', () => {
  const results = processArticlesResponse({
    articles: { results: [
      article({ title: 'Acme Corp beats Q3 estimates by wide margin', url: 'https://a.example.com/1' }),
      article({ title: 'Acme Corp beats Q3 estimates by a wide margin', url: 'https://b.example.com/1' }),
    ] },
  }, COMPANY);
  assert.equal(results.length, 1);
});

test('sorts results newest-first', () => {
  const results = processArticlesResponse({
    articles: { results: [
      article({ title: 'Acme Corp signs partnership deal with major retailer', url: 'https://example.com/old', dateTimePub: '2026-01-01T00:00:00Z' }),
      article({ title: 'Acme Corp launches new product line in Mumbai', url: 'https://example.com/new', dateTimePub: '2026-01-10T00:00:00Z' }),
      article({ title: 'Acme Corp reports record profit for the quarter', url: 'https://example.com/mid', dateTimePub: '2026-01-05T00:00:00Z' }),
    ] },
  }, COMPANY);
  assert.deepEqual(results.map((r) => r.url), ['https://example.com/new', 'https://example.com/mid', 'https://example.com/old']);
});

// ---------------------------------------------------------------------------
// canonicalizeArticleUrl / deduplicate / sortNewestFirst / mergeAcrossSymbols
// ---------------------------------------------------------------------------

test('canonicalizeArticleUrl strips tracking params, fragment and trailing slash', () => {
  assert.equal(
    canonicalizeArticleUrl('https://News.example.com/story/1/?utm_source=x#frag'),
    canonicalizeArticleUrl('https://news.example.com/story/1'),
  );
});

test('mergeAcrossSymbols unions symbols for the same canonical URL and sorts newest-first', () => {
  const merged = mergeAcrossSymbols([
    { symbol: 'AAA', articles: [{ ...article({ title: 'Shared story', url: 'https://example.com/shared?utm=1', dateTimePub: undefined }), publishedAt: '2026-01-01T00:00:00.000Z', symbols: ['AAA'] }] },
    { symbol: 'BBB', articles: [{ ...article({ title: 'Shared story', url: 'https://example.com/shared', dateTimePub: undefined }), publishedAt: '2026-01-01T00:00:00.000Z', symbols: ['BBB'] }] },
    { symbol: 'CCC', articles: [{ ...article({ title: 'Newer unrelated story', url: 'https://example.com/other', dateTimePub: undefined }), publishedAt: '2026-02-01T00:00:00.000Z', symbols: ['CCC'] }] },
  ]);
  assert.equal(merged.length, 2);
  const shared = merged.find((a) => a.url.includes('shared'));
  assert.deepEqual(shared.symbols.sort(), ['AAA', 'BBB']);
  assert.equal(merged[0].url, 'https://example.com/other'); // newest first
});

// ---------------------------------------------------------------------------
// fetchNewsForSymbols — partial failure / concurrency-safety (no real network)
// ---------------------------------------------------------------------------

test('a single symbol failure does not fail the other symbols (partial results)', async () => {
  const fetchOne = async (symbol) => {
    if (symbol === 'BAD') throw new NewsAPIError('provider down for BAD', 502);
    return [{ title: `${symbol} story`, url: `https://example.com/${symbol}`, publishedAt: '2026-01-01T00:00:00.000Z', symbols: [symbol] }];
  };

  const result = await fetchNewsForSymbols(['GOOD1', 'BAD', 'GOOD2'], fetchOne);

  assert.equal(result.providerStatus, 'PARTIAL');
  assert.equal(result.successful.length, 2);
  assert.deepEqual(result.failedSymbols.map((f) => f.symbol), ['BAD']);
  assert.equal(result.articles.length, 2);
});

test('all symbols failing reports providerStatus DOWN with zero articles', async () => {
  const fetchOne = async () => { throw new NewsAPIError('provider down', 503); };
  const result = await fetchNewsForSymbols(['A', 'B'], fetchOne);
  assert.equal(result.providerStatus, 'DOWN');
  assert.equal(result.articles.length, 0);
  assert.equal(result.failedSymbols.length, 2);
});

test('bounded concurrency still resolves every symbol exactly once', async () => {
  const seen = [];
  const fetchOne = async (symbol) => {
    seen.push(symbol);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return [];
  };
  const symbols = Array.from({ length: 10 }, (_, i) => `SYM${i}`);
  await fetchNewsForSymbols(symbols, fetchOne);
  assert.deepEqual([...seen].sort(), [...symbols].sort());
  assert.equal(seen.length, symbols.length);
});

// ---------------------------------------------------------------------------
// getStockNews — provider failure must never be cached as a valid result
// ---------------------------------------------------------------------------

test('a provider failure is never cached — the next call retries for real', async () => {
  clearNewsCache();
  const originalGet = axios.get;
  let callCount = 0;
  axios.get = async () => {
    callCount++;
    if (callCount === 1) throw Object.assign(new Error('network blip'), { code: 'ETIMEDOUT' });
    return { data: { articles: { results: [
      { title: 'HDFC Bank posts results', url: 'https://example.com/hdfc-1', dateTimePub: '2026-01-01T00:00:00Z', source: { title: 'Example' }, body: 'HDFC Bank reported results.' },
    ] } } };
  };

  try {
    await assert.rejects(() => getStockNews('HDFCBANK'));
    const second = await getStockNews('HDFCBANK');
    assert.equal(second.length, 1);
    assert.equal(callCount, 2); // the failed first call was not cached, so the second call hit the network again
  } finally {
    axios.get = originalGet;
    clearNewsCache();
  }
});

test('a quota/error HTTP-200 payload is also never cached', async () => {
  clearNewsCache();
  const originalGet = axios.get;
  let callCount = 0;
  axios.get = async () => {
    callCount++;
    if (callCount === 1) return { data: { error: 'quota exceeded' } };
    return { data: { articles: { results: [
      { title: 'ICICI Bank posts results', url: 'https://example.com/icici-1', dateTimePub: '2026-01-01T00:00:00Z', source: { title: 'Example' }, body: 'ICICI Bank reported results.' },
    ] } } };
  };

  try {
    await assert.rejects(() => getStockNews('ICICIBANK'));
    const second = await getStockNews('ICICIBANK');
    assert.equal(second.length, 1);
    assert.equal(callCount, 2);
  } finally {
    axios.get = originalGet;
    clearNewsCache();
  }
});
