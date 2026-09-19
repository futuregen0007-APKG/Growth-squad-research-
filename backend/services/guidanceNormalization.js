/**
 * guidanceNormalization.js
 * ===========================
 * Phase 4D Part 2: canonical guidance representation. Converts a trusted
 * evidence envelope item (a retrieved document chunk OR a merged Earnings
 * Intelligence promise/outcome record — see services/EvidenceEnvelope.js)
 * into an INTERNAL, additional canonical record describing what guidance
 * fact it actually asserts, if any. The original evidence item is never
 * mutated — normalization is pure metadata layered alongside it.
 *
 * Three provenance paths feed this, tried in order (Phase 4E Part 6):
 *   1. Earnings Intelligence items (documentType MANAGEMENT_PROMISE/
 *      PROMISE_OUTCOME, built by EvidenceEnvelope.js's
 *      buildEarningsIntelligenceEnvelopeItems) carry REAL STRUCTURED data
 *      (metric/targetValue/targetUnit/operator, from
 *      models/ManagementPromise.js's own required schema fields) — this is
 *      used DIRECTLY, never re-parsed from text, and gets 'high' confidence.
 *   2. A retrieved document chunk that has a verified, offline-extracted
 *      annotation (models/ResearchGuidanceAnnotation.js, status VERIFIED
 *      only — see services/guidanceAnnotationLookup.js, threaded in by
 *      EvidenceEnvelope.js as `item.chunkAnnotation`) — produced entirely
 *      offline by scripts/enrichGuidanceCorpus.js, never at request time,
 *      and never anything but a VERIFIED row (an unverified one is simply
 *      never looked up).
 *   3. Retrieved document chunks with no such annotation fall back to this
 *      module's own runtime parsing: metric and value are extracted with a
 *      small, explicit, conservative pattern set. Anything not confidently
 *      recognized is left unresolved (Part 2: "if normalization is
 *      uncertain, leave the relationship unresolved") rather than guessed.
 *   4. Otherwise: UNRESOLVED.
 *
 * Safety rules enforced here (never anywhere else downstream):
 *   - Different units (INR_CRORE vs USD_MILLION, a bare number vs a
 *     percentage) are NEVER equated or converted.
 *   - A quarterly figure and an annual figure for the "same" metric are
 *     NEVER treated as the same target period — targetFiscalYear/
 *     targetQuarter are copied verbatim from the envelope item's own
 *     trusted fiscalYear/fiscalQuarter, never inferred from text, and a
 *     record with fiscalQuarter set is a structurally different scope
 *     from one with fiscalQuarter null (see graph/temporalRelationships.js's
 *     grouping key, which includes fiscalQuarter).
 *   - A metric name is only ever mapped to a canonical metricKey via the
 *     explicit METRIC_ALIASES table below — no fuzzy/stemmed matching, so
 *     "EBITDA margin" and "operating margin" are always two different
 *     metricKeys (an unsafe equivalence per Part 2's own example) unless
 *     a future alias entry explicitly says otherwise.
 */

