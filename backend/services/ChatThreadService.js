import mongoose from 'mongoose';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import UserPreference from '../models/UserPreference.js';
import { AppError, createNotFoundError } from '../utils/errorHandler.js';
import { ResponseBlockSchema, MAX_EXCERPT_LENGTH } from '../graph/schemas.js';

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

// MAX_EXCERPT_LENGTH is imported from graph/schemas.js — the ONE
// authoritative bound shared with EvidenceDrawerEntrySchema's Zod
// validation and models/ChatMessage.js's Mongoose maxlength (see that
// constant's own note for the real, measured bug this sharing prevents:
// a citation whose excerpt fell BETWEEN two previously-mismatched limits
// saved successfully but was silently dropped on every reload). "should
// never happen" (an oversized excerpt) is not the same guarantee as
// "cannot happen": several tool-built excerpts are raw, unbounded
// provider text (article descriptions, company profile summaries), and
// Mongoose's `maxlength` is a save-time VALIDATOR, not a silent
// truncator — normalizing here, once, right before persistence, is what
// makes "an oversized excerpt cannot prevent the assistant message from
// saving" an ACTUAL guarantee rather than an assumption about input size.

/** normalizeExcerpt - truncates only if over the limit; returns non-string/short values completely unchanged. */
export const normalizeExcerpt = (value) => (
  typeof value === 'string' && value.length > MAX_EXCERPT_LENGTH ? value.slice(0, MAX_EXCERPT_LENGTH) : value
);

/** normalizeCitationExcerpts - the citations array as given, with only the excerpt field bounded. */
export const normalizeCitationExcerpts = (citations = []) => (citations || []).map((citation) => (
  citation && typeof citation === 'object' && 'excerpt' in citation
    ? { ...citation, excerpt: normalizeExcerpt(citation.excerpt) }
    : citation
));

/**
 * normalizeResponseBlockExcerpts - the ONLY block type that carries a
 * free-text excerpt is evidence_drawer (source_list deliberately does
 * not — see its own schema note); every other block type is returned
 * completely unchanged.
 */
export const normalizeResponseBlockExcerpts = (blocks = []) => (blocks || []).map((block) => (
  block?.type === 'evidence_drawer' && Array.isArray(block.entries)
    ? { ...block, entries: block.entries.map((entry) => ({ ...entry, excerpt: normalizeExcerpt(entry?.excerpt) })) }
    : block
));

// ---------------------------------------------------------------------------
// UI Phase 1B: responseBlocks <-> persisted-shape mapping.
//
// The API/SSE shape (graph/schemas.js's ResponseBlockSchema — what
// buildResponseBlocks produces and what message.completed sends) and the
// Mongoose-persisted shape (models/ChatMessage.js's responseBlockSchema)
// differ in exactly one place: comparison_table's `values`, keyed by
// symbol in the API shape (`{TCS: {...}, INFY: {...}}`), is an ARRAY of
// `{symbol, ...}` in the persisted shape (a Mongoose object keyed by an
// arbitrary symbol string does not round-trip cleanly through `.lean()`).
// These two functions are the ONLY place that difference exists, so a
// thread reload returns the client the EXACT SAME shape a live SSE
// `message.completed` did — one renderer, no origin-specific branching.
// ---------------------------------------------------------------------------

const toPersistedResponseBlock = (block) => {
  switch (block?.type) {
    case 'metric_grid':
      return { type: block.type, metricGrid: { symbol: block.symbol, metrics: block.metrics } };
    case 'comparison_table':
      return {
        type: block.type,
        comparisonTable: {
          symbols: block.symbols,
          rows: block.rows.map((row) => ({
            metric: row.metric,
            label: row.label,
            commonPeriod: row.commonPeriod,
            comparable: row.comparable,
            values: Object.entries(row.values || {}).map(([symbol, cell]) => ({
              symbol, value: cell.value, unit: cell.unit, evidence: cell.evidence,
            })),
          })),
        },
      };
    case 'source_list':
      return { type: block.type, sourceList: { sources: block.sources } };
    case 'data_quality':
      return {
        type: block.type,
        dataQuality: {
          groundingStatus: block.groundingStatus,
          unmatchedRequestedPeriods: block.unmatchedRequestedPeriods,
          valuationGaps: block.valuationGaps,
          limitations: block.limitations,
        },
      };
    case 'suggested_questions':
      return { type: block.type, suggestedQuestions: { questions: block.questions } };
    case 'company_header':
      return {
        type: block.type,
        companyHeader: {
          symbol: block.symbol, companyName: block.companyName, sector: block.sector, exchange: block.exchange,
          price: block.price, // {value, currency, asOf, evidence} or null -- shape matches companyHeaderPriceSchema directly
        },
      };
    case 'evidence_drawer':
      return { type: block.type, evidenceDrawer: { entries: block.entries } };
    case 'news_list':
      return { type: block.type, newsList: { articles: block.articles } };
    case 'chart':
      return {
        type: block.type,
        chart: {
          version: block.version, symbol: block.symbol, currency: block.currency, priceBasis: block.priceBasis,
          points: block.points, rangeStart: block.rangeStart, rangeEnd: block.rangeEnd,
          requestedRangeDays: block.requestedRangeDays, provider: block.provider, sourceUrl: block.sourceUrl,
          dataAsOf: block.dataAsOf, evidence: block.evidence,
        },
      };
    default:
      return null; // unrecognized type -- never persisted (mirrors the schema's own rejection)
  }
};

/** toPersistedResponseBlocks - maps a whole (already-validated) array, dropping anything unrecognized rather than throwing. */
export const toPersistedResponseBlocks = (blocks = []) => (blocks || []).map(toPersistedResponseBlock).filter(Boolean);

