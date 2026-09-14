/**
 * citations.js
 * ==============
 * The ONE place a final answer's [N] citation markers are mapped back to
 * real evidence records. Moved out of nodes/composeAnswer.js in Phase 3
 * (composeAnswer no longer computes citations at all — see its module
 * note) into its own module since it's now used by publishFinalAnswer.js
 * AND buildSafeFallback.js. Re-exported from composeAnswer.js unchanged
 * for backward compatibility with existing imports/tests.
 */

const CITATION_MARKER_PATTERN = /\[(\d+)\]/g;

/**
 * extractCitations - maps every distinct [N] marker actually present in
 * `answerText` back to the corresponding evidence record. A marker
 * outside the given evidence range is silently dropped — never fabricated
 * into a citation. Phase 3: this must always be called on the FINAL
 * (published) answer text, never a rejected draft — see
 * publishFinalAnswer.js, the only call site that feeds state.citations.
 */
export const extractCitations = (answerText, evidence) => {
  const usedIndexes = new Set();
  for (const match of String(answerText || '').matchAll(CITATION_MARKER_PATTERN)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= evidence.length) usedIndexes.add(n);
  }
  return [...usedIndexes].sort((a, b) => a - b).map((n) => evidence[n - 1]);
};

export default { extractCitations };
