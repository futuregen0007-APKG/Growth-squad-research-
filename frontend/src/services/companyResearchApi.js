import axios from 'axios';
import API_BASE from '@/config/api';
import { reportBackendUnavailable, isAvailabilityImpactingAxiosError } from '@/services/backendHealth';

const api = axios.create({
  baseURL: `${API_BASE}/api`,
  timeout: 15000,
});

// Same shared-readiness reporting as stockApi.js/newsApi.js -- a network
// failure/timeout/502/503/504 on the Stock Detail research bundle means
// the backend itself is down, not that this one symbol's IndianAPI
// section failed (that's already reported per-section by the response
// body itself, never via a thrown error).
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (isAvailabilityImpactingAxiosError(error)) reportBackendUnavailable();
    return Promise.reject(error);
  },
);

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
