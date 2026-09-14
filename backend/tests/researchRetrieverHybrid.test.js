import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import {
  retrieveResearchEvidence, cosineSimilarity, RETRIEVAL_MODES, RETRIEVAL_STATUS, clearQueryEmbeddingCacheForTests,
} from '../services/ResearchRetrieverService.js';
import { embedChunks } from '../services/EmbeddingService.js';
import { LLM_CONFIG, OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZHYBRIDTEST';
const symbolFor = (suffix) => `${TEST_PREFIX}${suffix}`;
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);

let counter = 0;
/** Inserts a chunk and, when OpenAI is configured, embeds it for REAL with the project's real embedding model/version — required for it to be hybrid-eligible at all (the mandatory embeddingModel/embeddingVersion filter excludes anything else, by design). */
const insertEmbeddedChunk = async (overrides = {}) => {
  counter += 1;
  const base = {
    symbol: symbolFor('A'),
    registryDocumentId: new mongoose.Types.ObjectId(),
    documentHash: `hash-${counter}-${Math.random()}`,
    documentType: 'ANNUAL_REPORT',
    title: 'Test Annual Report',
    fiscalYear: 'FY2026',
    sourceUrl: 'https://example.com/filing.pdf',
    pageStart: 1,
    pageEnd: 1,
    chunkIndex: counter,
    text: 'Revenue grew significantly this fiscal year across all business segments.',
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

const cleanup = async () => { await ResearchDocumentChunk.deleteMany({ symbol: new RegExp(`^${TEST_PREFIX}`) }); };
test.beforeEach(async () => { await cleanup(); clearQueryEmbeddingCacheForTests(); });
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

// ---------------------------------------------------------------------------
// Pure function: cosine similarity correctness
// ---------------------------------------------------------------------------
test('required: cosineSimilarity is correct for known vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0, 'a length mismatch is a defensive 0, never a thrown error');
  assert.equal(cosineSimilarity([], []), 0);
});

// ---------------------------------------------------------------------------
// Mode labeling -- never mislabels itself as Atlas, honest fallback labeling
// ---------------------------------------------------------------------------
test('required: LOCAL_HYBRID_RERANK is never labeled as ATLAS_VECTOR or vice versa', async () => {
  await insertEmbeddedChunk({ text: 'Operating margin guidance for the fiscal year was reaffirmed today by management.' });
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  assert.notEqual(r.retrievalMode, RETRIEVAL_MODES.ATLAS_VECTOR);
  if (r.status === RETRIEVAL_STATUS.SUCCESS) assert.equal(r.retrievalMode, RETRIEVAL_MODES.LOCAL_HYBRID_RERANK);
});

test('required: an honest fallback to lexical-only (embedding unavailable) reports retrievalMode LEXICAL_FALLBACK, never a false LOCAL_HYBRID_RERANK claim', async () => {
  // Insert (and genuinely embed) the chunk FIRST, while OpenAI is still
  // configured -- otherwise it would never be embedded at all and would
  // be excluded by the mandatory embeddingModel filter regardless of
  // what this test is actually trying to exercise (query-embedding
  // unavailability, not chunk-embedding unavailability).
  await insertEmbeddedChunk({ text: 'Operating margin guidance for the fiscal year was reaffirmed today by management on the call.' });
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
    assert.equal(r.status, RETRIEVAL_STATUS.SUCCESS, 'lexical-only results must still be returned honestly');
    assert.equal(r.retrievalMode, RETRIEVAL_MODES.LEXICAL_FALLBACK, 'retrievalMode must be corrected to what actually ran, never claim hybrid');
  } finally {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
  }
});

// ---------------------------------------------------------------------------
// Metadata filtering BEFORE semantic scoring
// ---------------------------------------------------------------------------
test('required: symbol/period filters are applied before any semantic scoring -- hybrid mode never leaks a wrong-symbol or wrong-period result', async () => {
  await insertEmbeddedChunk({ symbol: symbolFor('A'), fiscalYear: 'FY2026', text: 'Operating margin guidance for the fiscal year was reaffirmed today by management on the call.' });
  await insertEmbeddedChunk({ symbol: symbolFor('B'), fiscalYear: 'FY2026', text: 'Operating margin guidance for the fiscal year was reaffirmed today by management on the call.' });
  await insertEmbeddedChunk({ symbol: symbolFor('A'), fiscalYear: 'FY2020', text: 'Operating margin guidance for the fiscal year was reaffirmed today by management on the call.' });
  const r = await retrieveResearchEvidence({
    query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], fiscalYears: ['FY2026'], mode: 'LOCAL_HYBRID_RERANK',
  });
  assert.ok(r.results.every((x) => x.symbol === symbolFor('A')));
  assert.ok(r.results.every((x) => x.fiscalYear === 'FY2026'));
});

test('required: model/version compatibility -- a chunk embedded with a DIFFERENT model/version is never used for cosine scoring, never returned by hybrid mode', async () => {
  await insertEmbeddedChunk({ text: 'Operating margin guidance for the fiscal year was reaffirmed by management this quarter.' });
  await ResearchDocumentChunk.create({
    symbol: symbolFor('A'),
    registryDocumentId: new mongoose.Types.ObjectId(),
    documentHash: `hash-mismatch-${Math.random()}`,
    documentType: 'ANNUAL_REPORT',
    fiscalYear: 'FY2026',
    sourceUrl: 'https://example.com/filing.pdf',
    pageStart: 2,
    pageEnd: 2,
    chunkIndex: 999,
    text: 'Operating margin guidance for the fiscal year was reaffirmed by management this quarter too.',
    approximateTokenCount: 12,
    embedding: Array.from({ length: 1536 }, () => 0.001),
    embeddingModel: 'some-other-embedding-model',
    embeddingVersion: '99',
  });
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  assert.ok(!r.results.some((x) => x.pageStart === 2), 'the mismatched-model/version chunk must never surface in hybrid results');
});

