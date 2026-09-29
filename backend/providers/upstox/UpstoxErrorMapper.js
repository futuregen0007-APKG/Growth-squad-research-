import { AppError } from '../../utils/errorHandler.js';

/**
 * UpstoxErrorMapper - translates axios/network errors from the Upstox
 * Company Fundamentals API into project-level AppErrors with a stable
 * `errorCode`. Mirrors providers/indian-api/IndianApiErrorMapper.js exactly
 * so callers (and the frontend) get the same shape from either provider.
 *
 * Upstox's documented error envelope is
 * `{ status: 'error', errors: [{ errorCode, message, ... }] }` (or the code
 * inlined at the top level in some responses) — `UDAPI1206` specifically
 * means an invalid ISIN. The Authorization bearer token is never included
 * in any log or error payload produced here.
 */
export const UPSTOX_ERROR_CODES = Object.freeze({
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_ISIN: 'INVALID_ISIN',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
});

const HTTP_STATUS_FOR = {
  CONFIGURATION_ERROR: 500,
  AUTHENTICATION_ERROR: 401,
  RATE_LIMITED: 429,
  INVALID_ISIN: 422,
  NOT_FOUND: 404,
  TIMEOUT: 504,
  UPSTREAM_UNAVAILABLE: 503,
  INVALID_RESPONSE: 502,
};

// UDAPI1206 is Upstox's documented code for an invalid/unknown ISIN.
const UPSTOX_BODY_ERROR_CODE_MAP = { UDAPI1206: 'INVALID_ISIN' };

const upstreamMessage = (error) => {
  const body = error?.response?.data;
  if (body && typeof body === 'object') {
    const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
    return String(firstError?.message || body.message || body.error || '').slice(0, 300) || null;
  }
  if (typeof body === 'string') return body.slice(0, 300);
  return null;
};

const upstreamBodyErrorCode = (error) => {
  const body = error?.response?.data;
  if (!body || typeof body !== 'object') return null;
  const firstError = Array.isArray(body.errors) ? body.errors[0] : null;
  return firstError?.errorCode || body.errorCode || body.error_code || null;
};

export class UpstoxError extends AppError {
  constructor(errorCode, message) {
    super(message, HTTP_STATUS_FOR[errorCode] || 502, errorCode);
    this.name = 'UpstoxError';
  }
}

/**
 * mapUpstoxError - classify an axios error (or a manually constructed
 * situation like missing config) into an UpstoxError.
 */
export const mapUpstoxError = (error, { operation = 'request' } = {}) => {
  if (!error) {
    return new UpstoxError(UPSTOX_ERROR_CODES.UPSTREAM_UNAVAILABLE, `Upstox ${operation} failed for an unknown reason`);
  }

  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    return new UpstoxError(UPSTOX_ERROR_CODES.TIMEOUT, `Upstox ${operation} timed out`);
  }

  const status = error.response?.status;
  const detail = upstreamMessage(error);
  const bodyErrorCode = upstreamBodyErrorCode(error);

  if (bodyErrorCode && UPSTOX_BODY_ERROR_CODE_MAP[bodyErrorCode]) {
    const mappedCode = UPSTOX_BODY_ERROR_CODE_MAP[bodyErrorCode];
    return new UpstoxError(UPSTOX_ERROR_CODES[mappedCode], `Upstox rejected ${operation}: invalid ISIN${detail ? ` (${detail})` : ''}`);
  }
  if (status === 401 || status === 403) {
    return new UpstoxError(UPSTOX_ERROR_CODES.AUTHENTICATION_ERROR, `Upstox rejected the access token during ${operation}${detail ? `: ${detail}` : ''}`);
  }
  if (status === 404) {
    return new UpstoxError(UPSTOX_ERROR_CODES.NOT_FOUND, `Upstox ${operation} found no matching record${detail ? `: ${detail}` : ''}`);
  }
  if (status === 429) {
    return new UpstoxError(UPSTOX_ERROR_CODES.RATE_LIMITED, `Upstox rate limit hit during ${operation}${detail ? `: ${detail}` : ''}`);
  }
  if (status === 400 || status === 422) {
    return new UpstoxError(UPSTOX_ERROR_CODES.INVALID_RESPONSE, `Upstox rejected the ${operation} request${detail ? `: ${detail}` : ''}`);
  }
  if (status && status >= 500) {
    return new UpstoxError(UPSTOX_ERROR_CODES.UPSTREAM_UNAVAILABLE, `Upstox ${operation} failed upstream (HTTP ${status})${detail ? `: ${detail}` : ''}`);
  }
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
    return new UpstoxError(UPSTOX_ERROR_CODES.UPSTREAM_UNAVAILABLE, `Upstox ${operation} was unreachable (${error.code})`);
  }

  return new UpstoxError(UPSTOX_ERROR_CODES.UPSTREAM_UNAVAILABLE, `Upstox ${operation} failed: ${error.message || 'unknown error'}`);
};

export default mapUpstoxError;
