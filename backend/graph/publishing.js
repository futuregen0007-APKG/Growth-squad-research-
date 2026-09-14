/**
 * publishing.js
 * ===============
 * Shared by nodes/publishFinalAnswer.js and nodes/buildSafeFallback.js —
 * the only two nodes that ever emit a `token` event, and both need the
 * exact same "bounded chunks, not raw per-delta streaming" behavior (see
 * publishFinalAnswer.js's module note on why token events moved here in
 * Phase 3).
 */

// Characters per emitted `token` event.
export const PUBLISH_CHUNK_SIZE = 40;

export const emitInChunks = (onEvent, text) => {
  if (!onEvent || !text) return;
  for (let i = 0; i < text.length; i += PUBLISH_CHUNK_SIZE) {
    onEvent({ type: 'token', token: text.slice(i, i + PUBLISH_CHUNK_SIZE) });
  }
};

export default { PUBLISH_CHUNK_SIZE, emitInChunks };
