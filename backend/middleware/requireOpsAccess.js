/**
 * requireOpsAccess.js
 * ======================
 * Phase 5A Part 10: access control for the operational diagnostics
 * endpoint (GET /api/ops/rag-metrics). Reuses the EXISTING authentication
 * middleware (middleware/auth.js) and the EXISTING `role` field on
 * models/User.js (already 'user'|'admin', previously unused by any
 * route) — never a new, weaker auth mechanism, and never a query-string
 * secret.
 *
 * Behavior:
 *   - production (NODE_ENV === 'production'): disabled entirely unless
 *     RAG_METRICS_ENDPOINT_ENABLED=true is explicitly set AND the caller
 *     is an authenticated admin. Disabled/unauthenticated/non-admin all
 *     respond 404 — never revealing whether the route exists at all
 *     (the same "don't leak sub-path existence" posture this project's
 *     own chat auth middleware already uses).
 *   - development/test: reachable directly (no admin requirement) UNLESS
 *     RAG_METRICS_REQUIRE_AUTH=true is explicitly set, so a developer can
 *     opt into testing the production-like gate locally without needing a
 *     real admin account.
 */
import { authenticate } from './auth.js';

const isProduction = () => process.env.NODE_ENV === 'production';
const isExplicitlyEnabledInProduction = () => process.env.RAG_METRICS_ENDPOINT_ENABLED === 'true';
const devRequiresAuth = () => process.env.RAG_METRICS_REQUIRE_AUTH === 'true';

const notFound = (res) => res.status(404).json({ success: false, error: 'Route not found' });

/**
 * authenticate (middleware/auth.js) answers a FAILED authentication with
 * its own 401 body, written directly to the response — correct for every
 * ordinary route, but on this one a 401 would confirm the endpoint exists
 * to an unauthenticated caller, which is exactly what this module's 404
 * posture exists to prevent. Rather than duplicating (and risking drifting
 * from) auth.js's real token/user/account-status checks, we hand it a
 * minimal response stand-in that captures its rejection and converts it
 * into this module's own 404 on the real response. Only the failure path
 * is intercepted: on success, authenticate calls `next()` having already
 * set req.user/req.userId on the REAL request object, exactly as usual.
 */
const captureAuthFailure = (res) => ({
  status: () => ({ json: () => notFound(res) }),
});

export const requireOpsAccess = async (req, res, next) => {
  if (isProduction() && !isExplicitlyEnabledInProduction()) return notFound(res);

  if (!isProduction() && !devRequiresAuth()) return next();

  return authenticate(req, captureAuthFailure(res), (err) => {
    if (err) return next(err);
    if (req.user?.role !== 'admin') return notFound(res);
    return next();
  });
};

export default requireOpsAccess;
