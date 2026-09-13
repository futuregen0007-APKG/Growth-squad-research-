import dotenv from 'dotenv';
import OpenAI from 'openai';
import { OpenAIServiceError, OPENAI_ERROR_CODES } from './errors.js';

// Mirrors services/openaiClient.js's own dotenv.config() call. server.js
// already loads .env before anything else in the running app, but this
// module must also work correctly when imported standalone (e.g. a single
// test file run directly via `node --test tests/x.test.js` without ever
// importing server.js) — without this, process.env.OPENAI_API_KEY would
// only be populated by accident, via some other imported module's side
// effect. dotenv.config() is idempotent and safe to call more than once.
dotenv.config();

/**
 * OpenAIClientFactory.js
 * =======================
 * The ONE place GS Copilot constructs an OpenAI client. Graph nodes, tools,
 * and controllers must import from here rather than calling `new OpenAI()`
 * themselves — this keeps model selection, timeout, and API-key handling
 * centralized and auditable.
 *
 * Reuses the same OPENAI_API_KEY the rest of the project already uses
 * (see services/openaiClient.js, used by ManagementPromiseService's
 * existing Earnings Intelligence extraction — left untouched and working).
 * This factory is a separate client instance because GS Copilot needs its
 * own configurable timeout/model set; both read the same underlying key.
 *
 * Conceptual roles — Phase 1 gives each an independently configurable
 * model (previously all three resolved to the same value by construction):
 *   - routing model   (classifyIntent, extractEntities, planTools) → LLM_CONFIG.routingModel
 *   - synthesis model  (composeAnswer)                              → LLM_CONFIG.synthesisModel
 *   - summary model    (preference detection, conversation summary) → LLM_CONFIG.summaryModel
 * All three may be pointed at the same model via configuration (the
 * default) — nothing requires them to differ. `chatModel` is kept as a
 * deprecated alias of `routingModel` for backward compatibility with any
 * existing caller/env var (OPENAI_CHAT_MODEL still works).
 */

// Conservative defaults: 'gpt-4o-mini' is the model already proven to work
// against this project's real OpenAI account (see ExecutionScoreService /
// ManagementPromiseService's promise-extraction calls) — never default to
// an unverified, potentially unavailable or more expensive model.
const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_SUMMARY_MODEL = 'gpt-4o-mini';

export const LLM_CONFIG = {
  // OPENAI_ROUTING_MODEL / OPENAI_SYNTHESIS_MODEL are the new, explicit
  // per-role env vars. OPENAI_CHAT_MODEL (the original, single var) is
  // preserved as the fallback for BOTH roles when the new ones aren't set —
  // an existing deployment's env config keeps working unchanged.
  get routingModel() { return process.env.OPENAI_ROUTING_MODEL || process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL; },
  get synthesisModel() { return process.env.OPENAI_SYNTHESIS_MODEL || process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL; },
  /** @deprecated use routingModel (or synthesisModel for composeAnswer) — kept only so any caller not yet migrated still resolves a real model. */
  get chatModel() { return this.routingModel; },
  get summaryModel() { return process.env.OPENAI_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL; },
  get temperature() {
    const value = Number(process.env.OPENAI_TEMPERATURE);
    return Number.isFinite(value) ? value : 0.2;
  },
  get maxOutputTokens() {
    const value = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS);
    return Number.isFinite(value) && value > 0 ? value : 2000;
  },
  get timeoutMs() {
    const value = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : 60000;
  },
};

let sharedClient = null;

const buildClient = () => new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: LLM_CONFIG.timeoutMs,
  maxRetries: 0, // GS Copilot's graph nodes own retry policy explicitly (at most one, for structured output) — the SDK must not silently retry on top of that
});

export const OpenAIClientFactory = {
  isConfigured: () => Boolean(process.env.OPENAI_API_KEY),

  /** Throws OPENAI_NOT_CONFIGURED (never a generic error) when no key is set. */
  getClient() {
    if (!process.env.OPENAI_API_KEY) {
      throw new OpenAIServiceError(OPENAI_ERROR_CODES.NOT_CONFIGURED, 'OPENAI_API_KEY is not configured — GS Copilot cannot answer questions that require the model.');
    }
    if (!sharedClient) {
      sharedClient = buildClient();
    }
    return sharedClient;
  },

  /** Test-only: force a fresh client (e.g. after swapping process.env in a test). */
  _resetForTests() {
    sharedClient = null;
  },
};

export default OpenAIClientFactory;
