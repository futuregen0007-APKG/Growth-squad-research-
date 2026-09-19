import mongoose from 'mongoose';

/**
 * ResearchGuidanceAnnotation
 * ============================
 * Phase 4E Part 5: versioned, idempotent output of the offline guidance
 * extraction pipeline (services/guidanceExtraction.js), run over REAL
 * ResearchDocumentChunk rows by scripts/enrichGuidanceCorpus.js.
 *
 * Deliberately a SEPARATE collection, never a mutation of
 * ResearchDocumentChunk itself — that model's own header explicitly treats
 * a chunk's (documentHash, pageStart, chunkIndex) identity as structural
 * provenance; adding derived, potentially-wrong annotation fields directly
 * onto it would blur "what the source document actually contains" with
 * "what a later extraction pass concluded about it". Mirrors
 * PromiseCandidate.js's storage conventions (a machine-generated draft
 * collection, Mongo as the source of truth because Render's filesystem is
 * ephemeral — see that model's own header comment).
 *
 * Idempotent identity: ONE ROW per (chunkId, extractionVersion) — a single
 * chunk can contain more than one distinct candidate guidance sentence
 * (real transcripts often discuss margin AND revenue growth in
 * consecutive sentences on the same page), so each candidate sentence's
 * result lives in the `annotations` ARRAY on that one row, rather than as
 * its own separate row — the alternative (one row per candidate sentence)
 * has no stable per-sentence identity to upsert against and would have
 * violated this exact (chunkId, extractionVersion) uniqueness constraint
 * the first time a chunk produced more than one candidate (an issue this
 * project actually hit and fixed while running the real corpus — see
 * Phase 4E's own final report). Re-running the enrichment script with the
 * SAME extractionVersion over an unchanged chunk always upserts the same
 * row (replacing its `annotations` array wholesale, never a duplicate);
 * bumping extractionVersion for a chunk whose extraction logic changed
 * inserts a NEW row alongside the old one rather than overwriting it, so a
 * caller can compare old vs new before deciding which is "current" (the
 * highest extractionVersion row for that chunkId — see
 * services/guidanceAnnotationLookup.js's getVerifiedAnnotationsByChunkIds).
 * `chunkHash` is also stored (copied from the chunk at extraction time,
 * never recomputed) purely as a staleness tripwire: since chunks are
 * immutable, a stored chunkHash that no longer matches the live chunk's
 * own chunkHash means something upstream re-wrote history, which should
 * never happen silently.
 *
 * Every chunk-identifying field here (symbol, documentType, fiscalYear,
 * fiscalQuarter, sourceUrl, pageStart, pageEnd, publishedAt) is copied
 * VERBATIM from the source chunk at extraction time, never re-derived from
 * this annotation's own extracted text — so a consumer
 * (guidanceNormalization.js, via EvidenceEnvelope.js) never has to trust
 * this collection for provenance, only for the extracted guidance fields
 * themselves.
 *
 * Each entry in `annotations` carries its own status:
 *   PENDING    - reserved for a future async/LLM extraction path; the
 *                synchronous deterministic pipeline never leaves an entry
 *                in this state.
 *   EXTRACTED  - reserved for a future path where extraction and
 *                verification are separate passes; the current pipeline
 *                verifies inline, so an entry is never left here either.
 *   VERIFIED   - passed every Part 4 deterministic check; the ONLY status
 *                guidanceAnnotationLookup.js will ever surface to
 *                guidanceNormalization.js.
 *   REJECTED   - failed a Part 4 check; rejectionReasons is always
 *                non-empty.
 *   UNRESOLVED - candidate sentence found, but metric and/or value could
 *                not be confidently normalized — never scored as a
 *                hallucination (Part 8's own instruction), just honestly
 *                unresolved.
 *
 * Never stored here: hidden model reasoning, raw LLM API responses, or
 * secrets — extractionMethod distinguishes DETERMINISTIC (the only method
 * actually exercised so far) from a future LLM_STRUCTURED path, but even
 * that path would only ever store the same typed fields below, never a
 * raw response blob.
 */

export const GUIDANCE_ANNOTATION_STATUSES = ['PENDING', 'EXTRACTED', 'VERIFIED', 'REJECTED', 'UNRESOLVED'];
export const GUIDANCE_KINDS = ['ORIGINAL', 'MAINTAINED', 'RAISED', 'LOWERED', 'REVISED'];
// Phase 4F.2 Part 4: EI_LINKED_DETERMINISTIC is still 100% deterministic,
// zero-LLM (same as DETERMINISTIC) -- it exists only to record PROVENANCE:
// this annotation was produced by the EI-to-chunk bridge
// (services/evidenceLinkage.js), sourced from an already public-safe,
// human-verified Earnings-Intelligence record's own excerpt, rather than
// blind-scanned from a chunk with no such backing record. Never a
// looser/weaker extraction method -- see that module's own header.
export const EXTRACTION_METHODS = ['DETERMINISTIC', 'LLM_STRUCTURED', 'EI_LINKED_DETERMINISTIC'];
// Phase 4F.2 Part 2: the same explicit, deterministic direction vocabulary
// guidanceNormalization.js's classifyQualitativeDirection resolves to.
export const QUALITATIVE_DIRECTIONS = ['INCREASE', 'DECREASE', 'MAINTAIN', 'IMPROVE', 'EXPAND', 'REDUCE', 'STABLE', 'OTHER'];

