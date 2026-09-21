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
 * citationFromLegacyEvidence - UI Phase 1D audit fix. Before this,
 * extractCitations returned the raw evidence object reference directly —
 * whatever fields buildEvidenceRecord happened to set (graph/evidence.js),
 * including internal bookkeeping (retrievedAt, evidenceQuality) and, since
 * UI Phase 1C.3's evidence-preservation fix, chartSeries/requestedRangeDays
 * (a whole 260-point series, meant to live on the chart responseBlock, not
 * be duplicated onto every citation object headed for the client/
 * persistence layer). This is the ONE explicit, supported field whitelist
 * a legacy (non-grounded) evidence record crosses into becoming a
 * citation — mirroring graph/groundedAnswer.js's own citationFromEvidence,
 * which already does exactly this for the grounded path (built from a
 * TRUSTED envelope with its own fixed field list); this closes the same
 * gap for the older path. Every field here already exists in
 * models/ChatMessage.js's citationSchema — nothing here is new, only
 * enforced at the point evidence becomes a citation rather than left
 * implicit.
 *
 * `pageNumber` (the legacy single-page field some evidence records carry)
 * is normalized into pageStart/pageEnd here — the SAME shape the grounded
 * path and services/responseBlocks.js's resolvePageRange already prefer,
 * one citation page-range shape, not two. `imageUrl` (news_list's own
 * need) is deliberately NOT included: buildNewsListBlock sources it
 * directly from state.evidence (matched by evidenceId), never from the
 * citation object, so the citation shape stays exactly the supported set
 * below — see services/responseBlocks.js's buildNewsListBlock.
 */
const citationFromLegacyEvidence = (item = {}) => ({
  evidenceId: item.evidenceId,
  claimType: item.claimType,
  symbol: item.symbol,
  title: item.title,
  sourceUrl: item.sourceUrl,
  provider: item.provider,
  publishedAt: item.publishedAt,
  reportingPeriod: item.reportingPeriod,
  excerpt: item.excerpt,
  pageStart: Number.isInteger(item.pageNumber) ? item.pageNumber : null,
  pageEnd: Number.isInteger(item.pageNumber) ? item.pageNumber : null,
});

/**
 * extractCitations - maps every distinct [N] marker actually present in
 * `answerText` back to the corresponding evidence record, projected
 * through citationFromLegacyEvidence's explicit whitelist. A marker
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
  return [...usedIndexes].sort((a, b) => a - b).map((n) => citationFromLegacyEvidence(evidence[n - 1]));
};

export default { extractCitations };
