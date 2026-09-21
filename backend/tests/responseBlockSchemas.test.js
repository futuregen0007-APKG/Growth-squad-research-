import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ResponseBlockSchema, ResponseBlocksSchema, MetricGridBlockSchema, ComparisonTableBlockSchema,
  SourceListBlockSchema, DataQualityBlockSchema, SuggestedQuestionsBlockSchema, EvidenceRefSchema,
  isSafeBlockUrl, MAX_RESPONSE_BLOCKS, CompanyHeaderBlockSchema, EvidenceDrawerBlockSchema, CanonicalGuidanceSchema,
  NewsListBlockSchema, ChartBlockSchema, MAX_CHART_POINTS,
} from '../graph/schemas.js';

/**
 * responseBlockSchemas.test.js
 * ===============================
 * UI Phase 1B. These pin the CONTRACT — limits, rejection of unknown
 * types, rejection of unsafe URLs — independent of any builder. A builder
 * bug that produced an out-of-contract block should be caught here even
 * if services/responseBlocks.js's own tests (which stub a state and
 * exercise the real builders) somehow missed it.
 */

const ref = (evidenceId = 'e1', citationIndex = 1) => ({ evidenceId, citationIndex });

test('an unrecognized block type is rejected by the discriminated union', () => {
  const result = ResponseBlockSchema.safeParse({ type: 'candlestick', symbol: 'TCS' });
  assert.equal(result.success, false);
});

test('a block missing the type discriminant entirely is rejected', () => {
  assert.equal(ResponseBlockSchema.safeParse({ symbol: 'TCS', metrics: [] }).success, false);
});

test('an unexpected extra key on an otherwise-valid block is rejected (.strict())', () => {
  const result = MetricGridBlockSchema.safeParse({
    type: 'metric_grid', symbol: 'TCS', unexpectedField: 'should not be here',
    metrics: [{ metric: 'REVENUE', label: 'Revenue', value: 1, unit: null, period: null, evidence: [ref()] }],
  });
  assert.equal(result.success, false);
});

test('metric_grid requires at least one metric, and every metric requires at least one evidence ref', () => {
  assert.equal(MetricGridBlockSchema.safeParse({ type: 'metric_grid', symbol: 'TCS', metrics: [] }).success, false, 'empty metrics array rejected');
  const noEvidence = MetricGridBlockSchema.safeParse({
    type: 'metric_grid', symbol: 'TCS',
    metrics: [{ metric: 'REVENUE', label: 'Revenue', value: 1, unit: null, period: null, evidence: [] }],
  });
  assert.equal(noEvidence.success, false, 'a metric with zero evidence refs is never valid -- this is the enforcement point');
});

test('metric_grid.metrics is capped at 20 entries', () => {
  const metrics = Array.from({ length: 21 }, (_, i) => ({
    metric: `M${i}`, label: `Metric ${i}`, value: i, unit: null, period: null, evidence: [ref(`e${i}`, i + 1)],
  }));
  assert.equal(MetricGridBlockSchema.safeParse({ type: 'metric_grid', symbol: 'TCS', metrics }).success, false);
  assert.equal(MetricGridBlockSchema.safeParse({ type: 'metric_grid', symbol: 'TCS', metrics: metrics.slice(0, 20) }).success, true);
});

test('comparison_table requires at least 2 symbols and is capped at 6', () => {
  const row = { metric: 'REVENUE', label: 'Revenue', values: { TCS: { value: 1, unit: null, evidence: [ref()] } }, commonPeriod: null, comparable: false };
  assert.equal(ComparisonTableBlockSchema.safeParse({ type: 'comparison_table', symbols: ['TCS'], rows: [row] }).success, false, 'a single symbol is not a comparison');
  const sevenSymbols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  assert.equal(ComparisonTableBlockSchema.safeParse({ type: 'comparison_table', symbols: sevenSymbols, rows: [row] }).success, false, 'over the 6-symbol cap');
  assert.equal(ComparisonTableBlockSchema.safeParse({ type: 'comparison_table', symbols: ['TCS', 'INFY'], rows: [row] }).success, true);
});

