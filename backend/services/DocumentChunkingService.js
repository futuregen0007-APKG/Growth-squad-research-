import crypto from 'node:crypto';

/**
 * DocumentChunkingService.js
 * =============================
 * Phase 4A: turns page-aware extracted text (services/FactExtractionService
 * .js's `extractPdfPages` — already produces `[{pageNumber, text}]`, one
 * whitespace-normalized string per real PDF page) into deterministic,
 * page-traceable chunks ready for embedding.
 *
 * Deliberately conservative: a chunk NEVER spans more than one source
 * page. `extractPdfPages` already collapses each page's internal
 * whitespace/newlines to single spaces, so there is no reliable line
 * structure left to reason about "this paragraph continues onto the next
 * page" — merging across pages would risk splicing together two
 * unrelated sections (e.g. the end of a risk-factors page with the start
 * of an unrelated financial-statements page). A page whose text exceeds
 * one chunk's budget is split into multiple chunks (with overlap); a
 * short page simply becomes its own single small chunk. This is the
 * "never combine unrelated pages blindly" requirement satisfied by
 * construction, not by a heuristic that could occasionally be wrong.
 *
 * Deterministic: chunkPages/chunkDocument are pure functions of their
 * input — the same pages + the same options always produce the exact
 * same chunk boundaries and chunkHash values, so re-running the indexer
 * against an unchanged document is a true no-op (see computeChunkHash).
 */

export const CHUNKING_VERSION = '2';

export const DEFAULT_CHUNKING_OPTIONS = Object.freeze({
  maxTokensPerChunk: 400,
  overlapTokens: 40,
  maxPagesPerDocument: 60,
  maxChunksPerDocument: 300,
  minPageTextLength: 40,
});

/**
 * Phase 4A.1 hardening: the flat 60-page/300-chunk cap silently truncated
 * long annual reports (which routinely run 150-300+ pages) while being
 * far more than a short press release or transcript ever needs. Limits
 * are now document-type-aware; `chunkDocument`/`chunkPages` report exactly
 * how much of the source document was actually covered (see
 * `extractionCoveragePct`/`truncated`/`truncationReason` below) so a
 * truncated document can never be silently mistaken for a fully-indexed
 * one downstream. Hard safety caps are still enforced for every type —
 * no document, however large, is ever chunked without a bound.
 */
export const DOCUMENT_TYPE_CHUNKING_LIMITS = Object.freeze({
  ANNUAL_REPORT: { maxPagesPerDocument: 250, maxChunksPerDocument: 900 },
  FINANCIAL_RESULTS: { maxPagesPerDocument: 80, maxChunksPerDocument: 350 },
  INVESTOR_PRESENTATION: { maxPagesPerDocument: 80, maxChunksPerDocument: 350 },
  EARNINGS_CALL_TRANSCRIPT: { maxPagesPerDocument: 60, maxChunksPerDocument: 300 },
  PRESS_RELEASE: { maxPagesPerDocument: 20, maxChunksPerDocument: 100 },
  EXCHANGE_FILING: { maxPagesPerDocument: 60, maxChunksPerDocument: 300 },
  OTHER: { maxPagesPerDocument: 60, maxChunksPerDocument: 300 },
});

/** Resolves the effective page/chunk caps for a document type — explicit caller overrides always win over the type-aware default, which in turn always wins over the flat DEFAULT_CHUNKING_OPTIONS. */
export const resolveChunkingOptions = (documentType, overrides = {}) => {
  const typeLimits = DOCUMENT_TYPE_CHUNKING_LIMITS[documentType] || {};
  return { ...DEFAULT_CHUNKING_OPTIONS, ...typeLimits, ...overrides };
};

// ~4 characters per token is OpenAI's own documented rule of thumb for
// English text — deterministic, no tokenizer dependency, no API call.
const CHARS_PER_TOKEN = 4;
export const approximateTokenCount = (text) => Math.max(1, Math.ceil(String(text || '').length / CHARS_PER_TOKEN));

