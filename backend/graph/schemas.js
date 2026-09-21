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
  // UI Phase 1C.3: bounded historical daily closes from the durable
  // StockPriceHistorySnapshot collection (NSE bhavcopy) — Mongo-backed,
  // like getEarningsTimeline/getManagementPromiseDetails above, never a
  // live/external provider call. See graph/tools/toolRegistry.js.
  'getPriceHistory',
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
  // UI Phase 1C.3: getPriceHistory's requested window, in calendar days —
  // parsed deterministically from the question by planTools.js (see its
  // parseRequestedRangeDays), never invented by the LLM planning fallback;
  // that path simply omits it and getPriceHistory applies its own default.
  days: z.number().int().positive().nullable(),
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

// ---------------------------------------------------------------------------
// UI Phase 1B: responseBlocks — structured, renderable supplements to the
// Markdown answer.
//
// UNLIKE every schema above, these are NOT passed to zodResponseFormat and
// the model never produces (or even sees) one — they validate the output of
// services/responseBlocks.js's PURE, DETERMINISTIC builders, which read only
// already-verified graph state (the claim plan, the final citations array,
// grounding status, valuation coverage). This is the same "server computes
// and validates, the model never grades its own work" discipline the
// grounded-answer schemas above already apply to claims — applied here to
// the supplementary UI data instead of to prose.
//
// Every array and text field carries an explicit `.max()` — no block field
// is allowed to grow unbounded from accumulated evidence/claim-plan rows.
// `z.discriminatedUnion` rejects any `type` outside the five approved block
// types by construction, and every object is `.strict()` so an unexpected
// extra key fails validation rather than silently passing through.
// ---------------------------------------------------------------------------

/** Same http(s)-only rule graph/evidence.js's isUsableUrl and the frontend's isSafeHref already enforce — never a bare .url() (which accepts any scheme). */
export const isSafeBlockUrl = (value) => {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const SafeUrlSchema = z.string().trim().min(1).max(2048).refine(isSafeBlockUrl, { message: 'sourceUrl must be an http(s) URL' });

/**
 * EvidenceRefSchema - the canonical reference every factual block field
 * must carry. `evidenceId` is the durable identity (matches an entry in
 * the turn's evidence/citations); `citationIndex` is a best-effort,
 * DERIVED convenience number (this evidenceId's 1-based position in the
 * FINAL `citations` array — the same numbering SourcesSection already
 * displays), resolved by the builder from the final citation array, never
 * invented or carried as the only relationship — see
 * services/responseBlocks.js's resolveEvidenceRef.
 */
export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1).max(100),
  citationIndex: z.number().int().min(1).max(200).nullable(),
}).strict();

const MAX_METRICS_PER_GRID = 20;
const MAX_COMPARISON_ROWS = 20;
const MAX_COMPARISON_SYMBOLS = 6;
const MAX_SOURCES = 20;
const MAX_GAPS = 10;
const MAX_SUGGESTED_QUESTIONS = 4;
const MAX_EVIDENCE_PER_FIELD = 10;

export const MetricGridEntrySchema = z.object({
  metric: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().max(30).nullable(),
  period: z.string().max(40).nullable(),
  evidence: z.array(EvidenceRefSchema).min(1).max(MAX_EVIDENCE_PER_FIELD),
}).strict();

export const MetricGridBlockSchema = z.object({
  type: z.literal('metric_grid'),
  symbol: z.string().min(1).max(20),
  metrics: z.array(MetricGridEntrySchema).min(1).max(MAX_METRICS_PER_GRID),
}).strict();

const ComparisonCellSchema = z.object({
  value: z.number().finite(),
  unit: z.string().max(30).nullable(),
  evidence: z.array(EvidenceRefSchema).min(1).max(MAX_EVIDENCE_PER_FIELD),
}).strict();

export const ComparisonRowSchema = z.object({
  metric: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  // Keyed by symbol — z.record requires an explicit key schema in the
  // installed zod@4.
  values: z.record(z.string().min(1).max(20), ComparisonCellSchema),
  commonPeriod: z.string().max(40).nullable(),
  comparable: z.boolean(),
}).strict();

export const ComparisonTableBlockSchema = z.object({
  type: z.literal('comparison_table'),
  symbols: z.array(z.string().min(1).max(20)).min(2).max(MAX_COMPARISON_SYMBOLS),
  rows: z.array(ComparisonRowSchema).min(1).max(MAX_COMPARISON_ROWS),
}).strict();

export const SourceEntrySchema = z.object({
  evidenceId: z.string().min(1).max(100),
  citationIndex: z.number().int().min(1).max(200).nullable(),
  title: z.string().max(300).nullable(),
  sourceUrl: SafeUrlSchema.nullable(),
  provider: z.string().max(120).nullable(),
  publishedAt: z.string().max(40).nullable(),
  reportingPeriod: z.string().max(40).nullable(),
}).strict();