// ---------------------------------------------------------------------------
// Canonical metric table — SAFE equivalence is an explicit allow-list, never
// inferred. Each key's alias list is deliberately narrow; adding a new
// alias is a conscious, reviewable decision, not automatic fuzzy matching.
//
// Phase 4F.1 Part 5: this table is THE ONE canonical metric-mapping layer
// for the whole project — chunk annotations (via
// services/guidanceExtraction.js), Earnings Intelligence records (via
// EvidenceEnvelope.js's structuredGuidance path, which passes a
// ManagementPromise document's own `promise.metric` ENUM value straight
// into normalizeMetric below), and every downstream consumer of the
// resulting metricKey (temporalRelationships.js groups by it,
// groundedVerification.js reads it via canonicalGuidance) all share this
// SAME table. The enum-token aliases below (underscored, e.g.
// "ebitda_margin", "revenue_growth", "capex") are added ALONGSIDE the
// pre-existing free-text aliases specifically to close a real gap this
// phase found: ManagementPromise's `promise.metric` field is an
// UPPERCASE_ENUM token ("EBITDA_MARGIN"), not free prose ("EBITDA
// margin"), so it never matched any pre-existing space-separated alias.
// Each addition is deliberately UNAMBIGUOUS on its own (never mapped to a
// key it could also plausibly mean something else as) -- notably, the
// bare enum token "MARGIN" is intentionally NOT aliased to any specific
// margin key, for the exact same reason bare free-text "margin" already
// wasn't: it is genuinely ambiguous between operating/EBITDA/net margin,
// and guessing would violate this module's own "never fuzzy" rule.
// Likewise "EMPLOYEE_PERCENTAGE" and "OTHER"/"OTHER_QUANTIFIABLE" are
// deliberately left unmapped -- an employee percentage could be attrition,
// onsite/offshore mix, or something else entirely, and "OTHER" is
// definitionally non-specific.
// ---------------------------------------------------------------------------
const METRIC_ALIASES = Object.freeze({
  operating_margin: ['operating margin', 'ebit margin'],
  ebitda_margin: ['ebitda margin', 'ebitda_margin'],
  net_margin: ['net margin', 'net profit margin', 'pat margin'],
  revenue_growth: ['revenue growth', 'revenue guidance', 'revenue_growth'],
  revenue_growth_constant_currency: ['constant currency revenue growth', 'cc revenue growth', 'constant currency growth'],
  revenue: ['revenue', 'topline'],
  headcount: ['headcount', 'employee addition', 'net addition', 'hiring', 'employee_count'],
  attrition: ['attrition', 'attrition rate'],
  // New in Phase 4F.1: CAPEX had no canonical key at all -- ManagementPromise's
  // own CAPEX enum value (and the plain word "capex" in free text) both
  // resolve here, unambiguous.
  capex: ['capex', 'capital expenditure'],
});

// Longest-alias-first so "constant currency revenue growth" is matched
// before the shorter "revenue growth" substring inside it — order matters
// for correctness, not just performance.
const METRIC_LOOKUP = Object.entries(METRIC_ALIASES)
  .flatMap(([metricKey, aliases]) => aliases.map((alias) => ({ metricKey, alias, label: alias })))
  .sort((a, b) => b.alias.length - a.alias.length);

/**
 * normalizeMetric - resolves free text (either a document excerpt or an
 * Earnings Intelligence `metric` field) to a canonical metricKey. Returns
 * `{ metricKey: null, confidence: 'unresolved' }` when no explicit alias
 * matches, or when the text plausibly matches more than one DIFFERENT
 * metricKey (genuinely ambiguous — never guessed).
 */
export const normalizeMetric = (text) => {
  const value = String(text || '').toLowerCase();
  const hits = METRIC_LOOKUP.filter(({ alias }) => value.includes(alias));
  if (!hits.length) {
    return { metricKey: null, metric: null, confidence: 'unresolved', reason: 'NO_KNOWN_METRIC_MATCHED' };
  }

  // METRIC_LOOKUP is sorted longest-alias-first — a shorter hit whose own
  // alias text is CONTAINED IN an already-accepted longer hit's alias
  // (e.g. "revenue" inside "revenue guidance") is a textual artifact of
  // the longer phrase, not an independent, competing metric match, so it
  // is dropped rather than counted toward ambiguity. Two hits with
  // genuinely unrelated alias text (neither contains the other) both
  // survive and DO make the result ambiguous/unresolved.
  const accepted = [];
  for (const hit of hits) {
    const subsumed = accepted.some((a) => a.alias.includes(hit.alias));
    if (!subsumed) accepted.push(hit);
  }

  const distinctKeys = new Set(accepted.map((h) => h.metricKey));
  if (distinctKeys.size === 1) {
    return { metricKey: accepted[0].metricKey, metric: accepted[0].alias, confidence: 'high' };
  }
  return {
    metricKey: null, metric: null, confidence: 'unresolved', reason: `AMBIGUOUS_METRIC:${[...distinctKeys].join(',')}`,
  };
};

