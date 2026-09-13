import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { EntitiesSchema } from '../schemas.js';
import { entitiesPrompt } from '../prompts/index.js';
import { SUPPORTED_STOCKS, INDEX_SYMBOLS } from '../../utils/constants.js';
import { invokeRoutingModel } from '../llmInvoke.js';
import { logger } from '../../utils/logger.js';

const KNOWN_SYMBOLS = new Set(Object.keys(SUPPORTED_STOCKS));
const TICKER_PATTERN = /\b([A-Z]{2,15})\b/g;

const deterministicSymbols = (text) => {
  const found = new Set();
  for (const match of text.toUpperCase().matchAll(TICKER_PATTERN)) {
    if (KNOWN_SYMBOLS.has(match[1]) || INDEX_SYMBOLS[match[1]]) found.add(match[1]);
  }
  return [...found];
};

// Matches "Q2 FY26", "Q2FY2026", "FY26", "FY2026" (2- or 4-digit year,
// optional apostrophe, optional space/no-space between quarter and FY).
// Normalizes to "Q2 FY2026" / "FY2026" so downstream period-matching (see
// utils/financialNormalization.js's parseFiscalPeriod, already used by
// Earnings Intelligence) recognizes the same shape.
//
// This is a pure regex extraction — it runs even on the deterministic
// symbol fast path, which previously hardcoded periods: [] unconditionally
// and so NEVER captured an explicit period like "Q2 FY26" from a message
// such as "Analyse HAL Q2 FY26 results" (confirmed bug: the message
// contained a real period, but extractEntities discarded it before the
// tool layer or evidence matching ever saw it).
const PERIOD_PATTERN = /\bQ([1-4])\s*['’]?\s*FY\s*(\d{2,4})\b|\bFY\s*(\d{2,4})\b/gi;

const normalizeYear = (raw) => (raw.length === 2 ? `20${raw}` : raw);

const deterministicPeriods = (text) => {
  const found = new Set();
  for (const match of text.matchAll(PERIOD_PATTERN)) {
    if (match[1] && match[2]) {
      found.add(`Q${match[1]} FY${normalizeYear(match[2])}`);
    } else if (match[3]) {
      found.add(`FY${normalizeYear(match[3])}`);
    }
  }
  return [...found];
};

// Intents where entity extraction is never needed — skipping saves a model
// call (Phase 11: "do not call every question every tool" applies equally
// to LLM calls, not just tools).
const SKIP_ENTITY_EXTRACTION_INTENTS = new Set(['GENERAL_EDUCATION', 'UNSUPPORTED']);

export const extractEntities = async (state) => {
  if (state.errors.length) return {};
  if (SKIP_ENTITY_EXTRACTION_INTENTS.has(state.intent)) return {};

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');
  const symbolsFromText = deterministicSymbols(text);
  const periodsFromText = deterministicPeriods(text);

  // Deterministic fast path: obvious symbols present and the message
  // doesn't look like a follow-up (no pronoun referring back). Skips the
  // model call entirely when it's unambiguous. Periods are always
  // extracted deterministically (see PERIOD_PATTERN above) regardless of
  // which path runs — this used to be hardcoded to [] here.
  const looksLikeFollowUp = state.intent === 'FOLLOW_UP' || /\b(it|its|that company|them|those)\b/i.test(text);
  if (symbolsFromText.length && !looksLikeFollowUp) {
    return {
      entities: { symbols: symbolsFromText, companyNames: [], periods: periodsFromText, comparisonMode: /\b(compare|vs\.?|versus)\b/i.test(text) },
    };
  }

  if (!OpenAIClientFactory.isConfigured()) {
    return { entities: { symbols: symbolsFromText, companyNames: [], periods: periodsFromText, comparisonMode: false } };
  }

  const { parsed, error, diagnostic } = await invokeRoutingModel({
    node: 'extractEntities',
    model: LLM_CONFIG.routingModel,
    maxTokens: 300,
    schema: EntitiesSchema,
    schemaName: 'entity_extraction',
    prompt: entitiesPrompt(text, state.activeEntities),
    signal: state.abortSignal,
    deadlineAt: state.deadlineAt,
  });

  if (parsed) {
    // Union deterministic symbol/period matches with the model's — belt-and-braces.
    const symbols = [...new Set([...symbolsFromText, ...parsed.symbols.map((s) => s.toUpperCase())])];
    const periods = [...new Set([...periodsFromText, ...parsed.periods])];
    return { entities: { ...parsed, symbols, periods }, llmCalls: [diagnostic] };
  }

  logger.warn(`[Graph] extractEntities failed: ${error}`);
  return {
    entities: { symbols: symbolsFromText, companyNames: [], periods: periodsFromText, comparisonMode: false },
    llmCalls: [diagnostic],
    warnings: symbolsFromText.length || error === 'CANCELLED' ? [] : ['Could not resolve which company you meant — please name it directly.'],
  };
};

export default extractEntities;