test('comparison_table rows are capped at 20', () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    metric: `M${i}`, label: `Metric ${i}`, values: { TCS: { value: i, unit: null, evidence: [ref(`e${i}`, i + 1)] } }, commonPeriod: null, comparable: false,
  }));
  assert.equal(ComparisonTableBlockSchema.safeParse({ type: 'comparison_table', symbols: ['TCS', 'INFY'], rows }).success, false);
  assert.equal(ComparisonTableBlockSchema.safeParse({ type: 'comparison_table', symbols: ['TCS', 'INFY'], rows: rows.slice(0, 20) }).success, true);
});

test('isSafeBlockUrl accepts only http(s), matching graph/evidence.js and the frontend isSafeHref rule', () => {
  assert.equal(isSafeBlockUrl('https://nseindia.com/x'), true);
  assert.equal(isSafeBlockUrl('http://example.com'), true);
  assert.equal(isSafeBlockUrl('javascript:alert(1)'), false);
  assert.equal(isSafeBlockUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeBlockUrl('ftp://example.com/file'), false);
  assert.equal(isSafeBlockUrl(''), false);
  assert.equal(isSafeBlockUrl(null), false);
});

test('source_list rejects an unsafe sourceUrl outright (the schema itself refuses it, independent of any builder-side sanitization)', () => {
  const result = SourceListBlockSchema.safeParse({
    type: 'source_list',
    sources: [{ evidenceId: 'e1', citationIndex: 1, title: 'x', sourceUrl: 'javascript:alert(1)', provider: null, publishedAt: null, reportingPeriod: null }],
  });
  assert.equal(result.success, false);
});

test('source_list accepts a null sourceUrl (absence is honest; a bad scheme is not)', () => {
  const result = SourceListBlockSchema.safeParse({
    type: 'source_list',
    sources: [{ evidenceId: 'e1', citationIndex: 1, title: 'x', sourceUrl: null, provider: null, publishedAt: null, reportingPeriod: null }],
  });
  assert.equal(result.success, true);
});

test('source_list is capped at 20 sources', () => {
  const sources = Array.from({ length: 21 }, (_, i) => ({
    evidenceId: `e${i}`, citationIndex: i + 1, title: null, sourceUrl: null, provider: null, publishedAt: null, reportingPeriod: null,
  }));
  assert.equal(SourceListBlockSchema.safeParse({ type: 'source_list', sources }).success, false);
  assert.equal(SourceListBlockSchema.safeParse({ type: 'source_list', sources: sources.slice(0, 20) }).success, true);
});

test('data_quality accepts an all-empty-but-present shape (the OMISSION decision belongs to the builder, not the schema)', () => {
  const result = DataQualityBlockSchema.safeParse({
    type: 'data_quality', groundingStatus: null, unmatchedRequestedPeriods: [], valuationGaps: [], limitations: [],
  });
  assert.equal(result.success, true);
});

test('data_quality.groundingStatus only accepts the three real server-computed values', () => {
  assert.equal(DataQualityBlockSchema.safeParse({
    type: 'data_quality', groundingStatus: 'grounded', unmatchedRequestedPeriods: [], valuationGaps: [], limitations: [],
  }).success, true);
  assert.equal(DataQualityBlockSchema.safeParse({
    type: 'data_quality', groundingStatus: 'made_up_status', unmatchedRequestedPeriods: [], valuationGaps: [], limitations: [],
  }).success, false);
});

test('data_quality arrays are each capped at 10', () => {
  const many = Array.from({ length: 11 }, (_, i) => `period-${i}`);
  assert.equal(DataQualityBlockSchema.safeParse({
    type: 'data_quality', groundingStatus: null, unmatchedRequestedPeriods: many, valuationGaps: [], limitations: [],
  }).success, false);
});

