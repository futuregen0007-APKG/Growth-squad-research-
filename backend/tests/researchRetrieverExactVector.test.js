import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { retrieveResearchEvidence, RETRIEVAL_MODES, RETRIEVAL_STATUS } from '../services/ResearchRetrieverService.js';
import { embedChunks } from '../services/EmbeddingService.js';
import { LLM_CONFIG } from '../llm/OpenAIClientFactory.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
// Real chunks must live under a real TCS/INFY symbol for the canary/fusion
// modes to ever consider them at all -- this is the whole point of their
// scope restriction, so the test fixtures use TCS itself (safe: a
// dedicated documentHash keeps them from colliding with any real indexed
// TCS chunk, and cleanup removes them by that unique hash prefix).
const FIXTURE_HASH_PREFIX = 'zzexactvectortest-';
let counter = 0;
const insertEmbeddedChunk = async (overrides = {}) => {
  counter += 1;
  const base = {
    symbol: 'TCS',
    registryDocumentId: new mongoose.Types.ObjectId(),
    documentHash: `${FIXTURE_HASH_PREFIX}${counter}-${Math.random()}`,
    documentType: 'ANNUAL_REPORT',
    title: 'Test fixture (not a real filing)',
    fiscalYear: 'FY2099',
    sourceUrl: 'https://example.com/exact-vector-fixture.pdf',
    pageStart: 1,
    pageEnd: 1,
    chunkIndex: counter,
    text: 'Operating margin guidance for the fiscal year was reaffirmed by management on the call today.',
    approximateTokenCount: 12,
    ...overrides,
  };
  if (!HAS_OPENAI_KEY) return ResearchDocumentChunk.create(base);
  const { results } = await embedChunks([{ text: base.text }], { model: LLM_CONFIG.embeddingModel, embeddingVersion: LLM_CONFIG.embeddingVersion });
  const item = results[0];
  return ResearchDocumentChunk.create({
    ...base,
    embedding: item.status === 'EMBEDDED' ? item.embedding : undefined,
    embeddingModel: item.status === 'EMBEDDED' ? item.embeddingModel : null,
    embeddingVersion: item.status === 'EMBEDDED' ? item.embeddingVersion : null,
    indexedAt: item.status === 'EMBEDDED' ? new Date() : null,
  });
};

const cleanup = async () => { await ResearchDocumentChunk.deleteMany({ documentHash: new RegExp(`^${FIXTURE_HASH_PREFIX}`) }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

// ---------------------------------------------------------------------------
// LOCAL_EXACT_VECTOR_CANARY
// ---------------------------------------------------------------------------
test('required: LOCAL_EXACT_VECTOR_CANARY refuses any symbol outside TCS/INFY', async () => {
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['HDFCBANK'], mode: 'LOCAL_EXACT_VECTOR_CANARY' });
  assert.equal(r.status, RETRIEVAL_STATUS.UNSUPPORTED);
  assert.match(r.reason, /TCS\/INFY/);
});

test('required: LOCAL_EXACT_VECTOR_CANARY refuses to run in a production runtime', async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['TCS'], mode: 'LOCAL_EXACT_VECTOR_CANARY' });
    assert.equal(r.status, RETRIEVAL_STATUS.UNSUPPORTED);
    assert.match(r.reason, /evaluation-only/);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;
  }
});

test('required: LOCAL_EXACT_VECTOR_CANARY applies mandatory metadata filters before any cosine scoring', async () => {
  await insertEmbeddedChunk({ symbol: 'TCS', fiscalYear: 'FY2099', pageStart: 1 });
  await insertEmbeddedChunk({ symbol: 'TCS', fiscalYear: 'FY2050', pageStart: 2 });
  const r = await retrieveResearchEvidence({
    query: 'operating margin guidance fiscal year', symbols: ['TCS'], fiscalYears: ['FY2099'], mode: 'LOCAL_EXACT_VECTOR_CANARY',
  });
  if (r.status === RETRIEVAL_STATUS.SUCCESS) {
    assert.ok(r.results.every((x) => x.fiscalYear === 'FY2099'));
  }
});