const fromPersistedResponseBlock = (doc) => {
  switch (doc?.type) {
    case 'metric_grid':
      return doc.metricGrid ? { type: 'metric_grid', symbol: doc.metricGrid.symbol, metrics: doc.metricGrid.metrics || [] } : null;
    case 'comparison_table':
      return doc.comparisonTable ? {
        type: 'comparison_table',
        symbols: doc.comparisonTable.symbols || [],
        rows: (doc.comparisonTable.rows || []).map((row) => ({
          metric: row.metric,
          label: row.label,
          commonPeriod: row.commonPeriod,
          comparable: row.comparable,
          values: Object.fromEntries((row.values || []).map((cell) => [
            cell.symbol, { value: cell.value, unit: cell.unit, evidence: cell.evidence },
          ])),
        })),
      } : null;
    case 'source_list':
      return doc.sourceList ? { type: 'source_list', sources: doc.sourceList.sources || [] } : null;
    case 'data_quality':
      return doc.dataQuality ? { type: 'data_quality', ...doc.dataQuality } : null;
    case 'suggested_questions':
      return doc.suggestedQuestions ? { type: 'suggested_questions', questions: doc.suggestedQuestions.questions || [] } : null;
    case 'company_header':
      return doc.companyHeader ? {
        type: 'company_header',
        symbol: doc.companyHeader.symbol,
        companyName: doc.companyHeader.companyName,
        sector: doc.companyHeader.sector,
        exchange: doc.companyHeader.exchange,
        price: doc.companyHeader.price || null,
      } : null;
    case 'evidence_drawer':
      return doc.evidenceDrawer ? { type: 'evidence_drawer', entries: doc.evidenceDrawer.entries || [] } : null;
    case 'news_list':
      return doc.newsList ? { type: 'news_list', articles: doc.newsList.articles || [] } : null;
    case 'chart':
      return doc.chart ? {
        type: 'chart',
        version: doc.chart.version,
        symbol: doc.chart.symbol,
        currency: doc.chart.currency,
        priceBasis: doc.chart.priceBasis,
        points: doc.chart.points || [],
        rangeStart: doc.chart.rangeStart,
        rangeEnd: doc.chart.rangeEnd,
        requestedRangeDays: doc.chart.requestedRangeDays,
        provider: doc.chart.provider,
        sourceUrl: doc.chart.sourceUrl,
        dataAsOf: doc.chart.dataAsOf,
        evidence: doc.chart.evidence || [],
      } : null;
    default:
      return null;
  }
};

/**
 * fromPersistedResponseBlocks - the read side. Re-validated against the
 * SAME Zod schema the builders used (defense in depth: a reload must never
 * hand the client a shape that would have failed validation at build
 * time, even if the stored document is old or was somehow hand-edited) —
 * anything that fails is dropped, never thrown, matching "omit invalid or
 * empty blocks" at every boundary, not just at build time.
 */
export const fromPersistedResponseBlocks = (docs = []) => (docs || [])
  .map((doc) => fromPersistedResponseBlock(doc.toObject ? doc.toObject() : doc))
  .filter(Boolean)
  .map((block) => ResponseBlockSchema.safeParse(block))
  .filter((result) => result.success)
  .map((result) => result.data);

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
  const rawMessages = await ChatMessage.find({ threadId: thread._id }).sort({ createdAt: 1 }).lean();
  // UI Phase 1B: responseBlocks come back from Mongo in their persisted
  // shape (see the module note above) — converted here, once, so every
  // caller of getThread (the REST endpoint, tests) sees the same shape a
  // live message.completed SSE event sends.
  const messages = rawMessages.map((message) => (
    message.responseBlocks?.length
      ? { ...message, responseBlocks: fromPersistedResponseBlocks(message.responseBlocks) }
      : message
  ));
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

  // UI Phase 1D fix: `clientMessageId` is genuinely OMITTED (never `null`)
  // when the caller didn't supply one -- see models/ChatMessage.js's own
  // field note on why an explicit null defeated the partial unique index
  // this collection relies on. A user message sent without one (should be
  // rare -- the frontend always generates one, but never assumed) now
  // behaves the same safe way an assistant message already does.
  const message = await ChatMessage.create({
    threadId: thread._id, userId, role: 'user', content, ...(clientMessageId ? { clientMessageId } : {}), status: 'COMPLETE',
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
  content, status = 'COMPLETE', citations = [], responseBlocks = [], toolSummary = [], intent = null, model = null, tokenUsage = null,
}) => {
  const thread = await assertOwnedThread(threadId, userId);
  const message = await ChatMessage.create({
    threadId: thread._id,
    userId,
    role: 'assistant',
    content,
    status,
    // UI Phase 1C.2: excerpt normalized to MAX_EXCERPT_LENGTH here —
    // see that constant's own note for why this must happen regardless
    // of the schema's own maxlength.
    citations: normalizeCitationExcerpts(citations),
    // UI Phase 1B: converted to the persisted shape here, once — see the
    // module note above for why the shapes differ. Excerpt normalization
    // happens BEFORE the shape conversion (evidence_drawer's excerpt
    // field exists on the live/API shape either way).
    responseBlocks: toPersistedResponseBlocks(normalizeResponseBlockExcerpts(responseBlocks)),
    toolSummary,
    intent,
    model,
    tokenUsage,
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
  toPersistedResponseBlocks, fromPersistedResponseBlocks,
  normalizeExcerpt, normalizeCitationExcerpts, normalizeResponseBlockExcerpts,
};
