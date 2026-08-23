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