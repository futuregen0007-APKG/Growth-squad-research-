import { zodResponseFormat } from 'openai/helpers/zod';
import {
  appendAssistantMessage, updateThreadMemory, getThread, saveExplicitPreferences,
} from '../../services/ChatThreadService.js';
import { summarizeOlderMessages, SUMMARY_TRIGGER_MESSAGE_COUNT, RECENT_MESSAGE_COUNT } from '../../services/ConversationSummaryService.js';
import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../../llm/errors.js';
import { ExplicitPreferenceSchema } from '../schemas.js';
import { logger } from '../../utils/logger.js';

const MAX_ACTIVE_ENTITIES = 15;
const mergeUnique = (existing = [], incoming = [], max = MAX_ACTIVE_ENTITIES) => [...new Set([...incoming, ...existing])].slice(0, max);

// Cheap deterministic pre-filter — only worth an LLM call when the message
// plausibly states a durable preference at all.
const PREFERENCE_SIGNAL = /\b(i am|i'm|i prefer|my goal|my risk|conservative|aggressive|long[- ]term|short[- ]term|risk[- ]appetite|risk tolerance)\b/i;

const detectExplicitPreference = async (message) => {
  if (!PREFERENCE_SIGNAL.test(message) || !OpenAIClientFactory.isConfigured()) return null;
  try {
    const client = OpenAIClientFactory.getClient();
    const response = await client.chat.completions.parse({
      model: LLM_CONFIG.summaryModel,
      temperature: 0,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Did the user explicitly state a durable investing preference (risk appetite, investment horizon, a financial goal, or a preferred sector) in this message? Only set stated=true for a genuinely explicit, unambiguous statement — not a passing or ambiguous remark.\n\nMessage: "${message}"`,
      }],
      response_format: zodResponseFormat(ExplicitPreferenceSchema, 'explicit_preference'),
    });
    return response.choices?.[0]?.message?.parsed || null;
  } catch (error) {
    logger.warn(`[Graph] preference detection skipped: ${mapOpenAIError(error, { operation: 'detectExplicitPreference' }).message}`);
    return null;
  }
};

/**
 * saveMemory - the final node. Persists the assistant's message, updates
 * short-term thread memory (active entities, and a fresh summary once the
 * thread crosses SUMMARY_TRIGGER_MESSAGE_COUNT), and — only when the user
 * explicitly stated one — updates long-term preferences. Never blocks the
 * response the user already received; failures here are logged, not
 * surfaced as an error to the client (the answer was already streamed).
 */
export const saveMemory = async (state) => {
  if (!state.threadId || !state.userId || state.answer === null) return {};

  try {
    await appendAssistantMessage(state.userId, state.threadId, {
      content: state.answer,
      status: state.errors.length ? 'ERROR' : 'COMPLETE',
      citations: state.citations,
      // UI Phase 1B: [] on every turn that never reached buildResponseBlocks
      // (e.g. buildSafeFallback) or that found nothing valid to report —
      // never undefined, so appendAssistantMessage's own default is never
      // relied on to paper over a missing field.
      responseBlocks: state.responseBlocks || [],
      toolSummary: state.toolResults.map((t) => ({ tool: t.tool, status: t.status, warning: t.warning })),
      intent: state.intent,
      model: LLM_CONFIG.synthesisModel, // the model that actually composed this answer, not the routing model classifyIntent/planTools used
      tokenUsage: state.tokenUsage,
    });
  } catch (error) {
    logger.warn(`[Graph] saveMemory failed to persist assistant message: ${error.message}`);
    return {};
  }

  try {
    const { thread } = await getThread(state.userId, state.threadId);
    const mergedEntities = {
      symbols: mergeUnique(thread.activeEntities?.symbols, state.entities?.symbols),
      companyNames: mergeUnique(thread.activeEntities?.companyNames, state.entities?.companyNames),
    };

    let summaryUpdate = {};
    if (thread.messageCount >= SUMMARY_TRIGGER_MESSAGE_COUNT) {
      const { messages } = await getThread(state.userId, state.threadId);
      const olderMessages = messages.slice(0, -RECENT_MESSAGE_COUNT);
      const unsummarized = olderMessages.filter((m) => !thread.summaryUpToMessageId || String(m._id) > String(thread.summaryUpToMessageId));
      if (unsummarized.length) {
        // These two LLM calls happen AFTER logDiagnostics in the graph
        // (composeAnswer -> validateFinalAnswer -> logDiagnostics ->
        // saveMemory -> END), so they can never appear in that turn's main
        // diagnostic line — logged here instead, in the same safe,
        // structured, no-prompt-content style (Phase 1 report notes this
        // ordering constraint explicitly rather than reordering the graph
        // to force them into one line).
        const summaryStartedAt = Date.now();
        const summarized = await summarizeOlderMessages(thread.summary, unsummarized);
        logger.info(`[GS Copilot:memory] ${JSON.stringify({ node: 'summarizeOlderMessages', role: 'summary', model: LLM_CONFIG.summaryModel, durationMs: Date.now() - summaryStartedAt, produced: Boolean(summarized) })}`);
        if (summarized) {
          summaryUpdate = {
            summary: summarized.summary,
            summaryUpToMessageId: unsummarized[unsummarized.length - 1]._id,
          };
          mergedEntities.symbols = mergeUnique(mergedEntities.symbols, summarized.activeSymbols);
          mergedEntities.companyNames = mergeUnique(mergedEntities.companyNames, summarized.activeCompanies);
        }
      }
    }

    await updateThreadMemory(state.userId, state.threadId, { activeEntities: mergedEntities, ...summaryUpdate });
  } catch (error) {
    logger.warn(`[Graph] saveMemory failed to update thread memory: ${error.message}`);
  }

  try {
    const lastMessage = state.messages[state.messages.length - 1];
    const preferenceStartedAt = Date.now();
    const preference = await detectExplicitPreference(String(lastMessage?.content || ''));
    logger.info(`[GS Copilot:memory] ${JSON.stringify({ node: 'detectExplicitPreference', role: 'summary', model: LLM_CONFIG.summaryModel, durationMs: Date.now() - preferenceStartedAt, stated: Boolean(preference?.stated) })}`);
    if (preference?.stated) {
      await saveExplicitPreferences(state.userId, preference);
    }
  } catch (error) {
    logger.warn(`[Graph] saveMemory failed to save explicit preference: ${error.message}`);
  }

  return {};
};

export default saveMemory;
