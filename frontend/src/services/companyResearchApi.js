import axios from 'axios';
import API_BASE from '@/config/api';

const api = axios.create({
  baseURL: `${API_BASE}/api`,
  timeout: 15000,
});

/**
 * fetchCompanyResearch - provider-neutral company research bundle
 * (profile, financials, key metrics, shareholding, corporate actions,
 * analyst data, news) for the Stock Detail page. Backed by
 * GET /api/stocks/:symbol/research. Each section in the response carries
 * its own { available, data, error, asOf } — this call itself only throws
 * on a total request failure (network down, 5xx from our own backend),
 * never because one IndianAPI section was unavailable.
 */
export const fetchCompanyResearch = async (symbol, options = {}) => {
  const response = await api.get(`/stocks/${encodeURIComponent(symbol)}/research`, options);
  return response.data.data;
};

export default { fetchCompanyResearch };