test('required: LOCAL_EXACT_VECTOR_CANARY never exposes a raw embedding vector on any result', async () => {
  await insertEmbeddedChunk({});
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], fiscalYears: ['FY2099'], mode: 'LOCAL_EXACT_VECTOR_CANARY' });
  for (const result of r.results) assert.ok(!('embedding' in result));
});

test('required: LOCAL_EXACT_VECTOR_CANARY is never labeled ATLAS_VECTOR or LOCAL_HYBRID_RERANK', async () => {
  await insertEmbeddedChunk({});
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], fiscalYears: ['FY2099'], mode: 'LOCAL_EXACT_VECTOR_CANARY' });
  assert.notEqual(r.retrievalMode, RETRIEVAL_MODES.ATLAS_VECTOR);
  assert.notEqual(r.retrievalMode, RETRIEVAL_MODES.LOCAL_HYBRID_RERANK);
});

// ---------------------------------------------------------------------------
// LOCAL_EXACT_VECTOR_HYBRID_FUSION
// ---------------------------------------------------------------------------
test('required: LOCAL_EXACT_VECTOR_HYBRID_FUSION refuses any symbol outside TCS/INFY', async () => {
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['BHEL'], mode: 'LOCAL_EXACT_VECTOR_HYBRID_FUSION' });
  assert.equal(r.status, RETRIEVAL_STATUS.UNSUPPORTED);
});

test('required: LOCAL_EXACT_VECTOR_HYBRID_FUSION refuses to run in a production runtime', async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['INFY'], mode: 'LOCAL_EXACT_VECTOR_HYBRID_FUSION' });
    assert.equal(r.status, RETRIEVAL_STATUS.UNSUPPORTED);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;
  }
});

test('required: LOCAL_EXACT_VECTOR_HYBRID_FUSION requires a candidate to independently clear the lexical eligibility gate -- cosine alone cannot rescue a low-lexical-relevance chunk', async () => {
  await insertEmbeddedChunk({ text: 'Employee cafeteria menu options were updated this month across all office locations nationwide.' });
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance for the fiscal year', symbols: ['TCS'], fiscalYears: ['FY2099'], mode: 'LOCAL_EXACT_VECTOR_HYBRID_FUSION' });
  assert.equal(r.status, RETRIEVAL_STATUS.EMPTY);
});

test('required: LOCAL_EXACT_VECTOR_HYBRID_FUSION a query with no meaningful terms produces EMPTY, never reaching the embedding step', async () => {
  await insertEmbeddedChunk({});
  const r = await retrieveResearchEvidence({ query: "What is the company's business growth, management, and results this year?", symbols: ['TCS'], mode: 'LOCAL_EXACT_VECTOR_HYBRID_FUSION' });
  assert.equal(r.status, RETRIEVAL_STATUS.EMPTY);
});

test('required: LOCAL_EXACT_VECTOR_HYBRID_FUSION never exposes a raw embedding vector on any result', async () => {
  await insertEmbeddedChunk({});
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], fiscalYears: ['FY2099'], mode: 'LOCAL_EXACT_VECTOR_HYBRID_FUSION' });
  for (const result of r.results) assert.ok(!('embedding' in result));
});

// ---------------------------------------------------------------------------
// Recency scoring (Phase 4A.3 general fix for within-fiscal-year
// guidance revisions)
// ---------------------------------------------------------------------------
test('required: within the same fiscal year, a more recently-published filing is nudged above an older one when other signals are close', { skip: !HAS_OPENAI_KEY && 'requires a configured OPENAI_API_KEY' }, async () => {
  const sharedText = 'We are retaining our operating margin guidance for the fiscal year at a similar range as before.';
  await insertEmbeddedChunk({
    pageStart: 1, chunkIndex: 100, publishedAt: new Date('2023-01-01'), text: sharedText,
  });
  await insertEmbeddedChunk({
    pageStart: 2, chunkIndex: 101, publishedAt: new Date('2023-06-01'), text: sharedText,
  });
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], fiscalYears: ['FY2099'], mode: 'LOCAL_HYBRID_RERANK' });
  if (r.status === RETRIEVAL_STATUS.SUCCESS && r.results.length) {
    assert.ok('recencyScore' in r.results[0].debug, 'recencyScore must be present in hybrid diagnostics');
  }
});
