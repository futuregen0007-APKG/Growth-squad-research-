import mongoose from 'mongoose';
import { computeNormalizedTextHash, computeChunkHash } from '../services/DocumentChunkingService.js';

/**
 * ResearchDocumentChunk
 * =======================
 * Phase 4A: page-aware, deterministically-chunked passages extracted from
 * REAL documents already durably stored via CompanyDocumentRegistry +
 * DocumentStorageService (GridFS/S3) — this model never stores raw PDF
 * bytes itself, only derived text + (once embedded) a vector, always
 * traceable back to the exact document + page range it came from.
 *
 * Chunk identity (Phase 4A.1 hardening): the TRUE, database-enforced
 * identity is the compound unique index on (documentHash, pageStart,
 * chunkIndex) — see `unique_chunk_identity` below — not a single opaque
 * hash string. This is what makes provenance structural rather than
 * hash-hopeful: a document's content hash already anchors every chunk to
 * exactly one company + one filing + one fiscal period, so identical TEXT
 * appearing in two different documents, or twice on two different pages
 * of the SAME document, always produces two independently-addressable,
 * independently-citable rows — their (documentHash, pageStart,
 * chunkIndex) tuples differ even when `text` is byte-for-byte identical.
 * `chunkHash` (still present, still deterministic — see
 * services/DocumentChunkingService.js's `computeChunkHash`) is a derived
 * content fingerprint built from the SAME compound key plus a normalized
 * hash of the text; the indexing CLI upserts on the compound key
 * directly (never on chunkHash alone — see DocumentChunkingService.js's
 * identity note for why). Re-running the indexer against an UNCHANGED
 * document therefore reproduces the exact same row for every chunk (a
 * plain in-place upsert, never a duplicate, never a re-embed), while a
 * CHANGED document (different pdfHash) always produces an entirely
 * disjoint set of (documentHash, pageStart, chunkIndex) tuples — the old
 * document's rows are superseded, never silently mixed with the new ones.
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
  // Derived content fingerprint (documentHash + pageStart + chunkIndex +
  // a normalized hash of the text) — NOT the identity key (see the
  // compound unique index below); kept indexed for fast lookup and to
  // detect "this chunk's content silently changed" without recomputing.
  chunkHash: { type: String, required: true, index: true },
  // sha256 of the chunk's lowercased, whitespace-collapsed text — the
  // "normalized text hash" component of chunkHash, stored separately so
  // near-duplicate/content-change detection never has to re-normalize
  // and re-hash the full text on the fly.
  normalizedTextHash: { type: String, required: true },
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
  // Phase 4A.1: denormalized from the source document's own chunking-run
  // coverage summary (see DocumentChunkingService.chunkPages) so a
  // retriever result can be honestly flagged as coming from a document
  // that was only partially indexed — "no evidence found" must never be
  // confused with "the evidence exists on a page we truncated away".
  documentTruncated: { type: Boolean, default: false },
  documentExtractionCoveragePct: { type: Number, default: 100 },
}, { timestamps: true });

// Convenience auto-fill, never an override: a caller that already computed
// normalizedTextHash/chunkHash itself (the indexing CLI always does) keeps
// its own values untouched; anything that omits them (tests, ad-hoc
// scripts) gets them derived from `text` + the compound identity fields
// here, so `required: true` above can never be a surprising validation
// failure for code that's otherwise correct.
researchDocumentChunkSchema.pre('validate', function autofillIdentityHashes() {
  if (!this.normalizedTextHash && this.text) {
    this.normalizedTextHash = computeNormalizedTextHash(this.text);
  }
  if (!this.chunkHash && this.documentHash && this.text != null && this.pageStart != null && this.chunkIndex != null) {
    this.chunkHash = computeChunkHash({
      documentHash: this.documentHash, pageStart: this.pageStart, pageEnd: this.pageEnd, chunkIndex: this.chunkIndex, text: this.text,
    });
  }
});

// THE identity guarantee (Phase 4A.1): one chunk per (documentHash,
// pageStart, chunkIndex) tuple, enforced by MongoDB itself — not merely
// hoped for via a hash string. A second indexing run over an UNCHANGED
// document resolves to the exact same tuple for every chunk (a plain
// in-place upsert, never a duplicate, never a re-embed); a changed
// document (different pdfHash) occupies an entirely disjoint tuple space
// and is inserted alongside — never replacing — the old rows, which a
// caller can then explicitly clean up (see the indexing CLI's scoped
// --force-reindex-symbol) rather than having them vanish implicitly.
researchDocumentChunkSchema.index({ documentHash: 1, pageStart: 1, chunkIndex: 1 }, { unique: true, name: 'unique_chunk_identity' });
// chunkHash's own `index: true` field option (above) already gives it a
// plain lookup index — it is a deterministic, globally-unique-in-practice
// value (a hash of the same compound key plus content) but is NOT the
// enforced identity constraint; that's the compound index above.
researchDocumentChunkSchema.index({ symbol: 1, registryDocumentId: 1, chunkIndex: 1 }, { name: 'chunk_order_within_document' });
researchDocumentChunkSchema.index({ symbol: 1, fiscalYear: 1, documentType: 1 }, { name: 'retrieval_filter' });
researchDocumentChunkSchema.index({ embeddingModel: 1, embeddingVersion: 1 }, { name: 'embedding_version' });

export const ResearchDocumentChunk = mongoose.models.ResearchDocumentChunk
  || mongoose.model('ResearchDocumentChunk', researchDocumentChunkSchema);

export default ResearchDocumentChunk;
