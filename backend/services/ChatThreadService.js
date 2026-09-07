import mongoose from 'mongoose';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import UserPreference from '../models/UserPreference.js';
import { AppError, createNotFoundError } from '../utils/errorHandler.js';

/**
 * ChatThreadService.js
 * =====================
 * The ONLY module that reads/writes ChatThread/ChatMessage/UserPreference.
 * Every method takes userId and filters by it — a thread can never be
 * loaded, renamed, deleted, or appended to by anyone but its owner. This
 * is the enforcement point for "a user must never access another user's
 * thread by changing the ID."
 */

const isValidObjectId = (value) => mongoose.isValidObjectId(value);

const assertOwnedThread = async (threadId, userId) => {
  if (!isValidObjectId(threadId)) throw createNotFoundError('Thread', threadId);
  const thread = await ChatThread.findOne({ _id: threadId, userId, deletedAt: null });
  if (!thread) throw createNotFoundError('Thread', threadId);
  return thread;
};

export const createThread = async (userId, { title } = {}) => {
  const thread = await ChatThread.create({ userId, title: title || 'New chat' });
  return thread.toObject();
};

export const listThreads = async (userId, { limit = 50 } = {}) => {
  return ChatThread.find({ userId, deletedAt: null })
    .sort({ updatedAt: -1 })
    .limit(Math.min(limit, 100))
    .lean();
};

export const getThread = async (userId, threadId) => {
  const thread = await assertOwnedThread(threadId, userId);
  const messages = await ChatMessage.find({ threadId: thread._id }).sort({ createdAt: 1 }).lean();
  return { thread: thread.toObject(), messages };
};

export const renameThread = async (userId, threadId, title) => {
  const thread = await assertOwnedThread(threadId, userId);
  thread.title = String(title || '').trim().slice(0, 120) || thread.title;
  await thread.save();
  return thread.toObject();
};

/** Soft delete — a deleted thread must never load again (enforced by assertOwnedThread's deletedAt filter). */
export const deleteThread = async (userId, threadId) => {
  const thread = await assertOwnedThread(threadId, userId);
  thread.deletedAt = new Date();
  await thread.save();
  return { deleted: true };
};

/**
 * appendUserMessage - idempotent on clientMessageId: a duplicate submit
 * (double-click, retried request after a network blip) returns the
 * existing message instead of creating a second one.
 */
export const appendUserMessage = async (userId, threadId, { content, clientMessageId }) => {
  const thread = await assertOwnedThread(threadId, userId);

  if (clientMessageId) {
    const existing = await ChatMessage.findOne({ threadId: thread._id, clientMessageId });
    if (existing) return { message: existing.toObject(), thread: thread.toObject(), duplicate: true };
  }

  const message = await ChatMessage.create({
    threadId: thread._id, userId, role: 'user', content, clientMessageId: clientMessageId || null, status: 'COMPLETE',
  });

  thread.messageCount += 1;
  thread.lastMessageAt = new Date();
  if (thread.title === 'New chat') {
    thread.title = String(content).trim().slice(0, 60) || thread.title;
  }
  await thread.save();

  return { message: message.toObject(), thread: thread.toObject(), duplicate: false };
};

export const appendAssistantMessage = async (userId, threadId, {
  content, status = 'COMPLETE', citations = [], toolSummary = [], intent = null, model = null, tokenUsage = null,
}) => {
  const thread = await assertOwnedThread(threadId, userId);
  const message = await ChatMessage.create({
    threadId: thread._id, userId, role: 'assistant', content, status, citations, toolSummary, intent, model, tokenUsage,
  });
  thread.messageCount += 1;
  thread.lastMessageAt = new Date();
  await thread.save();
  return message.toObject();
};

export const updateThreadMemory = async (userId, threadId, { summary, summaryUpToMessageId, activeEntities }) => {
  const thread = await assertOwnedThread(threadId, userId);
  if (summary !== undefined) thread.summary = summary;
  if (summaryUpToMessageId !== undefined) thread.summaryUpToMessageId = summaryUpToMessageId;
  if (activeEntities !== undefined) thread.activeEntities = activeEntities;
  await thread.save();
  return thread.toObject();
};

/**
 * getUserPreferences / saveExplicitPreferences - long-term memory. Saving
 * only ever merges explicitly-stated fields (never clears an existing
 * preference the current turn didn't mention).
 */
export const getUserPreferences = async (userId) => {
  const pref = await UserPreference.findOne({ userId }).lean();
  return pref || { userId, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [], preferredDetail: null };
};

export const saveExplicitPreferences = async (userId, updates = {}) => {
  const setFields = {};
  if (updates.riskAppetite) setFields.riskAppetite = updates.riskAppetite;
  if (updates.investmentHorizon) setFields.investmentHorizon = updates.investmentHorizon;
  if (updates.preferredDetail) setFields.preferredDetail = updates.preferredDetail;

  const addToSetOps = {};
  if (updates.goals?.length) addToSetOps.goals = { $each: updates.goals };
  if (updates.preferredSectors?.length) addToSetOps.preferredSectors = { $each: updates.preferredSectors };

  if (!Object.keys(setFields).length && !Object.keys(addToSetOps).length) {
    return getUserPreferences(userId);
  }

  const update = {};
  if (Object.keys(setFields).length) update.$set = setFields;
  if (Object.keys(addToSetOps).length) update.$addToSet = addToSetOps;

  const pref = await UserPreference.findOneAndUpdate(
    { userId },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return pref;
};

export default {
  createThread, listThreads, getThread, renameThread, deleteThread,
  appendUserMessage, appendAssistantMessage, updateThreadMemory,
  getUserPreferences, saveExplicitPreferences,
};
