import { evidenceForPrompt } from '../evidence.js';
import { resolveResearchScope } from '../researchScope.js';

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

  return { evidence: evidenceForPrompt(deduped), warnings };
};

export default validateEvidence;
