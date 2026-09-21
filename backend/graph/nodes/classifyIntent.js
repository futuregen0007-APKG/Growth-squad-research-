import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { IntentSchema } from '../schemas.js';
import { intentPrompt } from '../prompts/index.js';
import { SUPPORTED_STOCKS, INDEX_SYMBOLS } from '../../utils/constants.js';
import { invokeRoutingModel, SKIPPED_NO_BUDGET } from '../llmInvoke.js';
import { logger } from '../../utils/logger.js';

const KNOWN_SYMBOLS = new Set(Object.keys(SUPPORTED_STOCKS));
const KNOWN_TICKER_PATTERN = /\b([A-Z]{2,15})\b/g;

const containsKnownSymbol = (text) => {
  const upper = text.toUpperCase();
  for (const match of upper.matchAll(KNOWN_TICKER_PATTERN)) {
    if (KNOWN_SYMBOLS.has(match[1]) || INDEX_SYMBOLS[match[1]]) return true;
  }
  return false;
};

const PRICE_PHRASES = /\b(current price|live price|share price|stock price|quote|trading at|ltp)\b/i;
// UI Phase 1D fix: a confirmed live bug -- "Show me a chart of TCS price
// history for the last 90 days" (a known symbol named directly, explicit
// chart language) was classified GENERAL_EDUCATION by the LLM on one run,
// DOCUMENT_RESEARCH on another, and FOLLOW_UP on a third -- non-
// deterministic across otherwise-identical requests. GENERAL_EDUCATION is
// the worst outcome: composeAnswer.js's own isGeneralEducation check
// discards ANY evidence a tool fetched for that intent by design (a
// genuinely general question must never carry company-specific
// citations), so a chart request misclassified this way is silently
// unanswerable regardless of any planTools.js fix. The real, durable fix
// is here: exactly like PRICE_PHRASES above, a chart/historical-price
// phrase naming a KNOWN symbol never reaches the LLM classifier at all —
// LIVE_MARKET_DATA is the closest existing intent bucket for "market/
// price data about a specific company," and planTools.js's own
// chart-keyword wiring (kept in sync with this pattern) takes it from
// there. Mirrors planTools.js's CHART_KEYWORDS — kept as a separate
// constant (this file's own established convention: DEBT_KEYWORDS/
// FINANCIALS_KEYWORDS-style patterns are never shared across files here)
// but deliberately the same phrase set.
const CHART_PHRASES = /\b(chart|price (history|trend|movement|chart)|historical price|share price trend|performance over|price over time)\b/i;
const WATCHLIST_PHRASES = /\b(my watchlist|watch list)\b/i;
const PORTFOLIO_PHRASES = /\b(my portfolio|my holdings|my investments)\b/i;
const EARNINGS_PHRASES = /\b(management promise|guidance|earnings intelligence|reliability score|track record|promise|missed target|fulfilled)\b/i;
const COMPARISON_PHRASES = /\b(compare|vs\.?|versus|which is better)\b/i;

// Sector-wide ranking/discovery phrasing ("best defence companies by order
// book", "top 3 stocks for the capex theme", "which companies have the
// highest margins") — GS Copilot has no sector-universe or ranking tool
// (see graph/tools/toolRegistry.js: every tool takes an explicit symbol or
// symbol list, resolved from a real SUPPORTED_STOCKS ticker; there is no
// "list/rank all companies matching X" capability). Without this rule, a
// query like this fell through to the LLM tool-planner, which could
// hallucinate a plausible-looking list of symbols from its own training
// knowledge rather than a real sector/ranking data source — exactly the
// "answer from unsupported knowledge" this project must never do. Firing
// only when NO specific known symbol is named avoids misclassifying a
// real two-company comparison ("which is better, TCS or INFY") — that
// query already matches COMPARISON_PHRASES above and never reaches here.
const RANKING_DISCOVERY_PHRASES = /\b(best|top\s*\d*|highest|leading|which (companies|stocks|firms))\b.{0,40}\b(companies|stocks|firms)\b|\b(companies|stocks|firms)\b.{0,40}\bby\b.{0,30}\b(order book|revenue|margin|market cap|order intake)\b/i;

export const isUnsupportedSectorDiscovery = (text) => RANKING_DISCOVERY_PHRASES.test(text) && !containsKnownSymbol(text);

