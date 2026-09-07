import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * chatFrontendContract.test.js
 * ==============================
 * Static consistency checks between the frontend's URL-construction code
 * and the backend's declared routes — run without webpack/CRA (frontend/
 * src/config/api.js uses no JSX/browser APIs, but chatApi.js uses the `@`
 * webpack alias, which plain Node can't resolve; reading the source text
 * directly sidesteps that while still verifying the real, current files
 * on disk rather than a copy).
 */

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(backendDir, '..', '..');
const read = (relPath) => fs.readFileSync(path.join(repoRoot, relPath), 'utf8');

test('REACT_APP_API_BASE(_URL) is normalized to strip a trailing /api, so callers that append /api/... never produce /api/api', () => {
  const apiConfigSource = read('frontend/src/config/api.js');
  assert.match(apiConfigSource, /replace\(\/\\\/api\\\/\?\$\//, 'config/api.js must strip a trailing /api from the configured base URL');
});

test('chatApi.js constructs message-send URLs as `${API_BASE}${path}` where path always starts with /api/chat — never a bare /chat or a doubled /api/api', () => {
  const chatApiSource = read('frontend/src/services/chatApi.js');
  const pathAssignment = chatApiSource.match(/const path = .*/);
  assert.ok(pathAssignment, 'chatApi.js should build the send-message path in a single, greppable expression');
  assert.match(pathAssignment[0], /\/api\/chat\/threads\/\$\{threadId\}\/messages/);
  assert.match(pathAssignment[0], /\/api\/chat\/messages/);
  assert.doesNotMatch(pathAssignment[0], /\/api\/api\//);
  assert.doesNotMatch(pathAssignment[0], /\/chat\/chat\//);

  const fetchCall = chatApiSource.match(/fetch\(`\$\{API_BASE\}\$\{path\}`/);
  assert.ok(fetchCall, 'chatApi.js must build the fetch URL as `${API_BASE}${path}` — API_BASE must not already include /api (see config/api.js)');
});

test('every path chatApi.js sends a request to has a matching route actually declared in backend/routes/chat.js', () => {
  const chatApiSource = read('frontend/src/services/chatApi.js');
  const chatRouteSource = read('backend/routes/chat.js');

  // Frontend calls (relative to the API origin, always prefixed /api/chat/...).
  const frontendCalls = [...chatApiSource.matchAll(/apiClient\.(get|post|patch|delete)\('(\/api\/chat[^']*)'\)|apiClient\.(get|post|patch|delete)\(`(\/api\/chat[^`]*)`/g)]
    .map((m) => (m[2] || m[4]).replace(/\$\{[^}]+\}/g, ':param'));
  // Add the two POST paths built in `const path = ...` explicitly, since
  // those aren't apiClient.* calls (they're a raw fetch for streaming).
  frontendCalls.push('/api/chat/threads/:param/messages', '/api/chat/messages');

  // Routes actually declared in chat.js, normalized the same way + prefixed with the /api/chat mount point.
  const declaredRoutes = [...chatRouteSource.matchAll(/(?:router|authed)\.(get|post|patch|delete)\('([^']+)'/g)]
    .map((m) => `/api/chat${m[2] === '/' ? '' : m[2]}`.replace(/:\w+/g, ':param'));

  for (const call of frontendCalls) {
    assert.ok(
      declaredRoutes.includes(call),
      `frontend calls ${call} but backend/routes/chat.js declares no matching route. Declared: ${declaredRoutes.join(', ')}`,
    );
  }
});
