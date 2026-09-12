import mongoose from 'mongoose';

/**
 * StockPriceHistorySnapshot
 * ===========================
 * Durable, per-trading-day OHLCV row sourced from NSE's own official
 * CM-UDiFF Common Bhavcopy Final file (one file covers every listed equity
 * for that day) -- replaces per-symbol Angel One historical-candle calls,
 * which return HTTP 403 for the large majority of symbols in this
 * environment. Angel One remains the ONLY source for live/current price;
 * this collection is the durable historical record.
 */
export const HISTORY_PROVIDERS = ['NSE_BHAVCOPY'];
export const ADJUSTMENT_STATUSES = ['NOT_REQUIRED', 'ADJUSTED', 'UNVERIFIED'];

const stockPriceHistorySnapshotSchema = new mongoose.Schema({
  symbol: {
    type: String, required: true, uppercase: true, trim: true, index: true,
  },
  exchange: { type: String, default: 'NSE' },
  series: { type: String, required: true }, // 'EQ' by default; non-EQ rows are skipped unless explicitly supported
  isin: { type: String, default: null },
  tradingDate: { type: Date, required: true, index: true },
  open: { type: Number, required: true },
  high: { type: Number, required: true },
  low: { type: Number, required: true },
  close: { type: Number, required: true },
  previousClose: { type: Number, default: null },
  volume: { type: Number, default: null },
  turnover: { type: Number, default: null },
  provider: { type: String, enum: HISTORY_PROVIDERS, required: true },
  sourceUrl: { type: String, required: true },
  fetchedAt: { type: Date, required: true },
  dataAsOf: { type: Date, required: true },
  // Corporate-action safety (Part C): a row is only ever used for return/
  // drawdown math once its adjustment status is known. UNVERIFIED means a
  // discontinuity relative to the prior close was detected and could not be
  // safely explained/adjusted -- callers must exclude it from return/
  // drawdown calculations rather than reporting a distorted value.
  corporateActionAdjusted: { type: Boolean, default: false },
  adjustmentStatus: { type: String, enum: ADJUSTMENT_STATUSES, default: 'NOT_REQUIRED' },
}, { timestamps: true });

stockPriceHistorySnapshotSchema.index(
  { symbol: 1, exchange: 1, tradingDate: 1, provider: 1 },
  { unique: true, name: 'unique_price_row_per_symbol_exchange_date_provider' },
);
stockPriceHistorySnapshotSchema.index({ symbol: 1, tradingDate: -1 });

export default mongoose.models.StockPriceHistorySnapshot
  || mongoose.model('StockPriceHistorySnapshot', stockPriceHistorySnapshotSchema);
