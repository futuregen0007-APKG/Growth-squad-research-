import mongoose from 'mongoose';
import crypto from 'node:crypto';

/**
 * CompanyDocumentRegistry
 * =========================
 * A durable record of every primary-source document used to back a
 * CompanyHistoricalFact or ManagementPromise: which company/fiscal year it
 * covers, where it came from, when it was published, a content fingerprint
 * (so the same PDF is never re-downloaded or re-extracted twice), and
 * whether extraction has actually run against it yet.
 *
 * This is the "download once and cache" ledger required by the earnings
 * backfill spec (rule 9): a backfill script checks this registry before
 * fetching a URL again, and records extractionStatus so a partially-failed
 * backfill run can resume from where it left off instead of re-fetching
 * everything.
 */
export const EXTRACTION_STATUSES = ['PENDING', 'FETCHED', 'EXTRACTED', 'FAILED'];

const companyDocumentRegistrySchema = new mongoose.Schema({
  symbol: { type: String, required: true, uppercase: true, index: true },
  companyName: { type: String, required: true },
  fiscalYear: { type: String, required: true, index: true }, // e.g. 'FY2024', 'FY2025'
  sourceType: { type: String, required: true }, // EARNINGS_TRANSCRIPT, PRESS_RELEASE, ANNUAL_REPORT, EXCHANGE_FILING, ...
  url: { type: String, required: true },
  publicationDate: { type: Date, required: true },
  pdfHash: { type: String, default: null }, // sha256 of the fetched document bytes, once fetched -- this IS the "documentHash"
  // Durable-storage pointer (S3 or GridFS -- see services/DocumentStorageService.js).
  // Null means this document predates durable storage and only the original
  // (possibly now-stale) source URL is known for it.
  storageKey: { type: String, default: null },
  storageBackend: { type: String, enum: ['S3', 'GRIDFS', null], default: null },
  extractionStatus: { type: String, enum: EXTRACTION_STATUSES, default: 'PENDING', index: true },
  extractionMethod: { type: String, enum: ['DETERMINISTIC_TABLE', 'OPENAI_GUIDANCE_PAGE', 'MANUAL'], default: null },
  factsExtracted: { type: Number, default: 0 },
  promisesExtracted: { type: Number, default: 0 },
  // Separate from extractionStatus (facts): tracks the PROMISE_EXTRACTION
  // stage independently so a resumed run skips a document that genuinely
  // produced zero promises without mistaking it for "not yet processed"
  // (promisesExtracted:0 alone is ambiguous between those two cases).
  promiseExtractionStatus: { type: String, enum: ['PENDING', 'EXTRACTED', 'FAILED'], default: 'PENDING', index: true },
  fetchedAt: { type: Date, default: null },
  error: { type: String, default: null },
}, { timestamps: true });

companyDocumentRegistrySchema.index({ symbol: 1, url: 1 }, { unique: true, name: 'unique_document_per_symbol_url' });
companyDocumentRegistrySchema.index({ symbol: 1, fiscalYear: 1 });

export const hashDocumentContent = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export const CompanyDocumentRegistry = mongoose.models.CompanyDocumentRegistry
  || mongoose.model('CompanyDocumentRegistry', companyDocumentRegistrySchema);

export default CompanyDocumentRegistry;
