/**
 * researchScope.js
 * =================
 * Phase 4B Part 3: deterministic query understanding/routing for the
 * grounded RAG answer flow. Pure function, no LLM call and no I/O — reuses
 * entity resolution extractEntities.js has ALREADY done deterministically
 * (SUPPORTED_STOCKS-based ticker/company-name matching, which never
 * guesses an ambiguous company — see that module's own note) rather than
 * re-implementing company resolution here.
 *
 * "Never guess an ambiguous company": if extractEntities resolved zero
 * symbols (its own fast path only ever returns a symbol it is CERTAIN
 * about) or resolved more than one without comparison intent, this module
 * reports `ambiguousCompany: true` and the caller (composeAnswer.js's
 * grounded branch) must respond with a clarification request instead of
 * retrieving for an arbitrary one of them.
 */

const REVISED_GUIDANCE_PATTERN = /\b(revised|updated|new|raised|lowered|cut)\s+(guidance|outlook|target)/i;
const OUTCOME_PATTERN = /\b(actual|achieved|delivered|reported)\s+(results?|revenue|numbers?|performance)\b|\bdid\s+.{0,30}?\b(meet|achieve|achieved|beat|miss)\b|\bwas\s+the\s+(guidance|target)\s+met\b/i;
const COMPARISON_PATTERN = /\bcompare|\bcompared to\b|\bversus\b|\bvs\.?\b|\bdifference between\b/i;
const CURRENT_GUIDANCE_PATTERN = /\b(current|latest|this year'?s?|now|going forward)\s+(guidance|outlook|target)/i;

const FISCAL_QUARTER_PATTERN = /^Q([1-4])\s+FY(\d{4})$/;
const FISCAL_YEAR_ONLY_PATTERN = /^FY(\d{4})$/;

/** Splits an already-normalized "Q2 FY2026" / "FY2026" period string (see extractEntities.js's deterministicPeriods) into its fiscal year and quarter parts. */
export const splitFiscalPeriod = (period) => {
  if (!period) return { fiscalYear: null, fiscalQuarter: null };
  const withQuarter = FISCAL_QUARTER_PATTERN.exec(period);
  if (withQuarter) return { fiscalYear: `FY${withQuarter[2]}`, fiscalQuarter: `Q${withQuarter[1]}` };
  const yearOnly = FISCAL_YEAR_ONLY_PATTERN.exec(period);
  if (yearOnly) return { fiscalYear: `FY${yearOnly[1]}`, fiscalQuarter: null };
  return { fiscalYear: null, fiscalQuarter: null };
};

/**
 * classifyGuidanceIntent - "current guidance vs historical guidance vs
 * outcome vs comparison" (Part 3). Defaults to 'historical' rather than
 * 'current' when nothing matches — a plain "what was FY2023 guidance?"
 * question is about a specific past disclosure, not implicitly "the
 * latest one," and the deterministic verifier's superseded-guidance check
 * (graph/groundedVerification.js) depends on not silently assuming "current".
 */
export const classifyGuidanceIntent = (text) => {
  const value = String(text || '');
  if (COMPARISON_PATTERN.test(value)) return 'comparison';
  if (OUTCOME_PATTERN.test(value)) return 'outcome';
  if (REVISED_GUIDANCE_PATTERN.test(value)) return 'revised_guidance';
  if (CURRENT_GUIDANCE_PATTERN.test(value)) return 'current_guidance';
  return 'historical';
};

// Intents where the grounded RAG flow is actually the right consumer of
// retrieved evidence at all — DOCUMENT_RESEARCH is document/filing search
// by construction; other intents (LIVE_MARKET_DATA, financials, etc.) keep
// using the existing Phase 1-3 tool pipeline unchanged (Part 2: "do not
// silently switch providers" applies equally to not silently switching
// intents into a pipeline they were never meant for).
export const RESEARCH_GROUNDED_INTENTS = new Set(['DOCUMENT_RESEARCH']);

/**
 * resolveResearchScope - the single deterministic entry point Part 3 asks
 * for. Returns:
 *   - needsResearchCorpus: whether this question should go through the
 *     grounded RAG flow at all
 *   - ambiguousCompany: true when the corpus is needed but no single
 *     company could be safely resolved (extractEntities already refused
 *     to guess) — caller must ask for clarification, never retrieve for a
 *     substitute company
 *   - symbol / fiscalYear / fiscalQuarter / period: the resolved scope
 *     retrieval and verification must both honor exactly
 *   - guidanceIntent: 'current_guidance' | 'historical' | 'revised_guidance' | 'outcome' | 'comparison'
 */
export const resolveResearchScope = ({ text, entities = {}, intent } = {}) => {
  const needsResearchCorpus = RESEARCH_GROUNDED_INTENTS.has(intent);
  const symbols = entities.symbols || [];
  const guidanceIntent = classifyGuidanceIntent(text);

  if (!needsResearchCorpus) {
    return {
      needsResearchCorpus: false, ambiguousCompany: false, symbol: null, symbols, fiscalYear: null, fiscalQuarter: null, period: null, guidanceIntent,
    };
  }

  // The grounded RAG flow retrieves for exactly ONE resolved company per
  // turn — a multi-company DOCUMENT_RESEARCH request (rare; comparisons
  // normally route to STOCK_COMPARISON/compareStocks instead) is treated
  // as ambiguous here rather than silently retrieving for only the first
  // one named, exactly like zero resolved symbols is.
  const ambiguousCompany = symbols.length !== 1;
  const symbol = ambiguousCompany ? null : symbols[0];

  const period = (entities.periods || [])[0] || null;
  const { fiscalYear, fiscalQuarter } = splitFiscalPeriod(period);

  return {
    needsResearchCorpus: true,
    ambiguousCompany,
    symbol,
    symbols,
    fiscalYear,
    fiscalQuarter,
    period,
    guidanceIntent,
  };
};

export default { resolveResearchScope, classifyGuidanceIntent, splitFiscalPeriod, RESEARCH_GROUNDED_INTENTS };