// Explicit targetUnit values models/ManagementPromise.js already enforces —
// reused verbatim so a structured Earnings Intelligence record's unit is
// copied through unchanged, never re-derived.
export const STRUCTURED_UNIT_VALUES = new Set(['INR_CRORE', 'INR_LAKH', 'USD_MILLION', 'USD_BILLION', 'PERCENTAGE', 'COUNT', 'OTHER']);

// Phase 4E finding (a real, reproducible bug surfaced by running extraction
// against the genuine corpus): every number match below requires a
// negative lookbehind for a preceding letter/digit so a fiscal-period token
// like "FY22" or "Q4" can never have its trailing digits mistaken for the
// START of a value — without it, "...guidance for FY22 to 19.5% to 20%..."
// matched RANGE_PATTERN as "22 to 19.5%" (the "22" borrowed from "FY22"),
// fabricating a 22 lower bound that was never actually part of the
// guidance figure. This affects the SAME runtime text-parsing path this
// module already used before Phase 4E existed, not just the new offline
// extraction pipeline that reuses it.
const RANGE_PATTERN = /(?<![A-Za-z0-9])(-?\d[\d,]*(?:\.\d+)?)\s*(%)?\s*(?:-|to|–|—)\s*(-?\d[\d,]*(?:\.\d+)?)\s*(%)?/i;
const PERCENT_PATTERN = /(?<![A-Za-z0-9])(-?\d[\d,]*(?:\.\d+)?)\s*%/i;
const CURRENCY_UNIT_PATTERN = /(₹|\$|inr|usd)?\s*(?<![A-Za-z0-9])(-?\d[\d,]*(?:\.\d+)?)\s*(crore|crores|lakh|lakhs|million|mn|billion|bn)\b/i;

const toNumber = (raw) => {
  const cleaned = String(raw).replace(/[₹$,]/g, '').trim();
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
};

const CURRENCY_UNIT_MAP = Object.freeze({
  crore: 'INR_CRORE', crores: 'INR_CRORE', lakh: 'INR_LAKH', lakhs: 'INR_LAKH',
  million: 'USD_MILLION', mn: 'USD_MILLION', billion: 'USD_BILLION', bn: 'USD_BILLION',
});
const CURRENCY_SYMBOL_MAP = Object.freeze({ '₹': 'INR', inr: 'INR', $: 'USD', usd: 'USD' });

/**
 * normalizeValue - extracts a value range/exact figure and its unit from
 * free text. A percentage RANGE is always preferred over a lone
 * percentage (a range subsumes it); a currency+magnitude figure ("₹500
 * crore") is only ever recognized with BOTH a magnitude word and,
 * ideally, a currency marker — a bare number with no unit word and no %
 * sign is never treated as a guidance figure at all (too likely to be an
 * unrelated number in the sentence), so it comes back unresolved.
 */
