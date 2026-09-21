import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';
import {
  appendAssistantMessage, getThread, toPersistedResponseBlocks, fromPersistedResponseBlocks,
  normalizeExcerpt, normalizeCitationExcerpts, normalizeResponseBlockExcerpts,
} from '../services/ChatThreadService.js';

/**
 * chatMessageResponseBlocksPersistence.test.js
 * ================================================
 * UI Phase 1B: citations and responseBlocks must survive a thread reload
 * byte-for-byte-equivalent to what a live SSE message.completed sent.
 * Mocks ChatMessage/ChatThread's model methods exactly like the existing
 * tests/chatThreadOwnership.test.js does — fast and deterministic, and it
 * is what actually exercises appendAssistantMessage/getThread's own logic
 * (the mapping functions), rather than re-testing Mongoose itself.
 *
 * A genuine end-to-end round trip against the real configured MongoDB was
 * additionally run once by hand for this phase (see the delivery report);
 * this file is the registered, permanent regression guard.
 */

const OWNER_ID = new mongoose.Types.ObjectId().toString();
const THREAD_ID = new mongoose.Types.ObjectId().toString();

const makeFakeThreadDoc = () => ({
  _id: THREAD_ID, userId: OWNER_ID, deletedAt: null, messageCount: 0, title: 'New chat',
  save: async function save() { return this; },
  toObject: function toObject() { return { _id: this._id, userId: this.userId, title: this.title }; },
});

const GROUNDED_CITATION = {
  evidenceId: 'ev-grounded-1',
  claimType: 'FINANCIAL_DATA',
  symbol: 'TCS',
  title: 'TCS Q1 FY2026 results',
  sourceUrl: 'https://nsearchives.nseindia.com/x.xml',
  provider: 'NSE',
  publishedAt: '2026-07-10',
  reportingPeriod: 'Q1 FY2026',
  fiscalYear: 'FY2026',
  documentType: 'QUARTERLY_REPORT',
  sourceAuthority: 'NSE',
  pageStart: 3,
  pageEnd: 4,
  temporalStatus: 'CURRENT',
  supersededBy: null,
  supersedes: ['ev-grounded-0'],
  canonicalGuidance: {
    metric: 'Revenue growth', metricKey: 'revenue_growth', targetFiscalYear: 'FY2026', targetQuarter: null,
    guidanceKind: 'FORWARD', valueType: 'range', lowerBound: 21, upperBound: 23, exactValue: null,
    unit: 'PERCENTAGE', currency: null, qualitativeDirection: null,
  },
};

const SAMPLE_BLOCKS = [
  {
    type: 'metric_grid',
    symbol: 'TCS',
    metrics: [{ metric: 'REVENUE', label: 'Revenue', value: 240893, unit: 'INR_CRORE', period: 'FY2024', evidence: [{ evidenceId: 'ev-grounded-1', citationIndex: 1 }] }],
  },
  {
    type: 'source_list',
    sources: [{ evidenceId: 'ev-grounded-1', citationIndex: 1, title: 'TCS Q1 FY2026 results', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'NSE', publishedAt: '2026-07-10', reportingPeriod: 'Q1 FY2026' }],
  },
];

/** Installs ChatMessage.create/ChatThread.findOne mocks; returns (capturedDoc getter, restore fn). */
const installMocks = () => {
  const originalThreadFindOne = ChatThread.findOne;
  const originalMessageCreate = ChatMessage.create;
  let captured = null;

  ChatThread.findOne = () => Promise.resolve(makeFakeThreadDoc());
  ChatMessage.create = async (doc) => {
    captured = doc;
    return { ...doc, _id: new mongoose.Types.ObjectId(), toObject: function toObject() { return { ...doc, _id: this._id }; } };
  };

  return {
    getCaptured: () => captured,
    restore: () => { ChatThread.findOne = originalThreadFindOne; ChatMessage.create = originalMessageCreate; },
  };
};

test('appendAssistantMessage persists the widened citation fields (temporalStatus, canonicalGuidance, etc.), not just the original 8', async () => {
  const { getCaptured, restore } = installMocks();
  try {
    await appendAssistantMessage(OWNER_ID, THREAD_ID, {
      content: 'TCS grew revenue 21-23% [1].',
      citations: [GROUNDED_CITATION],
    });
    const doc = getCaptured();
    assert.equal(doc.citations.length, 1);
    const stored = doc.citations[0];
    assert.equal(stored.temporalStatus, 'CURRENT');
    assert.equal(stored.documentType, 'QUARTERLY_REPORT');
    assert.equal(stored.sourceAuthority, 'NSE');
    assert.equal(stored.pageStart, 3);
    assert.equal(stored.pageEnd, 4);
    assert.equal(stored.fiscalYear, 'FY2026');
    assert.deepEqual(stored.supersedes, ['ev-grounded-0']);
    assert.ok(stored.canonicalGuidance, 'canonicalGuidance sub-document is present');
    assert.equal(stored.canonicalGuidance.valueType, 'range');
    assert.equal(stored.canonicalGuidance.lowerBound, 21);
    assert.equal(stored.canonicalGuidance.upperBound, 23);
  } finally {
    restore();
  }
});

