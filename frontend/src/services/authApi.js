/**
 * ============================================================================
 * AUTH API SERVICE
 * ============================================================================
 * 
 * Centralized authentication API calls
 * Handles:
 * - Register user
 * - Sign in user
 * - Refresh access token
 * - Logout user
 */

const normalizeApiBaseUrl = (value) => {
  if (!value) return 'http://localhost:5001';
  return value.replace(/\/api\/?$/, '').replace(/\/$/, '');
};

const API_BASE_URL = normalizeApiBaseUrl(process.env.REACT_APP_API_BASE_URL || 'http://localhost:5001');

const buildApiUrl = (path) => `${API_BASE_URL}/api${path.startsWith('/') ? path : `/${path}`}`;

const getErrorMessage = (data, fallback) => {
  if (typeof data?.error === 'string' && data.error) return data.error;

  if (data?.details && typeof data.details === 'object') {
    const firstError = Object.values(data.details)[0];
    if (typeof firstError === 'string') return firstError;
  }

  return fallback;
};

/**
 * Register a new user
 * 
 * @param {Object} credentials - User registration credentials
 * @param {string} credentials.email - User email
 * @param {string} credentials.username - User username
 * @param {string} credentials.password - User password
 * @param {string} credentials.confirmPassword - Password confirmation
 * @returns {Promise<Object>} API response with user data
 * @throws {Error} If registration fails
 */
export const registerUser = async (credentials) => {
  try {
    const response = await fetch(buildApiUrl('/auth/register'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(credentials)
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(getErrorMessage(data, 'Registration failed'));
      error.statusCode = response.status;
      error.details = data.details;
      throw error;
    }

    return data.data;
  } catch (error) {
    console.error('Register error:', error);
    throw error;
  }
};

/**
 * Sign in user and get tokens
 * 
 * @param {Object} credentials - User login credentials
 * @param {string} credentials.email - User email
 * @param {string} credentials.password - User password
 * @returns {Promise<Object>} API response with user and tokens
 * @throws {Error} If login fails
 * 
 * Security Notes:
 * - Generic error message returned for all login failures
 * - Cannot distinguish between "email not found" and "password incorrect"
 * - This is intentional to prevent email enumeration attacks
 */
export const signinUser = async (credentials) => {
  try {
    const response = await fetch(buildApiUrl('/auth/signin'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(credentials)
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(
        getErrorMessage(data, 'Invalid credentials. Please try again.')
      );
      error.statusCode = response.status;
      throw error;
    }

    return data.data;
  } catch (error) {
    console.error('Signin error:', error);
    throw error;
  }
};

/**
 * Refresh access token using refresh token
 * 
 * @param {string} refreshToken - Valid refresh token
 * @returns {Promise<Object>} API response with new access token
 * @throws {Error} If refresh fails
 * 
 * To be implemented in API
 */
export const refreshAccessToken = async (refreshToken) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/refresh-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refreshToken })
    });

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.error || 'Token refresh failed');
      error.statusCode = response.status;
      throw error;
    }

    return data.data;
  } catch (error) {
    console.error('Token refresh error:', error);
    throw error;
  }
};

/**
 * Logout user
 * 
 * @param {string} refreshToken - Current refresh token to revoke
 * @returns {Promise<void>}
 * 
 * To be implemented in API
 */
export const logoutUser = async (refreshToken) => {
  try {
    await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
      },
      body: JSON.stringify({ refreshToken })
    });
  } catch (error) {
    console.error('Logout error:', error);
    // Don't throw - always clear client-side tokens even if server request fails
  }
};

/**
 * GET - Fetch current user profile
 * 
 * @returns {Promise<Object>} Current user data
 * @throws {Error} If fetch fails or user is not authenticated
 */
export const getCurrentUser = async () => {
  try {
    const accessToken = localStorage.getItem('accessToken');

    if (!accessToken) {
      throw new Error('No access token found');
    }

    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired or invalid
        localStorage.removeItem('accessToken');
        throw new Error('Session expired. Please login again.');
      }
      throw new Error(data.error || 'Failed to fetch user profile');
    }

    return data.data.user;
  } catch (error) {
    console.error('Get current user error:', error);
    throw error;
  }
};

export default {
  registerUser,
  signinUser,
  refreshAccessToken,
  logoutUser,
  getCurrentUser
};
