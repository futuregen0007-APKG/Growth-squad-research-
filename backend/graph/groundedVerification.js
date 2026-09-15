import { GROUNDED_VERDICTS } from './schemas.js';

/**
 * groundedVerification.js
 * =========================
 * Phase 4B Part 6: the deterministic citation/claim verifier for the
 * grounded RAG answer flow. Runs entirely AFTER generation, on plain data
 * only — no LLM call, no I/O, exactly the same "mechanically verifiable
 * rules only" discipline graph/claimValidation.js already uses for the
 * legacy pipeline (see that module's own note on why this deliberately
 * never tries to be a semantic verifier — genuinely ambiguous cases are
 * meant to fail closed here, not be judged).
 *
 * Every exported check takes plain objects (a claim, the evidence
 * envelope map, the resolved research scope) and returns one of
 * GROUNDED_VERDICTS — never throws.
 */

// --- Numeric/percentage/currency normalization (Part 6's explicit rules) ---
//
//   "21%-23%" === "21% to 23%"        (a range is a range, whatever the
//                                       separator glyph)
//   "21%-22%" !== "21%-23%"            (both bounds must match EXACTLY)
//   crore/million/billion are NEVER treated as interchangeable, and no
//   conversion is ever inferred when a unit is unclear — the unit word
//   (if any) is folded into the canonical token itself, so a claim number
//   with a different or missing unit than the evidence's simply never
//   matches, rather than being "helpfully" converted.

const RANGE_SEPARATOR = /\s*(?:-|to|–|—)\s*/i;
const UNIT_WORD = /(crore|crores|lakh|lakhs|million|mn|billion|bn|thousand|k)\b/i;

const normalizeNumberLiteral = (raw) => {
  // Strips thousands separators / a leading currency symbol, keeps sign
  // and decimals. "1,234.5" -> "1234.5". Never rounds, never scales.
  const cleaned = String(raw).replace(/[₹$,]/g, '').trim();
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
};

/**
 * extractNumberFacts - every distinct number-bearing assertion in `text`,
 * as canonical tokens. A "X%-Y%"/"X to Y%" style range becomes ONE
 * `range:<unit>:X:Y` token (order-independent so "21% to 23%" and
 * "23%-21%" — never legitimately produced, but handled safely — compare
 * equal); a standalone number becomes `num:<unit>:X`. `<unit>` is the
 * literal trailing unit word/symbol found right after the number (percent
 * sign, crore, million, ...) or the empty string when none is present —
 * this is what makes a unit mismatch a structural non-match rather than a
 * silently "close enough" one.
 */
export const extractNumberFacts = (text) => {
  const value = String(text || '');
  const facts = new Set();
  const consumed = [];

  const rangePattern = new RegExp(`(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(%)?${RANGE_SEPARATOR.source}(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(%)?`, 'gi');
  for (const match of value.matchAll(rangePattern)) {
    const a = normalizeNumberLiteral(match[1]);
    const b = normalizeNumberLiteral(match[3]);
    const isPercent = Boolean(match[2] || match[4]);
    if (a === null || b === null) continue;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    facts.add(`range:${isPercent ? '%' : ''}:${lo}:${hi}`);
    consumed.push({ start: match.index, end: match.index + match[0].length });
  }

  // The trailing \b that guards the unit-word alternative is scoped
  // INSIDE that alternative's own non-capturing group, not the pattern as
  // a whole — a number immediately followed by punctuation with no unit
  // word at all (e.g. "15%." at the end of a sentence) must still match
  // the '%' sign; a \b applied after an OPTIONAL unit group that failed
  // to match would otherwise force the regex engine to backtrack the
  // percent sign away too (there is no word boundary between '%' and
  // '.', both non-word characters) — confirmed by a real failing case:
  // "Revenue grew 15%." lost its '%' under the old single trailing \b.
  const numberPattern = /(-?\d[\d,]*(?:\.\d+)?)\s*(%)?(?:\s*(crore|crores|lakh|lakhs|million|mn|billion|bn|thousand|k)\b)?/gi;
  for (const match of value.matchAll(numberPattern)) {
    const withinRange = consumed.some((r) => match.index >= r.start && match.index < r.end);
    if (withinRange) continue;
    const n = normalizeNumberLiteral(match[1]);
    if (n === null) continue;
    const unit = match[2] ? '%' : (match[3] ? match[3].toLowerCase() : '');
    facts.add(`num:${unit}:${n}`);
  }

  return facts;
};

