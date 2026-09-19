/**
 * temporalRelationships.js
 * ===========================
 * Phase 4D Part 3: deterministic, provider-independent, document-type-
 * independent detection of temporal relationships between canonical
 * guidance records (graph/guidanceNormalization.js's output) for the SAME
 * company. This is what fixes the root cause: the OLD verifier-side
 * "supersession" check in graph/groundedVerification.js only ever compared
 * evidence items with the identical `documentType`, so a document chunk
 * (e.g. documentType EARNINGS_CALL_TRANSCRIPT) could never be recognized
 * as superseded by a later Earnings-Intelligence-sourced record
 * (documentType MANAGEMENT_PROMISE) even when both plainly describe the
 * same guidance lineage. Grouping here is keyed on the CANONICAL scope
 * (symbol, metricKey, targetFiscalYear, targetQuarter) instead — never on
 * documentType, sourceAuthority, or retrievalMode.
 *
 * Every relationship this module ever emits is one of TEMPORAL_RELATIONSHIP_TYPES
 * and carries `deterministic: true` — there is no LLM involvement anywhere
 * in this file.
 */

export const TEMPORAL_RELATIONSHIP_TYPES = Object.freeze([
  'SUPPORTS', 'REPEATS', 'REVISES', 'SUPERSEDES', 'CONFLICTS', 'OUTCOME_FOR', 'UNRESOLVED',
]);

const VALUE_EPSILON = 1e-9;

const valuesEqual = (a, b) => {
  if (a.valueType !== b.valueType) return false;
  if (a.valueType === 'range') {
    return Math.abs(a.lowerBound - b.lowerBound) < VALUE_EPSILON && Math.abs(a.upperBound - b.upperBound) < VALUE_EPSILON;
  }
  if (a.valueType === 'exact') {
    return Math.abs(a.exactValue - b.exactValue) < VALUE_EPSILON;
  }
  // Phase 4F.2: a qualitative record has no numeric value at all -- "equal"
  // means the SAME classified direction (e.g. two independent sources both
  // saying management is "more optimistic"), never a numeric comparison.
  if (a.valueType === 'qualitative') {
    return Boolean(a.qualitativeDirection) && a.qualitativeDirection === b.qualitativeDirection;
  }
  return false;
};

/** groupKey - the ONLY dimensions two records may ever be compared across: same company, same normalized metric, same exact target period (year AND quarter). Never guessed, never fuzzy. */
const groupKey = (record) => `${record.symbol}::${record.metricKey}::${record.targetFiscalYear}::${record.targetQuarter || 'FY'}`;

/**
 * isComparable - the "compatible units/value type" gate (Part 3). Two
 * records with different units, or where either side's normalization was
 * unresolved, are NEVER compared for equality/supersession — they fall
 * through to an explicit UNRESOLVED relationship instead of silently
 * being skipped, so the caller can see WHY no relationship was inferred.
 */
const isComparable = (a, b) => {
  if (a.confidence === 'unresolved' || b.confidence === 'unresolved') return false;
  // Phase 4F.2: a qualitative record never has a unit (Part 2's own schema
  // rule) -- comparing two qualitative records is legitimate on direction
  // alone, never gated behind a unit match that can never exist for them.
  if (a.valueType === 'qualitative' && b.valueType === 'qualitative') return true;
  return Boolean(a.unit && b.unit && a.unit === b.unit && a.valueType && b.valueType);
};

const validDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * detectPairRelationship - the core deterministic decision for one
 * candidate pair within a group, in priority order:
 *   1. Either side unnormalizable / incompatible units -> UNRESOLVED
 *      (Part 2: "if normalization is uncertain, leave the relationship
 *      unresolved").
 *   2. Exactly one side is an OUTCOME record -> OUTCOME_FOR (links the
 *      realized outcome to the guidance it reports against, regardless of
 *      whether the values happen to match).
 *   3. Equal values -> REPEATS (same source-shape restating itself) or
 *      SUPPORTS (a DIFFERENT source/document type corroborating the same
 *      figure) — a real, useful distinction: SUPPORTS specifically means
 *      "two independent provenance paths agree," which REPEATS does not
 *      claim.
 *   4. Different values:
 *      - SUPERSEDES only when ALL of: both issuedAt dates are valid, the
 *        chronologically later record's issuedAt is strictly after the
 *        earlier one's, AND the later record's guidanceKind is
 *        'revised' (i.e. its OWN text contains explicit revision
 *        language — see guidanceNormalization.js's inferGuidanceKind).
 *        A later date alone is never sufficient (Part 3's explicit rule).
 *      - Otherwise CONFLICTS — two genuinely different values for the
 *        exact same company/metric/period with no reliable way to prove
 *        which (if either) supersedes the other; this is flagged
 *        honestly rather than picked.
 */
const detectPairRelationship = (a, b) => {
  // Phase 4F.2 audit finding: OUTCOME_FOR must NEVER require matching
  // units/valueTypes -- Part 5's own rule is "OUTCOME_FOR requires
  // compatible symbol, metricKey and target period" only (all three already
  // guaranteed by this module's own groupKey grouping, before a pair is
  // ever handed to this function). The unit-comparability gate below exists
  // to protect SUPPORTS/REPEATS/SUPERSEDES/CONFLICTS, which genuinely need
  // an equal-value comparison -- it must run AFTER the outcome check, not
  // before, or a qualitative promise (no unit, by Part 2's own schema rule)
  // can never be linked to its later NUMERIC actual result, which is exactly
  // the real, live bug this audit found for TCS-FY2026-002 (a qualitative
  // "more optimistic" promise with a genuine 0.6% QoQ numeric outcome).
  const aIsOutcome = a.guidanceKind === 'outcome';
  const bIsOutcome = b.guidanceKind === 'outcome';
  if (aIsOutcome !== bIsOutcome) {
    if (a.confidence === 'unresolved' || b.confidence === 'unresolved') {
      return { type: 'UNRESOLVED', reason: 'NORMALIZATION_UNRESOLVED' };
    }
    const outcome = aIsOutcome ? a : b;
    const guidance = aIsOutcome ? b : a;
    // Phase 4F.2 Part 5: "if fulfillment cannot be evaluated
    // deterministically, preserve OUTCOME_FOR while leaving fulfillment
    // unresolved" -- a qualitative guidance side has no numeric target to
    // compare the outcome's value against, so fulfillment can never be a
    // deterministic yes/no here, only the LINK itself is genuine. Numeric
    // guidance + numeric outcome is the only case where a downstream
    // consumer (e.g. the already-computed verification.status on the
    // curated record) has a real deterministic comparison to point to.
    const fulfillmentEvaluable = guidance.valueType !== 'qualitative' && guidance.valueType !== null;
    return {
      type: 'OUTCOME_FOR',
      fromEvidenceId: outcome.evidenceId,
      toEvidenceId: guidance.evidenceId,
      reason: 'OUTCOME_REPORTS_AGAINST_GUIDANCE',
      fulfillmentEvaluable,
      fulfillmentReason: fulfillmentEvaluable ? null : 'QUALITATIVE_GUIDANCE_NO_DETERMINISTIC_FULFILLMENT_RULE',
    };
  }

  if (!isComparable(a, b)) {
    // Exactly one side genuinely qualitative (Part 2: a qualitative record
    // NEVER has a unit at all) and the other not is ALWAYS a
    // VALUE_TYPE_MISMATCH -- the root cause is "fundamentally different
    // representations," not "wrong unit," so this takes priority even
    // though the qualitative side's unit is trivially null. Otherwise,
    // UNIT_MISMATCH takes priority whenever units genuinely differ
    // (pre-existing behavior, unchanged) before falling to the generic
    // VALUE_TYPE_MISMATCH/NORMALIZATION_UNRESOLVED cases.
    const exactlyOneQualitative = (a.valueType === 'qualitative') !== (b.valueType === 'qualitative');
    return {
      type: 'UNRESOLVED',
      reason: exactlyOneQualitative
        ? 'VALUE_TYPE_MISMATCH'
        : (a.unit !== b.unit ? 'UNIT_MISMATCH' : (a.valueType !== b.valueType ? 'VALUE_TYPE_MISMATCH' : 'NORMALIZATION_UNRESOLVED')),
    };
  }

  const equal = valuesEqual(a, b);
  const dateA = validDate(a.issuedAt);
  const dateB = validDate(b.issuedAt);

  if (equal) {
    const crossSource = a.documentType !== b.documentType;
    // Deterministic, order-independent direction: prefer the one with a
    // later valid date as `fromEvidenceId` (the "confirming" record);
    // when dates are missing/tied, fall back to evidenceId ordering so
    // the result never depends on array/object insertion order.
    let later = a;
    let earlier = b;
    if (dateA && dateB) {
      if (dateB > dateA) { later = b; earlier = a; }
    } else if (String(b.evidenceId).localeCompare(String(a.evidenceId)) < 0) {
      later = b; earlier = a;
    }
    return crossSource
      ? {
        type: 'SUPPORTS', fromEvidenceId: later.evidenceId, toEvidenceId: earlier.evidenceId, reason: 'IDENTICAL_VALUE_CROSS_SOURCE_CORROBORATION',
      }
      : {
        type: 'REPEATS', fromEvidenceId: later.evidenceId, toEvidenceId: earlier.evidenceId, reason: 'IDENTICAL_VALUE_RESTATED',
      };
  }

  if (dateA && dateB && dateA.getTime() !== dateB.getTime()) {
    const [earlier, later] = dateA < dateB ? [a, b] : [b, a];
    if (later.guidanceKind === 'revised') {
      return {
        type: 'SUPERSEDES', fromEvidenceId: later.evidenceId, toEvidenceId: earlier.evidenceId, reason: 'EXPLICIT_REVISION_LANGUAGE_WITH_NEWER_DATE',
      };
    }
    // A later date alone is never sufficient (Part 3) — falls through to
    // CONFLICTS below, exactly like the "later publication without
    // revision" required test scenario.
  }

  return {
    type: 'CONFLICTS', fromEvidenceId: a.evidenceId, toEvidenceId: b.evidenceId, reason: dateA && dateB && dateA.getTime() === dateB.getTime() ? 'DIFFERING_VALUES_SAME_DATE' : 'DIFFERING_VALUES_NO_RELIABLE_SUPERSESSION_SIGNAL',
  };
};

/**
 * detectRelationships - Part 3's main entry point. Compares every pair of
 * canonical records that share the SAME (symbol, metricKey,
 * targetFiscalYear, targetQuarter) group; records with no resolvable
 * metric/period never enter any group at all (so they simply produce no
 * relationships, rather than a forced UNRESOLVED pairing with everything —
 * see buildTemporalAnnotations for how an ungrouped record is still
 * surfaced honestly).
 *
 * Deterministic pair ordering (sorted by evidenceId before pairing) means
 * the SAME input list always produces the SAME relationship list, in the
 * SAME order, regardless of the envelope's original array order.
 */
export const detectRelationships = (canonicalRecords = []) => {
  const groups = new Map();
  for (const record of canonicalRecords) {
    if (!record.symbol || !record.metricKey || !record.targetFiscalYear) continue; // never guessed — see module note
    const key = groupKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const relationships = [];
  for (const records of groups.values()) {
    const sorted = [...records].sort((a, b) => String(a.evidenceId).localeCompare(String(b.evidenceId)));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const pairResult = detectPairRelationship(sorted[i], sorted[j]);
        const { type, fromEvidenceId, toEvidenceId, reason } = pairResult;
        if (type === 'UNRESOLVED') {
          relationships.push({
            type, fromEvidenceId: sorted[i].evidenceId, toEvidenceId: sorted[j].evidenceId, reason, deterministic: true,
          });
        } else if (type === 'OUTCOME_FOR') {
          // Additive fields only present on OUTCOME_FOR -- Part 5's own
          // report requirement ("whether fulfillment is deterministically
          // evaluable"), never a numeric fulfillment verdict computed here.
          relationships.push({
            type, fromEvidenceId, toEvidenceId, reason, deterministic: true,
            fulfillmentEvaluable: pairResult.fulfillmentEvaluable, fulfillmentReason: pairResult.fulfillmentReason,
          });
        } else {
          relationships.push({
            type, fromEvidenceId, toEvidenceId, reason, deterministic: true,
          });
        }
      }
    }
  }
  return relationships;
};

export default { TEMPORAL_RELATIONSHIP_TYPES, detectRelationships };
