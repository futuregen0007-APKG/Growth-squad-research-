import mongoose from 'mongoose';

/**
 * StockFundamentalsSnapshot
 * ===========================
 * Durable (MongoDB) home for a symbol's last successfully verified
 * fundamentals -- fixes "Load Eligible Stocks" always returning empty
 * whenever Redis is empty/unavailable or IndianAPI is rate-limited. Redis
 * remains a fast read-through cache IN FRONT of this collection; this
 * collection is the durable source of truth. A write here only ever happens
 * after a real, successful IndianAPI fetch or a real CompanyHistoricalFact
 * derivation -- never a guess, and an existing valid field is never
 * overwritten with null/zero (see StockFundamentalsService.js).
 */
export const FUNDAMENTALS_SOURCES = ['INDIAN_API', 'REAL_RESEARCH_DERIVED'];

const stockFundamentalsSnapshotSchema = new mongoose.Schema({
  symbol: {
    type: String, required: true, uppercase: true, trim: true, unique: true, index: true,
  },
  peRatio: { type: Number, default: null },
  roe: { type: Number, default: null },
  revenueGrowth: { type: Number, default: null }, // % , CAGR or period-over-period, per derivationMethod
  profitGrowth: { type: Number, default: null }, // % (PAT growth/CAGR)
  operatingMargin: { type: Number, default: null }, // %
  debtTrend: {
    direction: { type: String, enum: ['INCREASING', 'DECREASING', 'STABLE', null], default: null },
    changePercent: { type: Number, default: null },
  },
  source: { type: String, enum: FUNDAMENTALS_SOURCES, required: true },
  // Provider identifier (e.g. 'indian-api') or, for a derived snapshot, the
  // primary-source document URL(s) that back it -- never a guessed origin.
  sourceUrl: { type: String, default: null },
  provenance: {
    sourceType: { type: String, default: null },
    sourceUrls: { type: [String], default: [] },
    periodsUsed: { type: [String], default: [] },
    derivationMethod: { type: String, default: null },
  },
  dataAsOf: { type: Date, required: true },
  lastSuccessfulRefresh: { type: Date, required: true },
  missingMetrics: { type: [String], default: [] },
  isStale: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.models.StockFundamentalsSnapshot
  || mongoose.model('StockFundamentalsSnapshot', stockFundamentalsSnapshotSchema);
