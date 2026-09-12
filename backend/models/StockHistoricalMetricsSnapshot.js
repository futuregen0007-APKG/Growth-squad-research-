import mongoose from 'mongoose';

/**
 * StockHistoricalMetricsSnapshot
 * =================================
 * Persisted, pre-computed historical statistics for one symbol -- so
 * "Load Eligible Stocks" and /stock/:symbol read a single small document
 * instead of recomputing return/volatility/drawdown over ~250 daily rows on
 * every click (Part Z: performance). Recomputed by
 * StockHistoricalMetricsService whenever new StockPriceHistorySnapshot rows
 * land for the symbol; a metric that can't be verified (insufficient
 * observations, or an unresolved corporate-action discontinuity in its
 * window) is left null here, never zero.
 */
const stockHistoricalMetricsSnapshotSchema = new mongoose.Schema({
  symbol: {
    type: String, required: true, uppercase: true, trim: true, unique: true, index: true,
  },
  observationCount: { type: Number, required: true },
  firstDate: { type: Date, required: true },
  lastDate: { type: Date, required: true },
  lastClose: { type: Number, default: null },
  fiftyTwoWeekHigh: { type: Number, default: null },
  fiftyTwoWeekLow: { type: Number, default: null },
  oneYearReturn: { type: Number, default: null },
  threeYearCagr: { type: Number, default: null },
  annualizedVolatility: { type: Number, default: null },
  maximumDrawdown: { type: Number, default: null },
  averageDailyVolume: { type: Number, default: null },
  averageDailyTurnover: { type: Number, default: null },
  liquidityClassification: { type: String, enum: ['HIGH', 'MODERATE', 'LOW', null], default: null },
  // Part C: corporate-action safety. UNVERIFIED means at least one
  // discontinuity in the window couldn't be explained, so oneYearReturn/
  // threeYearCagr/maximumDrawdown are forced null even if the raw
  // arithmetic would have produced a number.
  corporateActionAdjustmentStatus: { type: String, enum: ['NOT_REQUIRED', 'ADJUSTED', 'UNVERIFIED'], default: 'NOT_REQUIRED' },
  discontinuitiesDetected: {
    type: [{ date: Date, priorClose: Number, close: Number, changePercent: Number }],
    default: [],
  },
  missingMetrics: { type: [String], default: [] },
  provider: { type: String, default: 'NSE_BHAVCOPY' },
  dataAsOf: { type: Date, required: true },
  computedAt: { type: Date, required: true },
}, { timestamps: true });

export default mongoose.models.StockHistoricalMetricsSnapshot
  || mongoose.model('StockHistoricalMetricsSnapshot', stockHistoricalMetricsSnapshotSchema);
