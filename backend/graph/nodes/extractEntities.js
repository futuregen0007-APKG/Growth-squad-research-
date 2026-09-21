import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { EntitiesSchema } from '../schemas.js';
import { entitiesPrompt } from '../prompts/index.js';
import { SUPPORTED_STOCKS, INDEX_SYMBOLS } from '../../utils/constants.js';
import { invokeRoutingModel } from '../llmInvoke.js';
import { extractRequestedDimensions } from '../dimensions.js';
import { logger } from '../../utils/logger.js';

const KNOWN_SYMBOLS = new Set(Object.keys(SUPPORTED_STOCKS));
const TICKER_PATTERN = /\b([A-Z]{2,15})\b/g;

/**
 * Company-name directory, derived from SUPPORTED_STOCKS's existing
 * ticker->name map (single source of truth — never a second, hand-typed
 * list to fall out of sync). Fixes the confirmed Phase 0/1 regression:
 * "Compare TCS and Infosys" only ever resolved TCS, because "Infosys" is
 * the company's real NAME, not its ticker (INFY), so the ticker-only regex
 * above never saw it, and the old deterministic fast path returned before
 * anything else even looked at the rest of the message.
 *
 * Deliberately matches each symbol's FULL real name only (case-insensitive,
 * "&"/"and" interchangeable, flexible whitespace) — never a prefix or
 * partial name. That is what keeps this "never guess": e.g. "HDFC" alone
 * matches neither "HDFC Bank" nor "HDFC Life" as a whole phrase, so a
 * genuinely ambiguous short form correctly finds nothing here and falls
 * through to the LLM path below, rather than silently picking one.
 */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildCompanyNameRegex = (name) => {
  const escaped = escapeRegExp(name).replace(/&/g, '(?:&|and)').replace(/ /g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i');
};

const COMPANY_NAME_DIRECTORY = Object.entries(SUPPORTED_STOCKS)
  .filter(([, info]) => info?.name && info.name.trim().length > 2)
  .map(([symbol, info]) => ({ symbol, name: info.name, regex: buildCompanyNameRegex(info.name) }));

/** Ticker mentions (e.g. "TCS", "HAL") with their position in the original text, for order-preserving merges with company-name mentions below. */
const findTickerMentions = (text) => {
  const mentions = [];
  for (const match of text.toUpperCase().matchAll(TICKER_PATTERN)) {
    const token = match[1];
    if (KNOWN_SYMBOLS.has(token) || INDEX_SYMBOLS[token]) mentions.push({ symbol: token, index: match.index });
  }
  return mentions;
};

/** Full company-name mentions (e.g. "Infosys", "Tata Consultancy Services") with their position in the original text. */
const findCompanyNameMentions = (text) => {
  const mentions = [];
  for (const entry of COMPANY_NAME_DIRECTORY) {
    const match = entry.regex.exec(text);
    if (match) mentions.push({ symbol: entry.symbol, index: match.index });
  }
  return mentions;
};

/**
 * deterministicSymbols - resolves EVERY symbol mentioned in the full
 * message, by ticker OR by real company name, in the order first
 * mentioned, deduplicated. Runs deterministically (no LLM) so it is safe
 * to always run first — see extractEntities' fast path below, which now
 * only skips the model call once this has looked at the whole message,
 * not just its first recognizable token.
 */
const deterministicSymbols = (text) => {
  const combined = [...findTickerMentions(text), ...findCompanyNameMentions(text)]
    .sort((a, b) => a.index - b.index);
  const symbols = [];
  const seen = new Set();
  for (const { symbol } of combined) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
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

/** Canonical real names for a resolved symbol list — reuses SUPPORTED_STOCKS (the same single source of truth COMPANY_NAME_DIRECTORY is built from) rather than tracking a second parallel list; drops symbols with no directory entry (e.g. an index basket) rather than guessing a name. */
const companyNamesFor = (symbols) => symbols.map((symbol) => SUPPORTED_STOCKS[symbol]?.name).filter(Boolean);

export const extractEntities = async (state) => {
  if (state.errors.length) return {};
  if (SKIP_ENTITY_EXTRACTION_INTENTS.has(state.intent)) return {};

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');
  const symbolsFromText = deterministicSymbols(text);
  const periodsFromText = deterministicPeriods(text);
  // Requested-dimension planning (graph/dimensions.js) — purely a function
  // of the message text + classified intent, so it's computed once here
  // and included on every return path below, independent of which symbol-
  // resolution branch (fast path / LLM / fallback) ends up running.
  const requestedDimensions = extractRequestedDimensions(text, state.intent);

  // Deterministic fast path: skips the model call entirely when the whole
  // message is unambiguous and doesn't look like a follow-up (no pronoun
  // referring back). deterministicSymbols above now resolves EVERY symbol
  // mentioned by ticker OR real company name across the FULL message
  // (fixing the confirmed regression where "Compare TCS and Infosys" only
  // ever found TCS, because the old fast path returned as soon as it saw
  // the first ticker and never looked for "Infosys" by name) — so this
  // path is safe to take whenever it finds at least one symbol, not just
  // when the message happens to be a single bare ticker.
  const looksLikeFollowUp = state.intent === 'FOLLOW_UP' || /\b(it|its|that company|them|those)\b/i.test(text);
  if (symbolsFromText.length && !looksLikeFollowUp) {
    return {
      entities: {
        symbols: symbolsFromText, companyNames: companyNamesFor(symbolsFromText), periods: periodsFromText,
        comparisonMode: /\b(compare|vs\.?|versus)\b/i.test(text),
      },
      requestedDimensions,
    };
  }

  if (!OpenAIClientFactory.isConfigured()) {
    return {
      entities: { symbols: symbolsFromText, companyNames: companyNamesFor(symbolsFromText), periods: periodsFromText, comparisonMode: false },
      requestedDimensions,
    };
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
    // UI Phase 1D fix: the model's own `parsed.periods` guesses are
    // re-validated through the SAME deterministic PERIOD_PATTERN regex
    // (never trusted as free text) — a confirmed live bug had the model
    // return "last 90 days" (a chart date-RANGE phrase, from "show me a
    // chart of TCS price history for the last 90 days") as if it were a
    // fiscal reporting period. That string then poisoned
    // claimPlan.js's unmatchedRequestedPeriods (no financial metric row
    // is ever reported "for the period last 90 days"), which produced a
    // FALSE "I hold no data for LAST 90 DAYS" sentence in
    // buildSafeFallback.js even though getPriceHistory had genuinely
    // succeeded. deterministicPeriods() run over each LLM-suggested
    // string discards anything that isn't actually shaped like "Q2
    // FY2024"/"FY2023" — see entitiesPrompt's own updated wording for the
    // other half of this fix.
    const periods = [...new Set([...periodsFromText, ...parsed.periods.flatMap((p) => deterministicPeriods(String(p)))])];
    return {
      entities: { ...parsed, symbols, periods }, llmCalls: [diagnostic], requestedDimensions,
    };
  }

  logger.warn(`[Graph] extractEntities failed: ${error}`);
  return {
    entities: { symbols: symbolsFromText, companyNames: companyNamesFor(symbolsFromText), periods: periodsFromText, comparisonMode: false },
    llmCalls: [diagnostic],
    warnings: symbolsFromText.length || error === 'CANCELLED' ? [] : ['Could not resolve which company you meant — please name it directly.'],
    requestedDimensions,
  };
};

export default extractEntities;
