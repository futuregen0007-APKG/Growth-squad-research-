<!-- Signin API Implementation Guide -->

# Signin API - Implementation Guide

## Overview

The Signin API authenticates users and issues JWT tokens for accessing protected resources. It implements production-grade security practices to prevent common attacks.

## Endpoint

```
POST /api/auth/signin
```

## Request

### Headers
```
Content-Type: application/json
```

### Body
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123"
}
```

## Response

### Success (200 OK)
```json
{
  "success": true,
  "statusCode": 200,
  "message": "Login successful",
  "data": {
    "user": {
      "_id": "507f1f77bcf86cd799439011",
      "email": "user@example.com",
      "username": "john_doe",
      "role": "user",
      "accountStatus": "active",
      "isEmailVerified": false,
      "lastLogin": "2026-07-26T10:30:00.000Z",
      "createdAt": "2026-07-26T10:00:00.000Z",
      "updatedAt": "2026-07-26T10:30:00.000Z"
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expiresIn": 900
    }
  },
  "timestamp": "2026-07-26T10:30:00.000Z"
}
```

### Error (401 Unauthorized)
```json
{
  "success": false,
  "statusCode": 401,
  "error": "Invalid email or password. Please check your credentials and try again",
  "timestamp": "2026-07-26T10:30:00.000Z"
}
```

**Note:** The error message is intentionally generic for both "email not found" and "password incorrect" scenarios.

### Error (400 Bad Request)
```json
{
  "success": false,
  "statusCode": 400,
  "error": "Email is required",
  "details": {
    "field": "email"
  },
  "timestamp": "2026-07-26T10:30:00.000Z"
}
```

### Error (500 Internal Server Error)
```json
{
  "success": false,
  "statusCode": 500,
  "error": "An error occurred during authentication. Please try again later.",
  "timestamp": "2026-07-26T10:30:00.000Z"
}
```

## Implementation Details

### 1. Input Validation

**Step 1: Required Fields**
- Email must be provided
- Password must be provided

**Step 2: Email Format**
- Must match email regex pattern
- Example: `user@example.com`

**Step 3: Database Query**
- Query user by lowercase email
- Use `.select('+password')` to fetch password field (normally excluded)

### 2. Security Decisions Explained

#### A. Generic Error Message (Critical Security Feature)

**Problem:** If we return different errors for "email not found" vs "wrong password", attackers can:
1. Brute force emails to find which ones are registered
2. Then focus password guessing on valid emails
3. This is called "email enumeration attack"

**Solution:** Return same generic message for both cases

```javascript
// WRONG - Reveals which field is incorrect
if (!user) {
  return 401; // "User not found" - email enumeration possible
}
if (!isPasswordCorrect) {
  return 401; // "Password incorrect" - different message
}

// RIGHT - Same message for both scenarios
if (!user || !isPasswordCorrect) {
  return 401; // "Invalid email or password" - no information leaked
}
```

**HTTP Status Code**: Both scenarios return `401 Unauthorized`

**Error Message**: 
> "Invalid email or password. Please check your credentials and try again"

**Why Not 404 Not Found?**
- 404 explicitly tells attacker the email doesn't exist
- 401 Unauthorized is appropriate for authentication failure
- Maintains ambiguity about what failed

#### B. Timing-Safe Password Comparison

**Problem:** Regular string comparison times vary based on when mismatch occurs:
```javascript
// VULNERABLE to timing attacks
if (password === storedHash) { // Takes longer for first char match
  ...
}
```

Attackers can measure response time to:
- Guess password character by character
- Determine password length through timing analysis

**Solution:** Use bcrypt.compare() for constant-time comparison

```javascript
// CORRECT - Always takes same time regardless of password
const isMatch = await bcrypt.compare(plaintext, hash);
```

**bcrypt.compare() implementation:**
1. Extracts salt from stored hash
2. Hashes provided password with extracted salt
3. Compares hashes in constant time
4. Returns boolean

#### C. Account Status Check

Even if credentials are correct, blocked accounts should not login:

```javascript
if (user.accountStatus === 'blocked') {
  // Return same generic error as password failure
  // Don't reveal that account exists but is blocked
  return 401; // "Invalid email or password"
}
```

This prevents attackers from:
- Knowing which accounts are blocked
- Targeting those accounts with social engineering

#### D. Lowercase Email Normalization

All email queries use lowercase normalization:

```javascript
// Registration
email: email.toLowerCase() // "User@Example.com" → "user@example.com"

// Login
User.findOne({ email: email.toLowerCase() })
```

**Why:** Email addresses are case-insensitive (per RFC 5321)
- Prevents duplicate accounts like "john@example.com" and "John@example.com"
- Ensures consistent lookups

### 3. Password Verification Process

```
1. User enters plaintext password
   ↓
2. Query database for user by email
   ↓
3. Check if user exists
   ↓
4. Check if account is not blocked
   ↓
5. Call user.comparePassword(plaintext)
   ↓
6. comparePassword() uses bcrypt.compare()
   ↓
7. Return true/false
   ↓
