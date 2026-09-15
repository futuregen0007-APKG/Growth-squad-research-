/**
 * researchScope.js
 * =================
 * Phase 4B Part 3 + Phase 4C: deterministic query understanding/routing
 * for the grounded RAG answer flow. Pure functions, no LLM call, no I/O —
 * reuses entity resolution extractEntities.js has ALREADY done
 * deterministically (SUPPORTED_STOCKS-based ticker/company-name matching,
 * which never guesses an ambiguous company — see that module's own note)
 * rather than re-implementing company resolution here.
 *
 * Phase 4C root-cause fix: classifyIntent.js's deterministic EARNINGS_PHRASES
 * rule (graph/nodes/classifyIntent.js) matches the bare word "guidance" (also
 * "promise", "track record", "fulfilled", ...) and short-circuits straight to
 * EARNINGS_INTELLIGENCE BEFORE the LLM classifier ever runs — so "search TCS
 * filings for revenue guidance" and "what does the annual report say about
 * guidance" both get labeled EARNINGS_INTELLIGENCE, never DOCUMENT_RESEARCH,
 * confirmed live. Gating the grounded RAG flow on `state.intent ===
 * 'DOCUMENT_RESEARCH'` therefore misses the large majority of real natural
 * guidance/promise/document questions.
 *
 * Fix: classifyResearchQuestionType below is a SECOND, independent,
 * deterministic classifier over the raw message text — it never looks at
 * `state.intent` at all, so a "wrong" intent label from classifyIntent.js
 * can no longer block the grounded route. classifyIntent.js itself is
 * deliberately left UNCHANGED (it has its own extensive test suite —
 * chatIntentRouting.test.js — and other consumers depend on its exact
 * EARNINGS_INTELLIGENCE/COMPANY_RESEARCH/etc. behavior elsewhere); intent
 * is only used here as a coarse, LOW-risk pre-filter (excluding
 * LIVE_MARKET_DATA/WATCHLIST_ANALYSIS/PORTFOLIO_ANALYSIS/STOCK_COMPARISON/
 * GENERAL_EDUCATION/UNSUPPORTED, none of which are ever a single-company
 * document/guidance question).
 */

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

const COMPARISON_PATTERN = /\bcompare\b|\bcompared to\b|\bversus\b|\bvs\.?\b|\bdifference between\b/i;
const CURRENT_GUIDANCE_PATTERN = /\b(current|latest|this year'?s?|now|going forward)\s+(guidance|outlook|target)/i;

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
  if (/\b(actual|achieved|delivered|reported)\s+(results?|revenue|numbers?|performance)\b|\bdid\s+.{0,30}?\b(meet|achieve|achieved|beat|miss)\b|\bwas\s+the\s+(guidance|target)\s+met\b/i.test(value)) return 'outcome';
  if (/\brevis(e|ed|ion)|\bupdated\s+(guidance|outlook|forecast|target)|\braised?\s+(guidance|outlook)|\blowered\s+(guidance|outlook)|\bchanged\s+(its\s+)?guidance/i.test(value)) return 'revised_guidance';
  if (CURRENT_GUIDANCE_PATTERN.test(value)) return 'current_guidance';
  return 'historical';
};

// ---------------------------------------------------------------------------
// Phase 4C Part 2: the deterministic research-question-type routing policy.
// Checked in this exact priority order — several categories share the word
// "guidance", so a more specific category (REVISED_GUIDANCE,
// PROMISE_VS_OUTCOME) must be tried before the broad MANAGEMENT_GUIDANCE
// catch-all, and both DOCUMENT/EARNINGS_CALL checks before the FINANCIAL_
// RESULTS fallback, or a revised-guidance question would be misclassified.
// ---------------------------------------------------------------------------
export const RESEARCH_QUESTION_TYPES = Object.freeze([
  'REVISED_GUIDANCE',
  'PROMISE_VS_OUTCOME',
  'MANAGEMENT_GUIDANCE',
  'EARNINGS_CALL_STATEMENT',
  'DOCUMENT_FILING_QUESTION',
  'FINANCIAL_RESULTS',
  'NORMAL_STOCK_DATA',
]);