const factsSubsetOf = (claimFacts, evidenceFacts) => [...claimFacts].every((fact) => evidenceFacts.has(fact));

// --- Claim → verdict ---------------------------------------------------

const NUMERIC_OR_MATERIAL_PATTERN = /₹\s?[\d,]+(\.\d+)?|\$\s?[\d,]+(\.\d+)?|\b\d+(\.\d+)?\s?%|\bcrore|\blakh|\bmillion|\bbillion|\bQ[1-4]\b|\bFY\d{2,4}\b/i;

/**
 * verifyGroundedClaim - one claim's full deterministic check, in the exact
 * priority order Part 6 implies (an id that doesn't exist makes every
 * other check meaningless; a wrong company makes a period/number check
 * meaningless; etc). Returns { verdict, reasonCode }.
 */
export const verifyGroundedClaim = (claim, {
  evidenceById, scope = {}, allEnvelopeItems = [],
} = {}) => {
  const evidenceIds = Array.isArray(claim?.evidenceIds) ? claim.evidenceIds : [];

  // 1/2. At least one citation, and every cited id must resolve against
  // the trusted envelope this turn actually built (Part 6 items 1-2).
  if (!evidenceIds.length) {
    if (claim?.claimType === 'interpretation') return { verdict: 'VERIFIED', reasonCode: 'INTERPRETATION_NO_CITATION_REQUIRED' };
    return { verdict: 'UNCITED_MATERIAL_CLAIM', reasonCode: 'NO_EVIDENCE_ID_CITED' };
  }
  const unknown = evidenceIds.filter((id) => !evidenceById.has(id));
  if (unknown.length) return { verdict: 'UNKNOWN_EVIDENCE_ID', reasonCode: `UNKNOWN_ID:${unknown.join(',')}` };

  const cited = evidenceIds.map((id) => evidenceById.get(id));

  // 3. Every cited item must belong to the requested company.
  if (scope.symbol) {
    const wrongCompany = cited.some((item) => item.symbol && item.symbol !== scope.symbol);
    if (wrongCompany) return { verdict: 'COMPANY_MISMATCH', reasonCode: 'EVIDENCE_SYMBOL_NOT_REQUESTED' };
  }

  // 4. Fiscal year/quarter must match the requested period where the
  // question named one. A requested quarter whose cited evidence is a
  // full-year figure (fiscalQuarter: null) is exactly the "Q4 revenue is
  // not full-year revenue" case Part 6 calls out — never treated as a
  // match just because the fiscal year lines up.
  if (scope.fiscalYear) {
    const wrongYear = cited.some((item) => item.fiscalYear && item.fiscalYear !== scope.fiscalYear);
    if (wrongYear) return { verdict: 'PERIOD_MISMATCH', reasonCode: 'EVIDENCE_FISCAL_YEAR_MISMATCH' };
  }
  if (scope.fiscalQuarter) {
    const wrongQuarter = cited.some((item) => item.fiscalQuarter !== scope.fiscalQuarter);
    if (wrongQuarter) return { verdict: 'PERIOD_MISMATCH', reasonCode: 'QUARTERLY_VS_ANNUAL_OR_WRONG_QUARTER' };
  }

  // 8. Superseded guidance: a management_guidance/revised_guidance claim
  // must cite the LATEST disclosure the envelope has for this exact
  // (symbol, fiscalYear, fiscalQuarter) — never an older one presented as
  // current, when metadata (publishedAt) actually proves a newer one
  // exists among the evidence the model was given.
  if (claim?.claimType === 'management_guidance' || claim?.claimType === 'revised_guidance') {
    for (const item of cited) {
      const siblings = allEnvelopeItems.filter((e) => e.symbol === item.symbol
        && e.fiscalYear === item.fiscalYear
        && e.fiscalQuarter === item.fiscalQuarter
        && (e.documentType === 'GUIDANCE' || e.documentType === item.documentType));
      const newer = siblings.find((e) => e.publishedAt && item.publishedAt && new Date(e.publishedAt) > new Date(item.publishedAt));
      if (newer) return { verdict: 'SUPERSEDED_GUIDANCE', reasonCode: `NEWER_DISCLOSURE_EXISTS:${newer.evidenceId}` };
    }
  }

  // 6. Numbers/percentages/ranges/dates/currency in the claim must be
  // present in (or directly supported by) the cited text — no unit
  // conversion ever inferred (see extractNumberFacts above).
  const claimFacts = extractNumberFacts(claim?.text);
  if (claimFacts.size) {
    const evidenceFacts = new Set();
    cited.forEach((item) => extractNumberFacts(item.text).forEach((f) => evidenceFacts.add(f)));
    if (!factsSubsetOf(claimFacts, evidenceFacts)) {
      return { verdict: 'NUMERIC_MISMATCH', reasonCode: 'CLAIM_NUMBER_NOT_FOUND_IN_CITED_EVIDENCE' };
    }
  }

  // 11. A material claim (numeric/period-bearing) with weak textual
  // overlap against its own cited evidence — the deterministic stand-in
  // for "the cited text doesn't actually seem to be about this," since a
  // full semantic check is explicitly out of scope for this
  // non-LLM verifier.
  if (NUMERIC_OR_MATERIAL_PATTERN.test(claim?.text || '')) {
    const combinedCitedText = cited.map((item) => String(item.text || '').toLowerCase()).join(' ');
    const claimWords = String(claim?.text || '').toLowerCase().match(/[a-z]{5,}/g) || [];
    const meaningfulWords = claimWords.filter((w) => !STOPWORDS.has(w));
    // A 4-character stem, not the whole word, so an ordinary inflection
    // ("guidance" vs "guided", "revenues" vs "revenue") still counts as
    // overlap — this check exists only to catch a claim that is about
    // something completely absent from its cited text, not to require an
    // exact word match (this verifier does no real NLP/semantic analysis
    // by design; see this module's own note).
    const stemOf = (w) => w.slice(0, 4);
    if (meaningfulWords.length && !meaningfulWords.some((w) => combinedCitedText.includes(stemOf(w)))) {
      return { verdict: 'UNSUPPORTED_CLAIM', reasonCode: 'NO_LEXICAL_OVERLAP_WITH_CITED_EVIDENCE' };
    }
  }

  return { verdict: 'VERIFIED', reasonCode: 'OK' };
};

