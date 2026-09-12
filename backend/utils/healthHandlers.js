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
 */

export const mongoStateLabel = (readyState) => (
  { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[readyState] || 'unknown'
);

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
 */
export const createReadinessHandler = ({
  getMongoReadyState, mongoAttempted = () => true, getMongoLastError = () => null, getRedisClient = () => null,
}) => (req, res) => {
  const mongoState = getMongoReadyState();
  const mongoOk = mongoState === 1;
  let redisClient = null;
  try { redisClient = getRedisClient(); } catch { redisClient = null; }
  const redisOk = Boolean(redisClient && redisClient.isOpen);

  res.status(mongoOk ? 200 : 503).json({
    success: mongoOk,
    status: mongoOk ? 'ready' : 'starting',
    mongo: mongoStateLabel(mongoState),
    mongoAttempted: mongoAttempted(),
    mongoLastError: mongoOk ? null : getMongoLastError(),
    redis: redisOk ? 'connected' : 'unavailable',
    uptime: process.uptime(),
  });
};

export default { livenessHandler, createReadinessHandler, mongoStateLabel };
