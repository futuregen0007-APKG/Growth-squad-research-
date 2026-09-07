import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import { getThread, renameThread, deleteThread } from '../services/ChatThreadService.js';

const OWNER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_USER_ID = new mongoose.Types.ObjectId().toString();
const THREAD_ID = new mongoose.Types.ObjectId().toString();

const mockThreadFindOne = (implementation) => {
  const original = ChatThread.findOne;
  ChatThread.findOne = implementation;
  return () => { ChatThread.findOne = original; };
};

test('getThread queries ChatThread with BOTH the threadId and userId — never by id alone', async () => {
  let capturedQuery = null;
  const restore = mockThreadFindOne((query) => {
    capturedQuery = query;
    return Promise.resolve(null); // simulate "not found for this user"
  });
  try {
    await assert.rejects(() => getThread(OWNER_ID, THREAD_ID), (error) => error.statusCode === 404);
    assert.equal(capturedQuery._id, THREAD_ID);
    assert.equal(capturedQuery.userId, OWNER_ID);
    assert.equal(capturedQuery.deletedAt, null);
  } finally {
    restore();
  }
});

test('another user cannot load a thread they do not own — the query returning null for their userId produces 404, not the owner\'s data', async () => {
  const restore = mockThreadFindOne((query) => Promise.resolve(
    query.userId === OWNER_ID ? { _id: THREAD_ID, userId: OWNER_ID, toObject: () => ({ _id: THREAD_ID, userId: OWNER_ID }) } : null,
  ));
  const originalMessageFind = ChatMessage.find;
  ChatMessage.find = () => ({ sort: () => ({ lean: async () => [] }) });
  try {
    // Owner succeeds.
    const ownerResult = await getThread(OWNER_ID, THREAD_ID);
    assert.equal(ownerResult.thread.userId, OWNER_ID);

    // A different user gets a 404 for the SAME threadId, never the owner's thread.
    await assert.rejects(() => getThread(OTHER_USER_ID, THREAD_ID), (error) => error.statusCode === 404);
  } finally {
    restore();
    ChatMessage.find = originalMessageFind;
  }
});

test('an invalid threadId (not even a valid ObjectId) is rejected as not-found before any query, never a DB cast error leaking', async () => {
  await assert.rejects(() => getThread(OWNER_ID, 'not-a-valid-id'), (error) => error.statusCode === 404);
});

test('a soft-deleted thread cannot be loaded again (deletedAt filter enforced)', async () => {
  const restore = mockThreadFindOne((query) => {
    // Simulate the real Mongo behavior: a query with deletedAt: null never matches a soft-deleted doc.
    return Promise.resolve(query.deletedAt === null ? null : { _id: THREAD_ID });
  });
  try {
    await assert.rejects(() => getThread(OWNER_ID, THREAD_ID), (error) => error.statusCode === 404);
  } finally {
    restore();
  }
});

test('renameThread and deleteThread both enforce the same ownership check as getThread', async () => {
  const restore = mockThreadFindOne(() => Promise.resolve(null));
  try {
    await assert.rejects(() => renameThread(OTHER_USER_ID, THREAD_ID, 'Hacked title'), (error) => error.statusCode === 404);
    await assert.rejects(() => deleteThread(OTHER_USER_ID, THREAD_ID), (error) => error.statusCode === 404);
  } finally {
    restore();
  }
});
