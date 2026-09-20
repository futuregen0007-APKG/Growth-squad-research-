/**
 * traceContext.js
 * =================
 * Phase 5A Part 2: trace/request identity for one chat turn.
 *
 * Distinct from the PRE-EXISTING `requestId` (see controllers/
 * ChatController.js's `uuidv4()` call, threaded into `state.requestId` and
 * already used for thread/message correlation, SSE event payloads, and
 * logDiagnostics.js) — `traceId` is a NEW, purely observability-scoped
 * identifier that MAY be supplied by the caller (a frontend or an upstream
 * proxy that already has its own trace id, e.g. from a load balancer) and
 * is validated strictly before being trusted. `requestId` keeps its
 * existing, unrelated meaning and code path untouched.
 */
import { v4 as uuidv4, validate as uuidValidate, version as uuidVersion } from 'uuid';

// Strict: must be a syntactically valid UUID (any RFC 4122 version) — never
// accepts an arbitrary caller-supplied string as a trace id, which would
// let a client inject unbounded-cardinality or adversarial content into
// every downstream log/metric that carries traceId.
export const isValidTraceId = (value) => {
  if (typeof value !== 'string' || value.length > 100) return false;
  return uuidValidate(value) && [1, 3, 4, 5].includes(uuidVersion(value));
};

/**
 * resolveTraceId - accepts a caller-supplied id only if it passes strict
 * validation; otherwise mints a fresh one. Never throws.
 */
export const resolveTraceId = (incoming) => (isValidTraceId(incoming) ? incoming : uuidv4());

// The exact incoming header name this project reads an upstream trace id
// from, and the header every response echoes it back on — one canonical
// name, so a caller/proxy has exactly one place to look either way.
export const TRACE_ID_HEADER = 'X-Trace-Id';

export default { isValidTraceId, resolveTraceId, TRACE_ID_HEADER };
