import mongoose from 'mongoose';

const portfolioHoldingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true },
  quantity: { type: Number, required: true, min: 0.000001 },
  averageBuyPrice: { type: Number, required: true, min: 0 },
}, { timestamps: true });

portfolioHoldingSchema.index({ userId: 1, symbol: 1 }, { unique: true });

export default mongoose.models.PortfolioHolding
  || mongoose.model('PortfolioHolding', portfolioHoldingSchema);