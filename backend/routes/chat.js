import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { chatRateLimit } from '../middleware/chatRateLimit.js';
import {
  listUserThreads, createUserThread, getUserThread, renameUserThread, deleteUserThread, sendMessage, legacySendMessage,
} from '../controllers/ChatController.js';

const router = express.Router();

/**
 * Backward-compatible legacy contract: POST /api/chat { message } -> { reply }.
 * Unauthenticated, no thread/memory — preserved for any existing consumer
 * that hasn't migrated to the threaded API below. New frontend code should
 * use the threaded endpoints instead.
 */
router.post('/', legacySendMessage);

// Everything below requires authentication — GS Copilot's thread history,
// watchlist/portfolio tools, and long-term memory are all per-user. A
// dedicated sub-router (rather than router.use('/threads', authenticate))
// ensures every path here — including the /messages convenience route,
// which is NOT under /threads — is actually gated.
const authed = express.Router();
authed.use(authenticate);

authed.get('/threads', listUserThreads);
authed.post('/threads', createUserThread);
authed.get('/threads/:threadId', getUserThread);
authed.patch('/threads/:threadId', renameUserThread);
authed.delete('/threads/:threadId', deleteUserThread);

authed.post('/threads/:threadId/messages', chatRateLimit, sendMessage);
// Convenience: start a new thread and send the first message in one call.
authed.post('/messages', chatRateLimit, sendMessage);

router.use('/', authed);

export default router;