test('suggested_questions requires 1-4 questions, each capped at 140 chars', () => {
  assert.equal(SuggestedQuestionsBlockSchema.safeParse({ type: 'suggested_questions', questions: [] }).success, false, 'zero questions rejected');
  const five = ['a?', 'b?', 'c?', 'd?', 'e?'];
  assert.equal(SuggestedQuestionsBlockSchema.safeParse({ type: 'suggested_questions', questions: five }).success, false, 'over the 4-question cap');
  const tooLong = 'x'.repeat(141) + '?';
  assert.equal(SuggestedQuestionsBlockSchema.safeParse({ type: 'suggested_questions', questions: [tooLong] }).success, false);
  assert.equal(SuggestedQuestionsBlockSchema.safeParse({ type: 'suggested_questions', questions: ['A real question?'] }).success, true);
});

test('EvidenceRefSchema requires a non-empty evidenceId; citationIndex may be null but never negative/zero', () => {
  assert.equal(EvidenceRefSchema.safeParse(ref('', 1)).success, false);
  assert.equal(EvidenceRefSchema.safeParse({ evidenceId: 'e1', citationIndex: null }).success, true, 'unresolved citationIndex is honestly null, not omitted or guessed');
  assert.equal(EvidenceRefSchema.safeParse({ evidenceId: 'e1', citationIndex: 0 }).success, false);
  assert.equal(EvidenceRefSchema.safeParse({ evidenceId: 'e1', citationIndex: -1 }).success, false);
});

test('ResponseBlocksSchema caps the whole array at MAX_RESPONSE_BLOCKS', () => {
  const one = { type: 'suggested_questions', questions: ['Q?'] };
  const many = Array.from({ length: MAX_RESPONSE_BLOCKS + 1 }, () => one);
  assert.equal(ResponseBlocksSchema.safeParse(many).success, false);
  assert.equal(ResponseBlocksSchema.safeParse(many.slice(0, MAX_RESPONSE_BLOCKS)).success, true);
});

// UI Phase 1C.1 ---------------------------------------------------------

test('company_header requires companyName but allows a null price and null sector/exchange', () => {
  assert.equal(CompanyHeaderBlockSchema.safeParse({ type: 'company_header', symbol: 'TCS', companyName: '', sector: null, exchange: null, price: null }).success, false, 'an empty name is not a real name');
  assert.equal(CompanyHeaderBlockSchema.safeParse({ type: 'company_header', symbol: 'TCS', companyName: 'Tata Consultancy Services', sector: null, exchange: null, price: null }).success, true);
});

test('company_header.price requires at least one evidence ref -- a price is a factual claim, never asserted bare', () => {
  const result = CompanyHeaderBlockSchema.safeParse({
    type: 'company_header', symbol: 'TCS', companyName: 'TCS', sector: null, exchange: null,
    price: { value: 2105.5, currency: 'INR', asOf: null, evidence: [] },
  });
  assert.equal(result.success, false);
});

test('company_header.price.currency only accepts INR (the literal this system ever produces)', () => {
  const result = CompanyHeaderBlockSchema.safeParse({
    type: 'company_header', symbol: 'TCS', companyName: 'TCS', sector: null, exchange: null,
    price: { value: 2105.5, currency: 'USD', asOf: null, evidence: [{ evidenceId: 'e1', citationIndex: 1 }] },
  });
  assert.equal(result.success, false);
});