8. If false, return generic 401 error
```

### 4. Token Generation

#### Access Token
- **Type:** JWT
- **Lifetime:** 15 minutes
- **Usage:** Include in `Authorization: Bearer <token>` header
- **Contains:** userId, email, role, token type

**Why 15 minutes?**
- Short enough that stolen token has limited access window
- Long enough to avoid excessive refresh calls
- Industry standard for access tokens

**Structure:**
```javascript
{
  "userId": "507f1f77bcf86cd799439011",
  "email": "user@example.com",
  "role": "user",
  "type": "access",
  "iss": "stock-market-ai",
  "aud": "client",
  "exp": 1658829600
}
```

#### Refresh Token
- **Type:** JWT
- **Lifetime:** 7 days
- **Usage:** Stored client-side, used to get new access token
- **Contains:** userId, token type only (minimal data)

**Why 7 days?**
- Longer than access token to reduce friction
- Rotation recommended on each refresh (revoke old token)
- Can be invalidated server-side if necessary

**Structure:**
```javascript
{
  "userId": "507f1f77bcf86cd799439011",
  "type": "refresh",
  "iss": "stock-market-ai",
  "aud": "client",
  "exp": 1659434400
}
```

### 5. Environment Variables Required

```bash
# Backend .env
JWT_SECRET=your-super-secret-key-at-least-32-characters
JWT_EXPIRE_IN=15m
REFRESH_TOKEN_EXPIRE_IN=7d

# Frontend .env
REACT_APP_API_BASE_URL=http://localhost:5000
```

**JWT_SECRET Security:**
- Must be at least 32 characters
- Should be cryptographically random
- Never commit to version control
- Rotate periodically in production
- Use environment variables or secrets manager

### 6. lastLogin Update

```javascript
user.lastLogin = new Date();
await user.save();
```

**Purpose:**
- Track user activity
- Detect suspicious login patterns
- Generate security reports
- Identify inactive accounts

**Performance Note:**
- Updates database on every login
- Consider async update in high-traffic scenarios
- Can use background job instead

### 7. Error Handling

| Error Type | HTTP Status | Message | Cause |
|-----------|-----------|---------|-------|
| Missing field | 400 | "Email is required" | Input validation failure |
| Invalid format | 400 | "Invalid email format" | Email format doesn't match regex |
| User not found | 401 | "Invalid email or password" | Email doesn't exist (generic) |
| Wrong password | 401 | "Invalid email or password" | Password doesn't match (generic) |
| Account blocked | 401 | "Invalid email or password" | User status is "blocked" (generic) |
| Database error | 500 | "A database error occurred..." | Connection/operational error |
| Unexpected error | 500 | "An error occurred..." | Programming error/exception |

## Usage Examples

### cURL
```bash
curl -X POST http://localhost:5000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123"
  }'
```

### JavaScript/Fetch
```javascript
const response = await fetch('http://localhost:5000/api/auth/signin', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    email: 'user@example.com',
    password: 'SecurePassword123'
  })
});

const data = await response.json();
if (response.ok) {
  const { accessToken, refreshToken } = data.data.tokens;
  localStorage.setItem('accessToken', accessToken);
  localStorage.setItem('refreshToken', refreshToken);
}
```

### Frontend Implementation
See `frontend/src/pages/Login.jsx` for complete implementation

## Security Best Practices Checklist

- ✅ Generic error messages (don't reveal email enumeration)
- ✅ Timing-safe password comparison (bcrypt)
- ✅ Account status verification
- ✅ Email normalization (lowercase)
- ✅ Password hashing with salt (pre-save middleware)
- ✅ Separate access & refresh tokens
- ✅ Short access token lifetime (15 mins)
- ✅ Token stored in localStorage (frontend security consideration)
- ✅ Authorization header for API calls
- ✅ HTTPS required in production
- ⏳ Rate limiting (recommended - not implemented)
- ⏳ Two-factor authentication (recommended future)
- ⏳ Account lockout after N failed attempts (recommended)
- ⏳ Login attempt logging/monitoring (recommended)

## Future Enhancements

1. **Rate Limiting**
   - Limit login attempts per email (5 attempts per 15 minutes)
   - Implement exponential backoff
   - Block IP after multiple failures

2. **Two-Factor Authentication**
   - SMS or authenticator app
   - Required for admin accounts
   - Optional for users

3. **Account Lockout**
   - Lock account after 5 failed attempts
   - Auto-unlock after 30 minutes
   - Send email notification

4. **Login Attempt Logging**
   - Log all login attempts (success/failure)
   - Include IP address, user agent
   - Alert on suspicious patterns

5. **Session Management**
   - Track concurrent sessions
   - Limit sessions per user
   - Device-based session management

6. **Token Refresh Strategy**
   - Implement token rotation
   - Revoke old token on refresh
   - Track token usage per device

## API Integration Points

### Backend Setup (server.js)
```javascript
const authRoutes = require('./routes/auth');
app.use(express.json());
app.use('/api/auth', authRoutes);
```

### Frontend Setup (App.js)
```javascript
import { AuthProvider } from './hooks/useAuth';
import Login from './pages/Login';

function App() {
  return (
    <AuthProvider>
      <Login />
    </AuthProvider>
  );
}
```

### Protected Routes (Future)
```javascript
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();
  return isAuthenticated() ? children : <Navigate to="/login" />;
};
```

## Troubleshooting

### "JWT_SECRET not configured"
- Add `JWT_SECRET` to backend `.env` file
- Must be at least 32 characters

### "Invalid token"
- Token may have expired
- Refresh token should be used to get new access token
- Check token expiration time

### "Token refresh failed"
- Refresh token may have expired (7 days)
- User must login again
- Check refresh token in localStorage

### CORS errors
- Ensure frontend and backend are on same origin or CORS is configured
- Check `REACT_APP_API_BASE_URL` environment variable

---

**Last Updated:** July 26, 2026  
**Status:** Production Ready  
**Security Level:** High
