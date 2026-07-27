import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * User Schema
 * 
 * Represents application users with authentication, verification, and account management.
 * All sensitive data (password, tokens) follows security best practices.
 * 
 * @requires mongoose
 */
const userSchema = new mongoose.Schema(
  {
    /**
     * User's email address
     * - Must be unique across the application
     * - Used for login, password recovery, and email verification
     * - Stored in lowercase for consistency
     * - Validated with email format regex
     */
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        'Please provide a valid email address'
      ]
    },

    /**
     * User's display/login username
     * - Must be unique across the application
     * - Alphanumeric characters, underscores, and hyphens only
     * - Used for profile display and identification
     */
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username cannot exceed 30 characters'],
      match: [
        /^[a-zA-Z0-9_-]+$/,
        'Username can only contain letters, numbers, underscores, and hyphens'
      ]
    },

    /**
     * User's hashed password
     * - NEVER store plain text passwords
     * - Must be hashed using bcrypt with salt rounds >= 10 before saving
     * - Required for all user accounts
     * - Should be excluded from API responses using select: false
     */
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false // Exclude password from queries by default
    },

    /**
     * User's role in the application
     * - Determines access levels and permissions
     * - 'user': Regular user with standard permissions
     * - 'admin': Administrator with full system access
     * - Used for authorization middleware and role-based access control (RBAC)
     */
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
      required: true
    },

    /**
     * Email verification status
     * - Tracks whether user has verified their email address
     * - Set to false initially; updated to true after email verification
     * - Used to restrict features until email is verified
     * - Prevents spam registrations from unverified emails
     */
    isEmailVerified: {
      type: Boolean,
      default: false
    },

    /**
     * User's account status
     * - 'active': User account is in good standing and can login
     * - 'blocked': Account is blocked (can be due to violations, admin action, etc.)
     * - Used to enforce login restrictions and access control
     * - Blocked users should be prevented from logging in
     */
    accountStatus: {
      type: String,
      enum: ['active', 'blocked'],
      default: 'active',
      required: true
    },

    /**
     * Refresh tokens for multi-device support
     * - Stores array of refresh tokens to support login on multiple devices
     * - Each device gets a unique refresh token that can be revoked independently
     * - Allows users to logout from specific devices without logging out everywhere
     * 
     * Structure: Array of objects containing:
     * - token: The actual JWT refresh token (hashed for security)
     * - deviceId: Unique identifier for the device (UUID or similar)
     * - deviceName: Optional user-friendly device name (e.g., "Chrome on Windows")
     * - issuedAt: Timestamp when token was created
     * - expiresAt: Timestamp when token expires
     */
    refreshTokens: [
      {
        token: {
          type: String,
          required: true,
          // In production, store hashed version of token for security
          // Use: crypto.createHash('sha256').update(token).digest('hex')
        },
        deviceId: {
          type: String,
          required: true // Unique identifier for the device
        },
        deviceName: {
          type: String,
          default: 'Unknown Device'
        },
        issuedAt: {
          type: Date,
          default: Date.now
        },
        expiresAt: {
          type: Date,
          required: true
        }
      }
    ],

    /**
     * Last login timestamp
     * - Tracks when user last successfully authenticated
     * - Useful for security audits and detecting suspicious activity
     * - Can be used to identify inactive accounts
     */
    lastLogin: {
      type: Date,
      default: null
    },

    /**
     * Account creation timestamp
     * - Automatically set when document is created
     * - Used for audit trails and account age calculations
     */
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true // Prevent modification after creation
    },

    /**
     * Last modification timestamp
     * - Automatically updated whenever document is modified
     * - Used for tracking changes and audit trails
     */
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    // Mongoose schema options
    timestamps: false, // We're managing timestamps manually for more control
    toJSON: {
      transform(doc, ret) {
        // Remove sensitive fields when converting to JSON
        delete ret.password;
        delete ret.refreshTokens; // Don't expose tokens to client
        return ret;
      }
    }
  }
);

/**
 * ============================================================================
 * INDEX STRATEGY FOR PRODUCTION STOCK MARKET APPLICATION
 * ============================================================================
 * 
 * INDEXING PHILOSOPHY:
 * - Every index trades write performance (insert/update/delete) for read performance
 * - Each index consumes ~10-15% of collection size in disk space
 * - Only index fields that are frequently queried or sorted
 * - Use compound indexes for common query combinations
 * - Avoid indexing passwords and sensitive data (see below)
 * 
 * ============================================================================
 */

// TIER 1: CRITICAL INDEXES (High Priority - Frequent Operations)
// These are essential for login and authentication flows

// The email and username fields already use unique constraints in the schema,
// so explicit secondary index declarations are not needed here.

// ============================================================================
// TIER 2: HIGH-FREQUENCY QUERY INDEXES (Medium Priority)
// ============================================================================