/**
 * deterministicIntent - obvious, cheap-to-detect cases run BEFORE the
 * model, per Phase 3: "Simple deterministic rules may run before the
 * model for: obvious stock symbols, explicit price requests, explicit
 * watchlist/portfolio requests, known Earnings Intelligence phrases, empty
 * or invalid input." Returns null when no deterministic rule applies —
 * the LLM classifier decides then.
 */
export const deterministicIntent = (message) => {
  const text = message.trim();
  if (!text) return { intent: 'UNSUPPORTED', confidence: 1, reasoning: 'Empty input.' };

  if (WATCHLIST_PHRASES.test(text)) return { intent: 'WATCHLIST_ANALYSIS', confidence: 0.9, reasoning: 'Explicit watchlist reference.' };
  if (PORTFOLIO_PHRASES.test(text)) return { intent: 'PORTFOLIO_ANALYSIS', confidence: 0.9, reasoning: 'Explicit portfolio reference.' };

  if (COMPARISON_PHRASES.test(text) && containsKnownSymbol(text)) {
    return { intent: 'STOCK_COMPARISON', confidence: 0.85, reasoning: 'Comparison phrasing with recognizable symbols.' };
  }

  if (PRICE_PHRASES.test(text) && containsKnownSymbol(text)) {
    return { intent: 'LIVE_MARKET_DATA', confidence: 0.9, reasoning: 'Explicit price request for a known symbol.' };
  }

  if (CHART_PHRASES.test(text) && containsKnownSymbol(text)) {
    return { intent: 'LIVE_MARKET_DATA', confidence: 0.9, reasoning: 'Explicit chart/historical-price request for a known symbol.' };
  }

  if (EARNINGS_PHRASES.test(text)) {
    return { intent: 'EARNINGS_INTELLIGENCE', confidence: 0.8, reasoning: 'Known Earnings Intelligence phrasing.' };
  }

  if (isUnsupportedSectorDiscovery(text)) {
    return { intent: 'UNSUPPORTED', confidence: 0.95, reasoning: 'Sector-wide ranking/discovery request — no sector-universe or ranking tool exists; only per-company lookups are supported.' };
  }

  return null;
};

/**
 * classifyIntent - deterministic rules first, then a structured-output
 * model call. A malformed model response gets exactly one retry before
 * falling back to UNSUPPORTED with a warning (never crashes the graph).
 */
export const classifyIntent = async (state) => {
  if (state.errors.length) return {}; // validateInput already rejected this turn
  if (state.onEvent) state.onEvent({ type: 'status', message: 'Understanding your question…' });

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');

  const deterministic = deterministicIntent(text);
  if (deterministic) {
    return { intent: deterministic.intent, intentConfidence: deterministic.confidence };
  }

  if (!OpenAIClientFactory.isConfigured()) {
    return { intent: 'UNSUPPORTED', intentConfidence: 0, warnings: ['GS Copilot is not configured (missing OpenAI API key).'] };
  }

  const attempt = () => invokeRoutingModel({
    node: 'classifyIntent',
    model: LLM_CONFIG.routingModel,
    maxTokens: 200,
    schema: IntentSchema,
    schemaName: 'intent_classification',
    prompt: intentPrompt(text, state.conversationSummary, state.activeEntities),
    signal: state.abortSignal,
    deadlineAt: state.deadlineAt,
  });

  const first = await attempt();
  if (first.parsed) {
    return { intent: first.parsed.intent, intentConfidence: first.parsed.confidence, llmCalls: [first.diagnostic] };
  }
  if (first.error === 'CANCELLED' || first.error === SKIPPED_NO_BUDGET) {
    return { intent: 'UNSUPPORTED', intentConfidence: 0, llmCalls: [first.diagnostic], warnings: ['Ran out of time understanding your question — please try again.'] };
  }

  logger.warn(`[Graph] classifyIntent first attempt failed (${first.error}). Retrying once.`);
  const second = await attempt();
  if (second.parsed) {
    return { intent: second.parsed.intent, intentConfidence: second.parsed.confidence, llmCalls: [first.diagnostic, second.diagnostic] };
  }
  logger.warn(`[Graph] classifyIntent failed after retry (${second.error}).`);
  return {
    intent: 'UNSUPPORTED',
    intentConfidence: 0,
    llmCalls: [first.diagnostic, second.diagnostic],
    warnings: [second.error === 'CANCELLED' ? 'Generation was stopped.' : 'Could not classify your question — please try rephrasing it.'],
  };
};

export default classifyIntent;
