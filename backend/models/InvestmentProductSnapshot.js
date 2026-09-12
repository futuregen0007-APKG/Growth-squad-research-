import mongoose from 'mongoose';

/**
 * InvestmentProductSnapshot
 * ===========================
 * Normalized, provider-agnostic snapshot of one investable product (a mutual
 * fund scheme, an ETF, or -- via `productId`/`symbol` cross-reference only,
 * never duplicated here -- a stock already served by StockService). Backs
 * the Mutual Fund / Gold ETF / Debt Fund / Liquid Fund goal-recommendation
 * buckets in GoalAssetAllocationService/GoalProductRecommendationService.
 *
 * WHY MONGO: same reasoning as PromiseCandidate.js -- this is runtime-
 * ingested data (AMFI NAV file, NSE ETF listings) on Render's ephemeral
 * filesystem, refreshed daily by scripts/refreshInvestmentProducts.js, never
 * hand-curated or git-committed.
 *
 * Upserted by (productType, symbol) so a daily re-ingest updates the same
 * document rather than accumulating duplicates.
 */
const investmentProductSnapshotSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true }, // `${productType}:${symbol}`
  productType: { type: String, enum: ['MUTUAL_FUND', 'GOLD_ETF', 'DEBT_FUND', 'LIQUID_FUND'], required: true, index: true },
  name: { type: String, required: true },
  symbol: { type: String, required: true }, // AMFI scheme code, or NSE ETF ticker
  category: { type: String, required: true }, // e.g. 'Equity Scheme - Large Cap Fund', 'Debt Scheme - Liquid Fund', 'Gold ETF'
  riskLevel: { type: String, enum: ['LOW', 'MODERATE', 'HIGH', 'UNKNOWN'], default: 'UNKNOWN' },
  expenseRatio: { type: Number, default: null }, // percent; null when the source does not publish it (never invented)
  aum: { type: Number, default: null }, // INR crore; null when unavailable
  returns1Y: { type: Number, default: null },
  returns3Y: { type: Number, default: null },
  returns5Y: { type: Number, default: null },
  volatility3Y: { type: Number, default: null },
  maxDrawdown: { type: Number, default: null },
  liquidity: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'], default: 'UNKNOWN' },
  navOrPrice: { type: Number, required: true },
  sourceUrl: { type: String, required: true },
  dataAsOf: { type: Date, required: true, index: true }, // the source's own "as of" date (e.g. AMFI NAV date) -- drives freshness/staleness checks
  dataCompleteness: { type: Number, required: true, min: 0, max: 1 }, // fraction of the fields above that are non-null, real values
  ingestedAt: { type: Date, default: Date.now },
}, { timestamps: true });

investmentProductSnapshotSchema.index({ productType: 1, category: 1 });
investmentProductSnapshotSchema.index({ productType: 1, dataAsOf: -1 });

export const InvestmentProductSnapshot = mongoose.models.InvestmentProductSnapshot
  || mongoose.model('InvestmentProductSnapshot', investmentProductSnapshotSchema);

export default InvestmentProductSnapshot;
