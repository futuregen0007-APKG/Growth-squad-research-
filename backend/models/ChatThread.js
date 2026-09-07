import mongoose from 'mongoose';

/**
 * ChatThread - one GS Copilot conversation. Short-term memory container:
 * the running conversation summary, active entities, and message count
 * live here; the messages themselves are separate ChatMessage documents
 * (see below) so a thread can be listed/renamed cheaply without loading
 * every message.
 *
 * Ownership: every query MUST filter by userId — see
 * services/ChatThreadService.js, the only place threads are read/written.
 * Never trust a threadId alone.
 */
const chatThreadSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: 'New chat', trim: true, maxlength: 120 },

  // Short-term memory: factual summary of older messages once the recent-
  // message window is exceeded (see ConversationSummaryService). Recent
  // messages themselves are never summarized away — only older ones.
  summary: { type: String, default: null },
  summaryUpToMessageId: { type: mongoose.Schema.Types.ObjectId, default: null },

  activeEntities: {
    symbols: { type: [String], default: [] },
    companyNames: { type: [String], default: [] },
  },

  messageCount: { type: Number, default: 0 },
  lastMessageAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }, // soft delete — a deleted thread must never load again
}, { timestamps: true });

chatThreadSchema.index({ userId: 1, updatedAt: -1 });
chatThreadSchema.index({ userId: 1, deletedAt: 1 });

export default mongoose.models.ChatThread || mongoose.model('ChatThread', chatThreadSchema);
