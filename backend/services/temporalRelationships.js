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
const isComparable = (a, b) => a.confidence !== 'unresolved' && b.confidence !== 'unresolved'
  && a.unit && b.unit && a.unit === b.unit && a.valueType && b.valueType;

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
  if (!isComparable(a, b)) {
    return {
      type: 'UNRESOLVED', reason: a.unit !== b.unit ? 'UNIT_MISMATCH' : 'NORMALIZATION_UNRESOLVED',
    };
  }

  const aIsOutcome = a.guidanceKind === 'outcome';
  const bIsOutcome = b.guidanceKind === 'outcome';
  if (aIsOutcome !== bIsOutcome) {
    const outcome = aIsOutcome ? a : b;
    const guidance = aIsOutcome ? b : a;
    return {
      type: 'OUTCOME_FOR', fromEvidenceId: outcome.evidenceId, toEvidenceId: guidance.evidenceId, reason: 'OUTCOME_REPORTS_AGAINST_GUIDANCE',
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
        const { type, fromEvidenceId, toEvidenceId, reason } = detectPairRelationship(sorted[i], sorted[j]);
        if (type === 'UNRESOLVED') {
          relationships.push({
            type, fromEvidenceId: sorted[i].evidenceId, toEvidenceId: sorted[j].evidenceId, reason, deterministic: true,
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
