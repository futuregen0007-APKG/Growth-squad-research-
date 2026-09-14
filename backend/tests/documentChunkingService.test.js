import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkPages, chunkDocument, computeChunkHash, computeNormalizedTextHash, stripRepeatedHeaderFooter, approximateTokenCount,
  resolveChunkingOptions, DOCUMENT_TYPE_CHUNKING_LIMITS,
} from '../services/DocumentChunkingService.js';

const page = (pageNumber, text) => ({ pageNumber, text });

test('deterministic chunking: the same pages + options always produce identical chunk boundaries and hashes', () => {
  const pages = [page(1, 'A'.repeat(2000)), page(2, 'B'.repeat(500))];
  const a = chunkDocument(pages, { documentHash: 'hash-1' });
  const b = chunkDocument(pages, { documentHash: 'hash-1' });
  assert.deepEqual(a.chunks.map((c) => c.chunkHash), b.chunks.map((c) => c.chunkHash));
  assert.deepEqual(a.chunks.map((c) => c.text), b.chunks.map((c) => c.text));
});

test('page preservation: every chunk records the real page number it came from, never spanning two pages', () => {
  const pages = [page(1, 'Revenue grew 12% this quarter. '.repeat(5)), page(2, 'Margins held steady at 25%. '.repeat(5))];
  const { chunks } = chunkDocument(pages, { documentHash: 'h', maxTokensPerChunk: 400 });
  assert.ok(chunks.every((c) => c.pageStart === c.pageEnd), 'a chunk never spans more than one source page');
  assert.deepEqual(new Set(chunks.map((c) => c.pageStart)), new Set([1, 2]));
});