const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'their', 'there', 'these', 'those',
  'which', 'while', 'would', 'could', 'should', 'company', 'management', 'during',
]);

/**
 * verifyGroundedAnswer - runs verifyGroundedClaim over every claim and
 * recomputes the TRUSTED groundingStatus from the results — never the
 * model's own self-reported value (Part 6: the server, not the model,
 * decides this).
 */
export const verifyGroundedAnswer = ({ claims = [], evidenceEnvelope = [], scope = {} } = {}) => {
  const evidenceById = new Map(evidenceEnvelope.map((item) => [item.evidenceId, item]));
  const verified = claims.map((claim) => {
    const { verdict, reasonCode } = verifyGroundedClaim(claim, { evidenceById, scope, allEnvelopeItems: evidenceEnvelope });
    return { ...claim, verificationStatus: verdict, reasonCode };
  });

  const anyVerified = verified.some((c) => c.verificationStatus === 'VERIFIED');
  const anyFailed = verified.some((c) => c.verificationStatus !== 'VERIFIED');
  const groundingStatus = !verified.length || !anyVerified
    ? 'insufficient_evidence'
    : (anyFailed ? 'partially_grounded' : 'grounded');

  return { claims: verified, groundingStatus, allVerified: verified.length > 0 && !anyFailed };
};

export default { extractNumberFacts, verifyGroundedClaim, verifyGroundedAnswer, GROUNDED_VERDICTS };