test('CanonicalGuidanceSchema accepts a field being genuinely ABSENT, not just null -- a real production object shape, not a hypothetical', () => {
  // services/EvidenceEnvelope.js spreads qualitativeDirection in ONLY for a
  // genuine valueType:'qualitative' record; every numeric guidance record
  // (the overwhelming majority) never has that key at all.
  const numericGuidance = { valueType: 'range', lowerBound: 21, upperBound: 23, unit: 'PERCENTAGE' };
  const result = CanonicalGuidanceSchema.safeParse(numericGuidance);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

// UI Phase 1D fix: a confirmed live bug. services/EvidenceEnvelope.js has
// always spread `qualitativeText` (the literal excerpt supporting a
// qualitative guidance direction) onto real citation objects, but this
// schema never had a field for it -- since the schema is `.strict()`, a
// real grounded citation carrying qualitative guidance failed validation
// OUTRIGHT, silently dropping the entire evidence_drawer block. Confirmed
// live on "What guidance has TCS given for revenue growth?".
test('CanonicalGuidanceSchema accepts a real qualitative-guidance record, including its qualitativeText excerpt', () => {
  const qualitativeGuidance = {
    metric: 'revenue_growth', metricKey: 'revenue_growth', targetFiscalYear: 'FY2026', targetQuarter: 'Q2',
    guidanceKind: 'original', valueType: 'qualitative', qualitativeDirection: 'IMPROVE',
    qualitativeText: 'we don\'t give any specific guidance, but on the international revenue part, we are more optimistic in the coming quarter.',
  };
  const result = CanonicalGuidanceSchema.safeParse(qualitativeGuidance);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test('evidence_drawer preserves excerpt, page range, temporal status and canonical guidance, and rejects an unknown extra field', () => {
  const entry = {
    evidenceId: 'e1', citationIndex: 1, title: 'x', excerpt: 'Revenue grew 15%.', sourceUrl: 'https://example.com/x.pdf',
    provider: 'NSE', publishedAt: '2026-01-01', reportingPeriod: 'FY2024', documentType: 'QUARTERLY_REPORT',
    pageStart: 3, pageEnd: 4, temporalStatus: 'CURRENT', canonicalGuidance: null,
  };
  assert.equal(EvidenceDrawerBlockSchema.safeParse({ type: 'evidence_drawer', entries: [entry] }).success, true);
  assert.equal(EvidenceDrawerBlockSchema.safeParse({ type: 'evidence_drawer', entries: [{ ...entry, unexpectedField: 'x' }] }).success, false);
});

test('evidence_drawer rejects an unsafe sourceUrl at the schema level too', () => {
  const entry = { evidenceId: 'e1', citationIndex: 1, title: 'x', excerpt: null, sourceUrl: 'javascript:alert(1)', provider: null, publishedAt: null, reportingPeriod: null, documentType: null, pageStart: null, pageEnd: null, temporalStatus: null, canonicalGuidance: null };
  assert.equal(EvidenceDrawerBlockSchema.safeParse({ type: 'evidence_drawer', entries: [entry] }).success, false);
});

// UI Phase 1C.2 ---------------------------------------------------------

const newsArticle = (overrides = {}) => ({
  evidenceId: 'e1', citationIndex: 1, symbol: 'TCS', title: 'TCS wins major deal',
  url: 'https://reuters.com/tcs-deal', publisher: 'Reuters', publishedAt: '2026-09-01T00:00:00.000Z',
  imageUrl: 'https://reuters.com/img.jpg', ...overrides,
});

test('news_list requires a real url -- a missing or unsafe link is rejected, never omitted-but-still-valid', () => {
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle({ url: undefined })] }).success, false);
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle({ url: 'javascript:alert(1)' })] }).success, false);
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle({ url: 'ftp://example.com/x' })] }).success, false);
});

test('news_list accepts a null publisher/date/image -- these are honestly optional, never invented', () => {
  const result = NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle({ publisher: null, publishedAt: null, imageUrl: null })] });
  assert.equal(result.success, true);
});

test('news_list rejects an unsafe imageUrl even though the article itself is otherwise valid', () => {
  const result = NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle({ imageUrl: 'javascript:alert(1)' })] });
  assert.equal(result.success, false);
});

test('news_list requires a non-empty title -- no card with a blank headline', () => {
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle({ title: '' })] }).success, false);
});

test('news_list is capped at 5 articles', () => {
  const articles = Array.from({ length: 6 }, (_, i) => newsArticle({ evidenceId: `e${i}`, url: `https://reuters.com/a${i}` }));
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles }).success, false);
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: articles.slice(0, 5) }).success, true);
});

test('news_list requires at least one article -- an empty list is not a valid block', () => {
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: [] }).success, false);
});

test('news_list rejects an unexpected extra field (.strict())', () => {
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle()], extra: 'x' }).success, false);
  assert.equal(NewsListBlockSchema.safeParse({ type: 'news_list', articles: [newsArticle({ summary: 'an unrequested field' })] }).success, false);
});

test('news_list carries no excerpt/summary field at all -- headline, publisher, date, link, optional image only', () => {
  const shape = Object.keys(newsArticle());
  assert.deepEqual(
    shape.sort(),
    ['citationIndex', 'evidenceId', 'imageUrl', 'publishedAt', 'publisher', 'symbol', 'title', 'url'].sort(),
  );
});

