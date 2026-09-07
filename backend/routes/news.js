import express from 'express';
import { getStockNews, canonicalizeArticleUrl, deduplicate, sortNewestFirst } from '../services/NewsAPIService.js';

const router = express.Router();

// This is a public, unauthenticated endpoint (anonymous viewing is allowed
// for News) — bound the request so an anonymous caller can't force an
// unbounded number of expensive provider calls in one request.
const MAX_SYMBOLS_PER_REQUEST = 25;
// Caps simultaneous Event Registry calls regardless of how many symbols are
// requested — a slow/rate-limited provider response for one symbol must
// never block or pile up requests for the others.
const CONCURRENCY = 4;

/** Promise.allSettled-shaped, but with at most `limit` in flight at once. */
async function settleWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// Merges per-symbol article lists, dropping duplicates that multiple symbol
// queries legitimately turn up (canonical URL first, then near-identical
// title as a fallback for the same story reached via different URLs), then
// returns the merged list newest-first — the guarantee callers depend on.
export const mergeAcrossSymbols = (perSymbolResults) => {
  const byUrl = new Map();
  for (const { symbol, articles } of perSymbolResults) {
    for (const article of articles) {
      const canonicalUrl = canonicalizeArticleUrl(article.url);
      const existing = byUrl.get(canonicalUrl);
      if (existing) {
        if (!existing.symbols.includes(symbol)) existing.symbols.push(symbol);
        continue;
      }
      byUrl.set(canonicalUrl, { ...article, symbols: [...new Set(article.symbols || [symbol])] });
    }
  }
  return sortNewestFirst(deduplicate([...byUrl.values()]));
};

// Fetches news for a batch of symbols with bounded concurrency and merges
// the results — separated from the Express handler so it can be unit
// tested directly (partial failure, concurrency-safety) without an HTTP
// layer. `fetchOne` is injectable for tests; defaults to the real provider.
export async function fetchNewsForSymbols(symbols, fetchOne = getStockNews) {
  // One symbol's provider failure/rate-limit must not fail the whole
  // request — successful symbols still come back, failures are reported as
  // failedSymbols rather than a blanket error. Bounded concurrency keeps a
  // large symbol list from firing dozens of simultaneous provider calls.
  const settled = await settleWithConcurrency(symbols, CONCURRENCY, async (symbol) => ({ symbol, articles: await fetchOne(symbol) }));

  const successful = [];
  const failedSymbols = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successful.push(result.value);
    } else {
      failedSymbols.push({
        symbol: symbols[index],
        message: result.reason?.message || 'Unable to load news for this symbol.',
        statusCode: result.reason?.statusCode || null,
      });
    }
  });

  return {
    successful,
    failedSymbols,
    articles: mergeAcrossSymbols(successful),
    providerStatus: failedSymbols.length === 0 ? 'OK' : (successful.length === 0 ? 'DOWN' : 'PARTIAL'),
  };
}

router.get('/', async (req, res) => {
  let symbols = String(req.query.symbols || '').split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  if (!process.env.NEWS_API_KEY) return res.status(503).json({ error: 'News service is unavailable: NEWS_API_KEY is not configured.' });

  const truncated = symbols.length > MAX_SYMBOLS_PER_REQUEST;
  if (truncated) symbols = symbols.slice(0, MAX_SYMBOLS_PER_REQUEST);

  const { successful, failedSymbols, articles, providerStatus } = await fetchNewsForSymbols(symbols);

  if (providerStatus === 'DOWN') {
    const worst = failedSymbols.find((f) => f.statusCode) || failedSymbols[0];
    return res.status(worst.statusCode || 502).json({
      error: 'News is currently unavailable for all requested symbols.',
      failedSymbols,
      providerStatus,
    });
  }

  res.json({ data: successful, articles, failedSymbols, providerStatus, truncated });
});

router.get('/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!process.env.NEWS_API_KEY) return res.status(503).json({ error: 'News service is unavailable: NEWS_API_KEY is not configured.' });
    res.json({ data: await getStockNews(symbol) });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message });
  }
});

export default router;
