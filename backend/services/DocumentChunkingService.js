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

export const CHUNKING_VERSION = '1';

export const DEFAULT_CHUNKING_OPTIONS = Object.freeze({
  maxTokensPerChunk: 400,
  overlapTokens: 40,
  maxPagesPerDocument: 60,
  maxChunksPerDocument: 300,
  minPageTextLength: 40,
});

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
 * adds those. Enforces the hard per-document page/chunk limits.
 */
export const chunkPages = (pages, options = {}) => {
  const opts = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
  const pagesTotal = pages.length;
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
  for (const page of cleanedPages) {
    if (chunks.length >= opts.maxChunksPerDocument) { truncatedToChunkLimit = true; break; }
    const pieces = splitPageIntoChunks(page.text, opts.maxTokensPerChunk, opts.overlapTokens);
    for (const text of pieces) {
      if (chunks.length >= opts.maxChunksPerDocument) { truncatedToChunkLimit = true; break; }
      chunks.push({
        pageStart: page.pageNumber, pageEnd: page.pageNumber, chunkIndex: chunks.length,
        text, approximateTokenCount: approximateTokenCount(text),
      });
    }
  }

  return {
    chunks, rejectedPages,
    pagesTotal, pagesConsidered: usablePages.length,
    truncatedToPageLimit: pagesTotal > opts.maxPagesPerDocument,
    truncatedToChunkLimit,
  };
};

/** Deterministic chunk identity — see the model/module note on idempotent re-indexing. */
export const computeChunkHash = ({ documentHash, pageStart, pageEnd, chunkIndex, text }) => crypto
  .createHash('sha256')
  .update(`${documentHash}:${pageStart}-${pageEnd}:${chunkIndex}:${text}`)
  .digest('hex');

/**
 * chunkDocument - chunkPages + chunkHash, the actual entry point the
 * indexing CLI uses. `documentHash` must be the SOURCE document's real
 * content hash (CompanyDocumentRegistry.pdfHash) — every hash this
 * produces is anchored to it, which is exactly what makes a changed PDF
 * produce entirely new chunk identities.
 */
export const chunkDocument = (pages, { documentHash, ...options } = {}) => {
  if (!documentHash) throw new Error('chunkDocument requires a documentHash to anchor chunk identity');
  const result = chunkPages(pages, options);
  const chunks = result.chunks.map((chunk) => ({
    ...chunk,
    chunkHash: computeChunkHash({ documentHash, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, chunkIndex: chunk.chunkIndex, text: chunk.text }),
  }));
  return { ...result, chunks };
};

export default {
  CHUNKING_VERSION, DEFAULT_CHUNKING_OPTIONS, approximateTokenCount,
  stripRepeatedHeaderFooter, chunkPages, computeChunkHash, chunkDocument,
};
