import jwt from 'jsonwebtoken';
import {
  createUser,
  findUserByEmail,
  findUserByEmailWithPassword,
  findUserByUsername,
  comparePassword,
  updateLastLogin,
  sanitizeUser
} from '../utils/userStore.js';

/**
 * ============================================================================
 * RESPONSE UTILITIES - Centralized Response Handling
 * ============================================================================
 */

/**
 * Success Response Format
 * @param {number} statusCode - HTTP status code (200, 201, etc.)
 * @param {string} message - Success message
 * @param {Object} data - Response data object
 * @returns {Object} Formatted success response
 */
const sendSuccess = (statusCode, message, data = null) => ({
  success: true,
  statusCode,
  message,
  data,
  timestamp: new Date().toISOString()
});

/**
 * Error Response Format
 * @param {number} statusCode - HTTP status code (400, 409, 500, etc.)
 * @param {string} error - Error message
 * @param {Object} details - Additional error details (validation errors, field, etc.)
 * @returns {Object} Formatted error response
 */
const sendError = (statusCode, error, details = null) => ({
  success: false,
  statusCode,
  error,
  ...(details && { details }),
  timestamp: new Date().toISOString()
});

/**
 * ============================================================================
 * VALIDATION UTILITIES - Centralized Validation Logic
 * ============================================================================
 */

/**
 * Validate required fields
 * @param {Object} fields - Object with field names and values
 * @returns {Object|null} Error object or null if valid
 */
const validateRequiredFields = (fields) => {
  for (const [field, value] of Object.entries(fields)) {
    if (!value || (typeof value === 'string' && !value.trim())) {
      return {
        statusCode: 400,
        error: `${field.charAt(0).toUpperCase() + field.slice(1)} is required`,
        field
      };
    }
  }
  return null;
};

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {Object|null} Error object or null if valid
 */
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return {
      statusCode: 400,
      error: 'Invalid email format. Please provide a valid email address',
      field: 'email'
    };
  }
  return null;
};

/**
 * Validate username format and length
 * @param {string} username - Username to validate
 * @returns {Object|null} Error object or null if valid
 */
const validateUsername = (username) => {
  const usernameRegex = /^[a-zA-Z0-9_-]+$/;

  if (!usernameRegex.test(username)) {
    return {
      statusCode: 400,
      error: 'Username can only contain letters, numbers, underscores, and hyphens',
      field: 'username'
    };
  }

  if (username.length < 3) {
    return {
      statusCode: 400,
      error: 'Username must be at least 3 characters long',
      field: 'username'
    };
  }

  if (username.length > 30) {
    return {
      statusCode: 400,
      error: 'Username cannot exceed 30 characters',
      field: 'username'
    };
  }

  return null;
};

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {Object|null} Error object or null if valid
 */
const validatePassword = (password) => {
  if (password.length < 8) {
    return {
      statusCode: 400,
      error: 'Password must be at least 8 characters long',
      field: 'password'
    };
  }

  // Optional: Add password strength requirements
  // Uncomment if needed:
  // const hasUpperCase = /[A-Z]/.test(password);
  // const hasLowerCase = /[a-z]/.test(password);
  // const hasNumbers = /\d/.test(password);
  // if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
  //   return {
  //     statusCode: 400,
  //     error: 'Password must contain uppercase, lowercase, and numbers',
  //     field: 'password'
  //   };
  // }

  return null;
};

/**
 * Validate password confirmation
 * @param {string} password - Original password
 * @param {string} confirmPassword - Password confirmation
 * @returns {Object|null} Error object or null if valid
 */
const validatePasswordMatch = (password, confirmPassword) => {
  if (password !== confirmPassword) {
    return {
      statusCode: 400,
      error: 'Passwords do not match',
      field: 'confirmPassword'
    };
  }
  return null;
};

/**
 * ============================================================================
 * ERROR HANDLER - Centralized Error Processing
 * ============================================================================
 */

/**
 * Handle Mongoose Validation Errors
 * @param {Object} error - Mongoose ValidationError
 * @returns {Object} Formatted error response
 */
