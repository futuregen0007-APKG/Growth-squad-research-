import apiClient from './apiClient';

export const getWatchlists = () => apiClient.get('/api/watchlist');
export const addWatchlistSymbol = (id, symbol) => apiClient.post(`/api/watchlist/${id}/symbols`, { symbol });
export const removeWatchlistSymbol = (id, symbol) => apiClient.delete(`/api/watchlist/${id}/symbols/${encodeURIComponent(symbol)}`);