/**
 * REGULAR INDEX: accountStatus
 * 
 * Purpose: Filter active/blocked accounts
 * Selectivity: HIGH (only 2 values: active/blocked)
 * Performance Impact:
 *   - Query: db.collection.find({ accountStatus: 'active' })
 *   - Without index: Full collection scan (slow for millions of users)
 *   - With index: Fast filtered results
 * Write Impact: Minimal (account status rarely changes)
 * Use Cases:
 *   - Login authentication (deny blocked users)
 *   - Admin dashboards (count active users)
 *   - Bulk operations on active accounts
 */
userSchema.index({ accountStatus: 1 });

/**
 * REGULAR INDEX: isEmailVerified
 * 
 * Purpose: Segment verified vs unverified users
 * Selectivity: HIGH (binary: true/false)
 * Performance Impact:
 *   - Query: db.collection.find({ isEmailVerified: true })
 *   - Find unverified users for email reminder jobs
 * Write Impact: Minimal (typically set once during lifecycle)
 * Use Cases:
 *   - Admin reports on verification rates
 *   - Scheduled jobs to resend verification emails
 *   - Restrict feature access to unverified users
 */
userSchema.index({ isEmailVerified: 1 });

/**
 * REGULAR INDEX: role
 * 
 * Purpose: Role-based access control (RBAC) queries
 * Selectivity: MEDIUM (typically 2-3 values: user/admin)
 * Performance Impact:
 *   - Query: db.collection.find({ role: 'admin' })
 *   - Admin dashboards and admin-only features
 * Write Impact: Minimal (role rarely changes)
 * Use Cases:
 *   - Find all admins for permissions check
 *   - Admin-only operations
 *   - Audit trails for admin actions
 */
userSchema.index({ role: 1 });

/**
 * REGULAR INDEX: createdAt (Descending)
 * 
 * Purpose: Time-series queries and sorting
 * Performance Impact:
 *   - Query: db.collection.find().sort({ createdAt: -1 }).limit(20)
 *   - Recent user registrations (dashboards)
 *   - User growth analytics
 * Write Impact: Minimal (immutable field)
 * Use Cases:
 *   - Paginated user lists sorted by newest first
 *   - Time-range queries: db.collection.find({ createdAt: { $gte: date } })
 *   - Growth metrics and analytics
 */
userSchema.index({ createdAt: -1 });

/**
 * REGULAR INDEX: lastLogin (Descending)
 * 
 * Purpose: Activity tracking and inactive user detection
 * Performance Impact:
 *   - Query: db.collection.find({ lastLogin: { $lt: thirtyDaysAgo } })
 *   - Find inactive users for notifications
 * Write Impact: SIGNIFICANT (updated on every login - consider Trade-off)
 * Use Cases:
 *   - Identify inactive accounts
 *   - Activity reports for security team
 *   - Churn analysis
 * 
 * ⚠️ TRADE-OFF WARNING: This index is updated frequently (on every login)
 *    For high-traffic applications, consider:
 *    1. Remove this index if login performance is critical
 *    2. Update lastLogin asynchronously
 *    3. Use separate activity collection instead
 */
userSchema.index({ lastLogin: -1 });

// ============================================================================
// TIER 3: COMPOUND INDEXES (Optional - For Common Query Combinations)
// ============================================================================

/**
 * COMPOUND INDEX: (accountStatus, role)
 * 
 * Purpose: Efficient queries filtering by status AND role
 * When to use:
 *   - Query: db.collection.find({ accountStatus: 'active', role: 'admin' })
 *   - Find active admins for permission checks
 * 
 * Performance: Single compound index is more efficient than two separate indexes
 * Disk Cost: ~15% of collection size
 * 
 * Note: Comment out if query volume doesn't justify the overhead
 * Uncomment only after profiling shows this query is frequent:
 */
// userSchema.index({ accountStatus: 1, role: 1 });

/**
 * COMPOUND INDEX: (isEmailVerified, accountStatus)
 * 
 * Purpose: Find verified active users
 * Common Query:
 *   - db.collection.find({ isEmailVerified: true, accountStatus: 'active' })
 *   - Grant access to verified active accounts
 * 
 * Note: Similar trade-off as above. Enable only if this query is frequent.
 */
// userSchema.index({ isEmailVerified: 1, accountStatus: 1 });

