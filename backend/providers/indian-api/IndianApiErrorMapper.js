import { AppError } from '../../utils/errorHandler.js';

/**
 * IndianApiErrorMapper - translates axios/network errors from IndianAPI
 * into project-level AppErrors with a stable `errorCode`.
 *
 * IndianAPI does not publish a documented JSON error-body schema (verified
 * via their public docs/sandbox and community integrations as of Sep 2026),
 * so classification is driven by HTTP status code and axios error codes
 * rather than by parsing a specific error field name. The upstream message
 * (when present) is included for diagnostics but never a raw stack trace,
 * and the Authorization/x-api-key header is never included in any log or
 * error payload produced here.
 */
export const INDIAN_API_ERROR_CODES = Object.freeze({
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  PLAN_OR_BASE_URL_ERROR: 'PLAN_OR_BASE_URL_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
});

const HTTP_STATUS_FOR = {
  CONFIGURATION_ERROR: 500,
  AUTHENTICATION_ERROR: 401,
  PLAN_OR_BASE_URL_ERROR: 502,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  TIMEOUT: 504,
  UPSTREAM_UNAVAILABLE: 503,
  INVALID_RESPONSE: 502,
  UNSUPPORTED_CAPABILITY: 501,
};

const upstreamMessage = (error) => {
  const body = error?.response?.data;
  if (body && typeof body === 'object') {
    return String(body.message || body.detail || body.error || '').slice(0, 300) || null;
  }
  if (typeof body === 'string') return body.slice(0, 300);
  return null;
};

export class IndianApiError extends AppError {
  constructor(errorCode, message) {
    super(message, HTTP_STATUS_FOR[errorCode] || 502, errorCode);
    this.name = 'IndianApiError';
  }
}

/**
 * mapIndianApiError - classify an axios error (or a manually constructed
 * situation like missing config) into an IndianApiError.
 */
export const mapIndianApiError = (error, { operation = 'request' } = {}) => {
  if (!error) {
    return new IndianApiError(INDIAN_API_ERROR_CODES.UPSTREAM_UNAVAILABLE, `IndianAPI ${operation} failed for an unknown reason`);
  }

  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    return new IndianApiError(INDIAN_API_ERROR_CODES.TIMEOUT, `IndianAPI ${operation} timed out`);
  }

  const status = error.response?.status;
  const detail = upstreamMessage(error);

  if (status === 401 || status === 403) {
    return new IndianApiError(INDIAN_API_ERROR_CODES.AUTHENTICATION_ERROR, `IndianAPI rejected the API key during ${operation}${detail ? `: ${detail}` : ''}`);
  }
  if (status === 404) {
    return new IndianApiError(INDIAN_API_ERROR_CODES.NOT_FOUND, `IndianAPI ${operation} found no matching record${detail ? `: ${detail}` : ''}`);
  }
  if (status === 429) {
    return new IndianApiError(INDIAN_API_ERROR_CODES.RATE_LIMITED, `IndianAPI rate limit hit during ${operation}${detail ? `: ${detail}` : ''}`);
  }
  if (status === 400 || status === 422) {
    return new IndianApiError(INDIAN_API_ERROR_CODES.INVALID_RESPONSE, `IndianAPI rejected the ${operation} request${detail ? `: ${detail}` : ''}`);
  }
  if (status && status >= 500) {
    return new IndianApiError(INDIAN_API_ERROR_CODES.UPSTREAM_UNAVAILABLE, `IndianAPI ${operation} failed upstream (HTTP ${status})${detail ? `: ${detail}` : ''}`);
  }
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return new IndianApiError(INDIAN_API_ERROR_CODES.PLAN_OR_BASE_URL_ERROR, `IndianAPI base URL is unreachable during ${operation} — verify INDIAN_API_BASE_URL matches your plan`);
  }

  return new IndianApiError(INDIAN_API_ERROR_CODES.UPSTREAM_UNAVAILABLE, `IndianAPI ${operation} failed: ${error.message || 'unknown error'}`);
};

export default mapIndianApiError;
