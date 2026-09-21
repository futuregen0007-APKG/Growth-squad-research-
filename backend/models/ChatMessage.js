import mongoose from 'mongoose';
import { MAX_EXCERPT_LENGTH } from '../graph/schemas.js';

/**
 * ChatMessage - one turn in a GS Copilot thread. `clientMessageId` makes a
 * duplicate submit (double-click, retried request) a no-op rather than a
 * duplicate message — see ChatThreadService.appendUserMessage's upsert.
 *
 * Deliberately does NOT store: system prompts, chain-of-thought, raw tool
 * payloads, or full provider responses — only the final content, compact
 * tool-result summaries, and citation references (evidence lives fully in
 * the response stream/final message but is compacted here to avoid
 * persisting large raw payloads).
 */

/**
 * canonicalGuidanceSchema - mirrors services/EvidenceEnvelope.js's
 * canonicalGuidance object exactly (metric/metricKey/targetFiscalYear/
 * targetQuarter/guidanceKind/valueType/lowerBound/upperBound/exactValue/
 * unit/currency/qualitativeDirection). Explicit and typed, never `Mixed`
 * — every field a grounded citation can carry today is named here.
 */
const canonicalGuidanceSchema = new mongoose.Schema({
  metric: { type: String, default: null, maxlength: 200 },
  metricKey: { type: String, default: null, maxlength: 200 },
  targetFiscalYear: { type: String, default: null, maxlength: 20 },
  targetQuarter: { type: String, default: null, maxlength: 20 },
  guidanceKind: { type: String, default: null, maxlength: 60 },
  valueType: { type: String, default: null, maxlength: 20 },
  lowerBound: { type: Number, default: null },
  upperBound: { type: Number, default: null },
  exactValue: { type: Number, default: null },
  unit: { type: String, default: null, maxlength: 40 },
  currency: { type: String, default: null, maxlength: 10 },
  qualitativeDirection: { type: String, default: null, maxlength: 40 },
  // UI Phase 1D fix: mirrors graph/schemas.js's CanonicalGuidanceSchema —
  // see that schema's own note on the real, confirmed live bug this closes.
  qualitativeText: { type: String, default: null, maxlength: 1000 },
}, { _id: false });

/**
 * citationSchema - UI Phase 1B: explicitly widened. Before this change,
 * every field below `reportingPeriod` was silently stripped by Mongoose
 * on save (unknown paths are dropped, not rejected) — a grounded-path
 * citation's temporalStatus/documentType/pageStart/canonicalGuidance were
 * visible mid-stream (graph/groundedAnswer.js's citationFromEvidence
 * shape) but gone the moment the thread was reloaded. Every field added
 * here already exists on that SAME live citation object; nothing new is
 * introduced, only preserved. Kept as an explicit typed sub-schema (never
 * `Mixed`) so an unexpected field is still dropped rather than silently
 * accepted, exactly like the fields that were already here.
 */
const citationSchema = new mongoose.Schema({
  evidenceId: String,
  claimType: String,
  symbol: { type: String, default: null },
  title: { type: String, default: null },
  sourceUrl: { type: String, default: null },
  provider: { type: String, default: null },
  publishedAt: { type: String, default: null },
  reportingPeriod: { type: String, default: null },

  // --- grounded-path fields (graph/groundedAnswer.js's citationFromEvidence) ---
  fiscalYear: { type: String, default: null, maxlength: 20 },
  documentType: { type: String, default: null, maxlength: 60 },
  sourceAuthority: { type: String, default: null, maxlength: 120 },
  pageStart: { type: Number, default: null },
  pageEnd: { type: Number, default: null },
  // UI Phase 1C.1: needed for evidence_drawer to survive reload. Bounded
  // generously rather than tightly: unlike the controlled-vocabulary
  // fields above, an excerpt can be raw provider text (a company
  // description, an article summary — graph/tools/toolRegistry.js has
  // several UNTRUNCATED excerpt sources), and Mongoose's `maxlength` is a
  // save-time VALIDATOR, not a silent truncator — set too tight, it would
  // make the ENTIRE assistant message fail to persist (saveMemory.js's own
  // try/catch would swallow that as a warning, silently losing more than
  // just this one field). 4000 is well above any excerpt actually observed
  // in this codebase while still bounding unbounded growth.
  excerpt: { type: String, default: null, maxlength: MAX_EXCERPT_LENGTH },
  temporalStatus: { type: String, default: null, maxlength: 30 },
  // evidenceId of the citation THIS one was superseded by / that this one
  // supersedes — required for ChatMessageBubble's "Revised from X to Y"
  // lookup (it resolves supersedes[0] against the same citations array) to
  // keep working after reload; temporalStatus alone is not enough.
  supersededBy: { type: String, default: null },
  supersedes: { type: [String], default: [] },
  canonicalGuidance: { type: canonicalGuidanceSchema, default: null },
}, { _id: false });

