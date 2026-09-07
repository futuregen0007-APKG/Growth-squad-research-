import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../../llm/errors.js';
import { buildSystemPrompt, answerComposerPrompt } from '../prompts/index.js';
import { SAFE_REASONS } from '../safeReasons.js';
import { logger } from '../../utils/logger.js';

const CITATION_MARKER_PATTERN = /\[(\d+)\]/g;

/**
 * extractCitations - maps every distinct [N] marker the model actually
 * used in its answer back to the corresponding evidence record. A marker
 * outside the given evidence range is silently dropped — never fabricated
 * into a citation.
 */
export const extractCitations = (answerText, evidence) => {
  const usedIndexes = new Set();
  for (const match of answerText.matchAll(CITATION_MARKER_PATTERN)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= evidence.length) usedIndexes.add(n);
  }
  return [...usedIndexes].sort((a, b) => a - b).map((n) => evidence[n - 1]);
};

const GENERAL_EDUCATION_SYSTEM_NOTE = 'This is a general educational question — answer directly and concisely, with no citations needed since no company-specific tool data was used.';

// UNSUPPORTED must NEVER be treated like GENERAL_EDUCATION — a general
// question ("what is a P/E ratio?") is safe to answer from the model's own
// knowledge, but an UNSUPPORTED classification specifically means "this
// requires a capability GS Copilot doesn't have" (e.g. sector-wide
// ranking/discovery — see classifyIntent's isUnsupportedSectorDiscovery).
// Letting the model answer normally here would mean it improvises a
// ranked list of companies from its own training data with no real
// evidence — exactly the "answer from unsupported knowledge" failure mode
// this project must prevent. The model is told plainly to decline instead.
const UNSUPPORTED_SYSTEM_NOTE = `This request needs a capability GS Copilot does not currently have (for example: ranking or discovering companies across a whole sector by a metric like order book — there is no such tool or dataset available). Do not attempt to answer using your own general knowledge or guess a list of companies. Instead, clearly tell the user: "${SAFE_REASONS.CAPABILITY_NOT_SUPPORTED} — GS Copilot can look up named companies individually (e.g. financials, margins, comparisons between specific companies you name), but cannot yet rank or discover companies across an entire sector." Keep it brief and suggest they name specific companies instead.`;

/**
 * composeAnswer - streams the final answer via the OpenAI SDK's real
 * streaming (chat.completions.create({stream: true})), emitting `token`
 * events through state.onEvent as they arrive. Only final-answer tokens
 * are streamed — no chain-of-thought, no internal tool reasoning.
 */
export const composeAnswer = async (state) => {
  if (state.errors.length) {
    const answer = state.errors[0];
    if (state.onEvent) { state.onEvent({ type: 'token', token: answer }); }
    return { answer, citations: [] };
  }

  if (!OpenAIClientFactory.isConfigured()) {
    const answer = "GS Copilot isn't configured yet — the site administrator needs to set an OpenAI API key.";
    if (state.onEvent) state.onEvent({ type: 'token', token: answer });
    return { answer, citations: [], warnings: ['OpenAI is not configured.'] };
  }

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');

  const userPrompt = state.intent === 'UNSUPPORTED'
    ? `${UNSUPPORTED_SYSTEM_NOTE}\n\nUser question: "${text}"`
    : state.intent === 'GENERAL_EDUCATION' || !state.toolPlan.length
      ? `${GENERAL_EDUCATION_SYSTEM_NOTE}\n\nUser question: "${text}"`
      : answerComposerPrompt({ message: text, conversationSummary: state.conversationSummary, evidence: state.evidence, toolResults: state.toolResults, warnings: state.warnings });

  const systemPrompt = buildSystemPrompt(state.userContext);
  if (state.onEvent) state.onEvent({ type: 'status', message: 'Writing response…' });

  // Recent prior turns are included verbatim (never summarized) so the
  // model has real conversational continuity beyond the factual summary.
  const historyMessages = (state.recentHistory || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  try {
    const client = OpenAIClientFactory.getClient();
    const stream = await client.chat.completions.create({
      model: LLM_CONFIG.chatModel,
      temperature: LLM_CONFIG.temperature,
      max_tokens: LLM_CONFIG.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: userPrompt },
      ],
    });

    let full = '';
    let tokenUsage = null;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        if (state.onEvent) state.onEvent({ type: 'token', token: delta });
      }
      if (chunk.usage) {
        tokenUsage = {
          inputTokens: chunk.usage.prompt_tokens ?? null,
          outputTokens: chunk.usage.completion_tokens ?? null,
          totalTokens: chunk.usage.total_tokens ?? null,
        };
      }
      if (state.aborted?.()) {
        stream.controller?.abort?.();
        break;
      }
    }

    const citations = extractCitations(full, state.evidence);
    return { answer: full, citations, tokenUsage };
  } catch (error) {
    if (error?.isAbort || error?.name === 'APIUserAbortError') {
      return { answer: null, citations: [], warnings: ['Generation was stopped.'] };
    }
    const mapped = mapOpenAIError(error, { operation: 'composeAnswer' });
    logger.warn(`[Graph] composeAnswer failed: ${mapped.message}`);
    const answer = 'I ran into a problem generating a response just now. Please try again.';
    if (state.onEvent) state.onEvent({ type: 'token', token: answer });
    return { answer, citations: [], errors: [mapped.message] };
  }
};

export default composeAnswer;
