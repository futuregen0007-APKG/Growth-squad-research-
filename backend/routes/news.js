import express from 'express';
import { getStockNews } from '../services/NewsAPIService.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' });
  if (!process.env.NEWS_API_KEY) return res.status(503).json({ error: 'News service is unavailable: NEWS_API_KEY is not configured.' });

  try {
    const data = await Promise.all(symbols.map(async (symbol) => ({ symbol, articles: await getStockNews(symbol) })));
    res.json({ data });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message });
  }
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