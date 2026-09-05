import test from 'node:test';
import assert from 'node:assert/strict';

import { StockService } from '../services/StockService.js';
import { mergeAcrossSymbols } from '../routes/news.js';
import { deduplicate, canonicalizeArticleUrl } from '../services/NewsAPIService.js';

// --- Index symbols must be usable by the historical-candles path (Dashboard's Nifty chart) ---

test('StockService accepts a known INDEX_SYMBOLS entry (e.g. "NIFTY 50") for historical candles', async () => {
  let requestedSymbol = null;
  const service = new StockService({
    providerName: 'TestProvider',
    getHistoricalData: async (symbol) => { requestedSymbol = symbol; return [{ timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 }]; },
  });

  const result = await service.getHistoricalCandles('NIFTY 50', { range: '1D' });
  assert.equal(requestedSymbol, 'NIFTY 50');
  assert.equal(result.symbol, 'NIFTY 50');
  assert.equal(result.count, 1);
});

test('StockService still rejects a genuinely unknown/malformed symbol', async () => {
  const service = new StockService({ providerName: 'TestProvider', getHistoricalData: async () => [] });
  await assert.rejects(() => service.getHistoricalCandles('not a real symbol!!', { range: '1D' }));
});

// --- Cross-symbol news merge: canonical-URL and title-based dedup ---

test('mergeAcrossSymbols drops an article that appears under multiple symbols (same canonical URL)', () => {
  const shared = { title: 'Budget impact on banking stocks', url: 'https://example.com/news/budget-banking?utm_source=x', source: 'Reuters' };
  const perSymbolResults = [
    { symbol: 'HDFCBANK', articles: [shared] },
    { symbol: 'ICICIBANK', articles: [{ ...shared, url: 'https://example.com/news/budget-banking?utm_source=y' }] },
  ];
  const merged = mergeAcrossSymbols(perSymbolResults);
  assert.equal(merged.length, 1, 'the same article reached via two symbol queries must collapse to one');
});

test('mergeAcrossSymbols keeps genuinely distinct articles from different symbols', () => {
  const perSymbolResults = [
    { symbol: 'TCS', articles: [{ title: 'TCS wins large deal', url: 'https://example.com/a' }] },
    { symbol: 'INFY', articles: [{ title: 'Infosys guidance raised', url: 'https://example.com/b' }] },
  ];
  const merged = mergeAcrossSymbols(perSymbolResults);
  assert.equal(merged.length, 2);
});

test('canonicalizeArticleUrl strips query/fragment/trailing-slash and lowercases the host+path', () => {
  assert.equal(
    canonicalizeArticleUrl('https://Example.com/News/Story/?utm=1#section'),
    canonicalizeArticleUrl('https://example.com/news/story'),
  );
});

test('deduplicate collapses near-duplicate titles from different URLs', () => {
  const articles = [
    { title: 'Reliance Q2 profit jumps 20% on strong retail growth', url: 'https://a.com/1' },
    { title: 'Reliance Q2 profit jumps 20 percent on strong retail growth', url: 'https://b.com/2' },
    { title: 'Completely unrelated market update', url: 'https://c.com/3' },
  ];
  const result = deduplicate(articles);
  assert.equal(result.length, 2);
});
