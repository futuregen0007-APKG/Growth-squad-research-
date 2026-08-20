import express from 'express';
import ResearchService from '../services/ResearchService.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols query param required' });
  const list = symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  try {
    const data = await ResearchService.enrichSymbols(list);
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
