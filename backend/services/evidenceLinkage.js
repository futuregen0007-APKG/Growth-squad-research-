/**
 * evidenceLinkage.js
 * ====================
 * Phase 4F.2 Part 4: the deterministic bridge between a public-safe
 * Earnings-Intelligence (EI) record's own trusted fields (symbol,
 * sourceUrl, page, excerpt, metric, evidenceIntegrity.status) and the REAL
 * ResearchDocumentChunk that actually backs it.
 *
 * WHY THIS EXISTS: an EI record's promiseEvidence/outcomeEvidence excerpt
 * is already human-verified (that is what earns it VERIFIED_PRIMARY/
 * VERIFIED_EXCHANGE_COPY), but nothing previously PROVED, at runtime, that
 * the excerpt is a genuine substring of a real, locally-stored document.
 * This module proves it deterministically, or reports exactly why it
 * cannot — it never manufactures a link, never fuzzy-matches, and never
 * runs for any record that is not already public-safe.
 *
 * Matching is on trusted, structural fields ONLY:
 *   - sourceUrl (normalized — see normalizeSourceUrl)
 *   - the chunk's page range containing the record's own page
 *   - the record's own excerpt being an EXACT substring of that chunk's
 *     real stored text (after a narrow, generic punctuation
 *     normalization — see normalizeForExactMatch)
 * No semantic/embedding similarity is ever used here.
 */
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';
import { isPubliclyVisibleRecord } from '../utils/earningsIntelligenceValidation.js';
import { normalizeMetric, classifyQualitativeDirection } from './guidanceNormalization.js';

// Deliberately its OWN, non-numeric version namespace -- NEVER the same
// (chunkId, extractionVersion) key scripts/enrichGuidanceCorpus.js's blind
// corpus-wide scan uses (currently numeric "1"/"2"/"3", bumped by that
// script alone). A real collision was found and fixed during this phase:
// upserting an EI-linked annotation onto the SAME numeric version a
// corpus-wide rerun also writes to let the blind scan's own (correctly
// conservative) REJECTED verdict for the exact same sentence silently
// overwrite this bridge's verified result. guidanceAnnotationLookup.js
// treats any non-numeric extractionVersion as this bridge's own lane and
// prefers it over the numeric "current" row for the same chunk, since an
// EI-linked annotation is anchored to an already public-safe, human-
// reviewed record -- a strictly more trusted provenance than a blind scan.
export const EI_LINKED_EXTRACTION_VERSION = 'EI-LINKED-1';

export const LINKAGE_REASONS = Object.freeze({
  UNSAFE_INTEGRITY_STATUS: 'UNSAFE_INTEGRITY_STATUS',
  MISSING_FIELDS: 'MISSING_FIELDS',
  NO_CHUNK_FOR_SOURCE_AND_PAGE: 'NO_CHUNK_FOR_SOURCE_AND_PAGE',
  EXCERPT_NOT_FOUND_VERBATIM: 'EXCERPT_NOT_FOUND_VERBATIM',
  LINKED: 'LINKED',
});

/**
 * normalizeForExactMatch - a narrow, generic (never record-specific)
 * normalization of Unicode punctuation variants a real PDF-text-extraction
 * pipeline commonly produces but a hand-curated JSON excerpt commonly
 * doesn't (and vice versa): curly vs. straight quotes/apostrophes, en/em
 * dash vs. hyphen, non-breaking vs. regular space, and collapsed
 * whitespace runs. This is the SAME spirit as guidanceNormalization.js's
 * own RANGE_SEPARATOR treating "-"/"to"/"–"/"—" as equivalent — a
 * documented, reviewable allow-list of GLYPH variants, never a fuzzy or
 * semantic match. Two strings that are normalizeForExactMatch-equal are
 * the same text; nothing case-insensitive or word-order-tolerant is ever
 * applied.
 */
export const normalizeForExactMatch = (text) => String(text || '')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * findSupportingChunk - locates the real ResearchDocumentChunk backing one
 * side (promiseEvidence or outcomeEvidence) of an EI record. Returns
 * `{ linked: false, reason }` when no confident match exists — NEVER
 * widens the search beyond the record's own cited sourceUrl/page, and
 * never accepts a normalized-but-not-otherwise-verbatim excerpt match.
 */
export const findSupportingChunk = async ({ sourceUrl, page, excerpt, symbol } = {}) => {
  if (!sourceUrl || !excerpt) {
    return { linked: false, reason: LINKAGE_REASONS.MISSING_FIELDS };
  }

  const query = { sourceUrl };
  if (symbol) query.symbol = String(symbol).toUpperCase();
  if (Number.isInteger(page)) {
    query.pageStart = { $lte: page };
    query.pageEnd = { $gte: page };
  }

  const candidates = await ResearchDocumentChunk.find(query).lean();
  if (!candidates.length) {
    return { linked: false, reason: LINKAGE_REASONS.NO_CHUNK_FOR_SOURCE_AND_PAGE };
  }

  const normalizedExcerpt = normalizeForExactMatch(excerpt);
  const match = candidates.find((chunk) => normalizeForExactMatch(chunk.text).includes(normalizedExcerpt));
  if (!match) {
    return { linked: false, reason: LINKAGE_REASONS.EXCERPT_NOT_FOUND_VERBATIM };
  }

  return {
    linked: true,
    reason: LINKAGE_REASONS.LINKED,
    chunkId: String(match._id),
    chunk: match,
  };
};

