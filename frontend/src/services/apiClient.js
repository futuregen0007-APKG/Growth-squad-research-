/**
 * ============================================================================
 * API CLIENT - Fetch Wrapper with Token Management
 * ============================================================================
 * 
 * Automatically:
 * 1. Adds access token to request headers
 * 2. Refreshes token if expired (401 response)
 * 3. Retries request with new token
 * 4. Handles token refresh errors
 * 
 * Usage:
 * const data = await apiClient.get('/api/stocks');
 * const user = await apiClient.post('/api/users', { name: 'John' });
 */

const normalizeApiBaseUrl = (value) => {
  if (!value) return 'http://localhost:5001';
  return value.replace(/\/api\/?$/, '').replace(/\/$/, '');
};

const API_BASE_URL = normalizeApiBaseUrl(process.env.REACT_APP_API_BASE_URL || 'http://localhost:5001');
let isRefreshing = false;
let refreshSubscribers = [];

/**
 * Subscribe to token refresh event
 * Queues requests while token is being refreshed
 * 
 * @param {Function} callback - Function to call when token is refreshed
 */
const subscribeTokenRefresh = (callback) => {
  refreshSubscribers.push(callback);
};

/**
 * Notify all subscribers that token has been refreshed
 * @param {string} newToken - New access token
 */
const notifyTokenRefresh = (newToken) => {
  refreshSubscribers.forEach((callback) => callback(newToken));
  refreshSubscribers = [];
};

/**
 * Refresh access token using refresh token
 * 
 * @returns {Promise<string>} New access token
 * @throws {Error} If refresh fails
 */
const refreshToken = async () => {
  try {
    const refreshTokenValue = localStorage.getItem('refreshToken');

    if (!refreshTokenValue) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${API_BASE_URL}/api/auth/refresh-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refreshToken: refreshTokenValue })
    });

    if (!response.ok) {
      // Refresh failed - clear tokens and redirect to login
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      window.location.href = '/login';
      throw new Error('Token refresh failed');
    }

    const data = await response.json();
    const newAccessToken = data.data.tokens.accessToken;

    // Store new token
    localStorage.setItem('accessToken', newAccessToken);

    return newAccessToken;
  } catch (error) {
    console.error('Token refresh error:', error);
    throw error;
  }
};

/**
 * API Client - Wrapper around fetch with token handling
 */
const apiClient = {
  /**
   * Helper method to make requests
   * 
   * @param {string} endpoint - API endpoint (e.g., '/api/stocks')
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>} Parsed response data
   */
  async request(endpoint, options = {}) {
    const accessToken = localStorage.getItem('accessToken');

    // Default headers
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    // Add authorization header if token exists
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    // Make initial request
    let response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers
    });

    /**
     * Handle 401 Unauthorized (token expired)
     * 
     * Process:
     * 1. If already refreshing, queue the request
     * 2. Otherwise, start refresh process
     * 3. Refresh token
     * 4. Notify all queued requests with new token
     * 5. Retry original request
     */
    if (response.status === 401) {
      if (!isRefreshing) {
        isRefreshing = true;

        try {
          const newToken = await refreshToken();
          isRefreshing = false;

          // Notify all queued requests
          notifyTokenRefresh(newToken);

          // Retry original request with new token
          headers['Authorization'] = `Bearer ${newToken}`;
          response = await fetch(`${API_BASE_URL}${endpoint}`, {
            ...options,
            headers
          });
        } catch (error) {
          isRefreshing = false;
          throw error;
        }
      } else {
        // Token is already being refreshed
        // Queue this request
        return new Promise((resolve, reject) => {
          subscribeTokenRefresh((newToken) => {
            headers['Authorization'] = `Bearer ${newToken}`;
            fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers })
              .then((res) => res.json())
              .then(resolve)
              .catch(reject);
          });
        });
      }
    }

    /**
     * Parse response
     * All API responses are JSON
     */
    const data = await response.json();

    /**
     * Handle error responses
     */
    if (!response.ok) {
      const error = new Error(data.error || 'API request failed');
      error.statusCode = response.status;
      error.response = data;
      throw error;
    }

    return data;
  },

  /**
   * GET request
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>}
   */
  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  },

  /**
   * POST request
   * @param {string} endpoint - API endpoint
   * @param {Object} body - Request body
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>}
   */
  post(endpoint, body = {}, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body)
    });
  },

  /**
   * PUT request
   * @param {string} endpoint - API endpoint
   * @param {Object} body - Request body
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>}
   */
  put(endpoint, body = {}, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(body)
    });
  },

  /**
   * PATCH request
   * @param {string} endpoint - API endpoint
   * @param {Object} body - Request body
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>}
   */
  patch(endpoint, body = {}, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(body)
    });
  },

  /**
   * DELETE request
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Fetch options
   * @returns {Promise<Object>}
   */
  delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }
};

export default apiClient;

/**
 * ============================================================================
 * USAGE EXAMPLES
 * ============================================================================
 * 
 * // GET request
 * try {
 *   const stocks = await apiClient.get('/api/stocks');
 *   console.log(stocks.data);
 * } catch (error) {
 *   console.error('Error:', error.message);
 * }
 * 
 * // POST request
 * const newStock = await apiClient.post('/api/stocks', {
 *   symbol: 'AAPL',
 *   quantity: 10
 * });
 * 
 * // Automatic token refresh on 401
 * // If access token expires, client will:
 * // 1. Detect 401 response
 * // 2. Use refresh token to get new access token
 * // 3. Retry the original request
 * // 4. Return data to caller
 * 
 * ============================================================================
 * INTEGRATION WITH COMPONENTS
 * ============================================================================
 * 
 * import apiClient from '../services/apiClient';
 * import { useEffect, useState } from 'react';
 * 
 * function StockList() {
 *   const [stocks, setStocks] = useState([]);
 * 
 *   useEffect(() => {
 *     const fetchStocks = async () => {
 *       try {
 *         const response = await apiClient.get('/api/stocks');
 *         setStocks(response.data);
 *       } catch (error) {
 *         console.error('Failed to fetch stocks:', error);
 *       }
 *     };
 *     fetchStocks();
 *   }, []);
 * 
 *   return (
 *     <div>
 *       {stocks.map(stock => <div key={stock.id}>{stock.symbol}</div>)}
 *     </div>
 *   );
 * }
 */
