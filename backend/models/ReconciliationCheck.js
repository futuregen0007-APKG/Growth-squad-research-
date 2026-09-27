import mongoose from 'mongoose';

/**
 * The latest known result of one independently-re-derived cross-check against
 * a stored fact (its source XBRL filing, or the sum of its quarters against
 * the declared full year) -- see scripts/verifyNseXbrlFacts.js. A mismatch
 * here does NOT mean the stored value is wrong: many are pre-existing
 * differences that were individually investigated and found to be correct
 * against their own source (see quarantine for the ones that were NOT). It
 * means the two independent readings disagree and neither has been proven
 * wrong, so the difference must stay visible rather than be silently dropped
 * once the one-off verification run that found it ends.
 *
 * One document per check identity (`checkKey`), always upserted with the
 * latest verdict: a check that used to mismatch and now matches (a corrected
 * filing, or a fixed extraction re-run) flips back to OK in place, rather
 * than leaving a stale mismatch on record forever.
 */
const reconciliationCheckSchema = new mongoose.Schema({
  checkKey: { type: String, required: true, unique: true, index: true },
  checkType: { type: String, enum: ['SOURCE_VALUE', 'QUARTER_SUM'], required: true },
  symbol: { type: String, required: true, uppercase: true, index: true },
  metric: { type: String, default: null },
  period: { type: String, default: null }, // SOURCE_VALUE: the fact's own period; QUARTER_SUM: the fiscal year, e.g. "FY2025"
  basis: { type: String, default: null },
  status: { type: String, required: true }, // 'MATCH' | 'SUM_MATCH' (OK) or a mismatch/error status from verifyNseXbrlFacts.js
  detail: { type: String, default: null },
  lastCheckedAt: { type: Date, required: true },
  label: { type: String, default: null }, // the --label of the verification run that last touched this check
}, { timestamps: true, collection: 'reconciliation_checks' });

export const OK_STATUSES = ['MATCH', 'SUM_MATCH'];

export default mongoose.models.ReconciliationCheck || mongoose.model('ReconciliationCheck', reconciliationCheckSchema);
