import { resolveResearchScope } from '../researchScope.js';
import { emitEvent } from '../../services/telemetry/ragTelemetry.js';

// UI Phase 1C.3 fix: bounds an evidence item's excerpt to the SAME 500-char
// prompt-token-economy limit graph/evidence.js's evidenceForPrompt already
// enforces, WITHOUT dropping the other fields that function's own
// (unchanged, still correctly used/tested elsewhere) narrow field whitelist
// omits. Previously this node returned `evidenceForPrompt(deduped)`
// directly, which REPLACED state.evidence for the rest of the turn's
// pipeline with that narrow shape — silently discarding pageNumber/
// evidenceQuality/imageUrl(news_list)/chartSeries(chart) for every
// downstream node (composeAnswer's claim plan, publishFinalAnswer's
// citations, buildResponseBlocks) even though answerComposerPrompt (the
// ONLY place evidence text actually reaches an LLM prompt) already
// cherry-picks its own specific fields and never needed evidence to
// arrive pre-trimmed. Found via a live end-to-end check for the chart
// feature: a real getPriceHistory evidence record's chartSeries was
// present immediately after executeTools but gone by composeAnswer,
// making renderDeterministicAnswer silently fall through to free-text
// composition every time. The exact same mechanism affects news_list's
// imageUrl in production today (unconfirmed live, since Phase 1C.2's own
// live verification could not get past a provider auth failure to reach
// this code path) -- this fix resolves both.
const boundExcerpt = (item) => (
  item?.excerpt && item.excerpt.length > 500 ? { ...item, excerpt: item.excerpt.slice(0, 500) } : item
);

const EVIDENCE_DEPENDENT_INTENTS = new Set([
  'LIVE_MARKET_DATA', 'COMPANY_RESEARCH', 'EARNINGS_INTELLIGENCE',
  'DOCUMENT_RESEARCH', 'NEWS_RESEARCH', 'STOCK_COMPARISON', 'FOLLOW_UP',
]);

/**
 * validateEvidence - deterministic pre-composition gate. Deduplicates
 * evidence and, for intents that inherently require company-specific
 * facts, flags plainly when nothing came back so composeAnswer is told to
 * say "insufficient evidence" rather than improvise.
 */
export const validateEvidence = async (state) => {
  if (state.errors.length) return {};
  if (state.onEvent) state.onEvent({ type: 'status', message: 'Validating evidence…' });

  const seen = new Set();
  const deduped = state.evidence.filter((item) => {
    if (!item?.evidenceId || seen.has(item.evidenceId)) return false;
    seen.add(item.evidenceId);
    return true;
  });

  const warnings = [];
  // Phase 4B/4C: the grounded RAG flow's real evidence lives in
  // state.researchEvidence, never the legacy state.evidence array (see
  // toolRegistry.js's retrieveGroundedEvidence) — this check would
  // otherwise misfire a false "no evidence found" warning on every
  // successful grounded answer (confirmed live). Its own zero-evidence
  // case is already handled honestly by composeAnswer.js's grounded
  // branch (ABSTAINED), which needs no warning from here. Recomputed via
  // the same deterministic scope every grounded-aware node uses — the
  // grounded route is no longer tied to a single intent label.
  const lastMessage = state.messages?.[state.messages.length - 1];
  const scope = resolveResearchScope({ text: String(lastMessage?.content || ''), entities: state.entities, intent: state.intent });
  if (!scope.needsResearchCorpus
    && EVIDENCE_DEPENDENT_INTENTS.has(state.intent) && state.toolPlan.length && !deduped.length) {
    warnings.push('No verifiable evidence was found for this request — say so explicitly rather than guessing.');
  }

  // Phase 5A: one rag.evidence.built event per evidence round. Carries only
  // the COUNT of de-duplicated evidence records — never an evidence item, a
  // document excerpt, or a citation URL.
  emitEvent('rag.evidence.built', {
    traceId: state.traceId, requestId: state.requestId,
    evidenceCount: deduped.length, retrievalMode: state.retrievalMode || null,
  });

  return { evidence: deduped.map(boundExcerpt), warnings };
};

export default validateEvidence;
