/**
 * guidanceAnnotationLookup.js
 * ==============================
 * Phase 4E Part 6: the ONLY thing EvidenceEnvelope.js is allowed to ask
 * about offline-extracted guidance annotations. Reads directly from
 * MongoDB (models/ResearchGuidanceAnnotation.js) — there is no LLM call
 * anywhere in this file, at request time or otherwise, and never will be:
 * annotations are produced entirely offline by
 * scripts/enrichGuidanceCorpus.js.
 *
 * Only ever returns a VERIFIED entry. A row whose `annotations` array has
 * no VERIFIED entry at all (every candidate sentence in that chunk was
 * REJECTED/UNRESOLVED) is never surfaced here, which is what makes Phase
 * 4D's "unverified annotations cannot produce SUPERSEDES" guarantee
 * structural rather than a downstream filter someone could forget to
 * apply.
 *
 * When a chunk has rows at more than one extractionVersion (a
 * reprocessing run bumped the version), only the highest extractionVersion
 * row is considered per chunk — that is this module's definition of
 * "current". When that row's `annotations` array contains more than one
 * VERIFIED entry (a chunk genuinely discussing more than one distinct,
 * quantified guidance statement), the highest-confidence entry is
 * returned — a single retrieved chunk maps to exactly one canonicalGuidance
 * slot in guidanceNormalization.js, so only one entry can ever be surfaced
 * per chunk.
 */
import mongoose from 'mongoose';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';

const bestVerifiedEntry = (annotations = []) => annotations
  .filter((a) => a.status === 'VERIFIED')
  .sort((a, b) => b.confidence - a.confidence)[0] || null;

/**
 * getVerifiedAnnotationsByChunkIds - batched lookup for a set of chunk
 * ids (strings or ObjectIds). Returns a Map keyed by chunkId string ->
 * the current row's best VERIFIED entry, flattened with `status: 'VERIFIED'`
 * alongside it (plain object), or no entry at all when a chunk has no
 * VERIFIED annotation. A single Mongo round trip regardless of how many
 * chunk ids are passed, so calling this once per envelope build (rather
 * than per item) never adds N extra queries.
 */
export const getVerifiedAnnotationsByChunkIds = async (chunkIds = []) => {
  // A real ResearchDocumentChunk's own `_id` is always a Mongo ObjectId, so
  // a chunkId string that isn't a valid ObjectId (e.g. an
  // Earnings-Intelligence-sourced item's synthetic
  // `earnings-intelligence:...` id, or a test double) can never have a
  // real annotation row — filtered out here rather than passed to Mongo,
  // which would otherwise throw a CastError on the $in query.
  const ids = [...new Set((chunkIds || []).filter(Boolean).map(String))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!ids.length) return new Map();

  const rows = await ResearchGuidanceAnnotation.find({
    chunkId: { $in: ids },
    hasVerifiedAnnotation: true,
  }).lean();

  // extractionVersion is USUALLY a free-form numeric string ("1", "2", ...)
  // from scripts/enrichGuidanceCorpus.js's blind, corpus-wide scan —
  // compared numerically here (never lexically, which would rank "10"
  // before "2") to pick the current row per chunkId, exactly as before.
  //
  // Phase 4F.2: services/evidenceLinkage.js's EI-to-chunk bridge writes to
  // a DELIBERATELY separate, non-numeric extractionVersion lane
  // (EI_LINKED_EXTRACTION_VERSION) so its own upserts can never collide
  // with — and be silently overwritten by — the blind scan's own verdict
  // for the exact same chunk (a real bug this phase found and fixed: the
  // blind scan correctly, conservatively REJECTS a courtesy-phrase-
  // containing-"you" sentence that the SAME sentence's EI-linked
  // annotation had correctly verified via its own, differently-trusted
  // path). A chunk with a VERIFIED EI-linked entry always wins over its
  // numeric-lane sibling, since it is anchored to an already public-safe,
  // human-reviewed Earnings-Intelligence record — strictly more trusted
  // provenance than an unaudited blind scan.
  const currentRowByChunkId = new Map();
  const eiLinkedEntryByChunkId = new Map();
  for (const row of rows) {
    const key = String(row.chunkId);
    const isNumericVersion = /^\d+$/.test(String(row.extractionVersion));
    if (isNumericVersion) {
      const existing = currentRowByChunkId.get(key);
      if (!existing || Number(row.extractionVersion) > Number(existing.extractionVersion)) {
        currentRowByChunkId.set(key, row);
      }
    } else {
      const entry = bestVerifiedEntry(row.annotations);
      if (entry) eiLinkedEntryByChunkId.set(key, { ...entry, status: 'VERIFIED', extractionVersion: row.extractionVersion });
    }
  }

  const byChunkId = new Map();
  for (const key of new Set([...currentRowByChunkId.keys(), ...eiLinkedEntryByChunkId.keys()])) {
    const eiEntry = eiLinkedEntryByChunkId.get(key);
    if (eiEntry) {
      byChunkId.set(key, eiEntry);
      continue;
    }
    const row = currentRowByChunkId.get(key);
    const entry = row ? bestVerifiedEntry(row.annotations) : null;
    if (entry) byChunkId.set(key, { ...entry, status: 'VERIFIED', extractionVersion: row.extractionVersion });
  }
  return byChunkId;
};

export default { getVerifiedAnnotationsByChunkIds };