// ---------------------------------------------------------------------------
// Query-embedding cache: no second embedding call for a repeated query
// ---------------------------------------------------------------------------
test('required: the SAME query is embedded only ONCE -- a repeated call reuses the cache, never a second API call', { skip: !HAS_OPENAI_KEY && 'requires a configured OPENAI_API_KEY' }, async () => {
  await insertEmbeddedChunk({ text: 'Operating margin guidance for the fiscal year was reaffirmed by leadership on the earnings call today.' });
  const client = OpenAIClientFactory.getClient();
  const originalCreate = client.embeddings.create.bind(client.embeddings);
  let callCount = 0;
  client.embeddings.create = async (...args) => { callCount += 1; return originalCreate(...args); };
  try {
    const query = 'operating margin guidance for the fiscal year this quarter unique-cache-probe';
    await retrieveResearchEvidence({ query, symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
    const callsAfterFirst = callCount;
    await retrieveResearchEvidence({ query, symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
    assert.equal(callCount, callsAfterFirst, 'a second call with the identical query text must not trigger another embeddings.create call');
  } finally {
    client.embeddings.create = originalCreate;
  }
});

// ---------------------------------------------------------------------------
// Sentence-window ranking + numerical preservation + low-signal abstention
// ---------------------------------------------------------------------------
test('required: sentence-support diagnostics are present and include the supporting sentence excerpt, never a fabricated citation', async () => {
  await insertEmbeddedChunk({ text: 'We are retaining our operating margin guidance for the fiscal year at 21% to 22%. Many other unrelated topics were also discussed at length during this call today.' });
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  if (r.status === RETRIEVAL_STATUS.SUCCESS) {
    const top = r.results[0];
    assert.ok(top.debug, 'hybrid results must still carry the deterministic scoring diagnostic');
    assert.ok('sentenceScore' in top.debug);
    assert.ok('supportingSentence' in top.debug);
    // The stored chunk/page/source are UNCHANGED -- no fabricated citation.
    assert.equal(top.pageStart, 1);
    assert.equal(top.sourceUrl, 'https://example.com/filing.pdf');
  }
});

test('required: numerical values and percentage ranges remain intact in the returned evidence text', async () => {
  await insertEmbeddedChunk({ text: 'Revenue guidance was raised to 19.5% to 20% in constant currency terms for the fiscal year.' });
  const r = await retrieveResearchEvidence({ query: 'revenue guidance constant currency fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  if (r.status === RETRIEVAL_STATUS.SUCCESS) {
    assert.ok(r.results.some((x) => x.text.includes('19.5% to 20%')), 'the exact percentage range must survive verbatim in the returned text');
  }
});

test('required: low-quality lexical relevance still produces EMPTY in hybrid mode -- semantic similarity alone can never rescue a chunk with essentially no lexical relevance', async () => {
  await insertEmbeddedChunk({ text: 'Employee cafeteria menu options were updated this month across all office locations nationwide.' });
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance for the fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  assert.equal(r.status, RETRIEVAL_STATUS.EMPTY);
});

test('required: a query with no meaningful (non-generic) terms produces EMPTY in hybrid mode too -- never reaches the embedding step at all', async () => {
  await insertEmbeddedChunk({ text: 'The company reported strong business results this year under new management with growth across segments.' });
  const r = await retrieveResearchEvidence({ query: "What is the company's business growth, management, and results this year?", symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  assert.equal(r.status, RETRIEVAL_STATUS.EMPTY);
});

// ---------------------------------------------------------------------------
// No raw vectors exposed through API evidence; no secrets logged
// ---------------------------------------------------------------------------
test('required: no raw embedding vector is ever exposed on a returned evidence result, in either mode', async () => {
  await insertEmbeddedChunk({ text: 'Operating margin guidance for the fiscal year was reaffirmed by management on the call today.' });
  const lexical = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LEXICAL_FALLBACK' });
  const hybrid = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  for (const result of [...lexical.results, ...hybrid.results]) {
    assert.ok(!('embedding' in result), 'a retriever result must never carry a raw embedding vector field');
    assert.ok(JSON.stringify(result).length < 20000, 'sanity: no accidental 1536-float dump inflating the payload');
  }
});

test('required: no API key or other secret ever appears in a result\'s diagnostics', async () => {
  await insertEmbeddedChunk({ text: 'Operating margin guidance for the fiscal year was reaffirmed by management on the call today.' });
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK' });
  const serialized = JSON.stringify(r);
  assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(serialized), 'no OpenAI-shaped API key must ever appear in a retrieval result');
  if (process.env.OPENAI_API_KEY) assert.ok(!serialized.includes(process.env.OPENAI_API_KEY));
});

// ---------------------------------------------------------------------------
// Bounded candidate pool (never crashes / degrades with many candidates)
// ---------------------------------------------------------------------------
test('bounded candidate pool: hybrid mode remains correct and bounded even with far more than 50 matching candidates', async () => {
  const inserts = [];
  for (let i = 0; i < 60; i += 1) {
    inserts.push(insertEmbeddedChunk({ chunkIndex: i, pageStart: i + 1, pageEnd: i + 1, text: `Distinct operating margin guidance discussion number ${i} for this fiscal year overall results today.` }));
  }
  await Promise.all(inserts);
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: [symbolFor('A')], mode: 'LOCAL_HYBRID_RERANK', topK: 8 });
  assert.ok(r.results.length <= 8);
  assert.ok(r.results.every((x) => x.symbol === symbolFor('A')));
});
