/**
 * claimValidation.js
 * ====================
 * Phase 3's deterministic validation layer — runs BEFORE any LLM verifier
 * call, on every draft answer, regardless of intent. Pure functions over
 * plain data (draft text + evidence + coverage), no I/O, no LLM call, so
 * every rule here is directly unit-testable and mechanically verifiable —
 * exactly the checks that DON'T need semantic judgement.
 *
 * What this file deliberately does NOT try to do: attribute a specific
 * sentence to a specific symbol/period when multiple are legitimately in
 * play (e.g. "TCS evidence used for an INFY claim" inside a TCS-vs-INFY
 * comparison, where both symbols are legitimately cited SOMEWHERE in the
 * answer). That requires reading the prose semantically — see
 * nodes/validateFinalAnswer.js's structured claim verifier
 * (needsClaimVerifier below decides exactly when that extra LLM call is
 * actually worth making).
 */

export const SAFE_VALIDATION_REASONS = Object.freeze({
  GUARANTEE_LANGUAGE: 'GUARANTEE_LANGUAGE',
  UNSAFE_BUY_SELL_DIRECTIVE: 'UNSAFE_BUY_SELL_DIRECTIVE',
  MISSING_LIVE_PRICE_TIMESTAMP: 'MISSING_LIVE_PRICE_TIMESTAMP',
  CITATION_OUT_OF_RANGE: 'CITATION_OUT_OF_RANGE',
  CITED_EVIDENCE_SYMBOL_NOT_REQUESTED: 'CITED_EVIDENCE_SYMBOL_NOT_REQUESTED',
  CITED_EVIDENCE_PERIOD_MISMATCH: 'CITED_EVIDENCE_PERIOD_MISMATCH',
  UNCITED_FACTUAL_CLAIM: 'UNCITED_FACTUAL_CLAIM',
  ZERO_EVIDENCE_FACTUAL_CLAIM: 'ZERO_EVIDENCE_FACTUAL_CLAIM',
  PRICE_WITHOUT_EVIDENCE: 'PRICE_WITHOUT_EVIDENCE',
  FINANCIALS_WITHOUT_EVIDENCE: 'FINANCIALS_WITHOUT_EVIDENCE',
  NEWS_WITHOUT_EVIDENCE: 'NEWS_WITHOUT_EVIDENCE',
  GUIDANCE_AS_ACHIEVED_WITHOUT_OUTCOME: 'GUIDANCE_AS_ACHIEVED_WITHOUT_OUTCOME',
});

// Same set validateEvidence.js already uses for "does this intent
// inherently need company-specific facts" — re-declared here (rather than
// imported) to avoid a two-way dependency between graph/nodes/* and this
// plain-data module; kept in sync deliberately (both are short, stable
// lists changed together whenever intents change).
//
// Hardening: WATCHLIST_ANALYSIS/PORTFOLIO_ANALYSIS added here (they were
// missing from the original Phase 3 list) — a watchlist/portfolio answer
// makes market claims about the user's real holdings and is exactly as
// evidence-dependent as a plain company lookup; see the hardening
// report's required verifier-eligibility policy.
const EVIDENCE_DEPENDENT_INTENTS = new Set([
  'LIVE_MARKET_DATA', 'COMPANY_RESEARCH', 'EARNINGS_INTELLIGENCE',
  'DOCUMENT_RESEARCH', 'NEWS_RESEARCH', 'STOCK_COMPARISON', 'FOLLOW_UP',
  'WATCHLIST_ANALYSIS', 'PORTFOLIO_ANALYSIS',
]);

const GUARANTEE_PATTERNS = [
  /\bguaranteed?\s+(returns?|profit|gains?|to\s+\w+)\b/i,
  /\bwill\s+definitely\s+(rise|fall|grow|increase|decrease|double)\b/i,
  /\brisk[-\s]?free\b/i,
  /\bis\s+guaranteed\s+to\b/i,
];

const UNSAFE_BUY_SELL_DIRECTIVE = /\b(buy|sell)\s+(now|immediately|today)\b/i;

