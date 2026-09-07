import { zodResponseFormat } from 'openai/helpers/zod';
import { OpenAIClientFactory, LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../llm/errors.js';
import { ConversationSummarySchema } from '../graph/schemas.js';
import { logger } from '../utils/logger.js';

// Once a thread has more than this many messages, everything before the
// most recent RECENT_MESSAGE_COUNT is folded into a factual summary via
// the lower-cost model — recent messages always stay verbatim.
export const SUMMARY_TRIGGER_MESSAGE_COUNT = 20;
export const RECENT_MESSAGE_COUNT = 10;

const summaryPrompt = (priorSummary, messagesToSummarize) => `You are compacting an older portion of a financial research conversation into a factual summary for later reuse. Do not add opinions, do not invent facts that were not said, and do not include chain-of-thought.

${priorSummary ? `Existing summary of even older messages:\n${priorSummary}\n` : ''}
Messages to fold into the summary:
${messagesToSummarize.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}

Return strictly valid JSON matching the schema: a short factual summary, the stock symbols and company names actively discussed, and any explicit decisions the user stated (e.g. "I'm adding TCS to my watchlist mentally", "I prefer long-term picks").`;

/**
 * summarizeOlderMessages - returns null (never throws) on any failure so a
 * summarization hiccup never blocks the conversation; the caller simply
 * keeps the existing summary and tries again next turn.
 */
export const summarizeOlderMessages = async (priorSummary, messagesToSummarize) => {
  if (!messagesToSummarize.length) return null;
  if (!OpenAIClientFactory.isConfigured()) return null;

  try {
    const client = OpenAIClientFactory.getClient();
    const response = await client.chat.completions.parse({
      model: LLM_CONFIG.summaryModel,
      temperature: 0,
      max_tokens: 600,
      messages: [{ role: 'user', content: summaryPrompt(priorSummary, messagesToSummarize) }],
      response_format: zodResponseFormat(ConversationSummarySchema, 'conversation_summary'),
    });
    const parsed = response.choices?.[0]?.message?.parsed;
    return parsed || null;
  } catch (error) {
    const mapped = mapOpenAIError(error, { operation: 'summarizeOlderMessages' });
    logger.warn(`[ConversationSummary] summarization skipped: ${mapped.message}`);
    return null;
  }
};

export default { summarizeOlderMessages, SUMMARY_TRIGGER_MESSAGE_COUNT, RECENT_MESSAGE_COUNT };
