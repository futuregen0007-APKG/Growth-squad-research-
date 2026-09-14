import { extractCitations } from '../citations.js';
import { emitInChunks } from '../publishing.js';
import {
  formatMissingEvidenceForPrompt, DIMENSION_CLAIM_TYPES, DIMENSION_LABEL,
} from '../evidenceCoverage.js';

/**
 * factLineFor - a single deterministic, evidence-backed sentence for one
 * COVERED coverage row, citing the real evidence index. Never invents
 * anything: if no matching evidence item is actually found (should not
 * happen for a COVERED row, but defensive), returns null and that row is
 * simply omitted rather than guessed.
 */
const factLineFor = (row, evidence) => {
  const claimTypes = DIMENSION_CLAIM_TYPES[row.dimension];
  if (!claimTypes || !row.symbol) return null;
  const index = evidence.findIndex((e) => e.symbol === row.symbol && claimTypes.includes(e.claimType));
  if (index === -1) return null;
  const item = evidence[index];
  const label = DIMENSION_LABEL[row.dimension] || row.dimension;
  const fact = item.excerpt || item.title || 'data available';
  return `${row.symbol} ${label}: ${fact} [${index + 1}]`;
};

/**
 * buildSafeFallback - the fail-closed terminal node. Reached whenever
 * validateFinalAnswer's decision is FAILED_SAFE, or REPAIR_REQUIRED with
 * the one bounded repair already spent (see graph.js's
 * routeAfterValidation for the exact routing). NEVER publishes the
 * unsafe draft. Purely deterministic (no LLM call, no I/O, cannot time out):
 *   - for every COVERED coverage row, states the real fact with a real
 *     citation (item 7: "include supported data only when deterministic
 *     mapping is safe");
 *   - for every non-covered row, states plainly that it's unavailable
 *     (reusing formatMissingEvidenceForPrompt — the SAME phrasing already
 *     used to instruct composeAnswer/repairAnswer, kept consistent);
 *   - if nothing at all is covered, abstains entirely.
 * Citations are recomputed from THIS text, never inherited.
 */
export const buildSafeFallback = async (state) => {
  const coveredLines = (state.evidenceCoverage || [])
    .filter((row) => row.status === 'COVERED')
    .map((row) => factLineFor(row, state.evidence))
    .filter(Boolean);
  const missingNotes = formatMissingEvidenceForPrompt(state.missingEvidence);

  const parts = [];
  if (coveredLines.length) {
    parts.push(`Here's what I could verify:\n${coveredLines.map((line) => `- ${line}`).join('\n')}`);
  }
  if (missingNotes.length) {
    parts.push(`I don't have verified data for: ${missingNotes.join('; ')}. I'd rather say that plainly than guess.`);
  }
  if (!parts.length) {
    parts.push("I couldn't produce a fully verified answer to this right now. Please try again in a moment.");
  }

  const answer = parts.join('\n\n');
  const citations = extractCitations(answer, state.evidence);
  emitInChunks(state.onEvent, answer);

  // A pipeline failure (verifier/repair call itself broke) is distinct
  // from a content-quality decision (the draft just wasn't safe, or the
  // one repair didn't fix it) — both land here, but only the former keeps
  // the FAILED_SAFE label; everything else is recorded as a deliberate,
  // honest ABSTAINED.
  const validationStatus = state.validationStatus === 'FAILED_SAFE' ? 'FAILED_SAFE' : 'ABSTAINED';

  return { answer, citations, validationStatus };
};

export default buildSafeFallback;