const TIMESTAMP_PATTERN = /\b(\d{1,2}[:.]\d{2}|as of|20\d{2}-\d{2}-\d{2}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;

const CITATION_MARKER_PATTERN = /\[(\d+)\]/g;

const ABSTENTION_LANGUAGE = /\b(i (can'?t|cannot|could not|couldn'?t|don'?t have|do not have)|not (currently )?available|no (verifiable )?evidence|no data (was )?found|unable to (verify|find|retrieve)|i don'?t have access|temporarily unavailable)\b/i;

// A crude "this sentence asserts a specific number" signal — used only to
// decide whether an UNCITED answer even needs flagging; a citation-marker
// requirement never applies to pure prose with no numeric/₹/% claim.
const NUMERIC_CLAIM_PATTERN = /₹\s?[\d,]+(\.\d+)?|\b\d+(\.\d+)?\s?%|\b\d{2,}\b/;

const DIMENSION_ASSERTION_PATTERNS = Object.freeze({
  PRICE: /₹\s?[\d,]+|\btrading at\b|\bcurrent price\b|\bshare price (is|was|stands)\b|\blive price\b/i,
  FINANCIALS: /\b(revenue|profit|margins?|ebitda|\bpat\b)\b[^.]{0,30}\b(grew|grow|grows|increased|decreased|fell|rose|up|down)\b|\b(revenue|profit|margins?)\s+of\s+₹?\s?\d/i,
  NEWS: /\b(recent news|according to (a |the )?(news|article|report)|news outlets?|headlines?|(has |have )?announced|reported that)\b/i,
});

const ACHIEVED_LANGUAGE = /\b(achieved|delivered on|met its (target|guidance)|fulfilled|exceeded its (target|guidance))\b/i;

/** Every [N] marker in the text, split into valid (1..evidenceLength) and out-of-range indexes. Never throws, never mutates the answer. */
export const extractCitationIndexes = (text, evidenceLength) => {
  const valid = new Set();
  const outOfRange = new Set();
  for (const match of String(text || '').matchAll(CITATION_MARKER_PATTERN)) {
    const n = Number(match[1]);
    if (!Number.isInteger(n)) continue;
    if (n >= 1 && n <= evidenceLength) valid.add(n);
    else outOfRange.add(n);
  }
  return { valid, outOfRange };
};

/**
 * runDeterministicChecks - the ONE deterministic pass every draft goes
 * through, regardless of intent. Returns { issues: [SAFE_VALIDATION_REASONS...],
 * citedIndexes: Set<number> } — never throws, never calls out.
 */
export const runDeterministicChecks = ({
  draftAnswer, evidence = [], entities = {}, missingEvidence = [], intent = null, toolResults = [],
}) => {
  const text = String(draftAnswer || '');
  const issues = [];
  if (!text) return { issues, citedIndexes: new Set() };

  if (GUARANTEE_PATTERNS.some((pattern) => pattern.test(text))) {
    issues.push(SAFE_VALIDATION_REASONS.GUARANTEE_LANGUAGE);
  }
  if (UNSAFE_BUY_SELL_DIRECTIVE.test(text) && !/risk|evidence|however|consider/i.test(text)) {
    issues.push(SAFE_VALIDATION_REASONS.UNSAFE_BUY_SELL_DIRECTIVE);
  }
  if (intent === 'LIVE_MARKET_DATA' && toolResults.some((t) => t.tool === 'getLiveQuote' && t.status === 'SUCCESS') && !TIMESTAMP_PATTERN.test(text)) {
    issues.push(SAFE_VALIDATION_REASONS.MISSING_LIVE_PRICE_TIMESTAMP);
  }

  const { valid: citedIndexes, outOfRange } = extractCitationIndexes(text, evidence.length);
  if (outOfRange.size) issues.push(SAFE_VALIDATION_REASONS.CITATION_OUT_OF_RANGE);

  // A cited evidence item for a symbol that was never even part of this
  // request/conversation (entities.symbols) — a coarser, structural
  // sibling of the verifier's semantic WRONG_SYMBOL check (see the module
  // note above on why the fine-grained "right set, wrong specific one for
  // THIS sentence" case needs the verifier instead).
  const requestedSymbols = new Set((entities.symbols || []).map((s) => String(s).toUpperCase()));
  if (requestedSymbols.size) {
    const symbolMismatch = [...citedIndexes].some((n) => {
      const item = evidence[n - 1];
      return item?.symbol && !requestedSymbols.has(String(item.symbol).toUpperCase());
    });
    if (symbolMismatch) issues.push(SAFE_VALIDATION_REASONS.CITED_EVIDENCE_SYMBOL_NOT_REQUESTED);
  }

  // Same idea for an explicitly-requested reporting period — only checked
  // when the user actually named one; otherwise a natural period spread
  // across evidence is expected and not an error.
  const requestedPeriods = new Set((entities.periods || []).filter(Boolean));
  if (requestedPeriods.size) {
    const periodMismatch = [...citedIndexes].some((n) => {
      const item = evidence[n - 1];
      return item?.reportingPeriod && !requestedPeriods.has(item.reportingPeriod);
    });
    if (periodMismatch) issues.push(SAFE_VALIDATION_REASONS.CITED_EVIDENCE_PERIOD_MISMATCH);
  }

  const isEvidenceDependent = EVIDENCE_DEPENDENT_INTENTS.has(intent);
  if (isEvidenceDependent) {
    if (!evidence.length) {
      // Nothing to cite at all — a factual-sounding claim here can only
      // ever be fabricated. An answer that already reads as an honest
      // abstention is fine and not flagged.
      if (!ABSTENTION_LANGUAGE.test(text)) issues.push(SAFE_VALIDATION_REASONS.ZERO_EVIDENCE_FACTUAL_CLAIM);
    } else if (NUMERIC_CLAIM_PATTERN.test(text) && citedIndexes.size === 0) {
      issues.push(SAFE_VALIDATION_REASONS.UNCITED_FACTUAL_CLAIM);
    }
  }

  // Dimension/claim-type language mismatches — never borrow one
  // dimension's evidence-shaped language for a claim type with zero real
  // evidence of that type this turn, regardless of whether it was
  // requested (drift/hallucination is still drift/hallucination even for
  // an unrequested dimension).
  const claimTypesPresent = new Set(evidence.map((e) => e.claimType));
  if (DIMENSION_ASSERTION_PATTERNS.PRICE.test(text) && !claimTypesPresent.has('LIVE_PRICE')) {
    issues.push(SAFE_VALIDATION_REASONS.PRICE_WITHOUT_EVIDENCE);
  }
  if (DIMENSION_ASSERTION_PATTERNS.FINANCIALS.test(text) && !claimTypesPresent.has('FINANCIAL_DATA')) {
    issues.push(SAFE_VALIDATION_REASONS.FINANCIALS_WITHOUT_EVIDENCE);
  }
  if (DIMENSION_ASSERTION_PATTERNS.NEWS.test(text) && !claimTypesPresent.has('COMPANY_NEWS')) {
    issues.push(SAFE_VALIDATION_REASONS.NEWS_WITHOUT_EVIDENCE);
  }
  if (ACHIEVED_LANGUAGE.test(text) && !claimTypesPresent.has('PROMISE_OUTCOME')) {
    issues.push(SAFE_VALIDATION_REASONS.GUIDANCE_AS_ACHIEVED_WITHOUT_OUTCOME);
  }

  return { issues, citedIndexes };
};

// Intents that skip the verifier unconditionally — nothing company-
// specific is ever being asserted, so there is nothing for a claim
// verifier to check (GENERAL_EDUCATION covers greetings too — see
// classifyIntent.js, there is no separate "greeting" intent).
const SKIP_VERIFIER_INTENTS = new Set(['GENERAL_EDUCATION', 'UNSUPPORTED']);

// The ONLY intent family narrow enough that a fully deterministic mapping
// can stand in for the verifier at all — see isExactlyDeterministicallyVerified.
const SIMPLE_DETERMINISTIC_MAPPING_INTENTS = new Set(['LIVE_MARKET_DATA']);

/**
 * isExactlyDeterministicallyVerified - hardening fix: the ONLY way an
 * evidence-dependent draft with real evidence may skip the semantic
 * verifier. Deliberately narrow — every one of these must hold:
 *   - the intent is in SIMPLE_DETERMINISTIC_MAPPING_INTENTS (a plain
 *     "what's the price of X" lookup, not a comparison/analysis/news/
 *     guidance question where a citation-free or wrong-citation claim is
 *     exactly the failure mode a regex can miss — see the hardening
 *     report's worked example: "evidence exists for TCS guidance, draft
 *     makes uncited claims about TCS revenue and margins" must NOT be
 *     allowed to skip verification just because a plain price answer can);
 *   - the deterministic pass found ZERO issues already (a missing
 *     timestamp, an out-of-range citation, anything — any issue at all
 *     means this was not a clean, fully-mapped response);
 *   - there is EXACTLY one evidence item, cited EXACTLY once, and it
 *     belongs to the single symbol this turn was about.
 * Any answer with more than one evidence item, more than one requested
 * symbol, zero citations, or any deterministic issue always goes to the
 * verifier — citation presence/absence/validity plays NO role in this
 * decision (the previous, unsafe gating this replaces).
 */
const isExactlyDeterministicallyVerified = ({
  intent, evidence, entities, deterministicIssues, citedIndexes,
}) => {
  if (!SIMPLE_DETERMINISTIC_MAPPING_INTENTS.has(intent)) return false;
  if (deterministicIssues.length) return false;
  if (evidence.length !== 1) return false;
  if (citedIndexes.size !== 1 || !citedIndexes.has(1)) return false;
  const symbols = (entities.symbols || []).map((s) => String(s).toUpperCase());
  if (symbols.length !== 1) return false;
  return evidence[0].symbol && String(evidence[0].symbol).toUpperCase() === symbols[0];
};

/**
 * needsClaimVerifier - decides whether the extra structured-verification
 * LLM call (nodes/validateFinalAnswer.js) is worth making. Hardened
 * policy (citation presence is NEVER part of this decision):
 *
 *   REQUIRED for every evidence-dependent intent (company research,
 *   financials, comparison, news, guidance/promise outcomes, research
 *   documents, watchlist/portfolio) whenever genuine evidence exists —
 *   regardless of whether the draft has valid citations, invalid
 *   citations, or none at all. A citation-free evidence-dependent answer
 *   is NOT a reason to skip verification; it is one of the strongest
 *   reasons to run it (deterministic regex cannot reliably recognize
 *   every unmarked factual claim).
 *
 *   SKIPPED only for: pure general education / unsupported-capability
 *   answers (SKIP_VERIFIER_INTENTS — nothing company-specific asserted at
 *   all); zero-evidence turns (nothing exists to verify claims against —
 *   runDeterministicChecks' ZERO_EVIDENCE_FACTUAL_CLAIM check is what
 *   actually guards this case, forcing repair/fallback whenever the draft
 *   isn't already a clean, honest abstention); and the narrow
 *   isExactlyDeterministicallyVerified case above.
 */
export const needsClaimVerifier = ({
  evidence = [], intent = null, entities = {}, deterministicIssues = [], citedIndexes = new Set(),
}) => {
  if (SKIP_VERIFIER_INTENTS.has(intent)) return false;
  if (!EVIDENCE_DEPENDENT_INTENTS.has(intent)) return false;
  if (!evidence.length) return false;
  if (isExactlyDeterministicallyVerified({
    intent, evidence, entities, deterministicIssues, citedIndexes,
  })) return false;
  return true;
};

export default {
  SAFE_VALIDATION_REASONS, runDeterministicChecks, needsClaimVerifier, extractCitationIndexes,
};
