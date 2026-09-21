import { extractCitations } from '../citations.js';
import { emitInChunks } from '../publishing.js';
import {
  formatMissingEvidenceForPrompt, DIMENSION_CLAIM_TYPES, DIMENSION_LABEL,
} from '../evidenceCoverage.js';
import { resolveResearchScope } from '../researchScope.js';
import { buildGroundedSafeFallback } from '../groundedAnswer.js';

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
const SEPARATOR = "\n\n";

export const buildSafeFallback = async (state) => {
  // Phase 4B/4C: grounded RAG branch — see graph/groundedAnswer.js's own
  // module note. Covers every way a grounded turn can land here: zero
  // retrieved evidence (ABSTAINED), the generation call itself failing
  // (FAILED_SAFE), or the one repair still leaving unverified claims
  // (REPAIR_REQUIRED, repair budget spent). Keyed on the same deterministic
  // scope every grounded-aware node recomputes, never state.groundedAnswer
  // alone, because the zero-evidence/generation-failure cases never set
  // groundedAnswer at all.
  const lastMessage = state.messages?.[state.messages.length - 1];
  const scope = resolveResearchScope({ text: String(lastMessage?.content || ''), entities: state.entities, intent: state.intent });
  if (scope.needsResearchCorpus) {
    const update = buildGroundedSafeFallback(state);
    // Phase 6A: composeAnswer may have already produced a PRECISE
    // abstention - naming each company and why its data is missing, rather
    // than one generic sentence. Prefer it over the generic fallback text.
    // Everything else about this node (streaming, safety, no fabrication)
    // is unchanged.
    if (state.validationStatus === 'ABSTAINED_PRECISE' && state.draftAnswer) {
      update.answer = state.draftAnswer;
    }
    emitInChunks(state.onEvent, update.answer);
    return {
      ...update,
      validationStatus: state.validationStatus === 'FAILED_SAFE'
        ? 'FAILED_SAFE'
        : (state.validationStatus === 'ABSTAINED_PRECISE' && state.draftAnswer ? 'ABSTAINED_PRECISE' : 'ABSTAINED'),
    };
  }

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

  // Phase 6A: composeAnswer may already have produced a PRECISE abstention -
  // naming each company and why its data is missing, rather than one generic
  // sentence. Prefer it; everything else about this node (streaming, safety,
  // citation recomputation, no fabrication) is unchanged.
  // Phase 6B: when the question named a reporting period the held data does
  // not cover, say so here too. The verifier correctly refuses to present a
  // Q4 FY2024 figure as an answer about FY2015, and the fallback must not
  // quietly do it either.
  const unmatchedPeriods = state.claimPlan?.unmatchedRequestedPeriods || [];
  if (unmatchedPeriods.length) {
    parts.push(`I hold no data for ${unmatchedPeriods.join(', ')}; any figures above are for a different period.`);
  }

  const usePrecise = state.validationStatus === 'ABSTAINED_PRECISE' && Boolean(state.draftAnswer);
  const answer = usePrecise ? state.draftAnswer : parts.join(SEPARATOR);
  const citations = extractCitations(answer, state.evidence);
  emitInChunks(state.onEvent, answer);

  // A pipeline failure (verifier/repair call itself broke) is distinct
  // from a content-quality decision (the draft just wasn't safe, or the
  // one repair didn't fix it) — both land here, but only the former keeps
  // the FAILED_SAFE label; everything else is recorded as a deliberate,
  // honest ABSTAINED.
  // The precise abstention keeps its own label so callers and tests can tell
  // "named the gap per company" apart from the generic refusal.
  const validationStatus = state.validationStatus === 'FAILED_SAFE'
    ? 'FAILED_SAFE'
    : (usePrecise ? 'ABSTAINED_PRECISE' : 'ABSTAINED');

  return { answer, citations, validationStatus };
};

export default buildSafeFallback;
