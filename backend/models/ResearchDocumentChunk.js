import mongoose from 'mongoose';

/**
 * ResearchDocumentChunk
 * =======================
 * Phase 4A: page-aware, deterministically-chunked passages extracted from
 * REAL documents already durably stored via CompanyDocumentRegistry +
 * DocumentStorageService (GridFS/S3) — this model never stores raw PDF
 * bytes itself, only derived text + (once embedded) a vector, always
 * traceable back to the exact document + page range it came from.
 *
 * Idempotent re-indexing: `chunkHash` is a deterministic function of the
 * SOURCE document's content hash + this chunk's page span + its exact
 * text (see services/DocumentChunkingService.js's `computeChunkHash`) —
 * so re-running the indexer against an UNCHANGED document reproduces the
 * exact same chunkHash for every chunk (a plain upsert, never a
 * duplicate, never a re-embed), while a CHANGED document (different
 * pdfHash) or a changed chunking algorithm (different page spans/text)
 * always produces new chunkHash values, i.e. new chunks — the old ones
 * for that document are superseded, never silently mixed with them.
 *
 * `embedding`/`embeddingModel`/`embeddingVersion` are intentionally
 * separate from chunk creation: a chunk can exist (text extracted,
 * indexed) before it has ever been embedded (`embedding` absent,
 * `indexedAt: null`) — services/EmbeddingService.js fills these in as a
 * distinct, resumable step, and vectors from two different embedding
 * models/versions are NEVER compared against each other (the retriever
 * filters on embeddingModel+embeddingVersion before scoring).
 */

export const CHUNK_DOCUMENT_TYPES = [
  'ANNUAL_REPORT', 'FINANCIAL_RESULTS', 'INVESTOR_PRESENTATION',
  'EARNINGS_CALL_TRANSCRIPT', 'PRESS_RELEASE', 'EXCHANGE_FILING', 'OTHER',
];

const researchDocumentChunkSchema = new mongoose.Schema({
  symbol: { type: String, required: true, uppercase: true, index: true },
  registryDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyDocumentRegistry', required: true, index: true },
  // Mirrors CompanyDocumentRegistry.pdfHash AT INDEXING TIME — kept here
  // (not just joined via registryDocumentId) so chunkHash can be computed
  // and re-indexing decisions made without an extra lookup, and so a
  // chunk's provenance survives even if the registry row is later purged.
  documentHash: { type: String, required: true, index: true },
  chunkHash: { type: String, required: true },
  documentType: { type: String, enum: CHUNK_DOCUMENT_TYPES, required: true },
  title: { type: String, default: null },
  fiscalYear: { type: String, required: true, index: true },
  fiscalQuarter: { type: String, default: null },
  publishedAt: { type: Date, default: null },
  sourceUrl: { type: String, required: true },
  // 1-indexed, inclusive — a chunk drawn from a single page has
  // pageStart === pageEnd; one that had to span pages (a short trailing
  // page merged with its neighbor — see the chunking service) has
  // pageEnd > pageStart. Never spans pages that were not physically
  // adjacent in the source PDF.
  pageStart: { type: Number, required: true, min: 1 },
  pageEnd: { type: Number, required: true, min: 1 },
  // Position of this chunk within its document's own chunk sequence
  // (0-indexed) — lets a caller reconstruct reading order and gives
  // computeChunkHash a stable tiebreaker for two chunks that happen to
  // have identical text on different pages.
  chunkIndex: { type: Number, required: true, min: 0 },
  text: { type: String, required: true },
  approximateTokenCount: { type: Number, required: true },
  embeddingModel: { type: String, default: null },
  embeddingVersion: { type: String, default: null },
  // Not `select: false` — small enough (1536 floats for
  // text-embedding-3-small) that retrieval needs it directly, and hiding
  // it by default would just force every retriever query to override the
  // projection anyway.
  embedding: { type: [Number], default: undefined },
  // Set only once embedding has actually succeeded for this chunk — null
  // means "not yet embedded" (a genuinely different state from "embedded
  // with a zero-length vector", which never happens; embedding is either
  // absent or a real, complete vector).
  indexedAt: { type: Date, default: null },
  // A coarse trust signal carried over from the source document's own
  // provenance (e.g. 'EXCHANGE_FILING' for a BSE-sourced PDF via
  // CompanyDocumentRegistry vs a lower-trust discovered source) — never
  // computed by this model itself, always passed in from the indexer.
  sourceAuthority: { type: String, default: null },
  storageBackend: { type: String, enum: ['S3', 'GRIDFS', null], default: null },
  storageKey: { type: String, default: null },
  // Recorded so a future extraction-quality fix can be scoped to exactly
  // the chunks it affects without re-parsing every document to find out.
  extractedWithVersion: { type: String, default: '1' },
}, { timestamps: true });

// The idempotency guarantee: one chunk per (document content, page span,
// exact text, position) tuple, globally. A second indexing run over an
// UNCHANGED document computes the SAME chunkHash for every chunk and
// upserts (no-op after the first run); a changed document's chunks get a
// fresh set of hashes and are inserted as new rows alongside (not
// replacing) the old ones — see the indexing CLI for how stale chunks
// from a superseded documentHash are identified and cleaned up
// explicitly, never implicitly.
researchDocumentChunkSchema.index({ chunkHash: 1 }, { unique: true, name: 'unique_chunk_hash' });
researchDocumentChunkSchema.index({ symbol: 1, registryDocumentId: 1, chunkIndex: 1 }, { name: 'chunk_order_within_document' });
researchDocumentChunkSchema.index({ symbol: 1, fiscalYear: 1, documentType: 1 }, { name: 'retrieval_filter' });
researchDocumentChunkSchema.index({ embeddingModel: 1, embeddingVersion: 1 }, { name: 'embedding_version' });

export const ResearchDocumentChunk = mongoose.models.ResearchDocumentChunk
  || mongoose.model('ResearchDocumentChunk', researchDocumentChunkSchema);

export default ResearchDocumentChunk;