export const SourceListBlockSchema = z.object({
  type: z.literal('source_list'),
  sources: z.array(SourceEntrySchema).min(1).max(MAX_SOURCES),
}).strict();

// ---------------------------------------------------------------------------
// UI Phase 1C.1: company_header, evidence_drawer.
// ---------------------------------------------------------------------------

export const CompanyHeaderPriceSchema = z.object({
  value: z.number().finite(),
  currency: z.literal('INR'),
  // Honest, whichever source it came from: a live quote's real timestamp,
  // or a stored close's real trading date — never blurred (see
  // services/claimPlan.js's LIVE_PRICE/MARKET_HISTORY note).
  asOf: z.string().max(60).nullable(),
  evidence: z.array(EvidenceRefSchema).min(1).max(MAX_EVIDENCE_PER_FIELD),
}).strict();

export const CompanyHeaderBlockSchema = z.object({
  type: z.literal('company_header'),
  symbol: z.string().min(1).max(20),
  // Required (not nullable): the builder only ever produces this block
  // when a verified company name exists — see
  // services/responseBlocks.js's buildCompanyHeaderBlock.
  companyName: z.string().min(1).max(200),
  sector: z.string().max(100).nullable(),
  exchange: z.string().max(20).nullable(),
  price: CompanyHeaderPriceSchema.nullable(),
}).strict();

/**
 * CanonicalGuidanceSchema - mirrors services/EvidenceEnvelope.js's real
 * canonicalGuidance object (and models/ChatMessage.js's persisted
 * sub-schema) field-for-field. Never trusted from the model — this only
 * validates a shape the SERVER already computed.
 */
// Every field is BOTH nullable and optional: services/EvidenceEnvelope.js
// builds this object by spreading `canonical.<field>` directly, so a field
// the source guidance record genuinely never had comes through as
// `undefined` (dropped entirely by JSON serialization over SSE), not
// `null` — and qualitativeDirection is spread in ONLY for a genuine
// valueType:'qualitative' record, so it is routinely ABSENT rather than
// null on every numeric one. Requiring strict presence would reject real,
// already-shipped production objects, not just malformed ones.
export const CanonicalGuidanceSchema = z.object({
  metric: z.string().max(200).nullable().optional(),
  metricKey: z.string().max(200).nullable().optional(),
  targetFiscalYear: z.string().max(20).nullable().optional(),
  targetQuarter: z.string().max(20).nullable().optional(),
  guidanceKind: z.string().max(60).nullable().optional(),
  valueType: z.string().max(20).nullable().optional(),
  lowerBound: z.number().finite().nullable().optional(),
  upperBound: z.number().finite().nullable().optional(),
  exactValue: z.number().finite().nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  currency: z.string().max(10).nullable().optional(),
  qualitativeDirection: z.string().max(40).nullable().optional(),
  // UI Phase 1D fix: a confirmed live bug. services/EvidenceEnvelope.js
  // has always spread `qualitativeText` (the literal excerpt supporting a
  // qualitative guidance direction — see its own buildCanonicalGuidance-
  // style construction) onto real, already-shipped citation objects, but
  // this schema never had a field for it. Since this schema is `.strict()`,
  // a grounded citation carrying qualitative guidance failed validation
  // OUTRIGHT — silently dropping the ENTIRE evidence_drawer block (never
  // just this one field), confirmed live on a real "What guidance has TCS
  // given for revenue growth?" turn.
  qualitativeText: z.string().max(1000).nullable().optional(),
}).strict();

/**
 * MAX_EXCERPT_LENGTH - the ONE authoritative bound for every excerpt field
 * anywhere a citation/evidence-drawer entry is validated OR persisted —
 * this schema (EvidenceDrawerEntrySchema.excerpt), models/ChatMessage.js's
 * citationSchema.excerpt / evidenceDrawerEntrySchema.excerpt (Mongoose
 * maxlength), and services/ChatThreadService.js's normalizeExcerpt all
 * import this SAME constant. UI Phase 1C.2: a real, measured bug in this
 * codebase's history — this schema's excerpt cap was previously a
 * DIFFERENT, tighter number (600) than the Mongoose persistence layer's
 * (4000), so a citation whose excerpt was, say, 1000 characters saved
 * successfully (under Mongoose's limit) but was then SILENTLY DROPPED on
 * every reload by this schema's own stricter re-validation in
 * fromPersistedResponseBlocks — found via a real round-trip against the
 * actual configured MongoDB, not a hypothetical. Never redeclare this
 * number anywhere else.
 */
export const MAX_EXCERPT_LENGTH = 4000;