const handleValidationError = (error) => {
  const validationErrors = {};
  const firstFieldError = {};

  for (const field in error.errors) {
    const fieldError = error.errors[field];
    validationErrors[field] = fieldError.message;

    // Capture first field error for priority display
    if (!Object.keys(firstFieldError).length) {
      firstFieldError.field = field;
      firstFieldError.message = fieldError.message;
    }
  }

  return {
    statusCode: 400,
    error: 'Validation failed',
    details: validationErrors,
    firstError: firstFieldError
  };
};

/**
 * Handle MongoDB Duplicate Key Error (Error Code 11000)
 * @param {Object} error - MongoDB duplicate key error
 * @returns {Object} Formatted error response
 */
const handleDuplicateKeyError = (error) => {
  const duplicateField = Object.keys(error.keyPattern)[0];

  const fieldMessages = {
    email: 'This email is already registered. Please use a different email or login',
    username: 'This username is already taken. Please choose a different username'
  };

  const message = fieldMessages[duplicateField] || `This ${duplicateField} already exists`;

  return {
    statusCode: 409,
    error: message,
    field: duplicateField
  };
};

/**
 * Handle Database Errors
 * @param {Object} error - Database error
 * @returns {Object} Formatted error response
 */
const handleDatabaseError = (error) => {
  console.error('Database error:', error);

  return {
    statusCode: 500,
    error: 'A database error occurred. Please try again later'
  };
};

/**
 * Handle Unexpected Errors
 * @param {Object} error - Unexpected error
 * @returns {Object} Formatted error response
 */
const handleUnexpectedError = (error) => {
  console.error('Unexpected error:', error);

  return {
    statusCode: 500,
    error: 'An unexpected error occurred. Please try again later'
  };
};

/**
 * ============================================================================
 * AUTHENTICATION CONTROLLER
 * ============================================================================
 */

/**
 * REGISTER - Create new user account
 * 
 * HTTP Method: POST
 * Route: /api/auth/register
 * Body: { email, username, password, confirmPassword }
 * 
 * HTTP Status Codes:
 * - 201 Created: User successfully registered
 * - 400 Bad Request: Validation error (missing field, invalid format, etc.)
 * - 409 Conflict: Email or username already exists
 * - 500 Internal Server Error: Database or server error
 * 
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body
 * @param {string} req.body.email - User's email address
 * @param {string} req.body.username - User's username
 * @param {string} req.body.password - User's password (minimum 8 characters)
 * @param {string} req.body.confirmPassword - Password confirmation
 * @param {Object} res - Express response object
 */
