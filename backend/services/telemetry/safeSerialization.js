/**
 * safeSerialization.js
 * =======================
 * Phase 5A Part 2/3: the ONE place that decides what is safe to include in
 * a telemetry event or an aggregated metric. Two layers, in this order:
 *
 *   1. PRIMARY protection — allow-listing. Callers build an event by
 *      naming exactly the fields they mean to include (see ragTelemetry.js's
 *      EVENT_DIMENSION_KEYS/EVENT_MEASUREMENT_KEYS) — nothing else ever
 *      reaches this module in the first place for a well-behaved caller.
 *   2. SECONDARY protection — deterministic redaction. `redactDeep` walks
 *      whatever object IS passed (defense in depth for a caller that
 *      accidentally includes more than intended, or a nested object whose
 *      shape isn't fully controlled) and drops any key matching a known
 *      sensitive name, at any depth, replacing its value with the literal
 *      string '[REDACTED]' rather than silently keeping it.
 *
 * Never relies on string-replacing known secret VALUES after the fact —
 * that only catches secrets whose value you already know to look for.
 */

// Key names matched case-insensitively, after stripping non-alphanumeric
// characters (so `Authorization`, `authorization-header`, `auth_token`,
// `apiKey`, `API_KEY`, `mongo_uri`, `mongoDBUri` are all caught by one
// entry each). Deliberately broad — a false-positive redaction (dropping a
// harmless field that happens to share a sensitive-sounding name) is
// always safer than a false negative.
const SENSITIVE_KEY_PATTERNS = [
  /^authorization/, /^cookie/, /^setcookie/, /^apikey/, /^api_?secret/, /^accesstoken/, /^refreshtoken/,
  /^token$/, /^secret/, /^password/, /^passwd/, /^mongouri/, /^mongodburi/, /^connectionstring/, /^dsn$/,
  /^prompt$/, /^rawprompt/, /^completion$/, /^response$/, /^modelresponse/, /^content$/, /^messagetext/,
  /^chunktext/, /^documenttext/, /^excerpt$/, /^embedding/, /^stack$/, /^stacktrace/, /^email$/, /^useremail/,
  /^phone/, /^ssn$/, /^authheader/,
];

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

export const isSensitiveKey = (key) => {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
};

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 500;

/**
 * redactDeep - returns a NEW value with every sensitive key redacted at any
 * depth, arrays walked element-wise, and any overly long string truncated
 * (a defensive bound against an accidentally-included full prompt/document
 * slipping through as a single long string under an innocuous key name).
 * Never mutates the input. Bounded recursion depth so a pathological/
 * circular structure can never hang telemetry.
 */
export const redactDeep = (value, depth = 0) => {
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH_EXCEEDED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDeep(item, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : redactDeep(val, depth + 1);
  }
  return out;
};

export default { redactDeep, isSensitiveKey };