const toolSummarySchema = new mongoose.Schema({
  tool: String,
  status: String,
  warning: { type: String, default: null },
}, { _id: false });

// ---------------------------------------------------------------------------
// UI Phase 1B: responseBlocks persistence.
//
// Every block a turn can produce is already validated against graph/
// schemas.js's Zod ResponseBlockSchema BEFORE it ever reaches
// appendAssistantMessage (see graph/nodes/buildResponseBlocks.js) — so
// Mongoose's job here is purely "never silently drop a field Zod already
// approved," not re-enforce the business rules Zod already checked.
//
// Explicit typed sub-schema per block type (never `Mixed`), selected by
// `type`: one envelope schema with one populated `<type>` key, mirroring
// the discriminated union it was validated against. Deliberately not a
// Mongoose discriminator array (that API discriminates whole documents,
// not object literals inside a plain array path) — this achieves the same
// "each type has its own explicit shape" property with a flatter,
// easier-to-read schema.
// ---------------------------------------------------------------------------

const evidenceRefSchema = new mongoose.Schema({
  evidenceId: { type: String, required: true, maxlength: 100 },
  citationIndex: { type: Number, default: null },
}, { _id: false });

const metricGridEntrySchema = new mongoose.Schema({
  metric: { type: String, required: true, maxlength: 60 },
  label: { type: String, required: true, maxlength: 120 },
  value: { type: Number, required: true },
  unit: { type: String, default: null, maxlength: 30 },
  period: { type: String, default: null, maxlength: 40 },
  evidence: { type: [evidenceRefSchema], default: [] },
}, { _id: false });

const metricGridDataSchema = new mongoose.Schema({
  symbol: { type: String, required: true, maxlength: 20 },
  metrics: { type: [metricGridEntrySchema], default: [] },
}, { _id: false });

const comparisonCellSchema = new mongoose.Schema({
  symbol: { type: String, required: true, maxlength: 20 },
  value: { type: Number, required: true },
  unit: { type: String, default: null, maxlength: 30 },
  evidence: { type: [evidenceRefSchema], default: [] },
}, { _id: false });

const comparisonRowSchema = new mongoose.Schema({
  metric: { type: String, required: true, maxlength: 60 },
  label: { type: String, required: true, maxlength: 120 },
  // Stored as an array of {symbol, ...} rather than a Map/nested object
  // keyed by symbol — Mongoose Maps serialize awkwardly through .lean(),
  // and the frontend needs an array to render anyway (see
  // ResponseBlocksRenderer's ComparisonTableBlock).
  values: { type: [comparisonCellSchema], default: [] },
  commonPeriod: { type: String, default: null, maxlength: 40 },
  comparable: { type: Boolean, default: false },
}, { _id: false });

const comparisonTableDataSchema = new mongoose.Schema({
  symbols: { type: [String], default: [] },
  rows: { type: [comparisonRowSchema], default: [] },
}, { _id: false });

const sourceEntrySchema = new mongoose.Schema({
  evidenceId: { type: String, required: true, maxlength: 100 },
  citationIndex: { type: Number, default: null },
  title: { type: String, default: null, maxlength: 300 },
  sourceUrl: { type: String, default: null, maxlength: 2048 },
  provider: { type: String, default: null, maxlength: 120 },
  publishedAt: { type: String, default: null, maxlength: 40 },
  reportingPeriod: { type: String, default: null, maxlength: 40 },
}, { _id: false });

const sourceListDataSchema = new mongoose.Schema({
  sources: { type: [sourceEntrySchema], default: [] },
}, { _id: false });

const valuationGapSchema = new mongoose.Schema({
  symbol: { type: String, required: true, maxlength: 20 },
  metric: { type: String, required: true, maxlength: 30 },
  reason: { type: String, required: true, maxlength: 200 },
}, { _id: false });

const dataQualityDataSchema = new mongoose.Schema({
  groundingStatus: { type: String, default: null, maxlength: 30 },
  unmatchedRequestedPeriods: { type: [String], default: [] },
  valuationGaps: { type: [valuationGapSchema], default: [] },
  limitations: { type: [String], default: [] },
}, { _id: false });