const register = async (req, res) => {
  try {
    console.log('Register request received', req.body);
    const { email, username, password, confirmPassword } = req.body;

    /**
     * ========== VALIDATION STEP 1: Required Fields ==========
     */
    const requiredError = validateRequiredFields({
      email,
      username,
      password,
      confirmPassword
    });

    if (requiredError) {
      return res.status(requiredError.statusCode).json(
        sendError(requiredError.statusCode, requiredError.error, {
          field: requiredError.field
        })
      );
    }

    /**
     * ========== VALIDATION STEP 2: Email Format ==========
     */
    const emailError = validateEmail(email);
    if (emailError) {
      return res.status(emailError.statusCode).json(
        sendError(emailError.statusCode, emailError.error, {
          field: emailError.field
        })
      );
    }

    /**
     * ========== VALIDATION STEP 3: Username Format & Length ==========
     */
    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(usernameError.statusCode).json(
        sendError(usernameError.statusCode, usernameError.error, {
          field: usernameError.field
        })
      );
    }

    /**
     * ========== VALIDATION STEP 4: Password Length ==========
     */
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(passwordError.statusCode).json(
        sendError(passwordError.statusCode, passwordError.error, {
          field: passwordError.field
        })
      );
    }

    /**
     * ========== VALIDATION STEP 5: Password Confirmation ==========
     */
    const passwordMatchError = validatePasswordMatch(password, confirmPassword);
    if (passwordMatchError) {
      return res.status(passwordMatchError.statusCode).json(
        sendError(passwordMatchError.statusCode, passwordMatchError.error, {
          field: passwordMatchError.field
        })
      );
    }

    /**
     * ========== DATABASE CHECK: Duplicate Email ==========
     * Check before save to provide better UX and avoid database errors
     */
    const existingEmail = await findUserByEmail(email);
    if (existingEmail) {
      return res.status(409).json(
        sendError(
          409,
          'This email is already registered. Please use a different email or login',
          { field: 'email' }
        )
      );
    }

    /**
     * ========== DATABASE CHECK: Duplicate Username ==========
     */
    const existingUsername = await findUserByUsername(username);
    if (existingUsername) {
      return res.status(409).json(
        sendError(
          409,
          'This username is already taken. Please choose a different username',
          { field: 'username' }
        )
      );
    }

    /**
     * ========== CREATE USER INSTANCE ==========
     * All validations passed - create new user
     */
    const userResponse = await createUser({
      email,
      username,
      password,
      role: 'user',
      accountStatus: 'active',
      isEmailVerified: false
    });

    /**
     * ========== SEND SUCCESS RESPONSE ==========
     * HTTP 201 Created - resource successfully created
     */
    return res.status(201).json(
      sendSuccess(201, 'User registered successfully', {
        user: userResponse
      })
    );

  } catch (error) {
    /**
     * ========== ERROR HANDLING ==========
     */
    console.error('Register error stack:', error instanceof Error ? error.stack : error);

    // Mongoose Validation Error (field validation failed)
    if (error.name === 'ValidationError') {
      const errorResponse = handleValidationError(error);
      return res.status(errorResponse.statusCode).json(
        sendError(
          errorResponse.statusCode,
          errorResponse.error,
          errorResponse.details
        )
      );
    }

    // MongoDB Duplicate Key Error (race condition)
    if (error.code === 11000) {
      const errorResponse = handleDuplicateKeyError(error);
      return res.status(errorResponse.statusCode).json(
        sendError(
          errorResponse.statusCode,
          errorResponse.error,
          { field: errorResponse.field }
        )
      );
    }

    // Database connectivity or operational errors
    if (error.name === 'MongoNetworkError' || error.name === 'MongoError') {
      const errorResponse = handleDatabaseError(error);
      return res.status(errorResponse.statusCode).json(
        sendError(errorResponse.statusCode, errorResponse.error)
      );
    }

    // Unexpected/unhandled errors
    const errorResponse = handleUnexpectedError(error);
    return res.status(errorResponse.statusCode).json(
      sendError(errorResponse.statusCode, errorResponse.error)
    );
  }
};

/**
 * ============================================================================
 * SIGNIN / LOGIN CONTROLLER
 * ============================================================================
 */

/**
 * SIGNIN - Authenticate user and issue tokens
 * 
 * HTTP Method: POST
 * Route: /api/auth/signin
 * Body: { email, password }
 * 
 * HTTP Status Codes:
 * - 200 OK: Login successful
 * - 400 Bad Request: Missing or invalid email/password format
 * - 401 Unauthorized: Invalid credentials (generic message)
 * - 500 Internal Server Error: Database or server error
 * 
 * Security Notes:
 * - NEVER reveal whether email exists or password is incorrect
 * - Always return 401 with generic message for both cases
 * - Use bcrypt.compare() for timing-safe password comparison
 * - Return separate access & refresh tokens
 * - Consider rate limiting on this endpoint
 * 
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body
 * @param {string} req.body.email - User's email address
 * @param {string} req.body.password - User's password
 * @param {Object} res - Express response object
 */