// Pages that are structurally not real document content — a CAPTCHA/
// blocked-access interstitial, a dead link, a truly empty scan. Rejected
// pages are recorded (see chunkDocument's `rejectedPages`), never
// silently dropped without a trace, and never allowed to produce a chunk.
const CHALLENGE_PAGE_PATTERNS = [
  /are you a robot/i, /captcha/i, /access denied/i, /enable javascript/i,
  /page not found/i, /404 error/i, /\bforbidden\b/i,
];

const isRejectablePage = (page, minPageTextLength) => {
  const text = String(page?.text || '').trim();
  if (text.length < minPageTextLength) return true;
  if (CHALLENGE_PAGE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return false;
};

/**
 * stripRepeatedHeaderFooter - removes a running header/footer banner
 * (e.g. "TCS Annual Report 2026 Page 3 of 45") that repeats, near-
 * verbatim, across a majority of pages. `extractPdfPages` has already
 * flattened each page to one line, so this works on PREFIX/SUFFIX
 * substrings rather than "lines". Digit runs are normalized to `#` before
 * comparing (so "Page 3" and "Page 47" are recognized as the same
 * template).
 *
 * The template's length is DISCOVERED, not assumed: it grows the
 * candidate prefix/suffix one character at a time for as long as a
 * majority of pages still agree on the (digit-normalized) substring, and
 * stops at the first length where they diverge — i.e. exactly where the
 * shared banner ends and page-specific content begins. This is what
 * safely handles a header shorter (or longer) than any single fixed
 * sample window would assume. Once the template length is found, the
 * ACTUAL per-page substring of that length (not the normalized template
 * itself) is stripped from that page's real text — never a blind
 * fixed-string cut, and digits are never rewritten in the kept text.
 *
 * Deliberately conservative: requires at least 4 pages, a template of at
 * least MIN_TEMPLATE_LEN characters, and agreement across ≥60% of pages
 * before touching anything — short of that, a real document's genuine
 * content is left completely untouched.
 */
const MIN_TEMPLATE_LEN = 12;
const MAX_TEMPLATE_LEN = 150;
const REPETITION_THRESHOLD = 0.6;
const normalizeForRepetition = (snippet) => snippet.replace(/\d+/g, '#');

/** Longest length L (up to maxLen) at which the SAME normalized L-length prefix/suffix is shared by at least `threshold` of `texts` — 0 if none qualifies even at length 1. */
const findAgreedAffixLength = (texts, threshold, fromEnd) => {
  const shortest = Math.min(...texts.map((t) => t.length));
  const maxLen = Math.min(MAX_TEMPLATE_LEN, shortest);
  let bestLen = 0;
  for (let len = 1; len <= maxLen; len += 1) {
    const counts = new Map();
    let winner = 0;
    for (const text of texts) {
      const snippet = normalizeForRepetition(fromEnd ? text.slice(text.length - len) : text.slice(0, len));
      const next = (counts.get(snippet) || 0) + 1;
      counts.set(snippet, next);
      if (next > winner) winner = next;
    }
    if (winner >= threshold) bestLen = len;
    else break; // content has diverged from here on — stop growing
  }
  return bestLen;
};

export const stripRepeatedHeaderFooter = (pages) => {
  if (pages.length < 4) return pages;
  const texts = pages.map((p) => p.text || '');
  const threshold = Math.ceil(pages.length * REPETITION_THRESHOLD);

  const headerLen = findAgreedAffixLength(texts, threshold, false);
  const footerLen = findAgreedAffixLength(texts, threshold, true);
  const stripHeader = headerLen >= MIN_TEMPLATE_LEN;
  const stripFooter = footerLen >= MIN_TEMPLATE_LEN;
  if (!stripHeader && !stripFooter) return pages;

  return pages.map((page) => {
    const text = page.text || '';
    const start = stripHeader ? headerLen : 0;
    const end = stripFooter ? text.length - footerLen : text.length;
    return { ...page, text: (end > start ? text.slice(start, end) : text).trim() };
  });
};

/**
 * splitPageIntoChunks - one page's text -> 1+ chunk strings, each ≤
 * maxTokensPerChunk (approximated by character count), consecutive chunks
 * overlapping by ~overlapTokens. Prefers to break at a sentence boundary
 * near the target length (keeps a numeric statement like "revenue grew
 * 12% to ₹50,000 crore." from being split mid-sentence when a natural
 * break point exists nearby) — falls back to a hard character cut only
 * when no sentence boundary is found in the back half of the window.
 */
const splitPageIntoChunks = (text, maxTokensPerChunk, overlapTokens) => {
  const maxChars = maxTokensPerChunk * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const searchFrom = start + Math.floor(maxChars * 0.5);
      const lastSentenceEnd = text.lastIndexOf('. ', end);
      if (lastSentenceEnd > searchFrom) end = lastSentenceEnd + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1); // always make forward progress
  }
  return chunks;
};