const REVISED_GUIDANCE_TYPE_PATTERN = /\brevis(e|ed|ion|ing)\b|\bupdated\s+(guidance|outlook|forecast|target)\b|\b(raised?|lowered|cut|narrowed)\s+(its\s+)?(guidance|outlook|forecast|target)\b|\bchanged\s+(its\s+)?guidance\b|\boriginal\s+and\s+revised\s+guidance\b/i;
const PROMISE_VS_OUTCOME_TYPE_PATTERN = /\bdid\s+.{0,30}?\b(meet|achieve|deliver|fulfil{1,2}|keep|beat|miss)\b|\bpromise[sd]?\b.{0,30}?\b(deliver(ed)?|achiev(e|ed)|meet|met|fulfil{1,2}(led)?|keep|kept)\b|\b(deliver(ed)?|achiev(e|ed)|meet|met|fulfil{1,2}(led)?)\b.{0,30}?\bpromise[sd]?\b|\bpromise[sd]?\s+vs\.?\s+(outcome|actual|result)\b|\btrack\s+record\b|\bmissed\s+target\b/i;
const MANAGEMENT_GUIDANCE_TYPE_PATTERN = /\bguidance\b|\boutlook\b|\bforecast\b/i;
const EARNINGS_CALL_TYPE_PATTERN = /\bearnings\s+call\b|\bconference\s+call\b|\bcall\s+transcript\b|\bmanagement\s+(say|says|said|state|states|stated|comment|commented|remark|remarked|commentary)\b/i;
const DOCUMENT_FILING_TYPE_PATTERN = /\b(documents?|filings?|filed|annual\s+report|prospectus|excerpts?)\b|\bsearch\b.{0,20}\b(documents?|filings?|reports?)\b|\bfind\b.{0,20}\b(documents?|filings?|reports?|mentions?)\b|\blook\s+through\b/i;
const FINANCIAL_RESULTS_TYPE_PATTERN = /\b(results?|revenue|profit|margins?|ebitda|\bpat\b)\b.{0,25}?\b(reported|actual|announced|posted|declared|was|were|grew|grow|fell|rose)\b|\bQ[1-4]\b.{0,25}?\b(results?|revenue|profit|margins?)\b|\b(results?|revenue|profit|margins?)\b.{0,25}?\bQ[1-4]\b/i;

/**
 * classifyResearchQuestionType - the Phase 4C routing policy's core
 * decision. Deterministic, text-only, never consults `intent` — this is
 * exactly what makes it immune to classifyIntent.js's EARNINGS_PHRASES
 * short-circuit (see this module's top note).
 */
export const classifyResearchQuestionType = (text) => {
  const value = String(text || '');
  if (REVISED_GUIDANCE_TYPE_PATTERN.test(value)) return 'REVISED_GUIDANCE';
  if (PROMISE_VS_OUTCOME_TYPE_PATTERN.test(value)) return 'PROMISE_VS_OUTCOME';
  if (MANAGEMENT_GUIDANCE_TYPE_PATTERN.test(value)) return 'MANAGEMENT_GUIDANCE';
  if (EARNINGS_CALL_TYPE_PATTERN.test(value)) return 'EARNINGS_CALL_STATEMENT';
  if (DOCUMENT_FILING_TYPE_PATTERN.test(value)) return 'DOCUMENT_FILING_QUESTION';
  if (FINANCIAL_RESULTS_TYPE_PATTERN.test(value)) return 'FINANCIAL_RESULTS';
  return 'NORMAL_STOCK_DATA';
};

// The question types that are genuinely narrative/document-shaped research
// questions the grounded RAG corpus (earnings-call transcripts, press
// releases, annual reports, exchange filings) can actually answer.
// FINANCIAL_RESULTS/NORMAL_STOCK_DATA are deliberately EXCLUDED — a plain
// "what was Q4 revenue" numeric question is answered more precisely and
// reliably by the EXISTING getCompanyFinancials/getCompanyResearch numeric
// pipeline (Part 3: "preserve existing... do not replace") than by
// retrieving narrative document text for the same fact.
export const GROUNDED_RESEARCH_QUESTION_TYPES = new Set([
  'REVISED_GUIDANCE', 'PROMISE_VS_OUTCOME', 'MANAGEMENT_GUIDANCE', 'EARNINGS_CALL_STATEMENT', 'DOCUMENT_FILING_QUESTION',
]);

