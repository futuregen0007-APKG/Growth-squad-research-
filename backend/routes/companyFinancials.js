import express from 'express';
import { searchCompanyFinancials } from '../services/CompanyFinancialsSearchService.js';
import { explainCompanyFinancials } from '../services/CompanyFinancialsExplainService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/company-financials/search?q=<text>
 * Resolves q -> ISIN, fetches every Upstox section in parallel, and always
 * returns 200 -- per-section status/error fields communicate partial data
 * or an unconfigured provider; ambiguous/unresolved queries get their own
 * distinct response shape so the frontend can prompt disambiguation
 * instead of guessing.
 */
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ success: false, error: 'Query parameter "q" is required.' });
  }
  try {
    const result = await searchCompanyFinancials(q);
    return res.status(200).json(result);
  } catch (error) {
    logger.error(`[companyFinancials] search failed for "${q}": ${error.message}`);
    return res.status(200).json({ success: true, ambiguous: false, data: null, error: 'Company financials search failed unexpectedly.' });
  }
});

/**
 * POST /api/company-financials/:symbol/explain
 * Body: { sections, companyName } -- the ALREADY-fetched normalized
 * sections from /search. Never re-fetches from Upstox; falls back to the
 * same short-lived Redis cache when sections is omitted. Always 200, even
 * on failure/timeout/not-configured (`available: false` communicates it).
 */
router.post('/:symbol/explain', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  if (!symbol) {
    return res.status(400).json({ success: false, error: 'symbol path parameter is required.' });
  }
  const { sections, companyName } = req.body || {};
  try {
    const result = await explainCompanyFinancials(symbol, sections, companyName);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error(`[companyFinancials] explain failed for ${symbol}: ${error.message}`);
    return res.status(200).json({ success: true, available: false, reason: 'AI explanation is temporarily unavailable.' });
  }
});

export default router;