/**
 * EvidenceDrawerEntrySchema - the RICH per-citation shape, a strict
 * superset of SourceEntrySchema (excerpt, documentType, page range,
 * temporal status, canonical guidance). Deliberately kept as a SEPARATE
 * block/schema from source_list (Phase 1B) rather than widening
 * source_list itself — the approved Phase 1C.1 scope adds a drawer, it
 * does not redefine an already-shipped, already-persisted block type.
 */
export const EvidenceDrawerEntrySchema = z.object({
  evidenceId: z.string().min(1).max(100),
  citationIndex: z.number().int().min(1).max(200).nullable(),
  title: z.string().max(300).nullable(),
  excerpt: z.string().max(MAX_EXCERPT_LENGTH).nullable(),
  sourceUrl: SafeUrlSchema.nullable(),
  provider: z.string().max(120).nullable(),
  publishedAt: z.string().max(40).nullable(),
  reportingPeriod: z.string().max(40).nullable(),
  documentType: z.string().max(60).nullable(),
  pageStart: z.number().int().min(1).nullable(),
  pageEnd: z.number().int().min(1).nullable(),
  temporalStatus: z.string().max(30).nullable(),
  canonicalGuidance: CanonicalGuidanceSchema.nullable(),
}).strict();

export const EvidenceDrawerBlockSchema = z.object({
  type: z.literal('evidence_drawer'),
  entries: z.array(EvidenceDrawerEntrySchema).min(1).max(MAX_SOURCES),
}).strict();

// ---------------------------------------------------------------------------
// UI Phase 1C.2: news_list.
// ---------------------------------------------------------------------------

const MAX_NEWS_ARTICLES = 5;

/**
 * NewsArticleSchema - deliberately narrower than EvidenceDrawerEntrySchema:
 * no `excerpt`/summary field at all (see services/responseBlocks.js's
 * buildNewsListBlock — "headline, publisher, date, link, optional
 * thumbnail" is the full spec; a card never asserts a summary that would
 * need its own claim-level check). `symbol` is per-article, not on the
 * block, since one block can legitimately carry news for more than one
 * company (a comparison's NEWS dimension fans out per symbol).
 */
export const NewsArticleSchema = z.object({
  evidenceId: z.string().min(1).max(100),
  citationIndex: z.number().int().min(1).max(200).nullable(),
  symbol: z.string().max(20).nullable(),
  title: z.string().min(1).max(300),
  // Required, not nullable -- a card with no real link to the original
  // article is not a usable card; the builder never emits one.
  url: SafeUrlSchema,
  publisher: z.string().max(120).nullable(),
  // Never substituted with "today" when absent — rendered as an honest
  // "date unavailable" by the frontend, matching src/pages/News.jsx's own
  // existing convention for the exact same data.
  publishedAt: z.string().max(40).nullable(),
  imageUrl: SafeUrlSchema.nullable(),
}).strict();

export const NewsListBlockSchema = z.object({
  type: z.literal('news_list'),
  articles: z.array(NewsArticleSchema).min(1).max(MAX_NEWS_ARTICLES),
}).strict();

const ValuationGapSchema = z.object({
  symbol: z.string().min(1).max(20),
  metric: z.string().min(1).max(30),
  reason: z.string().min(1).max(200),
}).strict();

export const DataQualityBlockSchema = z.object({
  type: z.literal('data_quality'),
  groundingStatus: z.enum(GROUNDING_STATUSES).nullable(),
  unmatchedRequestedPeriods: z.array(z.string().min(1).max(40)).max(MAX_GAPS),
  valuationGaps: z.array(ValuationGapSchema).max(MAX_GAPS),
  // Phase 4B's model-self-reported coverage.limitations — already shown
  // directly in production today (ChatMessageBubble's GroundingStatusBadge
  // reads coverage.limitations), so surfacing it here exposes nothing new.
  limitations: z.array(z.string().min(1).max(200)).max(MAX_GAPS),
}).strict();

export const SuggestedQuestionsBlockSchema = z.object({
  type: z.literal('suggested_questions'),
  // Deterministic templates only — services/responseBlocks.js never calls
  // a model for this block. See SUGGESTED_QUESTION_TEMPLATES there.
  questions: z.array(z.string().min(1).max(140)).min(1).max(MAX_SUGGESTED_QUESTIONS),
}).strict();

// ---------------------------------------------------------------------------
// UI Phase 1C.3: chart (bounded historical price line chart).
// ---------------------------------------------------------------------------