test('a page whose text exceeds one chunk\'s budget is split into multiple overlapping chunks, still on the same page', () => {
  const longText = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} states a fact.`).join(' ');
  const { chunks } = chunkDocument([page(1, longText)], { documentHash: 'h', maxTokensPerChunk: 50, overlapTokens: 10 });
  assert.ok(chunks.length > 1, 'a long page must split into multiple chunks');
  assert.ok(chunks.every((c) => c.pageStart === 1 && c.pageEnd === 1));
  // Overlap: the tail of chunk N should reappear at the head of chunk N+1.
  const overlapText = chunks[0].text.slice(-20);
  assert.ok(chunks[1].text.includes(overlapText.split(' ').slice(-2).join(' ')), 'consecutive chunks should overlap, not cut cleanly');
});

test('required test: chunk deduplication -- re-indexing an unchanged document produces the exact same chunkHash set', () => {
  const pages = [page(1, 'Some real extracted page text about TCS financial performance.')];
  const first = chunkDocument(pages, { documentHash: 'doc-hash-abc' });
  const second = chunkDocument(pages, { documentHash: 'doc-hash-abc' });
  assert.deepEqual(first.chunks.map((c) => c.chunkHash), second.chunks.map((c) => c.chunkHash));
});

test('required test: changed-document versioning -- a different documentHash (the PDF changed) produces entirely different chunkHash values for identical text', () => {
  const pages = [page(1, 'Identical page text repeated here for length requirements in this test case.')];
  const v1 = chunkDocument(pages, { documentHash: 'hash-v1' });
  const v2 = chunkDocument(pages, { documentHash: 'hash-v2' });
  assert.ok(v1.chunks.length > 0 && v2.chunks.length > 0, 'sanity: both versions must actually produce chunks');
  assert.notDeepEqual(v1.chunks.map((c) => c.chunkHash), v2.chunks.map((c) => c.chunkHash));
});

// ---------------------------------------------------------------------------
// Phase 4A.1 hardening: chunk identity/provenance
// ---------------------------------------------------------------------------

test('required (Phase 4A.1): identical text in two DIFFERENT documents remains two independently citable identities', () => {
  const pages = [page(1, 'The exact same paragraph appears verbatim in two unrelated filings for this test.')];
  const docA = chunkDocument(pages, { documentHash: 'doc-A-hash' });
  const docB = chunkDocument(pages, { documentHash: 'doc-B-hash' });
  assert.notEqual(docA.chunks[0].chunkHash, docB.chunks[0].chunkHash, 'two different documents must never share a chunk identity, even with byte-identical text');
  // Same normalizedTextHash (content is genuinely identical) but the
  // compound identity (documentHash, pageStart, chunkIndex) still differs.
  assert.equal(docA.chunks[0].normalizedTextHash, docB.chunks[0].normalizedTextHash);
});

test('required (Phase 4A.1): identical text on two DIFFERENT PAGES of the SAME document preserves both page references as independent identities', () => {
  const sameText = 'A boilerplate risk-factors paragraph that happens to repeat verbatim on two pages.';
  const pages = [page(3, sameText), page(47, sameText)];
  const { chunks } = chunkDocument(pages, { documentHash: 'doc-hash-shared' });
  assert.equal(chunks.length, 2);
  assert.notEqual(chunks[0].chunkHash, chunks[1].chunkHash, 'same document, same text, different page -- must still be a distinct identity');
  assert.deepEqual(new Set(chunks.map((c) => c.pageStart)), new Set([3, 47]), 'both original page numbers must survive');
});

test('required (Phase 4A.1): computeNormalizedTextHash is whitespace/case-insensitive, so chunkHash is robust to non-semantic extraction jitter', () => {
  const a = computeNormalizedTextHash('Revenue   grew 12%   this quarter.');
  const b = computeNormalizedTextHash('revenue grew 12% this quarter.');
  assert.equal(a, b, 'differing only in whitespace runs/case must normalize to the same hash');
  const differentContent = computeNormalizedTextHash('Revenue grew 13% this quarter.');
  assert.notEqual(a, differentContent);
});

test('required (Phase 4A.1): re-indexing an unchanged document is still idempotent under the new identity formula', () => {
  const pages = [page(1, 'Some real extracted page text about company financial performance for identity testing.')];
  const first = chunkDocument(pages, { documentHash: 'doc-hash-idempotent' });
  const second = chunkDocument(pages, { documentHash: 'doc-hash-idempotent' });
  assert.deepEqual(first.chunks.map((c) => c.chunkHash), second.chunks.map((c) => c.chunkHash));
  assert.deepEqual(first.chunks.map((c) => c.normalizedTextHash), second.chunks.map((c) => c.normalizedTextHash));
});

// ---------------------------------------------------------------------------
// Phase 4A.1 hardening: document-type-aware limits + explicit truncation metadata
// ---------------------------------------------------------------------------

test('resolveChunkingOptions applies document-type-aware limits, with explicit caller overrides always winning', () => {
  const annualReport = resolveChunkingOptions('ANNUAL_REPORT');
  assert.equal(annualReport.maxPagesPerDocument, DOCUMENT_TYPE_CHUNKING_LIMITS.ANNUAL_REPORT.maxPagesPerDocument);
  assert.ok(annualReport.maxPagesPerDocument > DOCUMENT_TYPE_CHUNKING_LIMITS.PRESS_RELEASE.maxPagesPerDocument, 'an annual report must get a materially larger page budget than a press release');
  const overridden = resolveChunkingOptions('ANNUAL_REPORT', { maxPagesPerDocument: 3 });
  assert.equal(overridden.maxPagesPerDocument, 3, 'an explicit caller override always wins over the type default');
});

test('required (Phase 4A.1): a truncated document reports truncated=true, a real truncationReason, and extractionCoveragePct < 100', () => {
  const manyPages = Array.from({ length: 10 }, (_, i) => page(i + 1, `Real page content number ${i}, containing actual annual report text.`));
  const result = chunkDocument(manyPages, { documentHash: 'h-trunc', maxPagesPerDocument: 4 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'PAGE_LIMIT');
  assert.equal(result.pagesTotal, 10);
  assert.equal(result.processedPages, 4);
  assert.ok(result.extractionCoveragePct < 100 && result.extractionCoveragePct > 0);
});

test('required (Phase 4A.1): a chunk-limit truncation is reported distinctly from a page-limit truncation', () => {
  const manyPages = Array.from({ length: 20 }, (_, i) => page(i + 1, `Real page content number ${i}, containing text about the business and operations.`));
  const result = chunkDocument(manyPages, { documentHash: 'h-trunc-chunks', maxChunksPerDocument: 5, maxPagesPerDocument: 60 });
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'CHUNK_LIMIT');
  assert.ok(result.processedPages < result.pagesTotal, 'late pages beyond the chunk cap must not count as processed');
});

test('required (Phase 4A.1): a fully-covered document (no truncation) reports truncated=false and 100% coverage', () => {
  const pages = [page(1, 'Short real content about the fiscal year results and operating performance.')];
  const result = chunkDocument(pages, { documentHash: 'h-full' });
  assert.equal(result.truncated, false);
  assert.equal(result.truncationReason, null);
  assert.equal(result.extractionCoveragePct, 100);
});

test('required (Phase 4A.1): late-page evidence is either indexed, or clearly reported as outside coverage -- never silently absent', () => {
  const pages = Array.from({ length: 8 }, (_, i) => page(i + 1, `Filler content for page ${i + 1} of this test document about operations.`));
  pages.push(page(9, 'The critical late-page guidance figure investors are looking for appears only here.'));
  const truncatedResult = chunkDocument(pages, { documentHash: 'h-late-trunc', maxPagesPerDocument: 8 });
  const truncatedText = truncatedResult.chunks.map((c) => c.text).join(' ');
  assert.ok(!truncatedText.includes('critical late-page guidance'), 'sanity: the truncated run really did drop page 9');
  assert.equal(truncatedResult.truncated, true, 'a document missing real evidence due to a page cap must be flagged truncated, never silently reported as complete');

  const fullResult = chunkDocument(pages, { documentHash: 'h-late-full', maxPagesPerDocument: 20 });
  const fullText = fullResult.chunks.map((c) => c.text).join(' ');
  assert.ok(fullText.includes('critical late-page guidance'), 'with a sufficient page cap, the same late-page evidence is genuinely indexed');
  assert.equal(fullResult.truncated, false);
});

test('computeChunkHash is a pure function of its inputs -- changing any one field changes the hash', () => {
  const base = { documentHash: 'h', pageStart: 1, pageEnd: 1, chunkIndex: 0, text: 'hello' };
  const h0 = computeChunkHash(base);
  assert.notEqual(computeChunkHash({ ...base, text: 'hello!' }), h0);
  assert.notEqual(computeChunkHash({ ...base, pageStart: 2, pageEnd: 2 }), h0);
  assert.notEqual(computeChunkHash({ ...base, chunkIndex: 1 }), h0);
});

test('reject empty/corrupted/challenge pages -- they never produce a chunk, and are recorded, not silently dropped', () => {
  const pages = [page(1, 'Real substantial page content about company financial results and operations.'), page(2, ''), page(3, 'Please enable JavaScript and reload the page to continue - Access Denied Captcha')];
  const { chunks, rejectedPages } = chunkDocument(pages, { documentHash: 'h' });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pageStart, 1);
  assert.deepEqual(rejectedPages, [2, 3]);
});

test('a hard page limit truncates a document, reported explicitly via truncatedToPageLimit', () => {
  const manyPages = Array.from({ length: 10 }, (_, i) => page(i + 1, `Real page content number ${i}, containing actual text.`));
  const { pagesConsidered, truncatedToPageLimit } = chunkPages(manyPages, { maxPagesPerDocument: 5 });
  assert.equal(pagesConsidered, 5);
  assert.equal(truncatedToPageLimit, true);
});

test('a hard chunk limit stops chunking, reported explicitly via truncatedToChunkLimit', () => {
  const manyPages = Array.from({ length: 20 }, (_, i) => page(i + 1, `Real page content number ${i}, containing actual text about the business.`));
  const { chunks, truncatedToChunkLimit } = chunkPages(manyPages, { maxChunksPerDocument: 5 });
  assert.equal(chunks.length, 5);
  assert.equal(truncatedToChunkLimit, true);
});

test('stripRepeatedHeaderFooter removes a running header/footer template repeated across a majority of pages', () => {
  const uniqueSentences = [
    'Board approved a new capital expenditure plan for the data center expansion project this year.',
    'Attrition rates declined for the third consecutive quarter across all major delivery verticals.',
    'Company signed a large multi-year deal with a European banking client worth several hundred million.',
    'Operating cash flow improved significantly due to better working capital management practices.',
    'Employee headcount grew modestly as hiring resumed in select high-demand technology practice areas.',
    'Subsidiary in Latin America reported its first profitable quarter since the acquisition closed.',
  ];
  const pages = uniqueSentences.map((sentence, i) => page(
    i + 1,
    `TCS Annual Report Fiscal Year 2026 Page ${i + 1} of 6 . ${sentence} Confidential Internal Use Only Document Footer ${i + 1}`,
  ));
  const cleaned = stripRepeatedHeaderFooter(pages);
  assert.ok(cleaned.every((p) => !/TCS Annual Report Fiscal Year 2026/.test(p.text)), 'the repeated header must be stripped from every page');
  assert.ok(cleaned.every((p) => !/Confidential Internal Use Only Document Footer/.test(p.text)), 'the repeated footer must be stripped from every page');
  uniqueSentences.forEach((sentence, i) => {
    // Check the sentence's distinctive core wording survives (not
    // necessarily its exact trailing punctuation, which sits right at the
    // real content/footer boundary).
    const distinctiveWords = sentence.split(' ').slice(0, 6).join(' ');
    assert.ok(cleaned[i].text.includes(distinctiveWords), `real page-specific content must survive on page ${i + 1}: got "${cleaned[i].text}"`);
  });
});

test('stripRepeatedHeaderFooter never touches a short document (fewer than 4 pages) or content with no real repetition', () => {
  const pages = [page(1, 'Unique content one'), page(2, 'Unique content two'), page(3, 'Unique content three')];
  assert.deepEqual(stripRepeatedHeaderFooter(pages), pages);
});

test('approximateTokenCount is deterministic and roughly tracks text length', () => {
  assert.equal(approximateTokenCount('a'.repeat(400)), 100);
  assert.equal(approximateTokenCount(''), 1);
});

test('chunkDocument throws a clear error when documentHash is missing -- chunk identity can never be anchored to nothing', () => {
  assert.throws(() => chunkDocument([page(1, 'text')], {}), /documentHash/);
});
