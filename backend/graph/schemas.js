import { z } from 'zod';
import { REQUESTED_DIMENSIONS } from './dimensions.js';

/**
 * schemas.js
 * ===========
 * Zod schemas for every structured-output call GS Copilot's graph makes.
 * Passed to `zodResponseFormat` (openai/helpers/zod, confirmed present in
 * the installed openai@6.49.0 SDK) so the model's JSON output is validated
 * before the graph trusts it — a malformed response never crashes the
 * graph (see nodes/classifyIntent.js's single-retry-then-fallback logic).
 */

export const INTENTS = Object.freeze([
  'GENERAL_EDUCATION',
  'LIVE_MARKET_DATA',
  'COMPANY_RESEARCH',
  'EARNINGS_INTELLIGENCE',
  'DOCUMENT_RESEARCH',
  'NEWS_RESEARCH',
  'WATCHLIST_ANALYSIS',
  'PORTFOLIO_ANALYSIS',
  'STOCK_COMPARISON',
  'FOLLOW_UP',
  'UNSUPPORTED',
]);

export const IntentSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(300),
});

export const EntitiesSchema = z.object({
  symbols: z.array(z.string()).max(10),
  companyNames: z.array(z.string()).max(10),
  periods: z.array(z.string()).max(10),
  comparisonMode: z.boolean(),
  resolvedFromFollowUp: z.boolean(), // true when an entity like "its"/"that company" was resolved from thread memory rather than the current message
});

export const APPROVED_TOOLS = Object.freeze([
  'getLiveQuote',
  'getCompanyResearch',
  'getCompanyFinancials',
  'getCompanyNews',
  'getEarningsTimeline',
  'getManagementPromiseDetails',
  'searchResearchDocuments',
  'getWatchlist',
  'getPortfolio',
  'compareStocks',
  // Phase 4B: grounded RAG retrieval — wraps
  // services/ResearchRetrieverService.js's retrieveResearchEvidence
  // directly (provider-independent per RAG_RETRIEVAL_MODE), distinct from
  // the legacy searchResearchDocuments/collectDocuments path above, which
  // stays untouched. See graph/tools/toolRegistry.js.
  'retrieveGroundedEvidence',
]);

// OpenAI's strict Structured Outputs mode (zodResponseFormat defaults to
// strict: true — see openai/helpers/zod, confirmed in the installed SDK)
// rejects any object with a dynamic key set (z.record() compiles to
// `additionalProperties: <schema>`, which strict mode forbids). Tool args
// are therefore a FIXED, nullable field set rather than a free-form map —
// each tool destructures only the field(s) it needs.
export const ToolArgsSchema = z.object({
  symbol: z.string().nullable(),
  symbols: z.array(z.string()).nullable(),
  promiseId: z.string().nullable(),
  // Phase 2 "requested-dimension planning" — only compareStocks reads this
  // (see graph/tools/toolRegistry.js); every other tool ignores an unknown
  // arg key harmlessly. Validated against the same closed enum
  // extractEntities resolves deterministically, so the LLM planning
  // fallback path can never invent a dimension outside it.
  dimensions: z.array(z.enum(REQUESTED_DIMENSIONS)).nullable(),
  // Phase 4B: retrieveGroundedEvidence's own args. In practice this tool
  // is always planned deterministically (see planTools.js's DOCUMENT_
  // RESEARCH case, which never delegates company/period resolution to the
  // LLM) — these fields exist mainly so the LLM-planning fallback schema
  // stays complete if that path is ever reached for this tool.
  fiscalYear: z.string().nullable(),
  fiscalQuarter: z.string().nullable(),
  query: z.string().nullable(),
});

export const ToolPlanSchema = z.object({
  tools: z.array(z.object({
    tool: z.enum(APPROVED_TOOLS),
    args: ToolArgsSchema,
    reason: z.string().max(200),
  })).max(6),
});

export const CitationRefSchema = z.object({
  evidenceId: z.string(),
  claim: z.string().max(300),
});

// Removed in the Phase 3 hardening pass: ValidationResultSchema (a
// whole-answer pass/fail shape with no per-claim/evidence-index
// granularity) was unused both before and after Phase 3 — confirmed via a
// repo-wide grep with zero remaining imports anywhere (including tests) —
// and could not have been safely extended into the actual claim-level
// verifier below, which needs per-claim verdicts and evidence indexes
// this shape never had. Superseded by ClaimVerificationSchema.
// validationPrompt (prompts/index.js) was removed for the same reason —
// see this file's history for the removed shapes if ever needed again.

// Phase 3: structured claim verification. Each verdict names exactly what
// is wrong with one atomic claim — never free-form reasoning, never
// chain-of-thought (see graph/claimValidation.js and
// prompts/index.js's claimVerificationPrompt for how this is used).
export const CLAIM_VERDICTS = Object.freeze([
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'UNSUPPORTED',
  'WRONG_SYMBOL',
  'WRONG_PERIOD',
  'WRONG_DIMENSION',
  'FORECAST_AS_ACTUAL',
  'GUIDANCE_AS_OUTCOME',
  'INVALID_CITATION',
]);

export const ClaimVerificationSchema = z.object({
  claims: z.array(z.object({
    claimId: z.string().max(40),
    verdict: z.enum(CLAIM_VERDICTS),
    // 1-based indexes into the SAME numbered evidence list the draft was
    // given — never a raw evidenceId, so out-of-range values are trivially
    // checkable the same way extractCitations already checks draft citations.
    evidenceIndexes: z.array(z.number().int().min(1)).max(10),
    reasonCode: z.string().max(60),
  })).max(20),
});

