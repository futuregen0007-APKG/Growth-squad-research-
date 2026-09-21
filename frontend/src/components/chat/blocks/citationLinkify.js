/**
 * citationLinkify.js
 * =====================
 * UI Phase 1C.2: makes [N] citation markers embedded in the Markdown
 * answer's own prose clickable, opening the same evidence drawer
 * SourcesSection / metric_grid / comparison_table / company_header
 * already open (see ChatMessageBubble.jsx and CitationLinkContext.jsx).
 *
 * THE NUMBERING SUBTLETY THIS FILE EXISTS TO HANDLE: the literal marker
 * number written in the prose (e.g. "[7]") is NOT necessarily the same as
 * its position in message.citations / an evidence_drawer's entries. Both
 * are built server-side by graph/citations.js's extractCitations, which
 * COMPACTS the sparse set of marker numbers actually USED in the text
 * into a dense, ascending-sorted array — entries[0] is whichever distinct
 * marker number is smallest across the WHOLE answer, not necessarily "1"
 * (e.g. an answer using only [3] and [7] produces a 2-element citations
 * array; position 0 came from marker "3", not marker "1"). Reconstructing
 * that exact same compaction here — scan the full answer text once,
 * collect distinct marker numbers, sort ascending — is what lets a raw
 * "[7]" resolve to the correct entry without the frontend ever needing
 * the raw evidence array (which it never receives, by design).
 */

const CITATION_MARKER_PATTERN = /\[(\d+)\]/g;

/**
 * buildMarkerToEvidenceId - scans the FULL answer text once (never a
 * fragment — a table cell or list item alone doesn't have enough context
 * to know its marker's position among ALL markers in the answer) and maps
 * each distinct marker number to the evidenceId at the matching position
 * in `entries`.
 */
export const buildMarkerToEvidenceId = (text, entries) => {
  const map = new Map();
  if (!Array.isArray(entries) || !entries.length) return map;
  const distinctMarkers = [...new Set(
    [...String(text || '').matchAll(CITATION_MARKER_PATTERN)].map((m) => Number(m[1])),
  )].sort((a, b) => a - b);
  distinctMarkers.forEach((marker, index) => {
    const evidenceId = entries[index]?.evidenceId;
    if (evidenceId) map.set(marker, evidenceId);
  });
  return map;
};

export default { buildMarkerToEvidenceId };
