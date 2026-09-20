import { OpenAIClientFactory, LLM_CONFIG } from '../../llm/OpenAIClientFactory.js';
import { mapOpenAIError } from '../../llm/errors.js';
import { buildSystemPrompt, answerComposerPrompt } from '../prompts/index.js';
import { formatMissingEvidenceForPrompt } from '../evidenceCoverage.js';
import { SAFE_REASONS } from '../safeReasons.js';
import { boundedTimeout, hasBudgetFor } from '../requestBudget.js';
import { extractCitations } from '../citations.js';
import { EVIDENCE_DEPENDENT_INTENTS } from '../claimValidation.js';
import { resolveResearchScope } from '../researchScope.js';
import { generateGroundedAnswer } from '../groundedAnswer.js';
import { logger } from '../../utils/logger.js';
import { emitEvent } from '../../services/telemetry/ragTelemetry.js';
import { recordLlmCall } from '../../services/telemetry/costLedger.js';
import { buildClaimPlan } from '../../services/claimPlan.js';
import { renderDeterministicAnswer, renderUnavailableAnswer } from '../../services/answerRenderer.js';
import { classifySector, getStoredProfile, UNAVAILABLE_REASONS } from '../../services/storedFundamentals.js';

// Re-exported unchanged for backward compatibility — extractCitations now
// lives in graph/citations.js (see its own module note for why: it's used
// by publishFinalAnswer.js and buildSafeFallback.js too, not just here).
export { extractCitations };

const MIN_COMPOSE_BUDGET_MS = 500;

const GENERAL_EDUCATION_SYSTEM_NOTE = 'This is a general educational question — answer directly and concisely, with no citations needed since no company-specific tool data was used.';

// UNSUPPORTED must NEVER be treated like GENERAL_EDUCATION — a general
// question ("what is a P/E ratio?") is safe to answer from the model's own
// knowledge, but an UNSUPPORTED classification specifically means "this
// requires a capability GS Copilot doesn't have" (e.g. sector-wide
// ranking/discovery — see classifyIntent's isUnsupportedSectorDiscovery).
// Letting the model answer normally here would mean it improvises a
// ranked list of companies from its own training data with no real
// evidence — exactly the "answer from unsupported knowledge" failure mode
// this project must prevent. The model is told plainly to decline instead.
const UNSUPPORTED_SYSTEM_NOTE = `This request needs a capability GS Copilot does not currently have (for example: ranking or discovering companies across a whole sector by a metric like order book — there is no such tool or dataset available). Do not attempt to answer using your own general knowledge or guess a list of companies. Instead, clearly tell the user: "${SAFE_REASONS.CAPABILITY_NOT_SUPPORTED} — GS Copilot can look up named companies individually (e.g. financials, margins, comparisons between specific companies you name), but cannot yet rank or discover companies across an entire sector." Keep it brief and suggest they name specific companies instead.`;

/**
 * composeAnswer - Phase 3: produces a PRIVATE draft only. OpenAI output is
 * still received as a real stream internally (so the SDK's normal
 * streaming/cancellation path is exercised), but individual deltas are
 * accumulated on the server and are NEVER emitted as `token` events and
 * NEVER persisted — see nodes/publishFinalAnswer.js, the only node that
 * ever emits token events or writes `state.answer`, and only once
 * validateFinalAnswer has actually passed (or repaired) this draft.
 *
 * Latency trade-off (documented per instruction): the user's first
 * VISIBLE answer token now arrives after composition AND validation (and,
 * on the minority of turns that need it, one repair pass) complete —
 * strictly later than before, when raw tokens were streamed live as
 * OpenAI produced them. The `status` events below exist specifically to
 * keep the UI feeling responsive during that gap.
 *
 * For every deterministic/safe path below (input errors, not configured,
 * no budget, a provider error, a genuine cancellation) the "draft" is
 * already a fixed, non-LLM-generated safe string — never fabricated, so
 * `validationStatus: 'SKIPPED_GENERAL_EDUCATION'` is set directly and
 * validateFinalAnswer passes it straight through without re-checking.
 * The one exception is a genuine cancellation/timeout, where draftAnswer
 * stays null (nothing to publish) and validationStatus is 'FAILED_SAFE'.
 */