const suggestedQuestionsDataSchema = new mongoose.Schema({
  questions: { type: [String], default: [] },
}, { _id: false });

// --- UI Phase 1C.1: company_header, evidence_drawer ---

const companyHeaderPriceSchema = new mongoose.Schema({
  value: { type: Number, required: true },
  currency: { type: String, default: 'INR', maxlength: 10 },
  asOf: { type: String, default: null, maxlength: 60 },
  evidence: { type: [evidenceRefSchema], default: [] },
}, { _id: false });

const companyHeaderDataSchema = new mongoose.Schema({
  symbol: { type: String, required: true, maxlength: 20 },
  companyName: { type: String, required: true, maxlength: 200 },
  sector: { type: String, default: null, maxlength: 100 },
  exchange: { type: String, default: null, maxlength: 20 },
  price: { type: companyHeaderPriceSchema, default: null },
}, { _id: false });

// Mirrors graph/schemas.js's CanonicalGuidanceSchema field-for-field —
// Mongoose sub-document fields are ALREADY implicitly optional (no
// `required`), which correctly matches that a real canonicalGuidance
// object can genuinely lack a key (see that schema's own note).
const canonicalGuidanceDataSchema = new mongoose.Schema({
  metric: { type: String, default: null, maxlength: 200 },
  metricKey: { type: String, default: null, maxlength: 200 },
  targetFiscalYear: { type: String, default: null, maxlength: 20 },
  targetQuarter: { type: String, default: null, maxlength: 20 },
  guidanceKind: { type: String, default: null, maxlength: 60 },
  valueType: { type: String, default: null, maxlength: 20 },
  lowerBound: { type: Number, default: null },
  upperBound: { type: Number, default: null },
  exactValue: { type: Number, default: null },
  unit: { type: String, default: null, maxlength: 40 },
  currency: { type: String, default: null, maxlength: 10 },
  qualitativeDirection: { type: String, default: null, maxlength: 40 },
  // UI Phase 1D fix: mirrors graph/schemas.js's CanonicalGuidanceSchema —
  // see that schema's own note on the real, confirmed live bug this closes.
  qualitativeText: { type: String, default: null, maxlength: 1000 },
}, { _id: false });

const evidenceDrawerEntrySchema = new mongoose.Schema({
  evidenceId: { type: String, required: true, maxlength: 100 },
  citationIndex: { type: Number, default: null },
  title: { type: String, default: null, maxlength: 300 },
  // Generous, not tight -- see citationSchema's own excerpt field note above.
  excerpt: { type: String, default: null, maxlength: MAX_EXCERPT_LENGTH },
  sourceUrl: { type: String, default: null, maxlength: 2048 },
  provider: { type: String, default: null, maxlength: 120 },
  publishedAt: { type: String, default: null, maxlength: 40 },
  reportingPeriod: { type: String, default: null, maxlength: 40 },
  documentType: { type: String, default: null, maxlength: 60 },
  pageStart: { type: Number, default: null },
  pageEnd: { type: Number, default: null },
  temporalStatus: { type: String, default: null, maxlength: 30 },
  canonicalGuidance: { type: canonicalGuidanceDataSchema, default: null },
}, { _id: false });

const evidenceDrawerDataSchema = new mongoose.Schema({
  entries: { type: [evidenceDrawerEntrySchema], default: [] },
}, { _id: false });

// --- UI Phase 1C.2: news_list ---

const newsArticleSchema = new mongoose.Schema({
  evidenceId: { type: String, required: true, maxlength: 100 },
  citationIndex: { type: Number, default: null },
  symbol: { type: String, default: null, maxlength: 20 },
  title: { type: String, required: true, maxlength: 300 },
  url: { type: String, required: true, maxlength: 2048 },
  publisher: { type: String, default: null, maxlength: 120 },
  publishedAt: { type: String, default: null, maxlength: 40 },
  imageUrl: { type: String, default: null, maxlength: 2048 },
}, { _id: false });

const newsListDataSchema = new mongoose.Schema({
  articles: { type: [newsArticleSchema], default: [] },
}, { _id: false });

// --- UI Phase 1C.3: chart ---

const chartPointSchema = new mongoose.Schema({
  date: { type: String, required: true, maxlength: 10 },
  close: { type: Number, required: true },
  gapBefore: { type: Boolean, default: false },
}, { _id: false });

