import { GROUNDED_VERDICTS } from './schemas.js';
import { classifyQualitativeDirection } from '../services/guidanceNormalization.js';

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

// Phase 4D Part 6: cross-source temporal-reconciliation checks. Reads
// ONLY the server-computed, trusted annotations
// services/EvidenceEnvelope.js's reconcileEvidenceEnvelope already
// attached to every cited item (temporalStatus/supersededByEvidenceId/
// supersedesEvidenceIds/relationshipIds) — never re-derives supersession
// itself, and never trusts anything the model says about a relationship
// beyond checking a model-provided `relationshipId` against the real list.
const CONFLICT_DISCLOSURE_PATTERN = /\bconflict|\bconflicting|\bdiffer(?:s|ing)?\b|\bdiscrepanc|\bunclear\b|\bambiguous\b|\bmixed\s+signals?\b|\btwo\s+different\s+(figures|values|numbers)\b|\bunresolved\b/i;
const UNCHANGED_CLAIM_PATTERN = /\bunchanged\b|\bno\s+change\b|\bremained?\s+the\s+same\b|\bnot\s+revised\b|\bsame\s+as\s+(before|original)\b/i;
// A "historical_fact" claim citing SUPERSEDED evidence is only safe when
// its OWN text clearly frames the figure as past/original — otherwise it
// reads as asserting the (now-outdated) figure is still true today.
// claimType "management_guidance" is deliberately EXEMPT from this check:
// per its own definition (see graph/prompts/index.js's groundedAnswerPrompt)
// it always means "the target AS ORIGINALLY STATED," so citing a
// SUPERSEDED item there is exactly correct usage — this is precisely how
// a "what was the ORIGINAL guidance?" answer (Part 5) is expected to cite
// evidence, never an error.
const ORIGINAL_QUALIFIER_PATTERN = /\boriginally\b|\binitially\b|\bat\s+the\s+time\b|\bpreviously\b|\bhad\s+(guided|given|stated)\b|\bearlier\s+guidance\b|\bprior\s+guidance\b|\bformer(ly)?\s+guidance\b/i;

export const checkTemporalConsistency = (claim, cited, allEnvelopeItems) => {
  // Fabricated relationship id: the model MAY optionally reference a
  // relationshipId (e.g. when explicitly describing a revision), but
  // never REQUIRES it — if provided, it must exist among the relationships
  // this turn's real reconciliation actually computed.
  if (claim?.relationshipId) {
    const known = allEnvelopeItems.some((item) => (item.relationshipIds || []).includes(claim.relationshipId));
    if (!known) return { verdict: 'TEMPORAL_RELATIONSHIP_MISMATCH', reasonCode: `FABRICATED_RELATIONSHIP_ID:${claim.relationshipId}` };
  }

  // A plain "historical_fact" claim presenting guidance as CURRENT must
  // never cite an item the server has already determined is SUPERSEDED,
  // unless its own text clearly frames the figure as past/original — this
  // is the exact cross-source case the old same-documentType heuristic
  // missed (a document chunk superseded by a later Earnings-Intelligence
  // record, or vice versa).
  if (claim?.claimType === 'historical_fact') {
    const supersededCite = cited.find((item) => item.temporalStatus === 'SUPERSEDED');
    if (supersededCite && !ORIGINAL_QUALIFIER_PATTERN.test(String(claim?.text || ''))) {
      return { verdict: 'SUPERSEDED_AS_CURRENT', reasonCode: `CITES_SUPERSEDED:${supersededCite.evidenceId}:SUPERSEDED_BY:${supersededCite.supersededByEvidenceId}` };
    }
  }

  // A revision claim citing ONLY superseded (old) evidence never supports
  // a claim that guidance changed (Part 6: "a revision claim citing only
  // the old evidence" is a required reject). Citing the new value alone
  // is fine (a plain "guidance is now X" statement); citing both is also
  // fine and is how a compare-original-and-revised answer is expected to
  // work (Part 5).
  if (claim?.claimType === 'revised_guidance' && cited.length) {
    const allSuperseded = cited.every((item) => item.temporalStatus === 'SUPERSEDED');
    if (allSuperseded) {
      return { verdict: 'REVISION_NOT_SUPPORTED', reasonCode: 'REVISION_CLAIM_CITES_ONLY_SUPERSEDED_EVIDENCE' };
    }
  }

  // "Guidance was unchanged" claims are rejected outright when a real,
  // verified SUPERSEDES relationship exists for the cited scope — never
  // let an "unchanged" claim stand when the server knows it changed.
  if (UNCHANGED_CLAIM_PATTERN.test(String(claim?.text || ''))) {
    const involvesSupersession = cited.some((item) => item.temporalStatus === 'SUPERSEDED' || (item.supersedesEvidenceIds || []).length > 0);
    if (involvesSupersession) {
      return { verdict: 'REVISION_NOT_SUPPORTED', reasonCode: 'UNCHANGED_CLAIM_CONTRADICTS_KNOWN_REVISION' };
    }
  }

  // Undisclosed conflict: citing evidence the server flagged CONFLICTING
  // (a real disagreement it could not safely resolve) without any
  // disclosure language in the claim text would silently hide it.
  const conflictingCite = cited.find((item) => item.temporalStatus === 'CONFLICTING');
  if (conflictingCite && !CONFLICT_DISCLOSURE_PATTERN.test(String(claim?.text || ''))) {
    return { verdict: 'UNDISCLOSED_CONFLICT', reasonCode: `UNDISCLOSED_CONFLICT:${conflictingCite.evidenceId}` };
  }

  return null;
};

