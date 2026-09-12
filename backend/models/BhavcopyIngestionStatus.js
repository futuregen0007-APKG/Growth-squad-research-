import mongoose from 'mongoose';

/**
 * BhavcopyIngestionStatus
 * =========================
 * One document per trading date the NSE bhavcopy backfill has attempted --
 * lets `stocks:backfill-history --resume` skip a date already ingested
 * without re-downloading, and gives an exact list of failed dates rather
 * than a vague "some dates failed".
 */
export const INGESTION_STATUSES = ['COMPLETED', 'FAILED_PERMANENT', 'FAILED_RETRYABLE', 'NO_TRADING'];

const bhavcopyIngestionStatusSchema = new mongoose.Schema({
  tradingDate: {
    type: Date, required: true, unique: true, index: true,
  },
  status: { type: String, enum: INGESTION_STATUSES, required: true },
  rowsIngested: { type: Number, default: 0 },
  symbolsMatched: { type: Number, default: 0 },
  sourceUrl: { type: String, default: null },
  error: { type: String, default: null },
  attemptedAt: { type: Date, default: Date.now },
}, { timestamps: true });

export default mongoose.models.BhavcopyIngestionStatus
  || mongoose.model('BhavcopyIngestionStatus', bhavcopyIngestionStatusSchema);
