import { AppError } from '../utils/errorHandler.js';

/**
 * OPENAI_ERROR_CODES - controlled error codes GS Copilot maps every OpenAI
 * SDK failure onto. Never expose the raw SDK error, request headers, or API
 * key to the browser — only these codes and a short, sanitized message.
 */
export const OPENAI_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'OPENAI_NOT_CONFIGURED',
  AUTHENTICATION_FAILED: 'OPENAI_AUTHENTICATION_FAILED',
  RATE_LIMITED: 'OPENAI_RATE_LIMITED',
  INSUFFICIENT_QUOTA: 'OPENAI_INSUFFICIENT_QUOTA',
  MODEL_UNAVAILABLE: 'OPENAI_MODEL_UNAVAILABLE',
  TIMEOUT: 'OPENAI_TIMEOUT',
  UPSTREAM_ERROR: 'OPENAI_UPSTREAM_ERROR',
});

const HTTP_STATUS_FOR = {
  [OPENAI_ERROR_CODES.NOT_CONFIGURED]: 503,
  [OPENAI_ERROR_CODES.AUTHENTICATION_FAILED]: 502,
  [OPENAI_ERROR_CODES.RATE_LIMITED]: 429,
  [OPENAI_ERROR_CODES.INSUFFICIENT_QUOTA]: 402,
  [OPENAI_ERROR_CODES.MODEL_UNAVAILABLE]: 503,
  [OPENAI_ERROR_CODES.TIMEOUT]: 504,
  [OPENAI_ERROR_CODES.UPSTREAM_ERROR]: 502,
};

export class OpenAIServiceError extends AppError {
  constructor(code, message) {
    super(message, HTTP_STATUS_FOR[code] || 502, code);
    this.name = 'OpenAIServiceError';
  }
}

/**
 * mapOpenAIError - classifies an error thrown by the `openai` SDK (v6) into
 * an OpenAIServiceError. Verified against the SDK's actual exported error
 * classes (AuthenticationError, RateLimitError, NotFoundError,
 * BadRequestError, APIConnectionTimeoutError, InternalServerError,
 * PermissionDeniedError) rather than guessed.
 */
export const mapOpenAIError = (error, { operation = 'request' } = {}) => {
  if (!error) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.UPSTREAM_ERROR, `OpenAI ${operation} failed for an unknown reason`);
  }

  const name = error.name || error.constructor?.name;
  const status = error.status;
  const code = error.code || error.error?.code;
  const type = error.error?.type || error.type;

  if (name === 'APIUserAbortError' || error.message === 'Request was aborted.') {
    // Not a failure — the caller (or the client disconnecting) requested this.
    const abortError = new Error('Request aborted');
    abortError.isAbort = true;
    return abortError;
  }

  if (name === 'APIConnectionTimeoutError' || code === 'ETIMEDOUT' || /timeout/i.test(error.message || '')) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.TIMEOUT, `OpenAI ${operation} timed out`);
  }

  if (name === 'AuthenticationError' || status === 401) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.AUTHENTICATION_FAILED, 'OpenAI rejected the configured API key');
  }

  if (name === 'PermissionDeniedError' || status === 403) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.AUTHENTICATION_FAILED, 'OpenAI denied permission for this request');
  }

  if (status === 429 && (code === 'insufficient_quota' || type === 'insufficient_quota')) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.INSUFFICIENT_QUOTA, 'OpenAI account has insufficient quota');
  }

  if (name === 'RateLimitError' || status === 429) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.RATE_LIMITED, 'OpenAI rate limit reached — please retry shortly');
  }

  if (code === 'model_not_found' || (name === 'NotFoundError' && /model/i.test(error.message || ''))) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.MODEL_UNAVAILABLE, `The configured OpenAI model is not available on this account (${operation})`);
  }

  if (name === 'BadRequestError' && /model/i.test(error.message || '')) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.MODEL_UNAVAILABLE, `The configured OpenAI model was rejected as invalid (${operation})`);
  }

  if (name === 'InternalServerError' || name === 'APIConnectionError' || (status && status >= 500)) {
    return new OpenAIServiceError(OPENAI_ERROR_CODES.UPSTREAM_ERROR, `OpenAI ${operation} failed upstream`);
  }

  return new OpenAIServiceError(OPENAI_ERROR_CODES.UPSTREAM_ERROR, `OpenAI ${operation} failed: ${error.message || 'unknown error'}`);
};

export default mapOpenAIError;