// Phase 4F.2 Part 6: certainty-escalation language — a claim asserting a
// FIRM, formally-committed number/outcome when the cited evidence is only
// ever qualitative/directional. Deliberately a narrow, explicit phrase list
// (never a semantic judgment) — the same "never fuzzy" discipline every
// other pattern in this project's guidance layer uses.
// Deliberately does NOT include "fully delivered/achieved/met" -- that
// phrasing is specifically a FULFILLMENT conclusion (see
// FULFILLMENT_CLAIM_PATTERN below), a distinct, separately-tested failure
// mode even though both ultimately reject an overreaching claim.
const FIRM_COMMITMENT_PATTERN = /\bguarantee(?:d|s)?\b|\bformal(?:ly)?\s+guidance\b|\bcommit(?:ted|s)?\s+to\b|\bpromis(?:ed|es)\b|\bconfirmed\s+formally\b/i;
const FULFILLMENT_CLAIM_PATTERN = /\bfully\s+(?:delivered|achieved|met)\b|\bsuccessfully\s+(?:delivered|achieved|met)\b|\b(?:delivered|achieved|met)\s+(?:on|its)\s+(?:the\s+)?(?:promise|guidance|target|commitment)\b|\bmanagement\s+delivered\b/i;

/**
 * checkQualitativeConsistency - the qualitative-guidance-specific checks
 * Part 6 requires, run only against citations that are genuinely
 * qualitative (canonicalGuidance.valueType === 'qualitative') or genuinely
 * an OUTCOME_FOR pairing with a qualitative guidance side. Every other
 * citation (numeric, or no canonicalGuidance at all) is completely
 * unaffected — this never runs a check against evidence it doesn't apply
 * to, and never weakens any existing numeric check.
 */
export const checkQualitativeConsistency = (claim, cited) => {
  const text = String(claim?.text || '');
  const qualitativeCites = cited.filter((item) => item.canonicalGuidance?.valueType === 'qualitative');

  if (qualitativeCites.length) {
    // Direction mismatch: the claim asserts its OWN clear direction, and it
    // does not match ANY cited qualitative item's verified direction.
    const claimDirection = classifyQualitativeDirection(text);
    if (claimDirection.qualitativeDirection) {
      const anyDirectionMatches = qualitativeCites.some((item) => item.canonicalGuidance.qualitativeDirection === claimDirection.qualitativeDirection);
      if (!anyDirectionMatches) {
        return { verdict: 'QUALITATIVE_DIRECTION_MISMATCH', reasonCode: `CLAIM_DIRECTION_${claimDirection.qualitativeDirection}_NOT_IN_CITED_EVIDENCE` };
      }
    }

    // Overreach: the claim uses firm/formal-commitment language a
    // qualitative ("we are more optimistic", "aligned with our aspiration")
    // statement never supports — an aspiration is never a firm promise,
    // and a direction is never a specific number.
    if (FIRM_COMMITMENT_PATTERN.test(text)) {
      return { verdict: 'QUALITATIVE_OVERREACH', reasonCode: 'FIRM_COMMITMENT_LANGUAGE_FOR_QUALITATIVE_EVIDENCE' };
    }
  }

  // Unsupported fulfillment: a claim asserting management "fully
  // delivered"/"achieved"/"met" its guidance, citing an OUTCOME_FOR
  // pairing whose fulfillment the server has already determined is NOT
  // deterministically evaluable (Part 5 — the guidance side was
  // qualitative, so there is no numeric target to compare the outcome
  // against). The outcome itself (e.g. "0.6% QoQ growth") may still be
  // reported plainly; only an explicit FULFILLMENT verdict is blocked.
  if (FULFILLMENT_CLAIM_PATTERN.test(text)) {
    const unevaluableFulfillment = cited.find((item) => item.fulfillmentEvaluable === false);
    if (unevaluableFulfillment) {
      return { verdict: 'UNSUPPORTED_FULFILLMENT_CLAIM', reasonCode: `FULFILLMENT_NOT_DETERMINISTICALLY_EVALUABLE:${unevaluableFulfillment.evidenceId}` };
    }
  }

  return null;
};

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

  // 8. Phase 4D: cross-source temporal consistency — uses the trusted,
  // server-computed temporalStatus/relationship annotations
  // reconcileEvidenceEnvelope already attached to every envelope item
  // (see services/EvidenceEnvelope.js), never re-derives supersession
  // from documentType/publishedAt itself. This is what fixes the root
  // cause: a document chunk and a LATER Earnings-Intelligence record for
  // the same canonical guidance scope are now compared correctly,
  // regardless of documentType.
  const temporalVerdict = checkTemporalConsistency(claim, cited, allEnvelopeItems);
  if (temporalVerdict) return temporalVerdict;

  // Phase 4F.2 Part 6: qualitative-guidance-specific checks (direction
  // mismatch, firm-commitment overreach on an aspirational statement,
  // unsupported fulfillment conclusions) — a complete no-op for any claim
  // that cites no qualitative evidence.
  const qualitativeVerdict = checkQualitativeConsistency(claim, cited);
  if (qualitativeVerdict) return qualitativeVerdict;

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

export default {
  extractNumberFacts, verifyGroundedClaim, verifyGroundedAnswer, checkTemporalConsistency, checkQualitativeConsistency, GROUNDED_VERDICTS,
};
