import apiClient from './apiClient';

export const getPortfolio = () => apiClient.get('/api/portfolio');

export const addPortfolioHolding = (holding) => apiClient.post('/api/portfolio/holdings', holding);

export const updatePortfolioHolding = (id, holding) => apiClient.put(`/api/portfolio/holdings/${id}`, holding);

export const deletePortfolioHolding = (id) => apiClient.delete(`/api/portfolio/holdings/${id}`);