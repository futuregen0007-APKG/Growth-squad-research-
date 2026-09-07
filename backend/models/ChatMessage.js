import mongoose from 'mongoose';

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
const citationSchema = new mongoose.Schema({
  evidenceId: String,
  claimType: String,
  symbol: { type: String, default: null },
  title: { type: String, default: null },
  sourceUrl: { type: String, default: null },
  provider: { type: String, default: null },
  publishedAt: { type: String, default: null },
  reportingPeriod: { type: String, default: null },
}, { _id: false });

const toolSummarySchema = new mongoose.Schema({
  tool: String,
  status: String,
  warning: { type: String, default: null },
}, { _id: false });

const chatMessageSchema = new mongoose.Schema({
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatThread', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientMessageId: { type: String, default: null, index: true },

  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  status: { type: String, enum: ['COMPLETE', 'ERROR', 'ABORTED'], default: 'COMPLETE' },

  citations: { type: [citationSchema], default: [] },
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
chatMessageSchema.index({ threadId: 1, clientMessageId: 1 }, { unique: true, sparse: true });

export default mongoose.models.ChatMessage || mongoose.model('ChatMessage', chatMessageSchema);
