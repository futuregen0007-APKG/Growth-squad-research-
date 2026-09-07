import mongoose from 'mongoose';

/**
 * UserPreference - GS Copilot's long-term memory. Deliberately separate
 * from ChatThread's short-term summary/active-entities: this is durable,
 * cross-thread, and only ever written when the user explicitly states a
 * preference (see graph/nodes/saveMemory.js, gated by
 * ExplicitPreferenceSchema.stated === true) — never inferred from a casual
 * remark or silently overwritten.
 */
const userPreferenceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  riskAppetite: { type: String, enum: ['conservative', 'moderate', 'aggressive', null], default: null },
  investmentHorizon: { type: String, enum: ['short_term', 'medium_term', 'long_term', null], default: null },
  goals: { type: [String], default: [] },
  preferredSectors: { type: [String], default: [] },
  preferredDetail: { type: String, enum: ['concise', 'detailed', null], default: null },
}, { timestamps: true });

export default mongoose.models.UserPreference || mongoose.model('UserPreference', userPreferenceSchema);
