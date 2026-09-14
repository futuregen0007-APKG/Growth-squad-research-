/**
 * dimensions.js
 * ==============
 * Phase 2 "requested-dimension planning". A strict, closed enum of the
 * KINDS of evidence a user's message can ask for, extracted deterministically
 * (regex against the raw message + the classified intent — no LLM call) so
 * a comparison request like "using financial growth, management guidance
 * and recent news" plans exactly those three data types, not everything
 * compareStocks happens to know how to fetch.
 *
 * This is the fix for the confirmed Phase 0/1 regression's second half:
 * compareStocks always fetched quote+research+financials and NEVER fetched
 * news or guidance, regardless of what was actually asked — see
 * tools/toolRegistry.js's redesigned compareStocks, which now fans out
 * only to the dimensions resolved here.
 */

export const REQUESTED_DIMENSIONS = Object.freeze([
  'PRICE', 'FINANCIALS', 'COMPANY_RESEARCH', 'NEWS', 'GUIDANCE', 'DOCUMENTS', 'PORTFOLIO', 'WATCHLIST', 'GENERAL',
]);

// Order here is display/priority order (used to truncate under a budget —
// see compareStocks' MAX_COMPARISON_OPERATIONS), not detection order —
// every pattern below is tested independently against the full message.
const DIMENSION_PATTERNS = [
  ['PRICE', /\b(price|quote|trading at|share price|current price|live price|market cap)\b/i],
  ['FINANCIALS', /\b(revenue|profit|margins?|ebitda|\bpat\b|balance sheet|cash flow|results?|earnings|performance|quarterly|q[1-4]|growth|fundamentals?)\b/i],
  ['GUIDANCE', /\b(guidance|management\s+(commentary|outlook|promise|statement)|forward[- ]looking|outlook)\b/i],
  ['NEWS', /\b(news|headlines?|announcements?|recent\s+developments?)\b/i],
  ['DOCUMENTS', /\b(filings?|annual\s+report|prospectus|investor\s+presentation|transcripts?|\bdocuments?\b)\b/i],
  ['COMPANY_RESEARCH', /\b(profile|overview|business\s+model|shareholding|corporate\s+action|analyst\s+(view|rating|forecast))\b/i],
  ['PORTFOLIO', /\bmy\s+(portfolio|holdings?)\b/i],
  ['WATCHLIST', /\bmy\s+watchlist\b/i],
];

/**
 * DEFAULT_COMPARISON_DIMENSIONS - what "compare X and Y" means with no
 * further qualifier. Deliberately excludes NEWS/GUIDANCE/DOCUMENTS/
 * PORTFOLIO/WATCHLIST — those are only ever included when the message
 * actually asks for them (see extractRequestedDimensions), never assumed.
 */
export const DEFAULT_COMPARISON_DIMENSIONS = Object.freeze(['PRICE', 'FINANCIALS', 'COMPANY_RESEARCH']);

// Intents where a keyword-free message still implies one obvious dimension
// (e.g. "What's the price of HAL?" classified LIVE_MARKET_DATA never says
// the word "price" in a way DIMENSION_PATTERNS' generic wording always
// catches, but the intent itself already says everything). STOCK_COMPARISON
// is handled separately below (falls back to DEFAULT_COMPARISON_DIMENSIONS,
// not a single dimension). Intents absent from this map (e.g. FOLLOW_UP,
// whose actual tool choice already depends on its own keyword matching in
// planTools.js) are left for DIMENSION_PATTERNS alone to decide, which may
// legitimately resolve to no dimensions at all.
const INTENT_BASE_DIMENSIONS = Object.freeze({
  LIVE_MARKET_DATA: ['PRICE'],
  NEWS_RESEARCH: ['NEWS'],
  DOCUMENT_RESEARCH: ['DOCUMENTS'],
  EARNINGS_INTELLIGENCE: ['GUIDANCE', 'FINANCIALS'],
  COMPANY_RESEARCH: ['COMPANY_RESEARCH'],
  WATCHLIST_ANALYSIS: ['WATCHLIST'],
  PORTFOLIO_ANALYSIS: ['PORTFOLIO'],
  GENERAL_EDUCATION: ['GENERAL'],
  UNSUPPORTED: ['GENERAL'],
});

/**
 * extractRequestedDimensions - deterministic, no LLM call. Returns a
 * deduplicated array drawn strictly from REQUESTED_DIMENSIONS.
 */
export const extractRequestedDimensions = (text, intent) => {
  const found = new Set();
  const message = String(text || '');
  for (const [dimension, pattern] of DIMENSION_PATTERNS) {
    if (pattern.test(message)) found.add(dimension);
  }

  if (intent === 'STOCK_COMPARISON') {
    if (!found.size) DEFAULT_COMPARISON_DIMENSIONS.forEach((d) => found.add(d));
    return [...found];
  }

  if (!found.size && INTENT_BASE_DIMENSIONS[intent]) {
    INTENT_BASE_DIMENSIONS[intent].forEach((d) => found.add(d));
  }
  return [...found];
};

export default { REQUESTED_DIMENSIONS, DEFAULT_COMPARISON_DIMENSIONS, extractRequestedDimensions };