/**
 * chunkPages - the deterministic core. Returns chunk TEXT + page span +
 * position only (no hashes, no document identity) — chunkDocument below
 * adds those. Enforces the hard per-document page/chunk limits and
 * reports exactly how much of the source document those limits actually
 * covered (Phase 4A.1: a truncated document must never look
 * indistinguishable from a fully-covered one downstream).
 */
export const chunkPages = (pages, options = {}) => {
  const opts = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
  const pagesTotal = pages.length;
  const truncatedToPageLimit = pagesTotal > opts.maxPagesPerDocument;
  const boundedPages = pages.slice(0, opts.maxPagesPerDocument);

  const rejectedPages = [];
  const usablePages = [];
  for (const page of boundedPages) {
    if (isRejectablePage(page, opts.minPageTextLength)) { rejectedPages.push(page.pageNumber); continue; }
    usablePages.push(page);
  }

  const cleanedPages = stripRepeatedHeaderFooter(usablePages);

  const chunks = [];
  let truncatedToChunkLimit = false;
  // A page only counts as "processed" once every piece it was split into
  // made it into `chunks` — a page cut off midway by the chunk-count cap
  // is NOT counted, and we stop entirely at that point (everything after
  // it, including later legitimately-usable pages, is by definition also
  // not covered).
  let processedPages = 0;
  for (const page of cleanedPages) {
    if (chunks.length >= opts.maxChunksPerDocument) { truncatedToChunkLimit = true; break; }
    const pieces = splitPageIntoChunks(page.text, opts.maxTokensPerChunk, opts.overlapTokens);
    let piecesAdded = 0;
    for (const text of pieces) {
      if (chunks.length >= opts.maxChunksPerDocument) { truncatedToChunkLimit = true; break; }
      chunks.push({
        pageStart: page.pageNumber, pageEnd: page.pageNumber, chunkIndex: chunks.length,
        text, approximateTokenCount: approximateTokenCount(text),
      });
      piecesAdded += 1;
    }
    if (piecesAdded === pieces.length) { processedPages += 1; } else { break; }
  }

  const truncated = truncatedToPageLimit || truncatedToChunkLimit;
  let truncationReason = null;
  if (truncatedToPageLimit && truncatedToChunkLimit) truncationReason = 'PAGE_AND_CHUNK_LIMIT';
  else if (truncatedToPageLimit) truncationReason = 'PAGE_LIMIT';
  else if (truncatedToChunkLimit) truncationReason = 'CHUNK_LIMIT';

  // What fraction of the PHYSICAL document (every page pdf-parse reported,
  // before any rejection or truncation) is actually represented in
  // `chunks` — the honest "how much of this filing did we really index"
  // number, deliberately including legitimately-rejected pages (a blank
  // or challenge page IS a real gap in coverage, even if excluding it was
  // the correct call).
  const extractionCoveragePct = pagesTotal > 0 ? Math.round((processedPages / pagesTotal) * 1000) / 10 : 100;

  return {
    chunks, rejectedPages,
    pagesTotal, pagesConsidered: usablePages.length, processedPages,
    totalChunks: chunks.length,
    truncatedToPageLimit, truncatedToChunkLimit, truncated, truncationReason, extractionCoveragePct,
  };
};

