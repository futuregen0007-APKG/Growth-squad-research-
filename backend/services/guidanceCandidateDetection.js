/**
 * guidanceCandidateDetection.js
 * ===============================
 * Phase 4E Part 2: cheap, deterministic pre-filter over REAL
 * ResearchDocumentChunk text, selecting chunks that MIGHT contain
 * management guidance so the (more expensive) extraction pipeline
 * (guidanceExtraction.js) only ever runs against a plausible subset.
 *
 * This module NEVER decides a chunk actually contains valid guidance — it
 * only decides a chunk is worth attempting extraction on, and records WHY
 * (candidateSignals) for auditability. Broad recall is intentional: a
 * false positive here just means extraction later returns UNRESOLVED or
 * REJECTED; a false negative here means a real guidance statement is
 * silently skipped, which is the worse failure mode for this pre-filter.
 */

// Broad, intentionally recall-biased signal set (Part 2's own list, plus a
// few obvious synonyms). Each entry is independently informative — a chunk
// matching ANY of these is a candidate.
const SIGNAL_PATTERNS = Object.freeze([
  ['GUIDANCE', /\bguidance\b/i],
  ['OUTLOOK', /\boutlook\b/i],
  ['EXPECT', /\bexpect(?:ed|s|ing)?\b/i],
  ['FORECAST', /\bforecast(?:ed|s|ing)?\b/i],
  ['TARGET', /\btarget(?:ed|s|ing)?\b/i],
  ['REVISE', /\brevis(?:e|ed|ion|ing)\b/i],
  ['MAINTAIN', /\bmaintain(?:ed|s|ing)?\b/i],
  ['RAISE_LOWER', /\b(?:raise[ds]?|lower(?:ed|s|ing)?|cut|narrowed)\b/i],
  ['RANGE', /\b\d+(?:\.\d+)?\s*%?\s*(?:-|to|–|—)\s*\d+(?:\.\d+)?\s*%/i],
  ['MARGIN', /\bmargins?\b/i],
  ['REVENUE_GROWTH', /\brevenue\s+growth\b/i],
  ['CAPEX', /\bcapex\b|\bcapital\s+expenditure\b/i],
  ['HEADCOUNT', /\bhir(?:e|ing|es)\b|\bheadcount\b/i],
  ['DEAL_PIPELINE', /\bdeal\s+pipeline\b|\border\s+book\b|\bTCV\b/i],
  ['MANAGEMENT_EXPECTS', /\bmanagement\s+(?:expects?|believes?|anticipates?)\b/i],
  ['ASPIRATION', /\baspir(?:e|ation|ational)\b/i],
  ['GOING_FORWARD', /\bgoing\s+forward\b/i],
  ['REITERATE', /\breiterat(?:e|ed|es|ing)\b/i],
]);

// Deterministic exclusions — only for text that is UNAMBIGUOUSLY
// boilerplate/disclaimer/table-of-contents, never a heuristic guess about
// substantive content. A chunk matching an exclusion pattern is dropped
// even if it also matched a signal above (e.g. the standard forward-looking
// -statements legal disclaimer contains "expect" and "forecast" by design).
const EXCLUSION_PATTERNS = Object.freeze([
  ['SAFE_HARBOR_DISCLAIMER', /\bsafe\s+harbor\b|\bforward-looking\s+statements?\b.{0,80}\b(?:involve|subject to|risks?)\b/i],
  ['TABLE_OF_CONTENTS', /^\s*(?:table\s+of\s+contents|contents)\s*$/im],
  ['BOILERPLATE_LEGAL', /\bthis\s+(?:presentation|document|transcript)\s+(?:may\s+contain|contains)\s+forward-looking\b/i],
]);

/**
 * detectGuidanceCandidate - runs every signal/exclusion pattern once and
 * returns a machine-readable decision. `signals` always lists every signal
 * that matched (even when the chunk is ultimately excluded) so a caller
 * auditing false negatives/positives can see exactly why a decision was
 * made — never a bare boolean with no explanation.
 */
export const detectGuidanceCandidate = (text) => {
  const value = String(text || '');
  const signals = SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
  const exclusions = EXCLUSION_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);

  if (!signals.length) {
    return { isCandidate: false, signals: [], exclusions: [], reason: 'NO_SIGNAL_MATCHED' };
  }
  if (exclusions.length) {
    return { isCandidate: false, signals, exclusions, reason: `EXCLUDED:${exclusions.join(',')}` };
  }
  return { isCandidate: true, signals, exclusions: [], reason: 'SIGNAL_MATCHED' };
};

export default { detectGuidanceCandidate };
