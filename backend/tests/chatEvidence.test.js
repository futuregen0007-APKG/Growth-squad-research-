import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceRecord, evidenceForPrompt, CLAIM_TYPES } from '../graph/evidence.js';
import { extractCitations } from '../graph/nodes/composeAnswer.js';

test('buildEvidenceRecord returns null for an unknown/missing claimType instead of a partial fake record', () => {
  assert.equal(buildEvidenceRecord({ symbol: 'TCS' }), null);
  assert.equal(buildEvidenceRecord({ claimType: 'NOT_A_REAL_TYPE', symbol: 'TCS' }), null);
});

test('buildEvidenceRecord drops an unusable sourceUrl rather than keeping a fake link', () => {
  const record = buildEvidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'javascript:alert(1)' });
  assert.equal(record.sourceUrl, null);
});

// UI Phase 1D fix: a confirmed live bug, found via real browser
// verification. services/storedFundamentals.js's fallback evidence passes
// a raw Mongoose Date object (read via .lean(), never stringified) as
// publishedAt. graph/schemas.js's SourceEntrySchema/EvidenceDrawerEntrySchema
// both require publishedAt to be a STRING -- a Date object failed that
// check SILENTLY (Zod's safeParse never throws), which dropped BOTH
// source_list and evidence_drawer entirely for any real turn using that
// fallback path (confirmed live: a real "Tell me about TCS financials"
// turn had 7 real citations but responseBlocks never included source_list
// or evidence_drawer at all), making every citation marker a plain,
// inert <sup> instead of a clickable evidence-drawer trigger.
test('buildEvidenceRecord normalizes a raw Date publishedAt into its ISO string, never leaving a Date object on the record', () => {
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', publishedAt: new Date('2026-05-01T00:00:00.000Z') });
  assert.equal(record.publishedAt, '2026-05-01T00:00:00.000Z');
  assert.equal(typeof record.publishedAt, 'string');
});

test('buildEvidenceRecord leaves an already-correct string publishedAt untouched', () => {
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', publishedAt: '2026-05-01' });
  assert.equal(record.publishedAt, '2026-05-01');
});

test('buildEvidenceRecord treats an invalid Date as honestly absent, never a guessed/garbage string', () => {
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', publishedAt: new Date('not-a-real-date') });
  assert.equal(record.publishedAt, null);
});

test('buildEvidenceRecord end-to-end: a Date-typed publishedAt no longer breaks source_list/evidence_drawer schema validation', async () => {
  const { SourceListBlockSchema, EvidenceDrawerBlockSchema } = await import('../graph/schemas.js');
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS Revenue', publishedAt: new Date('2026-05-01T00:00:00.000Z') });
  const source = { evidenceId: record.evidenceId, citationIndex: 1, title: record.title, sourceUrl: null, provider: null, publishedAt: record.publishedAt, reportingPeriod: null };
  assert.equal(SourceListBlockSchema.safeParse({ type: 'source_list', sources: [source] }).success, true);
  const entry = { ...source, excerpt: null, documentType: null, pageStart: null, pageEnd: null, temporalStatus: null, canonicalGuidance: null };
  assert.equal(EvidenceDrawerBlockSchema.safeParse({ type: 'evidence_drawer', entries: [entry] }).success, true);
});

test('buildEvidenceRecord preserves a real https sourceUrl and stamps retrievedAt', () => {
  const record = buildEvidenceRecord({ claimType: 'COMPANY_NEWS', symbol: 'TCS', sourceUrl: 'https://example.com/a' });
  assert.equal(record.sourceUrl, 'https://example.com/a');
  assert.ok(record.retrievedAt);
  assert.ok(CLAIM_TYPES.includes(record.claimType));
});

test('evidenceForPrompt truncates a long excerpt and never leaks raw provider fields', () => {
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', excerpt: 'x'.repeat(1000) });
  const [prompt] = evidenceForPrompt([record]);
  assert.equal(prompt.excerpt.length, 500);
  assert.equal(prompt.raw, undefined);
});

test('extractCitations maps only [N] markers that are within range, sorted and deduplicated', () => {
  const evidence = [{ evidenceId: 'a' }, { evidenceId: 'b' }, { evidenceId: 'c' }];
  const answer = 'Revenue grew [2]. Margin held steady [2][1]. Unrelated [99].';
  const citations = extractCitations(answer, evidence);
  assert.deepEqual(citations.map((c) => c.evidenceId), ['a', 'b']);
});

