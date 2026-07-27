import { useState, useContext, useCallback, createContext } from 'react';

/**
 * ============================================================================
 * AUTH CONTEXT - Global Authentication State Management
 * ============================================================================
 * 
 * Manages:
 * - Current logged-in user
 * - Access token
 * - Refresh token
 * - Login/logout functions
 * - Token validation
 */

export const AuthContext = createContext();

/**
 * useAuth Hook
 * 
 * Usage in components:
 * const { user, accessToken, login, logout, isAuthenticated } = useAuth();
 * 
 * @returns {Object} Auth state and functions
 */
export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
};

/**
 * AuthProvider Component
 * 
 * Wraps application to provide authentication state to all components
 * 
 * Usage in App.js:
 * <AuthProvider>
 *   <App />
 * </AuthProvider>
 */
export const AuthProvider = ({ children }) => {
  /**
   * Authentication state
   */
  const [user, setUser] = useState(() => {
    try {
      const storedUser = localStorage.getItem('user');
      return storedUser ? JSON.parse(storedUser) : null;
    } catch (err) {
      console.error('Failed to read stored user:', err);
      return null;
    }
  });
  const [accessToken, setAccessToken] = useState(() => localStorage.getItem('accessToken'));
  const [refreshToken, setRefreshToken] = useState(() => localStorage.getItem('refreshToken'));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Check if user is authenticated
   * @returns {boolean} true if user has valid access token
   */
  const isAuthenticated = useCallback(() => {
    return !!accessToken && !!user;
  }, [accessToken, user]);

  /**
   * LOGIN - Store tokens and user data
   * 
   * Called after successful signin API response
   * Stores:
   * 1. Access token in localStorage (frontend accessible)
   * 2. Refresh token in localStorage (should ideally be httpOnly cookie)
   * 3. User object in state
   * 
   * @param {Object} response - API response with user and tokens
   * @param {Object} response.user - User data
   * @param {Object} response.tokens - { accessToken, refreshToken, expiresIn }
   */
  const login = useCallback((response) => {
    try {
      const { user, tokens } = response;

      /**
       * Store tokens
       * 
       * Security considerations:
       * - localStorage: Vulnerable to XSS attacks
       * - Alternative: httpOnly cookies (recommended for production)
       * - For now: localStorage with XSS protection (sanitize inputs, CSP headers)
       * 
       * TODO: Implement token refresh logic
       * Set timeout to refresh token before expiration
       */
      localStorage.setItem('accessToken', tokens.accessToken);
      localStorage.setItem('refreshToken', tokens.refreshToken);
      localStorage.setItem('user', JSON.stringify(user));

      // Update state
      setAccessToken(tokens.accessToken);
      setRefreshToken(tokens.refreshToken);
      setUser(user);
      setError(null);

      return true;
    } catch (err) {
      console.error('Login error:', err);
      setError('Failed to store authentication data');
      return false;
    }
  }, []);

  /**
   * LOGOUT - Clear tokens and user data
   * 
   * Called on:
   * 1. User clicks logout button
   * 2. Access token expires
   * 3. Refresh token expires
   * 4. User is blocked
   * 
   * Clears:
   * 1. Tokens from localStorage
   * 2. User from state
   * 3. Error messages
   */
  const logout = useCallback(() => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    setAccessToken(null);
    setRefreshToken(null);
    setUser(null);
    setError(null);
  }, []);

  /**
   * GET ACCESS TOKEN
   * @returns {string|null} Current access token
   */
  const getAccessToken = useCallback(() => {
    return accessToken || localStorage.getItem('accessToken');
  }, [accessToken]);

  /**
   * GET REFRESH TOKEN
   * @returns {string|null} Current refresh token
   */
  const getRefreshToken = useCallback(() => {
    return refreshToken || localStorage.getItem('refreshToken');
  }, [refreshToken]);

  /**
   * SET ERROR MESSAGE
   * @param {string} message - Error message to display
   */
  const setAuthError = useCallback((message) => {
    setError(message);
  }, []);

  /**
   * CLEAR ERROR MESSAGE
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Context value provided to all child components
   */
  const value = {
    // State
    user,
    accessToken: getAccessToken(),
    refreshToken: getRefreshToken(),
    isLoading,
    error,

    // Methods
    login,
    logout,
    isAuthenticated,
    setAuthError,
    clearError,
    setLoading: setIsLoading
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export default useAuth;
