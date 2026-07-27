/**
 * ERROR_HANDLER.JS
 * ================
 * Centralized error handling for consistent error responses across the entire API.
 * 
 * WHY THIS FILE EXISTS:
 * - Ensures all errors are formatted consistently
 * - Makes client-side error handling predictable
 * - Single place to modify error response structure
 * - Includes proper HTTP status codes and error codes
 * 
 * ARCHITECTURE:
 * 1. AppError class extends Error for structured error handling
 * 2. Handler function formats errors for API responses
 * 3. Middleware catches all errors and passes to handler
 */

import { ERROR_CODES, HTTP_STATUS } from './constants.js';

/**
 * AppError - Custom error class for application-specific errors
 * 
 * EXAMPLE:
 * throw new AppError('Stock not found', 404, 'NOT_FOUND');
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * formatErrorResponse - Converts error to API response format
 * 
 * INPUT: Error object
 * OUTPUT: {
 *   success: false,
 *   error: {
 *     message: string,
 *     code: string,
 *     statusCode: number,
 *     timestamp: ISO string
 *   }
 * }
 * 
 * WHY STRUCTURED:
 * - Consistent format clients can rely on
 * - Includes error code for programmatic handling
 * - Timestamp helps with debugging
 */
export const formatErrorResponse = (error) => {
  if (error instanceof AppError) {
    return {
      success: false,
      error: {
        message: error.message,
        code: error.errorCode,
        statusCode: error.statusCode,
        timestamp: error.timestamp,
      },
    };
  }

  // Unknown error - fallback to generic 500 error
  return {
    success: false,
    error: {
      message: error?.message || 'An unexpected error occurred',
      code: ERROR_CODES.INTERNAL_ERROR,
      statusCode: HTTP_STATUS.INTERNAL_ERROR,
      timestamp: new Date().toISOString(),
    },
  };
};

/**
 * getHttpStatus - Gets appropriate HTTP status code for error
 * 
 * Used when sending error response to client
 */
export const getHttpStatus = (error) => {
  if (error instanceof AppError) {
    return error.statusCode;
  }
  return HTTP_STATUS.INTERNAL_ERROR;
};

/**
 * Common error factory functions
 * Make error creation consistent and semantic
 */

export const createNotFoundError = (resource, identifier) => {
  return new AppError(
    `${resource} '${identifier}' not found`,
    HTTP_STATUS.NOT_FOUND,
    ERROR_CODES.NOT_FOUND
  );
};

export const createInvalidInputError = (message) => {
  return new AppError(
    message,
    HTTP_STATUS.BAD_REQUEST,
    ERROR_CODES.INVALID_INPUT
  );
};

export const createProviderError = (providerName, message) => {
  return new AppError(
    `Error from ${providerName}: ${message}`,
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    ERROR_CODES.PROVIDER_ERROR
  );
};

export const createCacheError = (message) => {
  return new AppError(
    `Cache error: ${message}`,
    HTTP_STATUS.INTERNAL_ERROR,
    ERROR_CODES.CACHE_ERROR
  );
};