const signin = async (req, res) => {
  try {
    const { email, password } = req.body;

    /**
     * ========== VALIDATION: Required Fields ==========
     */
    const requiredError = validateRequiredFields({ email, password });
    if (requiredError) {
      return res.status(requiredError.statusCode).json(
        sendError(requiredError.statusCode, requiredError.error, {
          field: requiredError.field
        })
      );
    }

    /**
     * ========== VALIDATION: Email Format ==========
     */
    const emailError = validateEmail(email);
    if (emailError) {
      return res.status(emailError.statusCode).json(
        sendError(emailError.statusCode, emailError.error, {
          field: emailError.field
        })
      );
    }

    /**
     * ========== DATABASE: Fetch User ==========
     * 
     * Query user by email
     * CRITICAL: Must use .select('+password') because password has select: false
     * Without explicit select, password field won't be fetched from database
     * 
     * Why lowercase email:
     * - Emails are case-insensitive in real systems
     * - We store emails in lowercase during registration
     * - Query must match the stored format
     */
    const user = await findUserByEmailWithPassword(email);

    /**
     * ========== SECURITY: User Not Found ==========
     * 
     * CRITICAL SECURITY DECISION:
     * If user not found, still return 401 Unauthorized
     * 
     * Why NOT 404 Not Found:
     * - 404 reveals that email doesn't exist (email enumeration attack)
     * - Attackers can brute force to find valid emails
     * - 401 tells them credentials are invalid (email or password)
     * 
     * What to do:
     * - Return same generic message as wrong password
     * - Client cannot distinguish between "email not found" vs "wrong password"
     * - This forces attackers to also guess passwords
     * 
     * Trade-off:
     * - Users might forget which email they registered with
     * - Acceptable: They can use "Forgot Password" feature
     * - Security benefit outweighs minor UX inconvenience
     */
    if (!user) {
      return res.status(401).json(
        sendError(
          401,
          'Invalid email or password. Please check your credentials and try again'
        )
      );
    }

    /**
     * ========== SECURITY: Check Account Status ==========
     * 
     * Even if credentials are correct, blocked accounts should not login
     * But we return same generic error to not reveal account status
     */
    if (user.accountStatus === 'blocked') {
      return res.status(401).json(
        sendError(
          401,
          'Invalid email or password. Please check your credentials and try again'
        )
      );
    }

    /**
     * ========== PASSWORD VERIFICATION ==========
     * 
     * Compare plain text password with stored hash
     * Uses bcrypt.compare() for timing-safe comparison
     * 
     * Why timing-safe:
     * - Regular string comparison time varies based on when match fails
     * - Attackers can measure response time to guess password length
     * - bcrypt.compare() always takes same time (constant-time)
     * - Prevents timing attacks
     */
    const isPasswordCorrect = await comparePassword(password, user.password);

    /**
     * ========== PASSWORD INCORRECT ==========
     * 
     * CRITICAL SECURITY DECISION:
     * Return same generic message as "user not found"
     * 
     * Why:
     * - Prevent password enumeration attacks
     * - Attacker can't verify if they found correct email
     * - Must guess both email AND password together
     * 
     * Implementation:
     * - Same 401 status code
     * - Same generic error message
     * - No difference in response time (both queries were performed)
     */
    if (!isPasswordCorrect) {
      return res.status(401).json(
        sendError(
          401,
          'Invalid email or password. Please check your credentials and try again'
        )
      );
    }

    /**
     * ========== TOKEN GENERATION ==========
     * 
     * REQUIRES: npm install jsonwebtoken
     * 
     * Create two types of tokens:
     * 1. Access Token - Short-lived (15 mins), includes user data
     * 2. Refresh Token - Long-lived (7 days), used to get new access token
     */

    /**
     * Ensure JWT_SECRET is configured
     */
    const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';

    /**
     * ========== ACCESS TOKEN ==========
     * 
     * Short-lived token (15 minutes)
     * Contains user ID and basic info
     * Sent in Authorization header for protected routes
     * 
     * Structure:
     * - Header: Algorithm (HS256), token type
     * - Payload: User ID, token type, expiration
     * - Signature: Signed with JWT_SECRET
     * 
     * Lifetime: 15 minutes = 900 seconds
     * Short lifetime = if token is stolen, damage is limited to 15 mins
     */
    const accessToken = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        role: user.role,
        type: 'access'
      },
      jwtSecret,
      {
        expiresIn: '15m', // 15 minutes
        issuer: 'stock-market-ai', // Custom issuer for validation
        audience: 'client' // Token intended for client
      }
    );

    /**
     * ========== REFRESH TOKEN ==========
     * 
     * Long-lived token (7 days)
     * Used to obtain new access token without re-entering password
     * Should be stored securely (httpOnly cookie in production)
     * 
     * Lifetime: 7 days = 604800 seconds
     * Long lifetime = reduces friction for returning users
     * Risk: If stolen, attacker has access for 7 days
     * Mitigation: Refresh token rotation (revoke old token when new one issued)
     * 
     * NOTE: In production, also store hashed refresh token in database
     * This allows revocation of specific tokens
     */
    const refreshToken = jwt.sign(
      {
        userId: user._id,
        type: 'refresh'
      },
      jwtSecret,
      {
        expiresIn: '7d', // 7 days
        issuer: 'stock-market-ai',
        audience: 'client'
      }
    );

    /**
     * ========== UPDATE LAST LOGIN ==========
     * 
     * Track when user last successfully logged in
     * Useful for security audits and activity reports
     * 
     * TODO: Consider async update to avoid blocking login
     */
    await updateLastLogin(user._id);

    /**
     * ========== PREPARE RESPONSE ==========
     * 
     * Return both tokens to client
     * Access token: Used for API requests
     * Refresh token: Stored for getting new access token
     */
    const userResponse = sanitizeUser(user);

    /**
     * ========== RETURN SUCCESS RESPONSE ==========
     */
    return res.status(200).json(
      sendSuccess(200, 'Login successful', {
        user: userResponse,
        tokens: {
          accessToken,
          refreshToken,
          expiresIn: 900 // Access token expiration in seconds (15 mins)
        }
      })
    );

  } catch (error) {
    /**
     * ========== ERROR HANDLING ==========
     */

    console.error('Signin error:', error);

    // Database errors
    if (error.name === 'MongoNetworkError' || error.name === 'MongoError') {
      return res.status(500).json(
        sendError(500, 'A database error occurred. Please try again later')
      );
    }

    // Unexpected errors
    return res.status(500).json(
      sendError(500, 'An error occurred during authentication. Please try again later')
    );
  }
};

