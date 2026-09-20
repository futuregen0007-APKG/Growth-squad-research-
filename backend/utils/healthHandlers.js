/**
 * healthHandlers.js
 * ===================
 * Pure, dependency-injected Express handlers for the liveness (/health) and
 * readiness (/ready) endpoints, split out of server.js so they can be unit-
 * tested directly (with a tiny express() app + supertest) without importing
 * the real server.js -- which has import-time side effects (dotenv, real
 * route mounting, provider construction, app.listen) that make it
 * impractical to instantiate in a test.
 *
 * Liveness never touches Mongo/Redis -- it only proves the Node process is
 * up and Express is handling requests. Readiness reports on already-tracked,
 * in-memory dependency state (never a live query/ping), so it always
 * answers instantly and can never itself hang the health check it exists
 * to provide.
 *
 * Phase 5B: /ready additionally reports a three-state `readiness` verdict
 * and the per-dependency snapshot, without changing liveness semantics and
 * without changing which states are served vs. taken out of rotation:
 *
 *   - /health is untouched. It is liveness and nothing else: 200 as long as
 *     the process is running. It must never gain a dependency check, or a
 *     dependency outage would get pods KILLED rather than drained.
 *   - /ready keeps its existing gate exactly: Mongo connected -> 200/'ready',
 *     anything else -> 503/'starting'. The new `readiness` field names which
 *     of the three states that is ('ready' | 'degraded' | 'unavailable'),
 *     so "still connecting" is distinguishable from "gone" — which the
 *     previous single 'starting' label could not express.
 *   - The per-dependency snapshot is REPORTING ONLY and deliberately does
 *     not drive the HTTP code. An optional dependency (Redis, Atlas) has
 *     never affected readiness and still does not; and a missing OpenAI key
 *     must not pull an instance out of rotation, since every non-chat route
 *     keeps working without it. Letting it do so would turn one missing
 *     env var into a total outage.
 *
 * SECRETS AND INTERNAL DETAIL: this endpoint is typically reachable by
 * anything that can reach the service, so it carries no credentials, no
 * connection strings, and — in production — no raw internal error text.
 * `mongoLastError` is a driver message that can contain host, port, and
 * replica-set topology, so in production it is replaced by a bounded,
 * non-identifying reason code. Locally it stays verbatim, where it is the
 * fastest way to see why a dev machine is not connecting.
 */

export const mongoStateLabel = (readyState) => (
  { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[readyState] || 'unknown'
);

/**
 * readinessVerdict - the three states the goal asks /ready to distinguish,
 * derived from the one required dependency readiness has ever gated on.
 *   ready       - connected and serving
 *   degraded    - a required dependency is mid-transition (connecting or
 *                 disconnecting): not serveable yet, but not broken either
 *   unavailable - disconnected, or a state we cannot interpret
 */
export const readinessVerdict = (mongoReadyState) => {
  if (mongoReadyState === 1) return 'ready';
  if (mongoReadyState === 2 || mongoReadyState === 3) return 'degraded';
  return 'unavailable';
};

/**
 * publicErrorDetail - what a caller is allowed to learn about WHY a
 * dependency is not ready. In production, a bounded reason code; elsewhere,
 * the real message (useful locally, never exposed to the internet).
 */
export const publicErrorDetail = (rawError, { isProduction = process.env.NODE_ENV === 'production' } = {}) => {
  if (!rawError) return null;
  if (!isProduction) return rawError;
  return 'dependency unavailable — see server logs';
};

/** Liveness: must respond the instant Express is listening, regardless of any other dependency's state. */
export const livenessHandler = (req, res) => {
  res.status(200).json({ success: true, status: 'ok', uptime: process.uptime() });
};

/**
 * createReadinessHandler - `deps` are injected so tests can simulate any
 * combination of Mongo/Redis state without a real database or cache.
 * @param {object} deps
 * @param {() => number} deps.getMongoReadyState - mirrors mongoose.connection.readyState (0-3)
 * @param {() => boolean} deps.mongoAttempted - whether an initial connection attempt has started
 * @param {() => string|null} deps.getMongoLastError
 * @param {() => {isOpen: boolean}|null} deps.getRedisClient
 * @param {() => object} [deps.getDependencies] - Phase 5B: the telemetry dependency snapshot,
 *        injected rather than imported so this module stays pure and test-drivable.
 */
export const createReadinessHandler = ({
  getMongoReadyState, mongoAttempted = () => true, getMongoLastError = () => null, getRedisClient = () => null,
  getDependencies = null, isProduction = () => process.env.NODE_ENV === 'production',
}) => (req, res) => {
  const mongoState = getMongoReadyState();
  const mongoOk = mongoState === 1;
  let redisClient = null;
  try { redisClient = getRedisClient(); } catch { redisClient = null; }
  const redisOk = Boolean(redisClient && redisClient.isOpen);

  // Never let an optional reporting extra break the health check it is part
  // of: a snapshot that throws is simply omitted.
  let dependencies = null;
  if (getDependencies) {
    try { dependencies = getDependencies(); } catch { dependencies = null; }
  }

  res.status(mongoOk ? 200 : 503).json({
    success: mongoOk,
    status: mongoOk ? 'ready' : 'starting',
    // Phase 5B: the three-state verdict, alongside (not replacing) `status`.
    readiness: readinessVerdict(mongoState),
    mongo: mongoStateLabel(mongoState),
    mongoAttempted: mongoAttempted(),
    mongoLastError: mongoOk ? null : publicErrorDetail(getMongoLastError(), { isProduction: isProduction() }),
    redis: redisOk ? 'connected' : 'unavailable',
    ...(dependencies ? { dependencies } : {}),
    uptime: process.uptime(),
  });
};

export default {
  livenessHandler, createReadinessHandler, mongoStateLabel, readinessVerdict, publicErrorDetail,
};
