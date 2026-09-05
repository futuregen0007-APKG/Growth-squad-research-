import mongoose from 'mongoose';

const watchlistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  symbols: [{ type: String, uppercase: true, trim: true }],
}, { timestamps: true });

watchlistSchema.index({ userId: 1, name: 1 }, { unique: true });

export default mongoose.models.Watchlist || mongoose.model('Watchlist', watchlistSchema);