// ============================================================================
// ❌ WHY WE DON'T INDEX PASSWORD
// ============================================================================
/*
 * SECURITY & PERFORMANCE REASONS:
 * 
 * 1. HASHED PASSWORDS ARE UNIQUE
 *    - Each password is hashed differently (due to salt)
 *    - Even identical passwords hash differently
 *    - Index would never be used for duplicate lookups
 *    - Zero performance benefit
 * 
 * 2. PASSWORDS ARE NEVER QUERIED
 *    - You NEVER do: db.collection.findOne({ password: '...' })
 *    - Authentication uses comparePassword() function instead
 *    - Queries would be dangerous security vulnerability
 * 
 * 3. SECURITY CONCERNS
 *    - Indexes are exposed in MongoDB admin tools
 *    - More data exposed = larger attack surface
 *    - Hashed password bytes stored in index increases memory footprint
 *    - Potential for side-channel attacks if index stats are exposed
 * 
 * 4. PERFORMANCE OVERHEAD
 *    - Index wastes ~10-15% of collection size
 *    - Slows down every insert/update/delete operation
 *    - MongoDB must maintain index for every new user
 *    - Zero query speed improvement (passwords never queried)
 * 
 * 5. SELECT: FALSE BEST PRACTICE
 *    - We already exclude password from all queries by default
 *    - { select: false } prevents accidental exposure
 *    - Indexing contradicts this security practice
 */

// ============================================================================
// PERFORMANCE IMPLICATIONS SUMMARY
// ============================================================================
/*
 * COLLECTION-LEVEL IMPACT (assuming 1M users):
 * 
 * Current Index Strategy:
 * - Total index size: ~200-250 MB (15% of collection)
 * - Disk space: Base collection 1.5GB + 250MB indexes = 1.75GB
 * - Memory (hot working set): All active indexes kept in RAM
 * 
 * WRITE PERFORMANCE:
 * - Inserts: 5-7 indexes to update per write (5-10% slower per index)
 * - Updates: Depends on which fields updated
 * - Deletes: All indexes must be updated (5-10% slower per index)
 * 
 * READ PERFORMANCE:
 * - With indexes: 50-1000x faster than collection scans
 * - Query on indexed field: O(log n) vs O(n) full scan
 * - Large result sets: Sorting benefit (no in-memory sort needed)
 * 
 * OPTIMIZATION RECOMMENDATIONS:
 * 1. Monitor login times (email/username queries most frequent)
 * 2. Profile lastLogin updates - may cause bottleneck
 * 3. Consider turning off lastLogin index if write-heavy
 * 4. Add compound indexes only after profiling identifies need
 * 5. Regularly review index usage with MongoDB profiler
 * 6. Drop unused indexes quarterly
 */

/**
 * Pre-save middleware for password hashing
 * 
 * Executes BEFORE the document is saved to MongoDB
 * Responsible for:
 * 1. Detecting if password field has been modified
 * 2. Hashing the plain text password
 * 3. Preventing double hashing of already hashed passwords
 */
userSchema.pre('save', async function(next) {
  /**
   * Check if password field has been modified in this document
   * 
   * Why this check is critical:
   * - First save: password field exists and is new → hash it
   * - Update username/email only: password exists but wasn't modified → skip hashing
   * - Without this check: would hash already hashed password again (BREAKS LOGIN)
   * 
   * isModified() returns:
   * - true: password was changed in current operation
   * - false: password wasn't touched (no need to hash)
   */
  if (!this.isModified('password')) {
    return next();
  }

  /**
   * BCRYPT CONFIGURATION
   * 
   * Salt rounds parameter:
   * - Higher rounds = stronger security but slower hashing
   * - Industry standard: 10-12 rounds
   * - 10 rounds: ~100ms on modern CPU
   * - 12 rounds: ~250ms on modern CPU
   * - Production recommendation: Use 12 for user passwords
   * 
   * Trade-off:
   * - Security: Each additional round = 2x harder to brute force
   * - Performance: Each round adds ~100ms latency
   * - Balance: 10-12 is optimal (strong enough, still responsive)
   */
  const SALT_ROUNDS = 10;

  try {
    /**
     * bcrypt.genSalt(rounds, callback)
     * 
     * Generates a cryptographic salt (random value added to password before hashing)
     * 
     * Purpose of salt:
     * - Prevents rainbow table attacks (precomputed hashes)
     * - Makes identical passwords hash differently
     * - Example: password "123456" might hash to different values each time
     * 
     * Why async:
     * - Cryptographic operations block the event loop
     * - genSalt can take 100-200ms depending on salt rounds
     * - Async/await prevents blocking other requests
     */
    const salt = await bcrypt.genSalt(SALT_ROUNDS);

    /**
     * bcrypt.hash(data, salt, callback)
     * 
     * Hashes password + salt combination
     * 
     * Process:
     * 1. Takes plain text password (this.password)
     * 2. Combines with salt (salts are prepended to hash automatically)
     * 3. Runs hashing algorithm multiple times (SALT_ROUNDS iterations)
     * 4. Returns: salt + hashed password as single string
     * 
     * Result format: $2a$10$...hash... (includes algorithm, rounds, salt, and hash)
     * 
     * Why bcrypt.hash() instead of manual approach:
     * - Bcrypt automatically includes salt in output
     * - Bcrypt handles timing attack resistance
     * - Bcrypt outputs in standard format for later comparison
     */
    this.password = await bcrypt.hash(this.password, salt);

    /**
     * Call next() middleware to proceed to document save
     * 
     * Flow:
     * 1. Hash completed successfully
     * 2. this.password now contains hashed value
     * 3. next() passes control to MongoDB save operation
     * 4. Hashed password is persisted to database
     */
    next();
  } catch (error) {
    /**
     * Error handling for hashing failure
     * 
     * Possible errors:
     * - genSalt fails: System entropy insufficient (rare)
     * - hash fails: Invalid input or bcrypt module issue
     * - Memory errors: Computer running out of memory
     * 
     * Pass error to Express error middleware via next(error)
     * This prevents silent failures and informs user of registration issue
     */
    next(error);
  }
});