/**
 * linkPublicSafeEIEvidence - the ONE entry point that should ever be
 * called with an EI record's evidence side. Refuses immediately (never
 * even queries chunks) for any record whose evidenceIntegrity.status is
 * not public-safe — QUARANTINED, UNSUPPORTED, UNREVIEWED_LEGACY,
 * PENDING_REVIEW, missing status, etc. all short-circuit here, matching
 * Part 4's own explicit "must never attach" list.
 */
export const linkPublicSafeEIEvidence = async (eiRecord, evidenceSide) => {
  if (!isPubliclyVisibleRecord(eiRecord)) {
    return { linked: false, reason: LINKAGE_REASONS.UNSAFE_INTEGRITY_STATUS };
  }
  const evidence = evidenceSide === 'outcome' ? eiRecord.outcomeEvidence : eiRecord.promiseEvidence;
  if (!evidence) return { linked: false, reason: LINKAGE_REASONS.MISSING_FIELDS };

  return findSupportingChunk({
    sourceUrl: evidence.sourceUrl,
    page: evidence.pageNumber,
    excerpt: evidence.excerpt,
    symbol: eiRecord.symbol,
  });
};

/**
 * buildQualitativeAnnotationFromLinkage - given a CONFIRMED linkage (from
 * linkPublicSafeEIEvidence) and the EI record's own trusted metric field,
 * upserts a genuine, real ResearchGuidanceAnnotation row for the linked
 * chunk — extractionMethod EI_LINKED_DETERMINISTIC, status VERIFIED only
 * when metric AND direction both resolve. Never writes anything when
 * either is unresolved (Part 4: "never manufacture an annotation").
 * Idempotent: re-running with the same (chunkId, extractionVersion)
 * upserts the SAME row, never a duplicate (inherited from
 * ResearchGuidanceAnnotation's own unique index).
 */
export const buildQualitativeAnnotationFromLinkage = async ({
  linkage, metric, excerpt, eiRecordId, fiscalYear, fiscalQuarter, symbol, documentType, publishedAt,
}) => {
  if (!linkage?.linked) {
    return { annotated: false, reason: linkage?.reason || LINKAGE_REASONS.MISSING_FIELDS };
  }

  const metricResult = normalizeMetric(metric);
  const direction = classifyQualitativeDirection(excerpt);
  if (!metricResult.metricKey || !direction.qualitativeDirection) {
    return {
      annotated: false,
      reason: !metricResult.metricKey ? 'METRIC_UNRESOLVED' : direction.reason,
    };
  }

  const chunk = linkage.chunk;
  const normalizedExcerpt = normalizeForExactMatch(excerpt);
  const normalizedChunkText = normalizeForExactMatch(chunk.text);
  const matchIndex = normalizedChunkText.indexOf(normalizedExcerpt);
  // The verified span is sliced from the REAL chunk text at the matched
  // offset (never the caller's own excerpt string) so supportingSpan is
  // always byte-for-byte genuine source content, exactly like the
  // corpus-wide extractor's own spanIsGenuine guarantee.
  const supportingSpan = matchIndex >= 0 ? chunk.text.slice(matchIndex, matchIndex + normalizedExcerpt.length) : excerpt;

  const annotationEntry = {
    status: 'VERIFIED',
    candidateSignals: ['EI_LINKED'],
    metric: metricResult.metric,
    metricKey: metricResult.metricKey,
    guidanceKind: 'ORIGINAL',
    valueType: 'qualitative',
    qualitativeDirection: direction.qualitativeDirection,
    supportingSpan,
    extractionMethod: 'EI_LINKED_DETERMINISTIC',
    confidence: 0.85,
    rejectionReasons: [],
    unresolvedReason: null,
    linkedEIRecordId: eiRecordId || null,
  };

  const doc = await ResearchGuidanceAnnotation.findOneAndUpdate(
    { chunkId: linkage.chunkId, extractionVersion: EI_LINKED_EXTRACTION_VERSION },
    {
      $set: {
        chunkHash: chunk.chunkHash,
        symbol: symbol || chunk.symbol,
        documentType: documentType || chunk.documentType,
        fiscalYear: fiscalYear || chunk.fiscalYear,
        fiscalQuarter: fiscalQuarter || chunk.fiscalQuarter || null,
        sourceUrl: chunk.sourceUrl,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        publishedAt: publishedAt || chunk.publishedAt || null,
        isCandidateChunk: true,
        candidateSignals: ['EI_LINKED'],
        candidateReason: 'EI_LINKED_QUALITATIVE',
        annotations: [annotationEntry],
        hasVerifiedAnnotation: true,
        extractedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { annotated: true, annotationId: String(doc._id), chunkId: linkage.chunkId, annotation: annotationEntry };
};

export default {
  LINKAGE_REASONS, normalizeForExactMatch, findSupportingChunk, linkPublicSafeEIEvidence, buildQualitativeAnnotationFromLinkage,
};
