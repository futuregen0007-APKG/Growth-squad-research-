/**
 * safeReasons.js
 * ===============
 * The ONLY user-facing failure-reason strings GS Copilot's tool layer ever
 * surfaces. A raw provider error message (IndianAPI/Angel One/OpenAI SDK
 * text, stack traces, upstream JSON bodies) must NEVER reach the model
 * prompt or the client — this module maps every known internal error code
 * onto one of a small, fixed set of safe, honest phrases instead.
 */

export const SAFE_REASONS = Object.freeze({
  PROVIDER_UNAVAILABLE: 'Provider unavailable',
  DATA_NOT_AVAILABLE_FOR_PERIOD: 'Data not available for requested period',
  COMPANY_NOT_RESOLVED: 'Company could not be resolved',
  EVIDENCE_SOURCE_UNAVAILABLE: 'Evidence source unavailable',
  CAPABILITY_NOT_SUPPORTED: 'Capability not yet supported',
});

// Internal error codes (from IndianApiErrorMapper, OpenAIClientFactory's
// errors.js, and CompanyResearchService's errorPayload) that mean
// "the provider/infrastructure itself failed" — never the caller's fault,
// never a sign the data genuinely doesn't exist.
const PROVIDER_UNAVAILABLE_CODES = new Set([
  'AUTHENTICATION_ERROR', 'PLAN_OR_BASE_URL_ERROR', 'CONFIGURATION_ERROR',
  'RATE_LIMITED', 'TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'INVALID_RESPONSE',
  'UPSTREAM_ERROR', // OpenAI-side equivalent
]);

/**
 * classifyErrorCode - maps one internal error code to { toolStatus, reason }.
 * Used wherever a tool/section needs to turn a provider's real error code
 * into the safe, user-facing pair. Returns null for an unrecognized code
 * (caller falls back to a generic ERROR/PROVIDER_UNAVAILABLE pairing).
 */
export const classifyErrorCode = (errorCode) => {
  if (!errorCode) return null;
  if (errorCode === 'UNSUPPORTED_CAPABILITY') {
    return { toolStatus: 'UNSUPPORTED', reason: SAFE_REASONS.CAPABILITY_NOT_SUPPORTED };
  }
  if (errorCode === 'NOT_FOUND') {
    return { toolStatus: 'EMPTY', reason: SAFE_REASONS.COMPANY_NOT_RESOLVED };
  }
  if (PROVIDER_UNAVAILABLE_CODES.has(errorCode)) {
    return { toolStatus: 'UNAVAILABLE', reason: SAFE_REASONS.PROVIDER_UNAVAILABLE };
  }
  return null;
};

export default { SAFE_REASONS, classifyErrorCode };
