/**
 * LOGGER.JS
 * ==========
 * Centralized logging utility for consistent log output across the application.
 * 
 * WHY THIS FILE EXISTS:
 * - Consistent log format makes debugging easier
 * - Can easily switch between console/file logging
 * - Single place to adjust log verbosity
 * - Includes timestamps and log levels
 * 
 * LOG LEVELS (in order of severity):
 * 1. error   - Something failed that needs attention
 * 2. warn    - Warning, may indicate future issues
 * 3. info    - Important information (app startup, connections)
 * 4. debug   - Detailed info for troubleshooting (cache hits, API calls)
 * 5. trace   - Very detailed debugging info
 */

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
  TRACE: 'TRACE',
};

// Current log level - adjust in .env or here
// In production: usually 'INFO' or 'WARN'
// In development: usually 'DEBUG'
const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL || 'DEBUG';

/**
 * shouldLog - Determines if message should be logged based on level
 * 
 * EXAMPLE: If CURRENT_LOG_LEVEL is 'INFO', then 'DEBUG' logs are skipped
 */
const shouldLog = (level) => {
  const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
  const currentIndex = levels.indexOf(CURRENT_LOG_LEVEL);
  const messageIndex = levels.indexOf(level);
  return messageIndex <= currentIndex;
};

/**
 * formatLog - Creates standardized log output
 * 
 * FORMAT: [TIMESTAMP] [LEVEL] Message
 * EXAMPLE: [2024-01-15 14:32:45] [INFO] Server started on port 5000
 */
const formatLog = (level, message) => {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] ${message}`;
};

/**
 * Logger object with methods for each log level
 */
export const logger = {
  /**
   * error - Log errors (highest priority)
   * Used for: Failed API calls, exceptions, critical issues
   */
  error: (message) => {
    if (shouldLog('ERROR')) {
      console.error(formatLog(LOG_LEVELS.ERROR, message));
    }
  },

  /**
   * warn - Log warnings
   * Used for: Deprecated features, potential issues, retries
   */
  warn: (message) => {
    if (shouldLog('WARN')) {
      console.warn(formatLog(LOG_LEVELS.WARN, message));
    }
  },

  /**
   * info - Log important information
   * Used for: Startup messages, connections, major events
   */
  info: (message) => {
    if (shouldLog('INFO')) {
      console.log(formatLog(LOG_LEVELS.INFO, message));
    }
  },

  /**
   * debug - Log debugging information
   * Used for: Cache hits/misses, function calls, data transforms
   */
  debug: (message) => {
    if (shouldLog('DEBUG')) {
      console.log(formatLog(LOG_LEVELS.DEBUG, message));
    }
  },

  /**
   * trace - Log very detailed information
   * Used for: Variable values, detailed flow info
   */
  trace: (message) => {
    if (shouldLog('TRACE')) {
      console.log(formatLog(LOG_LEVELS.TRACE, message));
    }
  },
};
