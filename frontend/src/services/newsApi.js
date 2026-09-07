import axios from 'axios';
import API_BASE from '@/config/api';

const api = axios.create({ baseURL: `${API_BASE}/api`, timeout: 12000 });

export const isValidArticleUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

export const fetchStockNews = async (symbol, options = {}) => {
  const response = await api.get(`/news/${encodeURIComponent(String(symbol).trim().toUpperCase())}`, options);
  return (response.data.data || []).filter((article) => isValidArticleUrl(article.url));
};

// Surfaces which symbols failed and the overall provider status alongside
// the merged article list — callers (Dashboard, News) use this to show a
// partial-results / degraded-state message instead of silently dropping the
// symbols that failed.
export const fetchNewsWithStatus = async (symbols, options = {}) => {
  const response = await api.get('/news', { params: { symbols: symbols.join(',') }, ...options });
  const articles = (response.data.articles || response.data.data?.flatMap((item) => item.articles || []) || [])
    .filter((article) => isValidArticleUrl(article.url));
  return {
    articles,
    failedSymbols: response.data.failedSymbols || [],
    providerStatus: response.data.providerStatus || 'OK',
  };
};