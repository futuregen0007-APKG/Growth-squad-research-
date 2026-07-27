import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { registerUser, signinUser } from '../services/authApi';
import '../styles/Login.css';

const Signup = () => {
  const navigate = useNavigate();
  const { login, isAuthenticated, setLoading, clearError } = useAuth();

  const [formData, setFormData] = useState({
    email: '',
    username: '',
    password: '',
    confirmPassword: ''
  });

  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState(null);

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, navigate]);

  const validateEmail = useCallback((email) => {
    if (!email) return 'Email is required';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return 'Please enter a valid email address';
    return null;
  }, []);

  const validateUsername = useCallback((username) => {
    if (!username) return 'Username is required';
    if (username.length < 3) return 'Username must be at least 3 characters';
    if (username.length > 30) return 'Username cannot exceed 30 characters';
    const usernameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!usernameRegex.test(username)) return 'Username can only contain letters, numbers, underscores, and hyphens';
    return null;
  }, []);

  const validatePassword = useCallback((password) => {
    if (!password) return 'Password is required';
    if (password.length < 8) return 'Password must be at least 8 characters';
    return null;
  }, []);

  const validateForm = useCallback(() => {
    const newErrors = {};
    const emailError = validateEmail(formData.email);
    if (emailError) newErrors.email = emailError;

    const usernameError = validateUsername(formData.username);
    if (usernameError) newErrors.username = usernameError;

    const passwordError = validatePassword(formData.password);
    if (passwordError) newErrors.password = passwordError;

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password';
    } else if (formData.confirmPassword !== formData.password) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData, validateEmail, validatePassword, validateUsername]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: null }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError(null);
    clearError();

    if (!validateForm()) return;

    setIsSubmitting(true);
    setLoading(true);

    try {
      await registerUser({
        email: formData.email.toLowerCase(),
        username: formData.username,
        password: formData.password,
        confirmPassword: formData.confirmPassword
      });

      const signinData = await signinUser({
        email: formData.email.toLowerCase(),
        password: formData.password
      });

      const success = login({ user: signinData.user, tokens: signinData.tokens });

      if (!success) {
        setApiError('Failed to save authentication data. Please try again.');
        return;
      }

      setFormData({ email: '', username: '', password: '', confirmPassword: '' });
      navigate('/dashboard', { replace: true });
    } catch (error) {
      console.error('Signup error:', error);
      const message = error?.message || 'An error occurred while creating your account. Please try again.';
      setApiError(message);
    } finally {
      setIsSubmitting(false);
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <h1>Create your account</h1>
          <p>Sign up to access your dashboard</p>
        </div>

        {apiError && (
          <div className="alert alert-error" role="alert">
            <button className="alert-close" onClick={() => setApiError(null)} aria-label="Close alert">×</button>
            <strong>Signup Error:</strong> {apiError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form" noValidate>
          <div className="form-group">
            <label htmlFor="email" className="form-label">Email Address<span className="required">*</span></label>
            <input id="email" type="email" name="email" value={formData.email} onChange={handleChange} placeholder="you@example.com" className={`form-input ${errors.email ? 'input-error' : ''}`} disabled={isSubmitting} autoComplete="email" autoFocus />
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="username" className="form-label">Username<span className="required">*</span></label>
            <input id="username" type="text" name="username" value={formData.username} onChange={handleChange} placeholder="choose a username" className={`form-input ${errors.username ? 'input-error' : ''}`} disabled={isSubmitting} autoComplete="username" />
            {errors.username && <span className="form-error">{errors.username}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="password" className="form-label">Password<span className="required">*</span></label>
            <input id="password" type="password" name="password" value={formData.password} onChange={handleChange} placeholder="Create a password" className={`form-input ${errors.password ? 'input-error' : ''}`} disabled={isSubmitting} autoComplete="new-password" />
            {errors.password && <span className="form-error">{errors.password}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword" className="form-label">Confirm Password<span className="required">*</span></label>
            <input id="confirmPassword" type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} placeholder="Confirm your password" className={`form-input ${errors.confirmPassword ? 'input-error' : ''}`} disabled={isSubmitting} autoComplete="new-password" />
            {errors.confirmPassword && <span className="form-error">{errors.confirmPassword}</span>}
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
            {isSubmitting ? <><span className="spinner"></span> Creating account...</> : 'Sign Up'}
          </button>
        </form>

        <div className="login-footer">
          <p>
            Already have an account? <Link to="/login" className="link-primary">Sign in here</Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Signup;
