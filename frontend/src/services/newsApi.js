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

export const fetchStockNews = async (symbol) => {
  const response = await api.get(`/news/${encodeURIComponent(String(symbol).trim().toUpperCase())}`);
  return (response.data.data || []).filter((article) => isValidArticleUrl(article.url));
};

export const fetchNews = async (symbols) => {
  const response = await api.get('/news', { params: { symbols: symbols.join(',') } });
  return (response.data.data || []).flatMap((item) => item.articles || []).filter((article) => isValidArticleUrl(article.url));
};

// Same endpoint as fetchNews, but also surfaces which symbols failed and the
// overall provider status — for callers (like Dashboard) that need to show a
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
