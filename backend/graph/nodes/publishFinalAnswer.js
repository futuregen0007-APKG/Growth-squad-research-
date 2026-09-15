import { extractCitations } from '../citations.js';
import { emitInChunks } from '../publishing.js';
import { publishGroundedAnswerNode } from '../groundedAnswer.js';

/**
 * publishFinalAnswer - the ONLY node that ever emits a `token` event or
 * sets the public `answer`/`citations` fields. Reached ONLY when
 * validateFinalAnswer decided PASSED or SKIPPED_GENERAL_EDUCATION (see
 * graph.js's routeAfterValidation) — draftAnswer is guaranteed non-null
 * on every path that reaches here.
 *
 * Citations are recomputed from scratch here, from whatever text is in
 * state.draftAnswer AT THIS POINT — never inherited from an earlier
 * round. If a repair happened, this is the repaired text; citations
 * extracted from the ORIGINAL pre-repair draft are never trusted (item 8).
 */
export const publishFinalAnswer = async (state) => {
  // Phase 4B: grounded RAG branch — see graph/groundedAnswer.js's own
  // module note. Reached only when validateFinalAnswer decided PASSED for
  // a grounded turn (every claim VERIFIED, or the model honestly asserted
  // zero claims) — citations are built ONLY from the trusted envelope,
  // never from parsing the answer text (there is no [N]-marker convention
  // in grounded answers at all).
  if (state.groundedAnswer) {
    const update = publishGroundedAnswerNode(state);
    emitInChunks(state.onEvent, update.answer);
    return update;
  }

  const text = state.draftAnswer || '';
  const citations = extractCitations(text, state.evidence);
  emitInChunks(state.onEvent, text);
  return { answer: text, citations };
};

export default publishFinalAnswer;
