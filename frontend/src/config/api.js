// Centralized API base configuration
const normalizeApiBaseUrl = (value) => {
  if (!value) return 'http://localhost:5001';
  return value.replace(/\/api\/?$/, '').replace(/\/$/, '');
};

// Support both environment variable names: REACT_APP_API_BASE and REACT_APP_API_BASE_URL
const envBase = process.env.REACT_APP_API_BASE || process.env.REACT_APP_API_BASE_URL;
export const API_BASE = normalizeApiBaseUrl(envBase || 'http://localhost:5001');

export default API_BASE;
