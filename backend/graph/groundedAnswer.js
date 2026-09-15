import { OpenAIClientFactory, LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { GroundedAnswerSchema } from './schemas.js';
import { groundedAnswerPrompt, groundedRepairPrompt } from './prompts/index.js';
import { invokeRoutingModel } from './llmInvoke.js';
import { verifyGroundedAnswer } from './groundedVerification.js';
import { resolveResearchScope } from './researchScope.js';
import { hasBudgetFor } from './requestBudget.js';

/**
 * groundedAnswer.js
 * ===================
 * Phase 4B's grounded RAG generate/verify/repair/publish/fallback logic,
 * called as thin branches from the EXISTING composeAnswer.js/
 * validateFinalAnswer.js/repairAnswer.js/publishFinalAnswer.js/
 * buildSafeFallback.js node files (see each node's own module note) —
 * deliberately NOT five new graph.js nodes/edges. This keeps the mature,
 * already-tested Phase 1-3 routing (routeAfterValidation's PASSED/
 * REPAIR_REQUIRED/ABSTAINED/FAILED_SAFE states, the repairCount<1 cap)
 * working completely unchanged: every function below returns state
 * updates using the SAME validationStatus enum, so the graph's existing
 * edges route a grounded turn exactly like a legacy one.
 */

const MIN_GENERATE_BUDGET_MS = 800;
const MIN_REPAIR_BUDGET_MS = 800;

/**
 * generateGroundedAnswer - Part 5's structured generation call. Called
 * from composeAnswer.js once retrieval (executeTools' retrieveGroundedEvidence
 * step) has already populated state.researchEvidence. Never called at all
 * when the corpus scope was ambiguous or the retrieval was empty — see
 * composeAnswer.js's grounded branch, which handles both cases itself
 * before ever reaching here (mirrors the legacy pipeline's own
 * zero-evidence fast path in spirit).
 */
export const generateGroundedAnswer = async (state, scope) => {
  if (!OpenAIClientFactory.isConfigured()) {
    return {
      draftAnswer: "GS Copilot isn't configured yet — the site administrator needs to set an OpenAI API key.",
      validationStatus: 'SKIPPED_GENERAL_EDUCATION',
      warnings: ['OpenAI is not configured.'],
    };
  }
  if (!hasBudgetFor(state.deadlineAt, MIN_GENERATE_BUDGET_MS)) {
    return {
      draftAnswer: 'I ran out of time gathering everything for this answer — please try again.',
      validationStatus: 'SKIPPED_GENERAL_EDUCATION',
      warnings: ['Response generation skipped: request deadline exhausted.'],
    };
  }

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');

  if (state.onEvent) state.onEvent({ type: 'status', message: 'Composing evidence-backed research answer…' });

  const { parsed, error, diagnostic } = await invokeRoutingModel({
    node: 'generateGroundedAnswer',
    role: 'grounded_generation',
    model: LLM_CONFIG.synthesisModel,
    maxTokens: LLM_CONFIG.maxOutputTokens,
    schema: GroundedAnswerSchema,
    schemaName: 'grounded_answer',
    prompt: groundedAnswerPrompt({ message: text, scope, evidenceEnvelope: state.researchEvidence, relationships: state.researchRelationships }),
    signal: state.abortSignal,
    deadlineAt: state.deadlineAt,
    minBudgetMs: MIN_GENERATE_BUDGET_MS,
  });

  if (!parsed) {
    // A genuine cancellation is never reported as a provider failure and
    // has nothing safe to publish (mirrors composeAnswer.js's own
    // FAILED_SAFE/draftAnswer:null cancellation path).
    if (error === 'CANCELLED') {
      return { validationStatus: 'FAILED_SAFE', warnings: ['Generation was stopped.'], llmCalls: [diagnostic] };
    }
    return {
      draftAnswer: 'I ran into a problem generating a research answer just now. Please try again.',
      validationStatus: 'SKIPPED_GENERAL_EDUCATION',
      errors: [`generateGroundedAnswer: ${error}`],
      llmCalls: [diagnostic],
    };
  }

  if (state.onEvent) state.onEvent({ type: 'status', message: 'Verifying citations and claims…' });
  return { groundedAnswer: parsed, llmCalls: [diagnostic] };
};

/**
 * verifyGroundedAnswerNode - Part 6, called from validateFinalAnswer.js.
 * Purely deterministic (graph/groundedVerification.js) — no LLM call.
 * Recomputes groundingStatus from the FINAL claim verdicts every pass
 * (including the post-repair pass), never accumulated.
 */
export const verifyGroundedAnswerNode = (state) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const scope = resolveResearchScope({ text: String(lastMessage?.content || ''), entities: state.entities, intent: state.intent });
  const { claims, groundingStatus, allVerified } = verifyGroundedAnswer({
    claims: state.groundedAnswer?.claims || [],
    evidenceEnvelope: state.researchEvidence,
    scope,
  });

  // Zero claims is the model HONESTLY asserting it has nothing it can
  // stand behind (e.g. a correct insufficient_evidence answer) — nothing
  // to repair, and spending the one bounded repair attempt on it would
  // only ever re-arrive at the same empty-claims state. Publish it as-is;
  // publishGroundedAnswerNode naturally produces zero citations for zero
  // claims either way.
  const validationStatus = (!claims.length || allVerified) ? 'PASSED' : 'REPAIR_REQUIRED';
  const validationIssues = claims.filter((c) => c.verificationStatus !== 'VERIFIED').map((c) => `${c.claimId}:${c.verificationStatus}:${c.reasonCode}`);

  return {
    groundedClaims: claims,
    groundingStatus,
    validationStatus,
    validationIssues,
    coverage: {
      ...(state.groundedAnswer?.coverage || {}),
      requestedSymbol: scope.symbol,
      requestedPeriod: scope.period,
    },
  };
};

