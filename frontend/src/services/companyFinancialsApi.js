import axios from 'axios';
import API_BASE from '@/config/api';

const BASE = API_BASE;

// The backend fans out ~7 Upstox calls in parallel with a target of
// ~13-15s warm -- give real network/frontend slack above that rather than
// reusing stockApi.js's shared 25s default, which was sized for ordinary
// single-call GETs.
const SEARCH_TIMEOUT_MS = 30000;
// The backend itself bounds its OpenAI call at ~20s (see
// CompanyFinancialsExplainService.js) -- this just needs to outlast that.
const EXPLAIN_TIMEOUT_MS = 25000;

/**
 * searchCompanyFinancials - GET /api/company-financials/search?q=.
 * Returns the raw envelope (`{success, ambiguous, notFound, isinUnavailable,
 * data}`) unmodified -- the page decides how to render each shape, since a
 * 200 here can legitimately mean several different non-error outcomes.
 */
export const searchCompanyFinancials = async (query, options = {}) => {
  const q = String(query || '').trim();
  if (!q) return { success: true, ambiguous: false, notFound: true, query: q };
  const response = await axios.get(`${BASE}/api/company-financials/search`, {
    params: { q },
    timeout: SEARCH_TIMEOUT_MS,
    ...options,
  });
  return response.data;
};

/**
 * explainCompanyFinancials - POST /api/company-financials/:symbol/explain.
 * `sections` should be the already-fetched normalized section data objects
 * from a prior searchCompanyFinancials() call -- this never triggers a
 * fresh Upstox fetch itself, only an AI explanation of data already held.
 */
export const explainCompanyFinancials = async (symbol, { sections, companyName } = {}, options = {}) => {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const response = await axios.post(
    `${BASE}/api/company-financials/${encodeURIComponent(normalizedSymbol)}/explain`,
    { sections, companyName },
    { timeout: EXPLAIN_TIMEOUT_MS, ...options },
  );
  return response.data;
};

export default { searchCompanyFinancials, explainCompanyFinancials };