const composeAnswerInner = async (state) => {
  if (state.errors.length) {
    const draftAnswer = state.errors[0];
    return { draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION' };
  }

  if (!OpenAIClientFactory.isConfigured()) {
    const draftAnswer = "GS Copilot isn't configured yet — the site administrator needs to set an OpenAI API key.";
    return { draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION', warnings: ['OpenAI is not configured.'] };
  }

  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');

  // Phase 4C: the grounded RAG branch is gated on a deterministic TEXT
  // classification (graph/researchScope.js's classifyResearchQuestionType),
  // never on state.intent's exact label — classifyIntent.js's own
  // EARNINGS_PHRASES rule absorbs most natural "guidance"/"promise"
  // questions into EARNINGS_INTELLIGENCE before the LLM ever runs (see
  // researchScope.js's module note), so gating on intent alone (the
  // original Phase 4B behavior) missed the large majority of real
  // questions. Company/period/question-type resolution is recomputed here
  // via resolveResearchScope (pure, deterministic, the SAME function
  // planTools.js already used to decide what to retrieve) rather than
  // threaded through state, so this node never trusts anything but
  // state.entities/intent/the message text.
  const scope = resolveResearchScope({ text, entities: state.entities, intent: state.intent });
  if (scope.needsResearchCorpus) {
    if (scope.ambiguousCompany) {
      return {
        draftAnswer: 'Which company would you like me to check the research documents for? Please name it directly (e.g. its ticker or full name) so I don\'t guess.',
        validationStatus: 'SKIPPED_GENERAL_EDUCATION',
      };
    }

    // Mirrors the Phase 4A zero-evidence fast path below: retrieval
    // genuinely ran (planTools.js planned it) but came back with nothing
    // usable — never spend a generation call on a draft that would only
    // ever be rejected for having nothing to cite.
    if (!state.researchEvidence?.length) {
      return { validationStatus: 'ABSTAINED' };
    }

    return generateGroundedAnswer(state, scope);
  }

  // Phase 2 bug found via live evaluation: this used to check
  // `!state.toolPlan.length` to mean "planTools decided no tool was
  // needed." That stopped being true once a bounded replan round could
  // exist (nodes/replanMissingEvidence.js) — a replan round that
  // correctly finds nothing further worth fetching (e.g. every gap is
  // UNAVAILABLE with no alternative tool) legitimately returns
  // `toolPlan: []`, overwriting round 1's real plan even though real
  // tools DID run and produced real (if empty/unavailable) toolResults.
  // Composing with GENERAL_EDUCATION_SYSTEM_NOTE in that case is actively
  // wrong: that note explicitly tells the model "no citations needed,
  // answer from your own knowledge" for what was really an
  // evidence-dependent question — confirmed live, this caused a
  // "Compare HAL and BEL" comparison (both symbols UNAVAILABLE from a
  // real IndianAPI rate limit) to be answered with fabricated general
  // knowledge (invented founding years, etc.) instead of the honest
  // "I don't have data right now" the warnings already correctly said.
  // toolResults — accumulated across BOTH rounds via state.js's
  // mergeToolResults — is the reliable signal for "did any tool actually
  // run this turn," regardless of what the LATEST round's plan was.
  const isGeneralEducation = state.intent === 'GENERAL_EDUCATION' || !state.toolResults.length;

  // Phase 4A item 9 (zero-evidence efficiency fix): the Phase 3 hardening
  // benchmark showed the primary comparison question needed a full
  // compose-then-repair round trip in 10/10 runs, purely to arrive back
  // at the SAME deterministic "I don't have verified data" fallback
  // buildSafeFallback.js would have produced anyway — evidence-dependent
  // tools genuinely ran (toolResults.length > 0) but came back with zero
  // usable evidence, so there was never anything real for a draft to cite
  // in the first place. Detecting that HERE, before spending an LLM call
  // on a draft that deterministic validation was always going to reject,
  // skips both the compose call and the repair call it would otherwise
  // trigger. validateFinalAnswer treats ABSTAINED as already-terminal
  // (same as SKIPPED_GENERAL_EDUCATION/FAILED_SAFE) and graph.js's
  // routeAfterValidation sends it straight to buildSafeFallback, which
  // builds the honest, per-dimension "unavailable" answer from the real
  // evidenceCoverage/missingEvidence state — never a fabricated draft.
  // Never fires for GENERAL_EDUCATION/UNSUPPORTED (excluded from
  // EVIDENCE_DEPENDENT_INTENTS), and never fires when tools never ran at
  // all (toolResults.length === 0 is a different, pre-existing case —
  // see isGeneralEducation above — not what this fix targets) or when
  // SOME evidence exists (a partial answer still has real content worth
  // composing and citing).
  if (EVIDENCE_DEPENDENT_INTENTS.has(state.intent) && state.toolResults.length > 0 && !state.evidence.length) {
    // Phase 6A: name what is missing and why, per company, instead of a
    // generic abstention. BEL/HAL must read as "no verified filing data has
    // been collected", not as a vague apology that implies a retry helps.
    const symbols = (state.entities?.symbols || []).map((sym) => String(sym).toUpperCase());
    const precise = renderUnavailableAnswer({ symbols, missing: state.missingEvidence || [] });
    if (precise) {
      return { draftAnswer: precise, validationStatus: 'ABSTAINED_PRECISE' };
    }
    return { validationStatus: 'ABSTAINED' };
  }

  // ---------------------------------------------------------------------
  // Phase 6A: DETERMINISTIC COMPOSITION
  // ---------------------------------------------------------------------
  // A 5x5 stability trace found 25/25 turns retrieving evidence but only
  // 4/25 passing verification, with 20 of 29 claim failures being
  // UNSUPPORTED_INFERENCE and 5 MISSING_CITATION: the model restating real
  // figures without their citation, or reasoning past what any single
  // evidence item supports. That is a sampling property of free-text
  // generation, and two rounds of prompt instruction did not make it
  // reliable.
  //
  // So for metric-shaped questions the factual core is no longer generated.
  // buildClaimPlan extracts typed claims (company, metric, value, unit,
  // period, evidence index) and the renderer emits the verdict, table,
  // strengths, risks and limitations directly from them. The model never
  // writes a number, a period, a unit, or a citation id, so it cannot
  // invent or mis-cite one.
  //
  // This does NOT bypass verification: validateFinalAnswer runs on this
  // text exactly as it would on a generated draft, and passes it because
  // every sentence restates a cited excerpt. It also removes the synthesis
  // LLM call entirely for these turns, which is where most of the latency
  // and all of the variance lived.
  if (EVIDENCE_DEPENDENT_INTENTS.has(state.intent) && state.evidence.length) {
    const symbols = (state.entities?.symbols || []).map((sym) => String(sym).toUpperCase());
    const sectorKindBySymbol = {};
    await Promise.all(symbols.map(async (symbol) => {
      const profile = await getStoredProfile(symbol).catch(() => null);
      sectorKindBySymbol[symbol] = classifySector(profile, symbol);
    }));

    const plan = buildClaimPlan({
      evidence: state.evidence,
      symbols,
      sectorKindBySymbol,
      missingEvidence: state.missingEvidence || [],
    });

    const rendered = renderDeterministicAnswer(plan, { question: text });
    if (rendered) {
      if (state.onEvent) state.onEvent({ type: 'status', message: 'Verifying claims and citations…' });
      return { draftAnswer: rendered, claimPlan: plan };
    }
  }

  const userPrompt = state.intent === 'UNSUPPORTED'
    ? `${UNSUPPORTED_SYSTEM_NOTE}\n\nUser question: "${text}"`
    : isGeneralEducation
      ? `${GENERAL_EDUCATION_SYSTEM_NOTE}\n\nUser question: "${text}"`
      : answerComposerPrompt({
        message: text, conversationSummary: state.conversationSummary, evidence: state.evidence, toolResults: state.toolResults,
        warnings: state.warnings, missingDataNotes: formatMissingEvidenceForPrompt(state.missingEvidence),
      });

  // Never start a synthesis call with essentially no budget left — a
  // partial-evidence, honest "ran out of time" answer beats hanging past
  // the turn's total deadline.
  if (!hasBudgetFor(state.deadlineAt, MIN_COMPOSE_BUDGET_MS)) {
    const draftAnswer = 'I ran out of time gathering everything for this answer — please try again.';
    return {
      draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION',
      warnings: ['Response generation skipped: request deadline exhausted.'],
      llmCalls: [recordLlmCall({ node: 'composeAnswer', role: 'synthesis', model: LLM_CONFIG.synthesisModel, durationMs: 0, timedOut: false, skipped: 'SKIPPED_NO_BUDGET' })],
    };
  }

  const systemPrompt = buildSystemPrompt(state.userContext);
  if (state.onEvent) state.onEvent({ type: 'status', message: 'Composing evidence-backed answer…' });

  // Recent prior turns are included verbatim (never summarized) so the
  // model has real conversational continuity beyond the factual summary.
  const historyMessages = (state.recentHistory || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const model = LLM_CONFIG.synthesisModel;
  const startedAt = Date.now();
  // Real cancellation: a controller-provided AbortSignal (client
  // disconnect or the request's total deadline — see ChatController.js)
  // is combined with a local timer bounded to whatever's left of the
  // budget, so composeAnswer never waits past either.
  const timeoutMs = boundedTimeout(LLM_CONFIG.timeoutMs, state.deadlineAt);
  const localController = new AbortController();
  const combinedSignal = state.abortSignal ? AbortSignal.any([state.abortSignal, localController.signal]) : localController.signal;
  const timer = setTimeout(() => localController.abort(), timeoutMs);

  try {
    const client = OpenAIClientFactory.getClient();
    const stream = await client.chat.completions.create({
      model,
      temperature: LLM_CONFIG.temperature,
      max_tokens: LLM_CONFIG.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: userPrompt },
      ],
    }, { signal: combinedSignal });

    let full = '';
    let tokenUsage = null;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      // Draft chunks are accumulated PRIVATELY — never emitted as a
      // user-visible `token` event and never persisted. Only
      // publishFinalAnswer, after validation, emits the final text.
      if (delta) full += delta;
      if (chunk.usage) {
        tokenUsage = {
          inputTokens: chunk.usage.prompt_tokens ?? null,
          outputTokens: chunk.usage.completion_tokens ?? null,
          totalTokens: chunk.usage.total_tokens ?? null,
          // Phase 5A Part 5: additive, present only when the provider
          // actually includes it — never estimated.
          cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? null,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? null,
        };
      }
      if (state.aborted?.()) {
        stream.controller?.abort?.();
        break;
      }
    }

    const llmCalls = [recordLlmCall({
      node: 'composeAnswer', role: 'synthesis', model, durationMs: Date.now() - startedAt, timedOut: false,
      inputTokens: tokenUsage?.inputTokens ?? null, outputTokens: tokenUsage?.outputTokens ?? null,
      cachedInputTokens: tokenUsage?.cachedInputTokens ?? null, reasoningTokens: tokenUsage?.reasoningTokens ?? null,
    })];
    if (state.onEvent) state.onEvent({ type: 'status', message: 'Verifying claims and citations…' });
    return { draftAnswer: full, tokenUsage, llmCalls };
  } catch (error) {
    const timedOut = error?.isAbort || error?.name === 'APIUserAbortError' || combinedSignal.aborted;
    const llmCalls = [recordLlmCall({ node: 'composeAnswer', role: 'synthesis', model, durationMs: Date.now() - startedAt, timedOut })];
    if (timedOut) {
      // A caller-initiated cancellation (client disconnect / deadline) is
      // never reported as a provider failure, and there is nothing safe
      // to publish — draftAnswer stays null, FAILED_SAFE short-circuits
      // the rest of the pipeline cheaply (see validateFinalAnswer.js).
      return { draftAnswer: null, validationStatus: 'FAILED_SAFE', warnings: ['Generation was stopped.'], llmCalls };
    }
    const mapped = mapOpenAIError(error, { operation: 'composeAnswer' });
    logger.warn(`[Graph] composeAnswer failed: ${mapped.message}`);
    const draftAnswer = 'I ran into a problem generating a response just now. Please try again.';
    return { draftAnswer, validationStatus: 'SKIPPED_GENERAL_EDUCATION', errors: [mapped.message], llmCalls };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * composeAnswer - Phase 5A Part 2/7 addition: a thin wrapper around the
 * existing, untouched composeAnswerInner. Recomputes resolveResearchScope
 * (the SAME pure, deterministic call composeAnswerInner already makes
 * internally — cheap, no I/O, safe to call twice) purely to persist its
 * verdict into state as `scopeSignal`, so operational telemetry
 * (services/telemetry/errorTaxonomy.js) and the canonical trace context
 * (researchQuestionType, ambiguousCompany, symbol, fiscalYear/Quarter) can
 * read it without composeAnswerInner's own branching logic changing at
 * all. Never changes composeAnswerInner's return value or control flow —
 * only adds one additional field alongside whatever it already returned.
 */
export const composeAnswer = async (state) => {
  const lastMessage = state.messages[state.messages.length - 1];
  const text = String(lastMessage?.content || '');
  const scope = resolveResearchScope({ text, entities: state.entities, intent: state.intent });
  const scopeSignal = {
    researchQuestionType: scope.researchQuestionType,
    needsResearchCorpus: scope.needsResearchCorpus,
    ambiguousCompany: scope.ambiguousCompany,
    symbol: scope.symbol,
    fiscalYear: scope.fiscalYear,
    fiscalQuarter: scope.fiscalQuarter,
  };
  // Phase 5A: rag.scope.resolved — emitted once per turn, from the one node
  // every path reaches (validateInput routes an input error straight here,
  // see graph.js), so it can never double-count. planTools.js resolves the
  // same scope for its own planning but deliberately does NOT emit: one
  // scope decision, one event. Carries the resolved scope labels only —
  // never the question text they were derived from.
  emitEvent('rag.scope.resolved', {
    traceId: state.traceId,
    requestId: state.requestId,
    intent: state.intent,
    researchQuestionType: scopeSignal.researchQuestionType,
    companySymbol: scopeSignal.symbol,
    fiscalYear: scopeSignal.fiscalYear,
    fiscalQuarter: scopeSignal.fiscalQuarter,
  });

  const generationStartedAt = performance.now();
  const update = await composeAnswerInner(state);

  // rag.generation.completed — ONLY when a generation call genuinely ran.
  // The zero-evidence fast path and every fixed-safe-string branch return no
  // llmCalls at all, and must not look like a generation that produced
  // nothing. Prefers the call's OWN measured duration over this wrapper's,
  // which would also include prompt assembly. Carries no prompt, no answer
  // text, and no token counts (see RAG_EVENT_SCHEMA's note on where those
  // legitimately live).
  const generationCall = (update?.llmCalls || [])[0];
  if (generationCall) {
    emitEvent('rag.generation.completed', {
      traceId: state.traceId,
      requestId: state.requestId,
      model: generationCall.model || null,
      role: generationCall.role || null,
      llmCallCount: update.llmCalls.length,
      groundingStatus: update.groundingStatus || null,
      durationMs: Number.isFinite(generationCall.durationMs)
        ? generationCall.durationMs
        : Math.round(performance.now() - generationStartedAt),
    });
  }

  return { ...update, scopeSignal };
};

export default composeAnswer;