test('appendAssistantMessage converts responseBlocks to their persisted shape before calling ChatMessage.create', async () => {
  const { getCaptured, restore } = installMocks();
  try {
    await appendAssistantMessage(OWNER_ID, THREAD_ID, { content: 'TCS revenue was ₹2,40,893 Cr [1].', responseBlocks: SAMPLE_BLOCKS });
    const doc = getCaptured();
    assert.equal(doc.responseBlocks.length, 2);
    assert.equal(doc.responseBlocks[0].type, 'metric_grid');
    assert.ok(doc.responseBlocks[0].metricGrid, 'stored under the type-named sub-key, not a raw Mixed blob');
    assert.equal(doc.responseBlocks[0].metricGrid.symbol, 'TCS');
    assert.equal(doc.responseBlocks[1].type, 'source_list');
    assert.ok(doc.responseBlocks[1].sourceList);
  } finally {
    restore();
  }
});

test('appendAssistantMessage defaults to an empty responseBlocks array when none is given -- never undefined', async () => {
  const { getCaptured, restore } = installMocks();
  try {
    await appendAssistantMessage(OWNER_ID, THREAD_ID, { content: 'Plain answer.' });
    assert.deepEqual(getCaptured().responseBlocks, []);
  } finally {
    restore();
  }
});

test('getThread returns responseBlocks in the SAME shape a live message.completed SSE event would send (object-keyed comparison values, not the persisted array form)', async () => {
  const originalThreadFindOne = ChatThread.findOne;
  const originalMessageFind = ChatMessage.find;
  const persistedBlocks = toPersistedResponseBlocks([
    {
      type: 'comparison_table',
      symbols: ['TCS', 'INFY'],
      rows: [{
        metric: 'REVENUE', label: 'Revenue', commonPeriod: 'FY2024', comparable: true,
        values: {
          TCS: { value: 1, unit: 'INR_CRORE', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] },
          INFY: { value: 2, unit: 'INR_CRORE', evidence: [{ evidenceId: 'e2', citationIndex: 2 }] },
        },
      }],
    },
  ]);
  ChatThread.findOne = () => Promise.resolve(makeFakeThreadDoc());
  ChatMessage.find = () => ({
    sort: () => ({
      lean: async () => [{
        _id: new mongoose.Types.ObjectId(), role: 'assistant', content: 'x', citations: [], responseBlocks: persistedBlocks,
      }],
    }),
  });

  try {
    const { messages } = await getThread(OWNER_ID, THREAD_ID);
    assert.equal(messages.length, 1);
    const [block] = messages[0].responseBlocks;
    assert.equal(block.type, 'comparison_table');
    // Object-keyed by symbol -- the API/SSE shape, not the array-of-{symbol,...} persisted shape.
    assert.equal(block.rows[0].values.TCS.value, 1);
    assert.equal(block.rows[0].values.INFY.value, 2);
    assert.equal(Array.isArray(block.rows[0].values), false);
  } finally {
    ChatThread.findOne = originalThreadFindOne;
    ChatMessage.find = originalMessageFind;
  }
});

test('getThread re-validates persisted blocks against the live Zod schema and drops anything that no longer parses, rather than returning a malformed shape', async () => {
  const originalThreadFindOne = ChatThread.findOne;
  const originalMessageFind = ChatMessage.find;
  ChatThread.findOne = () => Promise.resolve(makeFakeThreadDoc());
  ChatMessage.find = () => ({
    sort: () => ({
      lean: async () => [{
        _id: new mongoose.Types.ObjectId(),
        role: 'assistant',
        content: 'x',
        citations: [],
        // metricGrid.metrics is empty -- fromPersistedResponseBlock would
        // still shape an object, but MetricGridBlockSchema requires min(1).
        responseBlocks: [{ type: 'metric_grid', metricGrid: { symbol: 'TCS', metrics: [] } }],
      }],
    }),
  });

  try {
    const { messages } = await getThread(OWNER_ID, THREAD_ID);
    assert.deepEqual(messages[0].responseBlocks, [], 'a block that no longer validates is dropped, not surfaced broken');
  } finally {
    ChatThread.findOne = originalThreadFindOne;
    ChatMessage.find = originalMessageFind;
  }
});