// UI Phase 1C.3 -- chart -------------------------------------------------

const point = (date, close, gapBefore = false) => ({ date, close, gapBefore });

const chartBlock = (overrides = {}) => ({
  type: 'chart',
  version: 1,
  symbol: 'TCS',
  currency: 'INR',
  priceBasis: 'NOT_REQUIRED',
  points: [point('2026-08-01', 100), point('2026-08-02', 101), point('2026-08-03', 102)],
  rangeStart: '2026-08-01',
  rangeEnd: '2026-08-03',
  requestedRangeDays: null,
  provider: 'NSE_BHAVCOPY',
  sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv',
  dataAsOf: '2026-08-03',
  evidence: [ref()],
  ...overrides,
});

test('a well-formed chart block validates', () => {
  const result = ChartBlockSchema.safeParse(chartBlock());
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test('chart requires at least 2 points -- a single point is not a chart', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-01', 100)] })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [] })).success, false);
});

test('chart.points is capped at MAX_CHART_POINTS', () => {
  const base = new Date('2020-01-01T00:00:00Z');
  const overCap = Array.from({ length: MAX_CHART_POINTS + 1 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86400000);
    return point(d.toISOString().slice(0, 10), 100 + i);
  });
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: overCap, rangeStart: overCap[0].date, rangeEnd: overCap[overCap.length - 1].date })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: overCap.slice(0, MAX_CHART_POINTS), rangeStart: overCap[0].date, rangeEnd: overCap[MAX_CHART_POINTS - 1].date })).success, true);
});

test('chart points must be finite AND strictly positive -- zero, negative, NaN and Infinity are all rejected', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-01', 0), point('2026-08-02', 100)] })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-01', -5), point('2026-08-02', 100)] })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-01', NaN), point('2026-08-02', 100)] })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-01', Infinity), point('2026-08-02', 100)] })).success, false);
});

test('chart points must be strictly chronological -- an out-of-order or duplicate date is rejected', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-03', 102), point('2026-08-01', 100)] })).success, false, 'out of order');
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-01', 100), point('2026-08-01', 101)] })).success, false, 'duplicate date');
});

test('chart.date must be YYYY-MM-DD -- a datetime string is rejected', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [point('2026-08-01T00:00:00.000Z', 100), point('2026-08-02', 101)] })).success, false);
});

test('chart.currency only accepts INR (the literal this system ever produces)', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ currency: 'USD' })).success, false);
});

test('chart.priceBasis only accepts the three real adjustment statuses', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ priceBasis: 'MIXED' })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ priceBasis: 'ADJUSTED' })).success, true);
});

test('chart.version only accepts the literal 1 -- a future breaking shape change must bump this', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ version: 2 })).success, false);
});

test('chart requires at least one evidence ref -- a chart is a factual claim, never asserted bare', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ evidence: [] })).success, false);
});

test('chart rejects an unsafe sourceUrl at the schema level, but accepts a null one', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ sourceUrl: 'javascript:alert(1)' })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ sourceUrl: null })).success, true);
});

test('chart.requestedRangeDays is honestly null when no range was requested, and rejects a non-positive value', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ requestedRangeDays: null })).success, true);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ requestedRangeDays: 90 })).success, true);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ requestedRangeDays: 0 })).success, false);
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ requestedRangeDays: -5 })).success, false);
});

test('chart rejects an unexpected extra field (.strict())', () => {
  assert.equal(ChartBlockSchema.safeParse({ ...chartBlock(), unexpectedField: 'x' }).success, false);
});

test('a chart.point rejects an unexpected extra field too (.strict())', () => {
  assert.equal(ChartBlockSchema.safeParse(chartBlock({ points: [{ ...point('2026-08-01', 100), extra: 'x' }, point('2026-08-02', 101)] })).success, false);
});

test('the discriminated union recognizes a well-formed chart block', () => {
  assert.equal(ResponseBlockSchema.safeParse(chartBlock()).success, true);
});