export const normalizeValue = (text) => {
  const value = String(text || '');

  const range = RANGE_PATTERN.exec(value);
  if (range) {
    const a = toNumber(range[1]);
    const b = toNumber(range[3]);
    const isPercent = Boolean(range[2] || range[4]);
    if (a !== null && b !== null && isPercent) {
      const [lowerBound, upperBound] = a <= b ? [a, b] : [b, a];
      return {
        valueType: 'range', lowerBound, upperBound, exactValue: null, unit: 'PERCENTAGE', currency: null, confidence: 'high',
      };
    }
  }

  const percent = PERCENT_PATTERN.exec(value);
  if (percent) {
    const exactValue = toNumber(percent[1]);
    if (exactValue !== null) {
      return {
        valueType: 'exact', lowerBound: null, upperBound: null, exactValue, unit: 'PERCENTAGE', currency: null, confidence: 'high',
      };
    }
  }

  const currencyMatch = CURRENCY_UNIT_PATTERN.exec(value);
  if (currencyMatch) {
    const exactValue = toNumber(currencyMatch[2]);
    const magnitudeWord = currencyMatch[3].toLowerCase();
    const unit = CURRENCY_UNIT_MAP[magnitudeWord] || null;
    const currency = currencyMatch[1] ? (CURRENCY_SYMBOL_MAP[currencyMatch[1].toLowerCase()] || null) : null;
    if (exactValue !== null && unit) {
      return {
        valueType: 'exact', lowerBound: null, upperBound: null, exactValue, unit, currency, confidence: currency ? 'high' : 'low',
      };
    }
  }

  return {
    valueType: null, lowerBound: null, upperBound: null, exactValue: null, unit: null, currency: null, confidence: 'unresolved', reason: 'NO_RECOGNIZABLE_VALUE',
  };
};

// Explicit revision-language markers — the ONLY thing that ever sets
// guidanceKind to 'revised'. Deliberately the same spirit as
// researchScope.js's REVISED_GUIDANCE_TYPE_PATTERN but scoped to a single
// evidence item's own text, not the user's question.
const REVISION_LANGUAGE_PATTERN = /\brevis(e|ed|ion|ing)\b|\bupdated\s+(guidance|outlook|forecast|target)\b|\b(raised?|lowered|cut|narrowed)\s+(its\s+)?(guidance|outlook|forecast|target)\b|\brevised\s+(guidance|outlook|forecast|target)\b/i;

/**
 * inferGuidanceKind - 'outcome' for a PROMISE_OUTCOME record (always —
 * this is trusted envelope metadata, never re-derived); 'revised' when the
 * evidence's OWN text contains explicit revision language; 'original'
 * otherwise. This is deliberately the single source of "explicit revision
 * language" the temporal-relationship algorithm requires for a SUPERSEDES
 * verdict (Part 3: "explicit revision language... required").
 */
export const inferGuidanceKind = (item) => {
  if (item.documentType === 'PROMISE_OUTCOME') return 'outcome';
  if (REVISION_LANGUAGE_PATTERN.test(String(item.text || ''))) return 'revised';
  return 'original';
};

// A verified offline chunk annotation's own guidanceKind (Phase 4E's finer
// ORIGINAL/MAINTAINED/RAISED/LOWERED/REVISED enum — see
// models/ResearchGuidanceAnnotation.js) collapses onto this module's
// coarser original/revised distinction: anything other than ORIGINAL is
// unambiguous, explicit revision-indicating language (that is exactly what
// the offline verifier already required to reach VERIFIED status), so it
// maps to 'revised' — the only value detectRelationships' SUPERSEDES rule
// ever looks for.
const mapAnnotationGuidanceKind = (guidanceKind) => (guidanceKind && guidanceKind !== 'ORIGINAL' ? 'revised' : 'original');

/**
 * normalizeGuidanceEvidence - the Part 2 canonical record for ONE envelope
 * item, extended in Phase 4E Part 6 with a second trusted input:
 *   - `structured`: REAL ManagementPromise fields (metric/targetValue/
 *     targetUnit/operator) threaded through by EvidenceEnvelope.js for an
 *     Earnings-Intelligence-sourced item — highest priority.
 *   - `chunkAnnotation`: a VERIFIED offline ResearchGuidanceAnnotation row
 *     for this item's chunk (see guidanceAnnotationLookup.js) — used only
 *     when `structured` is absent, and only ever a VERIFIED row (an
 *     annotation lookup that found nothing, or found something not yet
 *     VERIFIED, is simply not passed in at all).
 * Runtime text parsing (this module's original behavior) is the fallback
 * when neither is present — Part 6: "existing behavior unchanged for
 * chunks without annotations."
 */