/**
 * repairGroundedAnswerNode - Part 7's ONE bounded repair, called from
 * repairAnswer.js. Sends the SAME evidence envelope back with the
 * verifier's per-claim failures and asks for a corrected structured
 * answer — never a new retrieval, never a new evidenceId. If the call
 * itself fails, groundedAnswer is left UNCHANGED (validateFinalAnswer's
 * re-run will find the same failures again, and the router sends it to
 * buildSafeFallback since repairCount is now >= 1 — never a fabricated
 * "repaired" answer).
 */
export const repairGroundedAnswerNode = async (state) => {
  const repairCount = (state.repairCount || 0) + 1;
  const base = { repairCount, repairAttempted: true };

  if (!OpenAIClientFactory.isConfigured() || state.aborted?.() || !hasBudgetFor(state.deadlineAt, MIN_REPAIR_BUDGET_MS)) {
    return base;
  }

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');
  const scope = resolveResearchScope({ text, entities: state.entities, intent: state.intent });

  if (state.onEvent) state.onEvent({ type: 'status', message: 'Correcting unverified claims…' });

  const { parsed, diagnostic } = await invokeRoutingModel({
    node: 'repairGroundedAnswer',
    role: 'grounded_repair',
    model: LLM_CONFIG.synthesisModel,
    maxTokens: LLM_CONFIG.maxOutputTokens,
    schema: GroundedAnswerSchema,
    schemaName: 'grounded_answer_repair',
    prompt: groundedRepairPrompt({
      message: text, scope, evidenceEnvelope: state.researchEvidence, relationships: state.researchRelationships, draft: state.groundedAnswer, claims: state.groundedClaims,
    }),
    signal: state.abortSignal,
    deadlineAt: state.deadlineAt,
    minBudgetMs: MIN_REPAIR_BUDGET_MS,
  });

  if (!parsed) return { ...base, llmCalls: [diagnostic] };
  return {
    ...base, groundedAnswer: parsed, llmCalls: [diagnostic],
  };
};

/**
 * evidenceUsedByVerifiedClaims - Part 9: "return only citations actually
 * used by verified claims" — never every retrieved evidence item, and
 * never an item cited only by a claim that failed verification (which, by
 * the time this runs, cannot happen anyway: publishGroundedAnswerNode is
 * only ever reached with validationStatus PASSED, i.e. every claim already
 * verified — this filter is kept anyway as a defensive, structural
 * guarantee rather than relying on that invariant alone).
 */
const evidenceUsedByVerifiedClaims = (claims, evidenceEnvelope) => {
  const evidenceById = new Map(evidenceEnvelope.map((item) => [item.evidenceId, item]));
  const usedIds = new Set();
  claims.filter((c) => c.verificationStatus === 'VERIFIED').forEach((c) => (c.evidenceIds || []).forEach((id) => usedIds.add(id)));
  return [...usedIds]
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.retrievalRank - b.retrievalRank);
};

