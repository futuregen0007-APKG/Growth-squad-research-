import express from 'express';
import { getStockNews, canonicalizeArticleUrl, deduplicate } from '../services/NewsAPIService.js';

const router = express.Router();

// Merges per-symbol article lists, dropping duplicates that multiple symbol
// queries legitimately turn up (canonical URL first, then near-duplicate
// title as a fallback for the same story reached via different URLs).
export const mergeAcrossSymbols = (perSymbolResults) => {
  const seenUrls = new Set();
  const merged = [];
  for (const { articles } of perSymbolResults) {
    for (const article of articles) {
      const canonicalUrl = canonicalizeArticleUrl(article.url);
      if (seenUrls.has(canonicalUrl)) continue;
      seenUrls.add(canonicalUrl);
      merged.push(article);
    }
  }
  return deduplicate(merged);
};

router.get('/', async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  if (!process.env.NEWS_API_KEY) return res.status(503).json({ error: 'News service is unavailable: NEWS_API_KEY is not configured.' });

  // One symbol's provider failure/rate-limit must not fail the whole
  // request — Promise.allSettled lets the successful symbols through and
  // reports the rest as failedSymbols rather than a blanket error.
  const settled = await Promise.allSettled(symbols.map(async (symbol) => ({ symbol, articles: await getStockNews(symbol) })));

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

  if (successful.length === 0 && failedSymbols.length > 0) {
    const worst = failedSymbols.find((f) => f.statusCode) || failedSymbols[0];
    return res.status(worst.statusCode || 502).json({
      error: 'News is currently unavailable for all requested symbols.',
      failedSymbols,
      providerStatus: 'DOWN',
    });
  }

  res.json({
    data: successful,
    articles: mergeAcrossSymbols(successful),
    failedSymbols,
    providerStatus: failedSymbols.length > 0 ? 'PARTIAL' : 'OK',
  });
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