const chartDataSchema = new mongoose.Schema({
  version: { type: Number, required: true, default: 1 },
  symbol: { type: String, required: true, maxlength: 20 },
  currency: { type: String, default: 'INR', maxlength: 10 },
  priceBasis: { type: String, default: null, maxlength: 20 },
  points: { type: [chartPointSchema], default: [] },
  rangeStart: { type: String, default: null, maxlength: 10 },
  rangeEnd: { type: String, default: null, maxlength: 10 },
  requestedRangeDays: { type: Number, default: null },
  provider: { type: String, default: null, maxlength: 120 },
  sourceUrl: { type: String, default: null, maxlength: 2048 },
  dataAsOf: { type: String, default: null, maxlength: 40 },
  evidence: { type: [evidenceRefSchema], default: [] },
}, { _id: false });

const responseBlockSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['metric_grid', 'comparison_table', 'source_list', 'data_quality', 'suggested_questions', 'company_header', 'evidence_drawer', 'news_list', 'chart'],
  },
  metricGrid: { type: metricGridDataSchema, default: null },
  comparisonTable: { type: comparisonTableDataSchema, default: null },
  sourceList: { type: sourceListDataSchema, default: null },
  dataQuality: { type: dataQualityDataSchema, default: null },
  suggestedQuestions: { type: suggestedQuestionsDataSchema, default: null },
  companyHeader: { type: companyHeaderDataSchema, default: null },
  evidenceDrawer: { type: evidenceDrawerDataSchema, default: null },
  newsList: { type: newsListDataSchema, default: null },
  chart: { type: chartDataSchema, default: null },
}, { _id: false });

const chatMessageSchema = new mongoose.Schema({
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatThread', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // UI Phase 1D fix: a confirmed, SEVERE live bug. This field deliberately
  // carries NO `default` — a user message that supplies a real
  // clientMessageId gets that string; an assistant message (which never
  // has one — see ChatThreadService.js's appendAssistantMessage, which
  // takes no such param at all) simply never sets this path, so Mongoose
  // omits it from the document entirely (genuinely absent, not `null`).
  // This is what the sparse/partial unique index below actually needs:
  // a PRIOR `default: null` made this field ALWAYS present (with value
  // null) on every assistant message, and MongoDB's sparse index only
  // skips a field that is truly MISSING, never one explicitly set to
  // null — so the SECOND assistant message ever saved to any thread
  // collided with the first (both `{threadId: X, clientMessageId: null}`)
  // on this unique index, and every assistant reply after the first was
  // SILENTLY DROPPED (saveMemory.js's own try/catch only warns on this
  // exact error, never surfaced to the user) for the lifetime of this bug.
  // Confirmed live: a real 6-turn thread had only its FIRST assistant
  // reply survive a reload; the other 5 were gone. See the index below.
  clientMessageId: { type: String, index: true },

  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  status: { type: String, enum: ['COMPLETE', 'ERROR', 'ABORTED'], default: 'COMPLETE' },

  citations: { type: [citationSchema], default: [] },
  // UI Phase 1B — additive. `[]` for every message that predates this
  // field (Mongoose's own default) and for every message a Phase 1B turn
  // produces with nothing valid to report — never null, never `Mixed`.
  responseBlocks: { type: [responseBlockSchema], default: [] },
  toolSummary: { type: [toolSummarySchema], default: [] },
  intent: { type: String, default: null },

  model: { type: String, default: null },
  tokenUsage: {
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    totalTokens: { type: Number, default: null },
  },
}, { timestamps: true });

chatMessageSchema.index({ threadId: 1, createdAt: 1 });
// UI Phase 1D fix: a PARTIAL index (not `sparse`) is the correct tool here
// — it enforces uniqueness ONLY over documents where clientMessageId is
// genuinely a string (real user-submitted messages), and is completely
// unaffected by whether some OTHER document has the field literally
// absent vs. explicitly null (the exact distinction that made the
// previous `sparse: true` index fail to protect assistant messages, which
// this field's own note above explains in full). See
// scripts/fixChatMessageClientIdIndex.js for the one-time migration this
// change requires on an already-deployed database (Mongoose does not
// retroactively rebuild a changed index with different options).
chatMessageSchema.index(
  { threadId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } }, name: 'unique_client_message_id_per_thread' },
);

export default mongoose.models.ChatMessage || mongoose.model('ChatMessage', chatMessageSchema);