/**
 * Instance method: comparePassword()
 * 
 * Called on User instance to verify login credentials
 * Example usage: const isMatch = await user.comparePassword(plaintextPassword);
 * 
 * @param {string} plaintextPassword - The plain text password provided by user (e.g., from login form)
 * @returns {Promise<boolean>} - true if password matches stored hash, false otherwise
 */
userSchema.methods.comparePassword = async function(plaintextPassword) {
  /**
   * bcrypt.compare(plaintext, hash, callback)
   * 
   * Safely compares plain text password with stored hash
   * 
   * How it works:
   * 1. Takes plain text password user submitted
   * 2. Extracts salt from stored hash (salt is embedded in hash string)
   * 3. Hashes the plain text using extracted salt
   * 4. Compares the newly computed hash with stored hash
   * 5. Returns true if they match, false otherwise
   * 
   * Why NOT compare plain strings:
   * ❌ Wrong: if (plaintextPassword === this.password) - exposes plaintext comparison
   * ✅ Right: use bcrypt.compare() - timing-safe comparison
   * 
   * Timing-safe comparison:
   * - bcrypt.compare() uses constant-time comparison
   * - Prevents timing attacks that could leak password length/content
   * - Attacker cannot measure comparison time to deduce password
   */
  try {
    /**
     * Perform async comparison
     * 
     * Parameters:
     * - plaintextPassword: What user typed in login form
     * - this.password: The stored bcrypt hash from database
     * 
     * this refers to current user document instance
     * Since we used select: false on password field, must explicitly select it
     * before calling this method (see usage example below)
     */
    const isPasswordMatch = await bcrypt.compare(
      plaintextPassword,
      this.password
    );

    /**
     * Return result of comparison
     * 
     * Usage in authentication controller:
     * const user = await User.findOne({ email }).select('+password');
     * const isMatch = await user.comparePassword(req.body.password);
     * 
     * if (isMatch) {
     *   // Login successful - generate JWT
     * } else {
     *   // Login failed - password incorrect
     * }
     */
    return isPasswordMatch;
  } catch (error) {
    /**
     * Error handling for comparison failure
     * 
     * Possible errors:
     * - Invalid hash format: Corrupted password in database
     * - bcrypt module error: Library malfunction
     * 
     * Throw error to be caught by auth controller
     * Do not silently return false (that would allow any login if bcrypt fails)
     */
    throw new Error(`Password comparison error: ${error.message}`);
  }
};

/**
 * Usage Example in Authentication Controller:
 * 
 * // During user registration:
 * const user = new User({
 *   email: 'user@example.com',
 *   password: 'plainTextPassword123', // Pre-save middleware will hash this
 *   username: 'john_doe'
 * });
 * await user.save(); // Password automatically hashed by pre-save middleware
 * 
 * // During login:
 * const user = await User.findOne({ email: 'user@example.com' }).select('+password');
 * // .select('+password') needed because password has select: false
 * 
 * const isPasswordCorrect = await user.comparePassword(req.body.password);
 * 
 * if (isPasswordCorrect) {
 *   // Generate JWT token
 *   const token = jwt.sign({ userId: user._id }, JWT_SECRET);
 * } else {
 *   // Reject login
 *   res.status(401).json({ error: 'Invalid credentials' });
 * }
 */

/**
 * Static Methods (commented - implement in auth service)
 * 
 * Recommended methods:
 * - findByEmail(email): Find user by email
 * - findByUsername(username): Find user by username
 * - findActiveUsers(): Find all active users
 */

/**
 * Virtual Fields (commented - add as needed)
 * 
 * Example:
 * userSchema.virtual('isActive').get(function() {
 *   return this.accountStatus === 'active' && this.isEmailVerified;
 * });
 */

const User = mongoose.model('User', userSchema);

export default User;