// ~one trading year of daily closes — this project's bhavcopy backfill
// window (see services/StockHistoricalMetricsService.js's own one-year
// note). A future longer backfill still cannot make a single chart exceed
// this; graph/tools/toolRegistry.js's getPriceHistory bounds its own query
// well below this too, so the cap here is a genuine ceiling, not a number
// that only looks safe today.
export const MAX_CHART_POINTS = 260;
const MIN_CHART_POINTS = 2; // fewer than this and buildChartBlock omits the whole block — see its own note.

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const CHART_PRICE_BASES = Object.freeze(['NOT_REQUIRED', 'ADJUSTED', 'UNVERIFIED']);

export const ChartPointSchema = z.object({
  date: z.string().regex(DATE_ONLY_PATTERN, 'date must be YYYY-MM-DD'),
  close: z.number().finite().positive(),
  // true when this point immediately follows a KNOWN gap in the series
  // (e.g. rows excluded for a mismatched price-adjustment basis) — never a
  // silently-smoothed-over jump. See buildChartBlock's own note and
  // ChartBlock.jsx's segment rendering.
  gapBefore: z.boolean(),
}).strict();

/** Every point strictly later than the one before it — chronological AND unique by construction (a repeated or out-of-order date fails this). */
const isChronologicalAndUnique = (points) => points.every((p, i) => i === 0 || p.date > points[i - 1].date);

export const ChartBlockSchema = z.object({
  type: z.literal('chart'),
  // Versioned per the brief: a future breaking change to this block's own
  // shape (e.g. a multi-symbol overlay) bumps this rather than silently
  // reinterpreting an already-persisted document under the same version.
  version: z.literal(1),
  symbol: z.string().min(1).max(20),
  currency: z.literal('INR'),
  // The basis EVERY point in this chart shares — never mixed (see
  // services/responseBlocks.js's buildChartBlock for how a mismatched-basis
  // row is excluded rather than blended in).
  priceBasis: z.enum(CHART_PRICE_BASES),
  points: z.array(ChartPointSchema).min(MIN_CHART_POINTS).max(MAX_CHART_POINTS)
    .refine(isChronologicalAndUnique, { message: 'points must be strictly chronological and unique by date' }),
  // The real first/last date actually returned — always stated, honestly,
  // regardless of what was requested (see requestedRangeDays below).
  rangeStart: z.string().regex(DATE_ONLY_PATTERN),
  rangeEnd: z.string().regex(DATE_ONLY_PATTERN),
  // The window the QUESTION asked for, in calendar days, when one was
  // named — null when the user gave no explicit range and the available
  // history was used instead. Never invented; a mismatch between this and
  // the real rangeStart/rangeEnd above is exactly what the frontend states
  // honestly rather than silently absorbing.
  requestedRangeDays: z.number().int().positive().max(3650).nullable(),
  provider: z.string().max(120).nullable(),
  sourceUrl: SafeUrlSchema.nullable(),
  dataAsOf: z.string().max(40).nullable(),
  evidence: z.array(EvidenceRefSchema).min(1).max(MAX_EVIDENCE_PER_FIELD),
}).strict();

/**
 * ResponseBlockSchema - the discriminated union of every block type
 * approved so far. An unrecognized `type` (or an object missing the
 * discriminant) fails validation by construction — there is no fallback
 * "unknown block" shape here; services/responseBlocks.js's aggregator
 * drops anything that fails this parse rather than ever emitting it.
 */
export const ResponseBlockSchema = z.discriminatedUnion('type', [
  MetricGridBlockSchema,
  ComparisonTableBlockSchema,
  SourceListBlockSchema,
  DataQualityBlockSchema,
  SuggestedQuestionsBlockSchema,
  CompanyHeaderBlockSchema,
  EvidenceDrawerBlockSchema,
  NewsListBlockSchema,
  ChartBlockSchema,
]);

export const MAX_RESPONSE_BLOCKS = 10;
export const ResponseBlocksSchema = z.array(ResponseBlockSchema).max(MAX_RESPONSE_BLOCKS);

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
  isSafeBlockUrl,
  EvidenceRefSchema,
  MetricGridEntrySchema,
  MetricGridBlockSchema,
  ComparisonRowSchema,
  ComparisonTableBlockSchema,
  SourceEntrySchema,
  SourceListBlockSchema,
  DataQualityBlockSchema,
  SuggestedQuestionsBlockSchema,
  CompanyHeaderPriceSchema,
  CompanyHeaderBlockSchema,
  CanonicalGuidanceSchema,
  EvidenceDrawerEntrySchema,
  EvidenceDrawerBlockSchema,
  NewsArticleSchema,
  NewsListBlockSchema,
  ChartPointSchema,
  ChartBlockSchema,
  CHART_PRICE_BASES,
  MAX_CHART_POINTS,
  ResponseBlockSchema,
  ResponseBlocksSchema,
  MAX_RESPONSE_BLOCKS,
  MAX_EXCERPT_LENGTH,
};
