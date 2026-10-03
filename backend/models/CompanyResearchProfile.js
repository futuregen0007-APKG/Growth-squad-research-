import mongoose from 'mongoose';

/**
 * CompanyResearchProfile
 * =========================
 * One record per SUPPORTED_STOCKS symbol, generated dynamically (see
 * services/CompanyResearchProfileSync.js) from the real BSE scrip master --
 * never one of 205 hand-authored profiles. `researchEnabled` is false for a
 * symbol whose BSE scrip code could not be resolved (see
 * BseScripMasterProvider.SCRIP_ID_OVERRIDES's documented unresolved cases),
 * so the batch runner can skip it honestly rather than fail repeatedly.
 */
const companyResearchProfileSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true, uppercase: true, index: true },
  companyName: { type: String, required: true },
  bseScripCode: { type: String, default: null },
  nseSymbol: { type: String, default: null },
  isin: { type: String, default: null },
  sector: { type: String, default: null },
  marketCapCr: { type: Number, default: null, index: true },
  researchEnabled: { type: Boolean, default: true },
  aliases: { type: [String], default: [] },
  lastProfileSyncAt: { type: Date, default: null },
  // Written by scripts/collectNseTranscripts.js after each guidance-discovery attempt (transcripts and
  // presentations). The rotation key: the least recently attempted company goes first, so a bounded
  // run never re-selects the same companies, and settled companies are revisited for new filings.
  lastGuidanceDiscoveryAt: { type: Date, default: null },
  lastGuidanceDiscoveryResult: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

companyResearchProfileSchema.index({ researchEnabled: 1, marketCapCr: -1 });

export const CompanyResearchProfile = mongoose.models.CompanyResearchProfile
  || mongoose.model('CompanyResearchProfile', companyResearchProfileSchema);

export default CompanyResearchProfile;