const guidanceAnnotationEntrySchema = new mongoose.Schema({
  status: { type: String, enum: GUIDANCE_ANNOTATION_STATUSES, required: true },
  candidateSignals: { type: [String], default: [] },

  metric: { type: String, default: null },
  metricKey: { type: String, default: null },
  guidanceKind: { type: String, enum: [...GUIDANCE_KINDS, null], default: null },
  // Phase 4F.2: 'qualitative' added, additive/backward-compatible -- every
  // existing row's valueType stays 'range'/'exact'/null exactly as before.
  valueType: { type: String, enum: ['range', 'exact', 'qualitative', null], default: null },
  lowerBound: { type: Number, default: null },
  upperBound: { type: Number, default: null },
  exactValue: { type: Number, default: null },
  unit: { type: String, default: null },
  currency: { type: String, default: null },
  // Present only when valueType === 'qualitative'; null for every numeric
  // or unresolved entry. `supportingSpan` below IS the verified
  // qualitativeText -- never a second, separately-typed free-text field
  // that could drift from the actual verified span.
  qualitativeDirection: { type: String, enum: [...QUALITATIVE_DIRECTIONS, null], default: null },

  supportingSpan: { type: String, required: true },
  extractionMethod: { type: String, enum: EXTRACTION_METHODS, required: true, default: 'DETERMINISTIC' },
  confidence: { type: Number, required: true, min: 0, max: 1 },

  rejectionReasons: { type: [String], default: [] },
  unresolvedReason: { type: String, default: null },
  // Phase 4F.2 Part 4: set only by the EI-to-chunk bridge -- which
  // public-safe Earnings-Intelligence record's own excerpt this annotation
  // was verified against, for audit/dedup purposes. Null for every
  // corpus-scanned (non-EI-linked) annotation.
  linkedEIRecordId: { type: String, default: null },
}, { _id: false });

const researchGuidanceAnnotationSchema = new mongoose.Schema({
  chunkId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResearchDocumentChunk', required: true, index: true },
  chunkHash: { type: String, required: true },
  extractionVersion: { type: String, required: true, default: '1' },

  // Copied verbatim from the source chunk — never re-derived.
  symbol: { type: String, required: true, uppercase: true, index: true },
  documentType: { type: String, required: true },
  fiscalYear: { type: String, required: true, index: true },
  fiscalQuarter: { type: String, default: null },
  sourceUrl: { type: String, required: true },
  pageStart: { type: Number, required: true },
  pageEnd: { type: Number, required: true },
  publishedAt: { type: Date, default: null },

  // Chunk-level candidate-detection outcome (Part 2) — kept even when
  // `annotations` ends up empty (a candidate chunk whose sentences all
  // failed sentence-level number/value gates), so the "why was this chunk
  // even considered" audit trail survives independently of what, if
  // anything, was ultimately extracted from it.
  isCandidateChunk: { type: Boolean, required: true },
  candidateSignals: { type: [String], default: [] },
  candidateReason: { type: String, default: null },

  annotations: { type: [guidanceAnnotationEntrySchema], default: [] },
  // Denormalized for the query in guidanceAnnotationLookup.js — true iff
  // ANY entry in `annotations` has status VERIFIED. Kept in sync by
  // scripts/enrichGuidanceCorpus.js on every write, never computed lazily.
  hasVerifiedAnnotation: { type: Boolean, required: true, default: false },

  extractedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true });

// THE idempotency guarantee (Part 5): rerunning the enrichment script for
// the same chunk at the same extractionVersion always resolves to this one
// row (upsert), never a duplicate — regardless of how many candidate
// sentences that chunk produces.
researchGuidanceAnnotationSchema.index({ chunkId: 1, extractionVersion: 1 }, { unique: true, name: 'unique_annotation_per_chunk_version' });
researchGuidanceAnnotationSchema.index({ symbol: 1, fiscalYear: 1, hasVerifiedAnnotation: 1 }, { name: 'verified_lookup_scope' });

export const ResearchGuidanceAnnotation = mongoose.models.ResearchGuidanceAnnotation
  || mongoose.model('ResearchGuidanceAnnotation', researchGuidanceAnnotationSchema);

export default ResearchGuidanceAnnotation;
