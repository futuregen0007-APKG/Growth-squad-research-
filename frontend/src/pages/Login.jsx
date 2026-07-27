import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { signinUser } from '../services/authApi';
import '../styles/Login.css';

/**
 * ============================================================================
 * LOGIN COMPONENT
 * ============================================================================
 * 
 * Features:
 * - Email and password input
 * - Form validation
 * - Loading state during login
 * - Error message display
 * - Generic error messages (don't reveal if email or password is wrong)
 * - Links to signup and forgot password
 * - Redirect to dashboard on successful login
 * 
 * Security:
 * - Password input is type="password"
 * - Tokens are stored after API response
 * - No password sent over unencrypted connection (HTTPS required)
 */
const Login = () => {
  const navigate = useNavigate();
  const { login, setLoading, clearError } = useAuth();

  /**
   * Form state
   */
  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState(null);

  /**
   * ========== INPUT VALIDATION ==========
   */

  /**
   * Validate email format
   * @param {string} email - Email to validate
   * @returns {string|null} Error message or null if valid
   */
  const validateEmail = useCallback((email) => {
    if (!email) {
      return 'Email is required';
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return 'Please enter a valid email address';
    }

    return null;
  }, []);

  /**
   * Validate password
   * @param {string} password - Password to validate
   * @returns {string|null} Error message or null if valid
   */
  const validatePassword = useCallback((password) => {
    if (!password) {
      return 'Password is required';
    }

    if (password.length < 8) {
      return 'Password must be at least 8 characters';
    }

    return null;
  }, []);

  /**
   * Validate entire form
   * @returns {boolean} true if form is valid
   */
  const validateForm = useCallback(() => {
    const newErrors = {};

    const emailError = validateEmail(formData.email);
    if (emailError) newErrors.email = emailError;

    const passwordError = validatePassword(formData.password);
    if (passwordError) newErrors.password = passwordError;

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData, validateEmail, validatePassword]);

  /**
   * ========== FORM HANDLERS ==========
   */

  /**
   * Handle input change
   * Clears field-specific error when user starts typing
   * @param {Event} e - Input change event
   */
  const handleChange = (e) => {
    const { name, value } = e.target;

    setFormData((prev) => ({
      ...prev,
      [name]: value
    }));

    // Clear error for this field
    if (errors[name]) {
      setErrors((prev) => ({
        ...prev,
        [name]: null
      }));
    }
  };

  /**
   * Handle form submission
   * 
   * Process:
   * 1. Prevent default form submission
   * 2. Validate form inputs
   * 3. Call signin API
   * 4. Store tokens and user data
   * 5. Redirect to dashboard
   * 
   * @param {Event} e - Form submit event
   */
  const handleSubmit = async (e) => {
    e.preventDefault();

    /**
     * Clear previous errors
     */
    setApiError(null);
    clearError();

    /**
     * Validate form
     */
    if (!validateForm()) {
      return;
    }

    /**
     * Set loading state
     */
    setIsSubmitting(true);
    setLoading(true);

    try {
      /**
       * Call signin API
       * 
       * API Endpoint: POST /api/auth/signin
       * Request body: { email, password }
       * 
       * Response on success:
       * {
       *   "success": true,
       *   "message": "Login successful",
       *   "data": {
       *     "user": { _id, email, username, role, ... },
       *     "tokens": {
       *       "accessToken": "...",
       *       "refreshToken": "...",
       *       "expiresIn": 900
       *     }
       *   }
       * }
       * 
       * Response on error (401):
       * {
       *   "success": false,
       *   "error": "Invalid email or password. Please check your credentials and try again"
       * }
       */
      const data = await signinUser({
        email: formData.email.toLowerCase(),
        password: formData.password
      });

      /**
       * ========== LOGIN SUCCESS ==========
       */
      const success = login({ user: data.user, tokens: data.tokens });

      if (!success) {
        setApiError('Failed to save authentication data. Please try again.');
        return;
      }

      /**
       * Clear form
       */
      setFormData({ email: '', password: '' });

      /**
       * Redirect to dashboard
       * useEffect will handle this once isAuthenticated() is true
       * Or we can manually navigate
       */
      navigate('/dashboard', { replace: true });

    } catch (error) {
      /**
       * Network error or other unexpected error
       */
      console.error('Login error:', error);
      setApiError(
        'An error occurred during login. Please check your connection and try again.'
      );
    } finally {
      /**
       * Clear loading state
       */
      setIsSubmitting(false);
      setLoading(false);
    }
  };

  /**
   * ========== RENDER ==========
   */
  return (
    <div className="login-container">
      <div className="login-card">
        {/* HEADER */}
        <div className="login-header">
          <h1>Welcome Back</h1>
          <p>Sign in to your account</p>
        </div>

        {/* API ERROR MESSAGE */}
        {apiError && (
          <div className="alert alert-error" role="alert">
            <button
              className="alert-close"
              onClick={() => setApiError(null)}
              aria-label="Close alert"
            >
              ×
            </button>
            <strong>Login Error:</strong> {apiError}
          </div>
        )}

        {/* LOGIN FORM */}
        <form onSubmit={handleSubmit} className="login-form" noValidate>
          {/* EMAIL FIELD */}
          <div className="form-group">
            <label htmlFor="email" className="form-label">
              Email Address
              <span className="required">*</span>
            </label>
            <input
              id="email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="you@example.com"
              className={`form-input ${errors.email ? 'input-error' : ''}`}
              disabled={isSubmitting}
              autoComplete="email"
              autoFocus
            />
            {errors.email && (
              <span className="form-error">{errors.email}</span>
            )}
          </div>

          {/* PASSWORD FIELD */}
          <div className="form-group">
            <label htmlFor="password" className="form-label">
              Password
              <span className="required">*</span>
            </label>
            <input
              id="password"
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Enter your password"
              className={`form-input ${errors.password ? 'input-error' : ''}`}
              disabled={isSubmitting}
              autoComplete="current-password"
            />
            {errors.password && (
              <span className="form-error">{errors.password}</span>
            )}
          </div>

          {/* FORGOT PASSWORD LINK */}
          <div className="form-links">
            <Link to="/forgot-password" className="link-secondary">
              Forgot password?
            </Link>
          </div>

          {/* SUBMIT BUTTON */}
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <span className="spinner"></span> Signing in...
              </>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* SIGNUP LINK */}
        <div className="login-footer">
          <p>
            Don't have an account?{' '}
            <Link to="/signup" className="link-primary">
              Sign up here
            </Link>
          </p>
        </div>

        {/* SECURITY INFO */}
        <div className="security-info">
          <p className="text-muted">
            🔒 Your password is encrypted and never stored in plain text.
            We use industry-standard security practices to protect your data.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;

/**
 * ============================================================================
 * USAGE IN App.js
 * ============================================================================
 * 
 * import { BrowserRouter, Routes, Route } from 'react-router-dom';
 * import { AuthProvider } from './hooks/useAuth';
 * import Login from './pages/Login';
 * import Dashboard from './pages/Dashboard';
 * 
 * function App() {
 *   return (
 *     <AuthProvider>
 *       <BrowserRouter>
 *         <Routes>
 *           <Route path="/login" element={<Login />} />
 *           <Route path="/dashboard" element={<Dashboard />} />
 *         </Routes>
 *       </BrowserRouter>
 *     </AuthProvider>
 *   );
 * }
 * 
 * ============================================================================
 * API ENDPOINT FLOW
 * ============================================================================
 * 
 * 1. User enters email and password
 * 2. Click "Sign In" button
 * 3. Form validates inputs (client-side)
 * 4. Send POST /api/auth/signin with email and password
 * 5. Backend validates and compares password
 * 6. Backend generates JWT tokens
 * 7. Frontend receives tokens and user data
 * 8. useAuth.login() stores tokens in localStorage
 * 9. User is redirected to dashboard
 * 
 * ============================================================================
 * SECURITY FEATURES
 * ============================================================================
 * 
 * Client-side:
 * - Password input type="password" (not visible while typing)
 * - Form validation before API call
 * - Tokens stored in localStorage (XSS vulnerable - consider httpOnly cookies)
 * - Automatic redirect if already authenticated
 * - Generic error message for all login failures
 * 
 * Server-side:
 * - Password hashed with bcrypt before storage
 * - Timing-safe password comparison
 * - Generic error message (don't reveal if email exists or password wrong)
 * - Rate limiting recommended (not implemented yet)
 * - HTTPS required for production
 * 
 * ============================================================================
 * CSS FILE NEEDED (Login.css)
 * ============================================================================
 * 
 * .login-container { }
 * .login-card { }
 * .login-header { }
 * .login-form { }
 * .form-group { }
 * .form-label { }
 * .form-input { }
 * .form-input.input-error { }
 * .form-error { }
 * .form-links { }
 * .btn { }
 * .btn-primary { }
 * .btn-block { }
 * .btn:disabled { }
 * .spinner { }
 * .alert { }
 * .alert-error { }
 * .alert-close { }
 * .login-footer { }
 * .link-primary { }
 * .link-secondary { }
 * .security-info { }
 * .text-muted { }
 * .required { }
 */