// Of those, exactly the guidance/promise-tracking categories ALSO merge in
// Earnings Intelligence's own structured promise/outcome evidence (Part 5:
// "if Earnings Intelligence supplies structured evidence, normalize it into
// the trusted EvidenceEnvelope") — EARNINGS_CALL_STATEMENT/DOCUMENT_FILING_
// QUESTION are plain narrative-document lookups with no promise-tracking
// angle, so merging Earnings Intelligence data there would add irrelevant
// evidence, not useful context.
export const MERGE_EARNINGS_INTELLIGENCE_TYPES = new Set(['REVISED_GUIDANCE', 'PROMISE_VS_OUTCOME', 'MANAGEMENT_GUIDANCE']);

// Coarse, LOW-risk intent-level pre-filter (Part 7: never touches
// classifyIntent.js itself). Excludes intents that can never legitimately
// be a single-company document/guidance question: live price lookups,
// watchlist/portfolio analysis (no single company at all), a genuine
// multi-company STOCK_COMPARISON (compareStocks already has its own
// well-tested dimension-aware pipeline — see toolRegistry.js), and the two
// intents that carry no company context whatsoever.
const INELIGIBLE_INTENTS = new Set([
  'GENERAL_EDUCATION', 'UNSUPPORTED', 'LIVE_MARKET_DATA', 'WATCHLIST_ANALYSIS', 'PORTFOLIO_ANALYSIS', 'STOCK_COMPARISON',
]);

// Retained for backward compatibility with any earlier Phase 4B caller —
// no longer the gating decision itself (see resolveResearchScope), which
// now depends on the deterministic text classifier above, not a bare
// intent-membership check.
export const RESEARCH_GROUNDED_INTENTS = new Set(['DOCUMENT_RESEARCH']);

/**
 * resolveResearchScope - the single deterministic entry point every
 * grounded-RAG-aware node calls. Returns:
 *   - needsResearchCorpus: whether this question should go through the
 *     grounded RAG flow at all (Phase 4C: independent of `intent`'s exact
 *     label — see classifyResearchQuestionType)
 *   - researchQuestionType: one of RESEARCH_QUESTION_TYPES
 *   - mergeEarningsIntelligence: whether Earnings Intelligence's own
 *     structured evidence should also be retrieved and merged in
 *   - ambiguousCompany: true when the corpus is needed but no single
 *     company could be safely resolved (extractEntities already refused
 *     to guess) — caller must ask for clarification, never retrieve for a
 *     substitute company
 *   - symbol / fiscalYear / fiscalQuarter / period: the resolved scope
 *     retrieval and verification must both honor exactly
 *   - guidanceIntent: 'current_guidance' | 'historical' | 'revised_guidance' | 'outcome' | 'comparison'
 */
export const resolveResearchScope = ({ text, entities = {}, intent } = {}) => {
  const symbols = entities.symbols || [];
  const guidanceIntent = classifyGuidanceIntent(text);
  const researchQuestionType = classifyResearchQuestionType(text);
  const needsResearchCorpus = !INELIGIBLE_INTENTS.has(intent) && GROUNDED_RESEARCH_QUESTION_TYPES.has(researchQuestionType);

  if (!needsResearchCorpus) {
    return {
      needsResearchCorpus: false, researchQuestionType, mergeEarningsIntelligence: false, ambiguousCompany: false, symbol: null, symbols, fiscalYear: null, fiscalQuarter: null, period: null, guidanceIntent,
    };
  }

  // The grounded RAG flow retrieves for exactly ONE resolved company per
  // turn — a multi-company research request is treated as ambiguous here
  // rather than silently retrieving for only the first one named, exactly
  // like zero resolved symbols is.
  const ambiguousCompany = symbols.length !== 1;
  const symbol = ambiguousCompany ? null : symbols[0];

  const period = (entities.periods || [])[0] || null;
  const { fiscalYear, fiscalQuarter } = splitFiscalPeriod(period);

  return {
    needsResearchCorpus: true,
    researchQuestionType,
    mergeEarningsIntelligence: MERGE_EARNINGS_INTELLIGENCE_TYPES.has(researchQuestionType),
    ambiguousCompany,
    symbol,
    symbols,
    fiscalYear,
    fiscalQuarter,
    period,
    guidanceIntent,
  };
};

export default {
  resolveResearchScope, classifyGuidanceIntent, classifyResearchQuestionType, splitFiscalPeriod,
  RESEARCH_GROUNDED_INTENTS, RESEARCH_QUESTION_TYPES, GROUNDED_RESEARCH_QUESTION_TYPES, MERGE_EARNINGS_INTELLIGENCE_TYPES,
};