test('fromPersistedResponseBlocks/toPersistedResponseBlocks round-trip is lossless for all nine block types', () => {
  const original = [
    { type: 'metric_grid', symbol: 'TCS', metrics: [{ metric: 'REVENUE', label: 'Revenue', value: 1, unit: null, period: null, evidence: [{ evidenceId: 'e1', citationIndex: 1 }] }] },
    { type: 'comparison_table', symbols: ['TCS', 'INFY'], rows: [{ metric: 'REVENUE', label: 'Revenue', commonPeriod: 'FY2024', comparable: true, values: { TCS: { value: 1, unit: null, evidence: [{ evidenceId: 'e1', citationIndex: 1 }] } } }] },
    { type: 'source_list', sources: [{ evidenceId: 'e1', citationIndex: 1, title: null, sourceUrl: null, provider: null, publishedAt: null, reportingPeriod: null }] },
    { type: 'data_quality', groundingStatus: 'grounded', unmatchedRequestedPeriods: ['FY2015'], valuationGaps: [{ symbol: 'HAL', metric: 'PE', reason: 'x' }], limitations: [] },
    { type: 'suggested_questions', questions: ['Q1?'] },
    { type: 'company_header', symbol: 'TCS', companyName: 'Tata Consultancy Services', sector: 'IT', exchange: 'NSE', price: { value: 2105.5, currency: 'INR', asOf: '2026-09-11T10:15:30.000Z', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] } },
    { type: 'company_header', symbol: 'HAL', companyName: 'Hindustan Aeronautics', sector: null, exchange: null, price: null },
    {
      type: 'evidence_drawer',
      entries: [{
        evidenceId: 'e1', citationIndex: 1, title: 'TCS filing', excerpt: 'Revenue grew 15%.', sourceUrl: 'https://x.com/doc.pdf',
        provider: 'NSE', publishedAt: '2026-01-01', reportingPeriod: 'FY2023', documentType: 'QUARTERLY_REPORT',
        pageStart: 3, pageEnd: 4, temporalStatus: 'CURRENT',
        canonicalGuidance: { valueType: 'range', lowerBound: 21, upperBound: 23, unit: 'PERCENTAGE' },
      }],
    },
    {
      type: 'news_list',
      articles: [
        { evidenceId: 'e1', citationIndex: 1, symbol: 'TCS', title: 'TCS wins major deal', url: 'https://reuters.com/tcs-deal', publisher: 'Reuters', publishedAt: '2026-09-01T00:00:00.000Z', imageUrl: 'https://reuters.com/img.jpg' },
        { evidenceId: 'e2', citationIndex: 2, symbol: 'TCS', title: 'TCS Q1 preview', url: 'https://moneycontrol.com/tcs-preview', publisher: null, publishedAt: null, imageUrl: null },
      ],
    },
    {
      type: 'chart',
      version: 1,
      symbol: 'TCS',
      currency: 'INR',
      priceBasis: 'NOT_REQUIRED',
      points: [
        { date: '2026-08-01', close: 100, gapBefore: false },
        { date: '2026-08-05', close: 104, gapBefore: true },
        { date: '2026-08-06', close: 105, gapBefore: false },
      ],
      rangeStart: '2026-08-01',
      rangeEnd: '2026-08-06',
      requestedRangeDays: 90,
      provider: 'NSE_BHAVCOPY',
      sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv',
      dataAsOf: '2026-08-06',
      evidence: [{ evidenceId: 'e1', citationIndex: 1 }],
    },
  ];
  const roundTripped = fromPersistedResponseBlocks(toPersistedResponseBlocks(original));
  assert.deepEqual(roundTripped, original);
});