// Phase 3: strict enum for state.validationStatus — see
// nodes/validateFinalAnswer.js for what sets each one and graph.js's
// routeAfterValidation for what each one means for graph routing.
export const VALIDATION_STATUSES = Object.freeze([
  'PASSED',
  'REPAIR_REQUIRED',
  'ABSTAINED',
  'FAILED_SAFE',
  'SKIPPED_GENERAL_EDUCATION',
]);

// Phase 4B Part 5: the grounded-answer structured-output shape. The model
// selects ONLY existing evidence ids from the numbered envelope it was
// given — it never constructs citation metadata (sourceUrl/page/etc)
// itself; the server builds the final citation objects from the trusted
// envelope by looking up each claim's evidenceIds (see
// nodes/publishFinalAnswer.js's grounded branch). `verificationStatus` is
// deliberately NOT part of this schema — that field is computed entirely
// server-side by graph/groundedVerification.js AFTER generation, never
// self-reported by the model (Part 6: "not relying on the LLM to verify
// itself").
export const GROUNDED_CLAIM_TYPES = Object.freeze([
  'historical_fact', 'management_guidance', 'revised_guidance', 'outcome', 'interpretation',
]);

export const GROUNDING_STATUSES = Object.freeze(['grounded', 'partially_grounded', 'insufficient_evidence']);

export const GroundedAnswerSchema = z.object({
  answer: z.string().max(4000),
  claims: z.array(z.object({
    claimId: z.string().max(20),
    text: z.string().max(1000),
    claimType: z.enum(GROUNDED_CLAIM_TYPES),
    // Stable "E1"/"E2" ids from the numbered envelope the model was
    // given — never a raw evidenceId string the model invents.
    evidenceIds: z.array(z.string().max(10)).max(10),
    // Phase 4D: OPTIONAL — the model may reference one of the trusted
    // relationshipIds it was shown (e.g. "R2") when explicitly describing
    // a revision/comparison; never required, and checked against the
    // real server-computed list, never trusted at face value (see
    // graph/groundedVerification.js's checkTemporalConsistency).
    relationshipId: z.string().max(10).nullable(),
  })).max(20),
  // The model's OWN self-assessment — informational only; the server
  // recomputes the trusted groundingStatus from final verified claims
  // (see nodes/validateFinalAnswer.js's grounded branch) and never
  // publishes this field directly.
  groundingStatus: z.enum(GROUNDING_STATUSES),
  coverage: z.object({
    requestedSymbol: z.string().nullable(),
    requestedPeriod: z.string().nullable(),
    evidenceCount: z.number().int().min(0),
    limitations: z.array(z.string().max(200)).max(10),
  }),
});

// Phase 4B Part 6: the deterministic grounded-claim verifier's verdict
// enum — see graph/groundedVerification.js for what sets each one. Kept
// separate from CLAIM_VERDICTS above (the Phase 3 legacy verifier's own
// enum) since the two pipelines check fundamentally different things
// (free-text [N] markers vs. structured evidenceIds + fiscal-period/
// numeric normalization).
export const GROUNDED_VERDICTS = Object.freeze([
  'VERIFIED',
  'UNSUPPORTED_CLAIM',
  'UNKNOWN_EVIDENCE_ID',
  'COMPANY_MISMATCH',
  'PERIOD_MISMATCH',
  'NUMERIC_MISMATCH',
  'PROVENANCE_MISMATCH',
  'SUPERSEDED_GUIDANCE',
  'UNCITED_MATERIAL_CLAIM',
  // Phase 4D Part 6: cross-source temporal-reconciliation verdicts — see
  // graph/groundedVerification.js's checkTemporalConsistency for what
  // sets each one. Kept distinct from SUPERSEDED_GUIDANCE above (the
  // Phase 4B same-documentType check, now subsumed by these but left in
  // the enum for backward compatibility with any existing reference).
  'SUPERSEDED_AS_CURRENT',
  'REVISION_NOT_SUPPORTED',
  'TEMPORAL_RELATIONSHIP_MISMATCH',
  'UNDISCLOSED_CONFLICT',
  // Phase 4F.2 Part 6: qualitative-guidance-specific verdicts — see
  // graph/groundedVerification.js's checkQualitativeConsistency.
  'QUALITATIVE_DIRECTION_MISMATCH',
  'QUALITATIVE_OVERREACH',
  'UNSUPPORTED_FULFILLMENT_CLAIM',
]);

export const ConversationSummarySchema = z.object({
  summary: z.string().max(1500),
  activeSymbols: z.array(z.string()).max(15),
  activeCompanies: z.array(z.string()).max(15),
  userDecisions: z.array(z.string().max(200)).max(15),
});

/**
 * ExplicitPreferenceSchema - used only when the answer-composition turn
 * detects the user stated a durable preference in plain language (e.g. "I'm
 * a conservative long-term investor"). `stated` must be true for anything
 * to be persisted to long-term memory — GS Copilot never infers/saves a
 * preference from a casual, ambiguous sentence.
 */
export const ExplicitPreferenceSchema = z.object({
  stated: z.boolean(),
  riskAppetite: z.enum(['conservative', 'moderate', 'aggressive']).nullable(),
  investmentHorizon: z.enum(['short_term', 'medium_term', 'long_term']).nullable(),
  goals: z.array(z.string().max(100)).max(10),
  preferredSectors: z.array(z.string().max(60)).max(10),
});

export default {
  INTENTS,
  IntentSchema,
  EntitiesSchema,
  APPROVED_TOOLS,
  ToolPlanSchema,
  CitationRefSchema,
  CLAIM_VERDICTS,
  ClaimVerificationSchema,
  VALIDATION_STATUSES,
  ConversationSummarySchema,
  ExplicitPreferenceSchema,
  GROUNDED_CLAIM_TYPES,
  GROUNDING_STATUSES,
  GroundedAnswerSchema,
  GROUNDED_VERDICTS,
};