/**
 * Export controller methods
 */
export { register, signin };

/**
 * ============================================================================
 * USAGE EXAMPLE
 * ============================================================================
 * 
 * In routes/auth.js:
 * 
 * const express = require('express');
 * const { register } = require('../controllers/auth.controller');
 * const router = express.Router();
 * 
 * router.post('/register', register);
 * 
 * module.exports = router;
 * 
 * Then in server.js:
 * const authRoutes = require('./routes/auth');
 * app.use('/api/auth', authRoutes);
 * 
 * ============================================================================
 * CURL EXAMPLE REQUEST
 * ============================================================================
 * 
 * curl -X POST http://localhost:5000/api/auth/register \
 *   -H "Content-Type: application/json" \
 *   -d '{
 *     "email": "user@example.com",
 *     "username": "john_doe",
 *     "password": "SecurePassword123",
 *     "confirmPassword": "SecurePassword123"
 *   }'
 * 
 * ============================================================================
 * SUCCESS RESPONSE (201 Created)
 * ============================================================================
 * 
 * {
 *   "success": true,
 *   "message": "User registered successfully",
 *   "data": {
 *     "user": {
 *       "_id": "507f1f77bcf86cd799439011",
 *       "email": "user@example.com",
 *       "username": "john_doe",
 *       "role": "user",
 *       "accountStatus": "active",
 *       "isEmailVerified": false,
 *       "lastLogin": null,
 *       "createdAt": "2026-07-26T10:30:00.000Z",
 *       "updatedAt": "2026-07-26T10:30:00.000Z"
 *     }
 *   }
 * }
 * 
 * Note: password field is NOT included
 * 
 * ============================================================================
 * ERROR RESPONSES
 * ============================================================================
 * 
 * 1. Missing field (400 Bad Request)
 * {
 *   "success": false,
 *   "error": "Email is required",
 *   "field": "email"
 * }
 * 
 * 2. Duplicate email (409 Conflict)
 * {
 *   "success": false,
 *   "error": "Email already registered",
 *   "field": "email"
 * }
 * 
 * 3. Invalid email format (400 Bad Request)
 * {
 *   "success": false,
 *   "error": "Invalid email format",
 *   "field": "email"
 * }
 * 
 * 4. Password too short (400 Bad Request)
 * {
 *   "success": false,
 *   "error": "Password must be at least 8 characters",
 *   "field": "password"
 * }
 * 
 * 5. Passwords don't match (400 Bad Request)
 * {
 *   "success": false,
 *   "error": "Passwords do not match",
 *   "field": "confirmPassword"
 * }
 * 
 * 6. Database error (500 Internal Server Error)
 * {
 *   "success": false,
 *   "error": "An error occurred during registration. Please try again later."
 * }
 */
