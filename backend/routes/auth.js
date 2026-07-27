import express from 'express';
import { register, signin } from '../controllers/auth.controller.js';

/**
 * Authentication Routes
 * 
 * All routes related to user authentication:
 * - User registration
 * - User login (to be implemented)
 * - Refresh token (to be implemented)
 * - Logout (to be implemented)
 */
const router = express.Router();

/**
 * POST /api/auth/register
 * 
 * Create a new user account
 * 
 * Request Body:
 * {
 *   "email": "user@example.com",
 *   "username": "john_doe",
 *   "password": "SecurePassword123",
 *   "confirmPassword": "SecurePassword123"
 * }
 * 
 * Success Response (201 Created):
 * {
 *   "success": true,
 *   "message": "User registered successfully",
 *   "data": {
 *     "user": { _id, email, username, role, accountStatus, ... }
 *   }
 * }
 * 
 * Error Response (400, 409, 500):
 * {
 *   "success": false,
 *   "error": "Error message",
 *   "field": "fieldName" (optional)
 * }
 */
router.post('/register', register);

/**
 * POST /api/auth/signin
 * 
 * Authenticate user and issue tokens
 * 
 * Request Body:
 * {
 *   "email": "user@example.com",
 *   "password": "SecurePassword123"
 * }
 * 
 * Success Response (200 OK):
 * {
 *   "success": true,
 *   "message": "Login successful",
 *   "data": {
 *     "user": { _id, email, username, role, ... },
 *     "tokens": {
 *       "accessToken": "eyJhbGc...",
 *       "refreshToken": "eyJhbGc...",
 *       "expiresIn": 900
 *     }
 *   }
 * }
 * 
 * Error Response (401):
 * {
 *   "success": false,
 *   "error": "Invalid email or password. Please check your credentials and try again"
 * }
 */
router.post('/signin', signin);

/**
 * Future endpoints (commented):
 * 
 * router.post('/refresh-token', refreshToken);
 * - Generate new access token from refresh token
 * - Support multi-device refresh tokens
 * - Implement token rotation
 * 
 * router.post('/logout', logout);
 * - Revoke refresh token for current device
 * - Or logout from all devices
 * 
 * router.post('/forgot-password', forgotPassword);
 * - Send password reset email
 * 
 * router.post('/reset-password', resetPassword);
 * - Reset password with token from email
 * 
 * router.post('/verify-email', verifyEmail);
 * - Confirm email address with token
 */

export default router;