/**
 * Chunk identity — Phase 4A.1 hardening.
 * =========================================
 * TRUE STRUCTURAL IDENTITY is the compound tuple (documentHash, pageStart,
 * chunkIndex) — see ResearchDocumentChunk's `unique_chunk_identity` index,
 * which is what actually enforces uniqueness at the database layer, not
 * this hash. A document's content hash already anchors every chunk to
 * exactly one company + one filing + one fiscal period (documentHash is
 * CompanyDocumentRegistry.pdfHash, a sha256 of that specific PDF's bytes),
 * pageStart anchors it to one physical page, and chunkIndex anchors it to
 * one position within that page's own split sequence — so identical TEXT
 * appearing in two different documents, or on two different pages of the
 * SAME document, always yields two independently addressable, independently
 * citable rows: their (documentHash, pageStart, chunkIndex) tuples differ
 * even when their text is byte-for-byte identical.
 *
 * `chunkHash` remains as a derived, deterministic content fingerprint
 * (stored on every row, still useful for detecting "this chunk's content
 * silently changed") — Phase 4A.1's indexing CLI now upserts on the
 * COMPOUND structural key (documentHash, pageStart, chunkIndex) directly
 * rather than on chunkHash, since keying on a content-sensitive hash would
 * fight a position-based unique index: if a re-chunk changes a page's
 * text, its chunkHash changes too, and an upsert keyed on the OLD
 * chunkHash would try to INSERT a new row at a (document, page, index)
 * position that already exists, violating uniqueness — keying on the
 * structural position instead means a changed chunk correctly UPDATES
 * the existing row at that position instead of orphaning it.
 * `chunkHash` itself is now built from a NORMALIZED text hash rather than
 * raw text — this makes it robust to non-semantic extraction jitter (e.g. a
 * pdf-parse version bump that changes internal whitespace but not the
 * actual words) without weakening provenance, since documentHash+
 * pageStart+chunkIndex are still baked into it directly.
 *
 * Old formula (Phase 4A):   sha256(`${documentHash}:${pageStart}-${pageEnd}:${chunkIndex}:${text}`)
 * New formula (Phase 4A.1): sha256(`${documentHash}:${pageStart}-${pageEnd}:${chunkIndex}:${normalizedTextHash}`)
 *   where normalizedTextHash = sha256(lowercased, whitespace-collapsed, trimmed text)
 */
const normalizeTextForHash = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

export const computeNormalizedTextHash = (text) => crypto
  .createHash('sha256')
  .update(normalizeTextForHash(text))
  .digest('hex');

export const computeChunkHash = ({ documentHash, pageStart, pageEnd, chunkIndex, text }) => {
  const normalizedTextHash = computeNormalizedTextHash(text);
  return crypto
    .createHash('sha256')
    .update(`${documentHash}:${pageStart}-${pageEnd}:${chunkIndex}:${normalizedTextHash}`)
    .digest('hex');
};

/**
 * chunkDocument - chunkPages + chunk identity, the actual entry point the
 * indexing CLI uses. `documentHash` must be the SOURCE document's real
 * content hash (CompanyDocumentRegistry.pdfHash) — every identity this
 * produces is anchored to it, which is exactly what makes a changed PDF
 * produce an entirely new documentHash and therefore an entirely
 * disjoint set of chunk identities (see the compound unique index note
 * above) — never mixed with a prior version's rows.
 */
export const chunkDocument = (pages, { documentHash, documentType, ...options } = {}) => {
  if (!documentHash) throw new Error('chunkDocument requires a documentHash to anchor chunk identity');
  const resolvedOptions = documentType ? resolveChunkingOptions(documentType, options) : options;
  const result = chunkPages(pages, resolvedOptions);
  const chunks = result.chunks.map((chunk) => ({
    ...chunk,
    normalizedTextHash: computeNormalizedTextHash(chunk.text),
    chunkHash: computeChunkHash({ documentHash, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, chunkIndex: chunk.chunkIndex, text: chunk.text }),
  }));
  return { ...result, chunks };
};

export default {
  CHUNKING_VERSION, DEFAULT_CHUNKING_OPTIONS, DOCUMENT_TYPE_CHUNKING_LIMITS, resolveChunkingOptions, approximateTokenCount,
  stripRepeatedHeaderFooter, chunkPages, computeChunkHash, computeNormalizedTextHash, chunkDocument,
};
