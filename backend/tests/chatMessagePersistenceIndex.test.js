import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import { createThread, appendAssistantMessage, appendUserMessage, getThread, deleteThread } from '../services/ChatThreadService.js';

/**
 * chatMessagePersistenceIndex.test.js
 * =======================================
 * UI Phase 1D: a confirmed, SEVERE live bug, found via a real multi-turn
 * browser session -- only the FIRST assistant reply in any thread
 * survived a reload; every later one was silently gone. Root cause: the
 * {threadId, clientMessageId} unique index was `sparse: true`, but every
 * assistant message had clientMessageId explicitly set to `null` (via the
 * model's old `default: null`) rather than genuinely omitted -- a sparse
 * index only skips a field that is truly MISSING, never one set to null,
 * so the SECOND assistant message ever saved to a thread collided with
 * the first on this index and was dropped (saveMemory.js's own try/catch
 * only warns, never surfaces the loss). This requires a REAL MongoDB
 * connection: unique-index enforcement happens server-side, never via
 * Mongoose's client-side validateSync().
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const OWNER_ID = new mongoose.Types.ObjectId().toString();

// Only this file's own connection is closed here (Mongoose's default
// connection is shared across the whole process) -- when run alongside
// other test files via `npm test`, node --test itself terminates the
// process once every file's tests complete, so this is a no-op there;
// run standalone, it lets THIS file's own real-DB connection exit
// cleanly instead of keeping the process alive indefinitely.
after(async () => { await mongoose.disconnect(); });

test('two assistant messages in the SAME thread (both with no clientMessageId) both persist -- neither is silently dropped by the unique index', async (t) => {
  const thread = await createThread(OWNER_ID, { title: 'index-fix-check' });
  t.after(async () => { await deleteThread(OWNER_ID, thread._id.toString()).catch(() => {}); });

  await appendAssistantMessage(OWNER_ID, thread._id.toString(), { content: 'First assistant reply.' });
  await appendAssistantMessage(OWNER_ID, thread._id.toString(), { content: 'Second assistant reply.' });
  await appendAssistantMessage(OWNER_ID, thread._id.toString(), { content: 'Third assistant reply.' });

  const { messages } = await getThread(OWNER_ID, thread._id.toString());
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMessages.length, 3, 'all three assistant replies must survive, not just the first');
  assert.deepEqual(
    assistantMessages.map((m) => m.content),
    ['First assistant reply.', 'Second assistant reply.', 'Third assistant reply.'],
  );
});

test('a real Mongoose document for a second assistant message in the same thread has clientMessageId genuinely ABSENT, not null (the actual field-level fix)', async (t) => {
  const thread = await createThread(OWNER_ID, { title: 'index-fix-field-check' });
  t.after(async () => { await deleteThread(OWNER_ID, thread._id.toString()).catch(() => {}); });

  await appendAssistantMessage(OWNER_ID, thread._id.toString(), { content: 'One.' });
  await appendAssistantMessage(OWNER_ID, thread._id.toString(), { content: 'Two.' });

  const raw = await ChatMessage.find({ threadId: thread._id }).lean();
  for (const doc of raw) {
    assert.equal('clientMessageId' in doc, false, 'clientMessageId must be genuinely absent from the document, never present as null');
  }
});

test('two user messages that BOTH genuinely omit clientMessageId also both persist (the same fix applied to appendUserMessage)', async (t) => {
  const thread = await createThread(OWNER_ID, { title: 'index-fix-user-check' });
  t.after(async () => { await deleteThread(OWNER_ID, thread._id.toString()).catch(() => {}); });

  await appendUserMessage(OWNER_ID, thread._id.toString(), { content: 'First question, no client id.' });
  await appendUserMessage(OWNER_ID, thread._id.toString(), { content: 'Second question, no client id.' });

  const { messages } = await getThread(OWNER_ID, thread._id.toString());
  assert.equal(messages.filter((m) => m.role === 'user').length, 2);
});

test('a genuine duplicate clientMessageId submission is STILL correctly deduped (the fix does not weaken real idempotency)', async (t) => {
  const thread = await createThread(OWNER_ID, { title: 'index-fix-dedup-check' });
  t.after(async () => { await deleteThread(OWNER_ID, thread._id.toString()).catch(() => {}); });

  const first = await appendUserMessage(OWNER_ID, thread._id.toString(), { content: 'Original.', clientMessageId: 'cmid-fixed-1' });
  const second = await appendUserMessage(OWNER_ID, thread._id.toString(), { content: 'Retried submit.', clientMessageId: 'cmid-fixed-1' });
  assert.equal(second.duplicate, true);
  assert.equal(second.message._id.toString(), first.message._id.toString());

  const { messages } = await getThread(OWNER_ID, thread._id.toString());
  assert.equal(messages.filter((m) => m.role === 'user').length, 1, 'the retried submit must not create a second message');
});

test('the collection\'s {threadId, clientMessageId} unique index is a PARTIAL index scoped to real string ids, not the old sparse index', async () => {
  const indexes = await ChatMessage.collection.indexes();
  const fixed = indexes.find((ix) => ix.name === 'unique_client_message_id_per_thread');
  assert.ok(fixed, 'the corrected index must exist on the real collection');
  assert.equal(fixed.unique, true);
  assert.deepEqual(fixed.partialFilterExpression, { clientMessageId: { $type: 'string' } });
  const stale = indexes.find((ix) => ix.name === 'threadId_1_clientMessageId_1');
  assert.equal(stale, undefined, 'the old sparse-only index must no longer exist');
});