test('extractCitations returns an empty array when the answer cites nothing', () => {
  assert.deepEqual(extractCitations('No citations here.', [{ evidenceId: 'a' }]), []);
});

test('extractCitations never fabricates a citation for an out-of-range marker', () => {
  const citations = extractCitations('See [5].', [{ evidenceId: 'a' }]);
  assert.deepEqual(citations, []);
});

// UI Phase 1D audit fix: extractCitations used to return the raw evidence
// object reference directly -- every field buildEvidenceRecord happened to
// set, including internal bookkeeping and (since UI Phase 1C.3) a whole
// chart point series, leaking into the client-facing/persisted citations
// array. It now projects through an explicit whitelist.
test('extractCitations never leaks internal-only or block-owned evidence fields onto a citation (retrievedAt, evidenceQuality, chartSeries, requestedRangeDays)', () => {
  const record = buildEvidenceRecord({
    claimType: 'MARKET_HISTORY', symbol: 'TCS', title: 'TCS share-price history (NSE)',
    excerpt: 'PRICE_HISTORY: 2 points, INR, NSE_BHAVCOPY, NOT_REQUIRED (2026-08-01 to 2026-08-02)',
    evidenceQuality: 'VERIFIED_MARKET_HISTORY',
    chartSeries: [{ date: '2026-08-01', close: 100 }, { date: '2026-08-02', close: 101 }],
    requestedRangeDays: 90,
  });
  const [citation] = extractCitations('Here is the chart [1].', [record]);
  assert.equal(citation.evidenceId, record.evidenceId);
  assert.equal(citation.excerpt, record.excerpt);
  assert.equal(citation.retrievedAt, undefined, 'internal bookkeeping timestamp must not reach a citation');
  assert.equal(citation.evidenceQuality, undefined, 'internal classification tag must not reach a citation');
  assert.equal(citation.chartSeries, undefined, 'the point series belongs on the chart responseBlock, never duplicated onto every citation');
  assert.equal(citation.requestedRangeDays, undefined, 'chart-specific metadata must not reach a generic citation');
  assert.equal(citation.imageUrl, undefined, 'imageUrl belongs on the news_list block (sourced from evidence directly), never on the citation object');
});

test('extractCitations normalizes a legacy pageNumber into pageStart/pageEnd -- one page-range shape, not two', () => {
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS', pageNumber: 3 });
  const [citation] = extractCitations('See page 3 [1].', [record]);
  assert.equal(citation.pageStart, 3);
  assert.equal(citation.pageEnd, 3);
  assert.equal(citation.pageNumber, undefined);
});

test('extractCitations gives a null page range when no page number was ever set -- never invented', () => {
  const record = buildEvidenceRecord({ claimType: 'FINANCIAL_DATA', symbol: 'TCS' });
  const [citation] = extractCitations('x [1].', [record]);
  assert.equal(citation.pageStart, null);
  assert.equal(citation.pageEnd, null);
});

test('extractCitations preserves every field the citation schema actually supports', () => {
  const record = buildEvidenceRecord({
    claimType: 'FINANCIAL_DATA', symbol: 'TCS', title: 'TCS Revenue', sourceUrl: 'https://nsearchives.nseindia.com/x.xml',
    provider: 'stored-verified-filings', publishedAt: '2026-05-01', reportingPeriod: 'FY2024', excerpt: 'REVENUE: 1 INR_CRORE (FY2024)',
  });
  const [citation] = extractCitations('x [1].', [record]);
  assert.equal(citation.claimType, 'FINANCIAL_DATA');
  assert.equal(citation.symbol, 'TCS');
  assert.equal(citation.title, 'TCS Revenue');
  assert.equal(citation.sourceUrl, 'https://nsearchives.nseindia.com/x.xml');
  assert.equal(citation.provider, 'stored-verified-filings');
  assert.equal(citation.publishedAt, '2026-05-01');
  assert.equal(citation.reportingPeriod, 'FY2024');
  assert.equal(citation.excerpt, 'REVENUE: 1 INR_CRORE (FY2024)');
});
