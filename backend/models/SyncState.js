import mongoose from 'mongoose';

/**
 * SyncState
 * ===========
 * One document per named incremental sync process (currently just
 * 'earnings-latest'). Tracks when it last ran, when it last succeeded, the
 * newest announcement id it has already processed (so a re-run never
 * re-processes the same announcement), and its most recent errors.
 */
const syncStateSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  lastCheckedAt: { type: Date, default: null },
  lastSuccessfulSync: { type: Date, default: null },
  lastAnnouncementId: { type: String, default: null },
  syncErrors: { type: [{ at: Date, message: String }], default: [] },
}, { timestamps: true });

export const SyncState = mongoose.models.SyncState || mongoose.model('SyncState', syncStateSchema);

export default SyncState;
