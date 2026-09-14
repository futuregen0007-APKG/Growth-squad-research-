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

// Superseded by ClaimVerificationSchema below for Phase 3's actual
// claim-level verifier — this whole-answer pass/fail shape has no
// evidence-index or per-claim verdict granularity, so it was not reused.
// Kept only because it was already exported (unused before Phase 3 too;
// see the Phase 3 audit report for why extending it wasn't safe/useful).
export const ValidationResultSchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.string().max(300)),
  missingEvidenceClaims: z.array(z.string().max(300)),
});

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
  ValidationResultSchema,
  CLAIM_VERDICTS,
  ClaimVerificationSchema,
  VALIDATION_STATUSES,
  ConversationSummarySchema,
  ExplicitPreferenceSchema,
};