/** citationFromEvidence - Part 9's citation object shape, built ONLY from the trusted envelope (never from model output). */
const citationFromEvidence = (item) => ({
  evidenceId: item.evidenceId,
  symbol: item.symbol,
  fiscalYear: item.fiscalYear,
  reportingPeriod: item.fiscalQuarter ? `${item.fiscalQuarter} ${item.fiscalYear || ''}`.trim() : item.fiscalYear,
  documentTitle: item.documentTitle,
  documentType: item.documentType,
  sourceAuthority: item.sourceAuthority,
  publishedAt: item.publishedAt,
  sourceUrl: item.sourceUrl,
  pageStart: item.pageStart,
  pageEnd: item.pageEnd,
  excerpt: item.text ? String(item.text).slice(0, 500) : null,
  // Phase 4D Part 7: backward-compatible additive temporal metadata —
  // trusted, server-computed (see services/EvidenceEnvelope.js's
  // reconcileEvidenceEnvelope), never model-generated. `null`/absent for
  // any non-guidance citation, so an existing client reading only the
  // fields above is completely unaffected.
  temporalStatus: item.temporalStatus || null,
  supersededBy: item.supersededByEvidenceId || null,
  supersedes: item.supersedesEvidenceIds && item.supersedesEvidenceIds.length ? item.supersedesEvidenceIds : null,
  canonicalGuidance: item.canonicalGuidance || null,
  // Back-compat aliases so the EXISTING SourcesSection component (which
  // reads c.title/c.provider) renders sensibly with zero frontend changes
  // required — see components/chat/ChatMessageBubble.jsx.
  title: item.documentTitle,
  provider: item.sourceAuthority,
});

/**
 * publishGroundedAnswerNode - Part 9, called from publishFinalAnswer.js.
 * Reached ONLY when validateFinalAnswer decided PASSED (every claim
 * VERIFIED) — draftAnswer-equivalent (groundedAnswer.answer) and
 * groundedClaims are guaranteed consistent at this point.
 */
export const publishGroundedAnswerNode = (state) => {
  const claims = state.groundedClaims?.length ? state.groundedClaims : (state.groundedAnswer?.claims || []).map((c) => ({ ...c, verificationStatus: 'VERIFIED' }));
  const citations = evidenceUsedByVerifiedClaims(claims, state.researchEvidence).map(citationFromEvidence);
  return {
    answer: state.groundedAnswer?.answer || '',
    citations,
    groundedClaims: claims,
    groundingStatus: state.groundingStatus || 'grounded',
  };
};

/**
 * buildGroundedSafeFallback - called from buildSafeFallback.js whenever
 * the grounded flow ends up here: zero evidence at all (ABSTAINED), the
 * generation call itself failed (FAILED_SAFE), or the one repair still
 * left unverified claims (REPAIR_REQUIRED, repair budget spent). NEVER
 * publishes an unverified claim — if ANY claims survived the last
 * verification pass, only those are kept (Part 7: "remove unsafe claims
 * if a useful partial answer results"); otherwise this is an honest
 * insufficient_evidence response, never a crash and never a fabrication.
 */
export const buildGroundedSafeFallback = (state) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const scope = resolveResearchScope({ text: String(lastMessage?.content || ''), entities: state.entities, intent: state.intent });
  const verifiedClaims = (state.groundedClaims || []).filter((c) => c.verificationStatus === 'VERIFIED');

  const periodLabel = scope.fiscalQuarter ? `${scope.fiscalQuarter} ${scope.fiscalYear || ''}`.trim() : (scope.fiscalYear || null);
  const scopeLabel = [scope.symbol, periodLabel].filter(Boolean).join(' ');

  if (verifiedClaims.length) {
    const citations = evidenceUsedByVerifiedClaims(verifiedClaims, state.researchEvidence).map(citationFromEvidence);
    const answer = `Here's what I could verify${scopeLabel ? ` for ${scopeLabel}` : ''}:\n${verifiedClaims.map((c) => `- ${c.text}`).join('\n')}\n\nI couldn't verify the rest of what was asked against the indexed research documents, so I left it out rather than guess.`;
    return {
      answer, citations, groundedClaims: verifiedClaims, groundingStatus: 'partially_grounded',
    };
  }

  const answer = state.researchEvidence?.length
    ? `I don't have verified evidence to confidently answer this${scopeLabel ? ` for ${scopeLabel}` : ''}. The research documents I found didn't clearly support a claim I could stand behind, so I'd rather say that plainly than guess.`
    : `I couldn't find any indexed research documents covering${scopeLabel ? ` ${scopeLabel}` : ' this request'}. I don't have verified evidence to answer this yet.`;

  return {
    answer, citations: [], groundedClaims: [], groundingStatus: 'insufficient_evidence',
  };
};

export default {
  generateGroundedAnswer, verifyGroundedAnswerNode, repairGroundedAnswerNode, publishGroundedAnswerNode, buildGroundedSafeFallback,
};