test('appendAssistantMessage persists a company_header with a null price without crashing (single-company turns without a resolvable price)', async () => {
  const { getCaptured, restore } = installMocks();
  try {
    await appendAssistantMessage(OWNER_ID, THREAD_ID, {
      content: 'HAL is a defence PSU.',
      responseBlocks: [{ type: 'company_header', symbol: 'HAL', companyName: 'Hindustan Aeronautics', sector: 'Defence', exchange: null, price: null }],
    });
    const doc = getCaptured();
    assert.equal(doc.responseBlocks[0].companyHeader.price, null);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// UI Phase 1C.2: an oversized excerpt cannot prevent the assistant message
// from saving.
//
// installMocks' ChatMessage.create stub above never runs Mongoose's OWN
// schema validation (it just echoes the doc back) — it cannot prove this
// guarantee, since it would "pass" even without the fix. These tests use
// `new ChatMessage(...).validateSync()`, which runs the REAL schema
// validators (including citationSchema/evidenceDrawerEntrySchema's
// `excerpt` maxlength) with no DB connection required — a genuine,
// fast, deterministic proof of the actual risk and the actual fix.
// ---------------------------------------------------------------------------

const OVERSIZED_EXCERPT = 'x'.repeat(10_000); // well beyond the 4000-char maxlength

test('sanity: an OVERSIZED excerpt, unnormalized, genuinely fails real Mongoose validation -- the risk normalizeExcerpt exists for is real, not hypothetical', () => {
  const doc = new ChatMessage({
    threadId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    role: 'assistant',
    content: 'x',
    citations: [{ evidenceId: 'e1', excerpt: OVERSIZED_EXCERPT }],
  });
  const error = doc.validateSync();
  assert.ok(error, 'validation must fail on the raw, oversized excerpt');
  assert.ok(String(error.message).includes('excerpt') || error.errors?.['citations.0.excerpt'], JSON.stringify(Object.keys(error.errors || {})));
});

test('normalizeExcerpt truncates only when over the limit, leaving short values byte-identical', () => {
  assert.equal(normalizeExcerpt(OVERSIZED_EXCERPT).length, 4000);
  assert.equal(normalizeExcerpt('a short excerpt'), 'a short excerpt');
  assert.equal(normalizeExcerpt(null), null);
  assert.equal(normalizeExcerpt(undefined), undefined);
});

test('normalizeCitationExcerpts bounds every citation excerpt, leaving every other field untouched', () => {
  const citations = [
    { evidenceId: 'e1', title: 'x', excerpt: OVERSIZED_EXCERPT, sourceUrl: 'https://example.com' },
    { evidenceId: 'e2', title: 'y' }, // no excerpt field at all -- must not crash or add one
  ];
  const result = normalizeCitationExcerpts(citations);
  assert.equal(result[0].excerpt.length, 4000);
  assert.equal(result[0].title, 'x');
  assert.equal(result[0].sourceUrl, 'https://example.com');
  assert.equal('excerpt' in result[1], false);
});

test('normalizeResponseBlockExcerpts bounds evidence_drawer excerpts only -- every other block type passes through untouched', () => {
  const blocks = [
    { type: 'evidence_drawer', entries: [{ evidenceId: 'e1', excerpt: OVERSIZED_EXCERPT }] },
    { type: 'metric_grid', symbol: 'TCS', metrics: [] }, // unrelated block type, must be returned as-is
  ];
  const result = normalizeResponseBlockExcerpts(blocks);
  assert.equal(result[0].entries[0].excerpt.length, 4000);
  assert.deepEqual(result[1], blocks[1]);
});

test('after normalization, the SAME oversized-excerpt document passes real Mongoose validation cleanly', () => {
  const normalizedCitations = normalizeCitationExcerpts([{ evidenceId: 'e1', excerpt: OVERSIZED_EXCERPT }]);
  const normalizedBlocks = toPersistedResponseBlocks(normalizeResponseBlockExcerpts([
    { type: 'evidence_drawer', entries: [{ evidenceId: 'e1', citationIndex: 1, excerpt: OVERSIZED_EXCERPT }] },
  ]));
  const doc = new ChatMessage({
    threadId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    role: 'assistant',
    content: 'TCS revenue grew [1].',
    citations: normalizedCitations,
    responseBlocks: normalizedBlocks,
  });
  const error = doc.validateSync();
  assert.equal(error, undefined, error ? JSON.stringify(Object.keys(error.errors || {})) : '');
});

test('end-to-end: appendAssistantMessage with an oversized excerpt in BOTH citations and an evidence_drawer entry does not throw', async () => {
  const { getCaptured, restore } = installMocks();
  try {
    // installMocks' create() stub does not itself validate, so this proves
    // the SERVICE layer's own call sequence (normalize -> toPersisted ->
    // create) completes without error for input that would otherwise fail
    // real validation (see the two tests above for that proof).
    await appendAssistantMessage(OWNER_ID, THREAD_ID, {
      content: 'TCS revenue grew [1].',
      citations: [{ evidenceId: 'e1', title: 'TCS filing', excerpt: OVERSIZED_EXCERPT }],
      responseBlocks: [{ type: 'evidence_drawer', entries: [{ evidenceId: 'e1', citationIndex: 1, excerpt: OVERSIZED_EXCERPT }] }],
    });
    const doc = getCaptured();
    assert.equal(doc.citations[0].excerpt.length, 4000);
    assert.equal(doc.responseBlocks[0].evidenceDrawer.entries[0].excerpt.length, 4000);
  } finally {
    restore();
  }
});