export const normalizeGuidanceEvidence = (item, { structured = null, chunkAnnotation = null } = {}) => {
  let metricResult;
  let valueResult;
  let guidanceKind;

  if (structured?.metric) {
    metricResult = normalizeMetric(structured.metric);
    if (structured.targetUnit && STRUCTURED_UNIT_VALUES.has(structured.targetUnit) && Number.isFinite(structured.targetValue)) {
      valueResult = {
        valueType: 'exact', lowerBound: null, upperBound: null, exactValue: structured.targetValue, unit: structured.targetUnit, currency: structured.targetUnit.startsWith('INR') ? 'INR' : (structured.targetUnit.startsWith('USD') ? 'USD' : null), confidence: 'high',
      };
    } else {
      valueResult = { ...normalizeValue(item.text), confidence: 'low' };
    }
    guidanceKind = inferGuidanceKind(item);
  } else if (chunkAnnotation && chunkAnnotation.status === 'VERIFIED' && chunkAnnotation.metricKey) {
    metricResult = { metricKey: chunkAnnotation.metricKey, metric: chunkAnnotation.metric, confidence: 'high' };
    valueResult = {
      valueType: chunkAnnotation.valueType,
      lowerBound: chunkAnnotation.lowerBound,
      upperBound: chunkAnnotation.upperBound,
      exactValue: chunkAnnotation.exactValue,
      unit: chunkAnnotation.unit,
      currency: chunkAnnotation.currency,
      confidence: 'high',
    };
    guidanceKind = mapAnnotationGuidanceKind(chunkAnnotation.guidanceKind);
  } else {
    metricResult = normalizeMetric(item.text);
    valueResult = normalizeValue(item.text);
    guidanceKind = inferGuidanceKind(item);
  }

  const targetFiscalYear = item.fiscalYear || null; // never guessed — see module note
  const targetQuarter = item.fiscalQuarter || null;

  const reasons = [metricResult.reason, valueResult.reason].filter(Boolean);
  let confidence = 'high';
  if (metricResult.confidence === 'unresolved' || valueResult.confidence === 'unresolved' || !targetFiscalYear) {
    confidence = 'unresolved';
    if (!targetFiscalYear) reasons.push('MISSING_TARGET_FISCAL_YEAR');
  } else if (metricResult.confidence === 'low' || valueResult.confidence === 'low') {
    confidence = 'low';
  }

  return {
    evidenceId: item.evidenceId,
    symbol: item.symbol || null,
    metric: metricResult.metric,
    metricKey: metricResult.metricKey,
    targetFiscalYear,
    targetQuarter,
    guidanceKind,
    valueType: valueResult.valueType,
    lowerBound: valueResult.lowerBound,
    upperBound: valueResult.upperBound,
    exactValue: valueResult.exactValue,
    unit: valueResult.unit,
    currency: valueResult.currency,
    issuedAt: item.publishedAt || null,
    documentType: item.documentType || null,
    sourceAuthority: item.sourceAuthority || null,
    sourceId: item.chunkId || item.documentId || item.evidenceId,
    originalText: item.text || null,
    confidence,
    reason: reasons.join(';') || 'OK',
  };
};

/** Batch form over a full evidence envelope array. `structuredById` maps evidenceId -> {metric,targetValue,targetUnit,operator} for Earnings-Intelligence-sourced items only. `chunkAnnotationById` maps evidenceId -> a VERIFIED ResearchGuidanceAnnotation row for document-chunk items only. */
export const normalizeGuidanceEnvelope = (items = [], structuredById = {}, chunkAnnotationById = {}) => items.map((item) => normalizeGuidanceEvidence(item, {
  structured: structuredById[item.evidenceId] || null,
  chunkAnnotation: chunkAnnotationById[item.evidenceId] || null,
}));

export default {
  METRIC_ALIASES, normalizeMetric, normalizeValue, inferGuidanceKind, normalizeGuidanceEvidence, normalizeGuidanceEnvelope, STRUCTURED_UNIT_VALUES,
};
