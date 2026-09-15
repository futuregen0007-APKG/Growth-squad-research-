import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import {
  retrieveResearchEvidence, RETRIEVAL_MODES, RETRIEVAL_STATUS,
} from '../services/ResearchRetrieverService.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

after(async () => { await mongoose.disconnect().catch(() => {}); });

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);

const fakeVectorSearchDoc = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  symbol: 'TCS',
  registryDocumentId: new mongoose.Types.ObjectId(),
  documentHash: `hash-${Math.random()}`,
  chunkHash: `chunkhash-${Math.random()}`,
  normalizedTextHash: `normhash-${Math.random()}`,
  documentType: 'EARNINGS_CALL_TRANSCRIPT',
  title: 'Mock Atlas fixture (not a real filing)',
  fiscalYear: 'FY2099',
  fiscalQuarter: null,
  publishedAt: new Date('2099-01-01'),
  sourceUrl: 'https://example.com/mock-atlas-doc.pdf',
  pageStart: 1,
  pageEnd: 1,
  chunkIndex: 0,
  text: 'Operating margin guidance for the fiscal year was reaffirmed by management on the call today.',
  approximateTokenCount: 12,
  sourceAuthority: 'EXCHANGE_FILING',
  embeddingModel: 'text-embedding-3-small',
  embeddingVersion: '1',
  documentTruncated: false,
  documentExtractionCoveragePct: 100,
  __atlasScore: 0.5,
  __score: 0.5,
  ...overrides,
});

/** Monkey-patches ResearchDocumentChunk.aggregate for the duration of `fn`, capturing every call's pipeline argument. Restores the real implementation afterward, even on throw -- this project's Atlas code is never permanently mocked, only for the scope of one test. */
const withMockedAggregate = async (impl, fn) => {
  const original = ResearchDocumentChunk.aggregate.bind(ResearchDocumentChunk);
  const calls = [];
  ResearchDocumentChunk.aggregate = async (pipeline) => {
    calls.push(pipeline);
    return impl(pipeline);
  };
  try {
    await fn(calls);
  } finally {
    ResearchDocumentChunk.aggregate = original;
  }
};

const withOpenAiConfigured = async (fn) => {
  if (HAS_OPENAI_KEY) return fn();
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-mock-key-not-real';
  try {
    return await fn();
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
};

/** When OPENAI_API_KEY is not genuinely configured, the query-embed step itself must also be mocked (embedChunks calls the real OpenAI client otherwise) -- these pipeline-level tests care about the Atlas aggregate stage, not the embedding call, so a fake but well-shaped embedding vector is injected via mocking the embeddings client only when no real key exists. */
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

const withMockedEmbeddingClient = async (fn) => {
  if (HAS_OPENAI_KEY) return fn();
  const originalGetClient = OpenAIClientFactory.getClient;
  OpenAIClientFactory.getClient = () => ({
    embeddings: {
      create: async () => ({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }], usage: { total_tokens: 5 } }),
    },
  });
  try {
    return await withOpenAiConfigured(fn);
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
  }
};

// ---------------------------------------------------------------------------
// Pipeline construction / metadata pre-filters / symbol+period isolation
// ---------------------------------------------------------------------------
test('required: ATLAS_VECTOR pipeline construction -- $vectorSearch stage carries the right index/path and mandatory metadata pre-filters', async () => {
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [],
    async (calls) => {
      await retrieveResearchEvidence({
        query: 'operating margin guidance', symbols: ['TCS'], fiscalYears: ['FY2099'], documentTypes: ['EARNINGS_CALL_TRANSCRIPT'], mode: 'ATLAS_VECTOR',
      });
      assert.equal(calls.length, 1);
      const stage = calls[0][0].$vectorSearch;
      assert.equal(stage.index, 'research_chunk_vector_index');
      assert.equal(stage.path, 'embedding');
      assert.ok(Array.isArray(stage.queryVector) && stage.queryVector.length === 1536);
      assert.deepEqual(stage.filter.symbol, { $in: ['TCS'] });
      assert.deepEqual(stage.filter.fiscalYear, { $in: ['FY2099'] });
      assert.deepEqual(stage.filter.documentType, { $in: ['EARNINGS_CALL_TRANSCRIPT'] });
      assert.ok(stage.filter.embeddingModel, 'embeddingModel must be part of the mandatory pre-filter');
      assert.ok(stage.filter.embeddingVersion, 'embeddingVersion must be part of the mandatory pre-filter');
    },
  ));
});

test('required: ATLAS_HYBRID_FUSION applies the SAME mandatory metadata pre-filters as ATLAS_VECTOR, before any lexical/cosine scoring', async () => {
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [],
    async (calls) => {
      await retrieveResearchEvidence({
        query: 'operating margin guidance fiscal year', symbols: ['INFY'], fiscalYears: ['FY2050'], mode: 'ATLAS_HYBRID_FUSION',
      });
      assert.equal(calls.length, 1);
      const stage = calls[0][0].$vectorSearch;
      assert.deepEqual(stage.filter.symbol, { $in: ['INFY'] });
      assert.deepEqual(stage.filter.fiscalYear, { $in: ['FY2050'] });
    },
  ));
});

// ---------------------------------------------------------------------------
// Empty results / timeout / failure classification
// ---------------------------------------------------------------------------
test('required: an empty Atlas result set produces EMPTY, never a fabricated result', async () => {
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [],
    async () => {
      const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['TCS'], mode: 'ATLAS_VECTOR' });
      assert.equal(r.status, RETRIEVAL_STATUS.EMPTY);
      assert.deepEqual(r.results, []);
    },
  ));
});

test('required: an Atlas aggregate failure (index missing/cluster unreachable/timeout) reports UNAVAILABLE honestly, never a silent fallback to a different mode', async () => {
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => { throw new Error('simulated: index not found'); },
    async () => {
      const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
      assert.equal(r.status, RETRIEVAL_STATUS.UNAVAILABLE);
      assert.equal(r.retrievalMode, RETRIEVAL_MODES.ATLAS_HYBRID_FUSION, 'must never silently relabel itself as LEXICAL_FALLBACK or any other mode');
    },
  ));
});

test('required: ATLAS_VECTOR/ATLAS_HYBRID_FUSION are UNSUPPORTED (never silently fall back) when OpenAI is not configured to embed the query', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const r1 = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['TCS'], mode: 'ATLAS_VECTOR' });
    assert.equal(r1.status, RETRIEVAL_STATUS.UNSUPPORTED);
    const r2 = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
    assert.equal(r2.status, RETRIEVAL_STATUS.UNSUPPORTED);
  } finally {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
  }
});

// ---------------------------------------------------------------------------
// Citation provenance / no raw vectors / no mutation
// ---------------------------------------------------------------------------
test('required: citation provenance -- every required field survives into the returned evidence shape', async () => {
  // __score must clear ATLAS_VECTOR's own (0.75) relevance threshold --
  // distinct from LOCAL_HYBRID_RERANK's lexical-scale default.
  const fake = fakeVectorSearchDoc({ __score: 0.9, __atlasScore: 0.9 });
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [fake],
    async () => {
      const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], mode: 'ATLAS_VECTOR' });
      assert.equal(r.status, RETRIEVAL_STATUS.SUCCESS);
      const top = r.results[0];
      assert.equal(top.symbol, 'TCS');
      assert.equal(top.fiscalYear, 'FY2099');
      assert.equal(top.documentType, 'EARNINGS_CALL_TRANSCRIPT');
      assert.equal(top.sourceUrl, fake.sourceUrl);
      assert.equal(top.pageStart, 1);
      assert.equal(top.pageEnd, 1);
      assert.equal(top.chunkId, String(fake._id));
      assert.equal(top.registryDocumentId, String(fake.registryDocumentId));
      assert.equal(top.sourceAuthority, 'EXCHANGE_FILING');
      assert.ok(!('embedding' in top), 'raw vector must never be exposed on a returned result');
    },
  ));
});

test('required: no mutation of stored chunks or golden fixtures -- an Atlas call never writes', async () => {
  const originalUpdateOne = ResearchDocumentChunk.updateOne;
  let writeAttempted = false;
  ResearchDocumentChunk.updateOne = (...args) => { writeAttempted = true; return originalUpdateOne.apply(ResearchDocumentChunk, args); };
  try {
    await withMockedEmbeddingClient(() => withMockedAggregate(
      () => [fakeVectorSearchDoc({})],
      async () => {
        await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
      },
    ));
  } finally {
    ResearchDocumentChunk.updateOne = originalUpdateOne;
  }
  assert.equal(writeAttempted, false, 'retrieval must never write to the chunk collection');
});

// ---------------------------------------------------------------------------
// Hybrid score calculation / normalization / deterministic tie-breaking /
// revised-vs-superseded (recency) ranking
// ---------------------------------------------------------------------------
test('required: ATLAS_HYBRID_FUSION exposes score components (vectorSearchScore, sentenceScore, recencyScore, rrfScore, finalScore) for audit', async () => {
  const fake = fakeVectorSearchDoc({ text: 'We are retaining our operating margin guidance for the fiscal year at a steady range.' });
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [fake],
    async () => {
      const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
      assert.equal(r.status, RETRIEVAL_STATUS.SUCCESS);
      const { debug } = r.results[0];
      for (const field of ['vectorSearchScore', 'sentenceScore', 'recencyScore', 'rrfScore', 'finalScore', 'lexicalScore']) {
        assert.ok(field in debug, `debug.${field} must be present for audit`);
      }
    },
  ));
});

test('required: a chunk with essentially no lexical relevance is never rescued by a high Atlas vector score', async () => {
  const fake = fakeVectorSearchDoc({ text: 'Employee cafeteria menu options were updated this month.', __atlasScore: 0.99 });
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [fake],
    async () => {
      const r = await retrieveResearchEvidence({ query: 'operating margin guidance for the fiscal year', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
      assert.equal(r.status, RETRIEVAL_STATUS.EMPTY, 'a near-zero lexical match must never be rescued purely by a high vector score');
    },
  ));
});

test('required: revised (more recent) guidance is nudged above superseded (older) guidance when other signals are close -- general recency, not company-specific', async () => {
  const older = fakeVectorSearchDoc({
    _id: new mongoose.Types.ObjectId(),
    pageStart: 1,
    pageEnd: 1,
    chunkIndex: 1,
    publishedAt: new Date('2020-01-01'),
    text: 'We are retaining our operating margin guidance for the fiscal year at a wide range.',
    __atlasScore: 0.5,
  });
  const newer = fakeVectorSearchDoc({
    _id: new mongoose.Types.ObjectId(),
    pageStart: 2,
    pageEnd: 2,
    chunkIndex: 2,
    publishedAt: new Date('2020-06-01'),
    text: 'We are retaining our operating margin guidance for the fiscal year at a narrow range.',
    __atlasScore: 0.5,
  });
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [older, newer],
    async () => {
      const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
      assert.equal(r.status, RETRIEVAL_STATUS.SUCCESS);
      assert.ok(r.results.length >= 1);
      assert.equal(r.results[0].pageStart, 2, 'with atlasScore and lexical relevance tied, the more recently-published chunk must rank first');
    },
  ));
});

test('deterministic tie-breaking: repeated identical calls against the same mocked Atlas response produce the same ranking order every time', async () => {
  const a = fakeVectorSearchDoc({
    _id: new mongoose.Types.ObjectId(), pageStart: 1, pageEnd: 1, chunkIndex: 1, __atlasScore: 0.5,
  });
  const b = fakeVectorSearchDoc({
    _id: new mongoose.Types.ObjectId(), pageStart: 2, pageEnd: 2, chunkIndex: 2, __atlasScore: 0.5,
  });
  const orders = [];
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [a, b],
    async () => {
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
        orders.push(r.results.map((x) => x.pageStart).join(','));
      }
    },
  ));
  assert.equal(new Set(orders).size, 1, 'identical input must always produce the identical output order -- no nondeterminism');
});

test('required: duplicate/near-duplicate results are removed after ranking', async () => {
  const sameText = 'We are retaining our operating margin guidance for the fiscal year at a steady range overall.';
  const a = fakeVectorSearchDoc({
    _id: new mongoose.Types.ObjectId(), pageStart: 1, pageEnd: 1, chunkIndex: 1, text: sameText, __atlasScore: 0.6,
  });
  const b = fakeVectorSearchDoc({
    _id: new mongoose.Types.ObjectId(), pageStart: 2, pageEnd: 2, chunkIndex: 2, text: `${sameText}!`, __atlasScore: 0.5,
  });
  await withMockedEmbeddingClient(() => withMockedAggregate(
    () => [a, b],
    async () => {
      const r = await retrieveResearchEvidence({ query: 'operating margin guidance fiscal year', symbols: ['TCS'], mode: 'ATLAS_HYBRID_FUSION' });
      assert.equal(r.results.length, 1, 'near-identical text must collapse to a single result');
    },
  ));
});

// ---------------------------------------------------------------------------
// Feature-flag behavior
// ---------------------------------------------------------------------------
test('required: ATLAS modes are never selected by default -- an explicit mode is required even with VECTOR_SEARCH_ENABLED unset', async () => {
  const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['TCS'] });
  assert.notEqual(r.retrievalMode, RETRIEVAL_MODES.ATLAS_VECTOR);
  assert.notEqual(r.retrievalMode, RETRIEVAL_MODES.ATLAS_HYBRID_FUSION);
});

test('required: VECTOR_SEARCH_ENABLED=true selects ATLAS_VECTOR as the default mode (existing convention), never ATLAS_HYBRID_FUSION implicitly', async () => {
  const original = process.env.VECTOR_SEARCH_ENABLED;
  process.env.VECTOR_SEARCH_ENABLED = 'true';
  try {
    await withMockedEmbeddingClient(() => withMockedAggregate(
      () => [],
      async () => {
        const r = await retrieveResearchEvidence({ query: 'operating margin guidance', symbols: ['TCS'] });
        assert.equal(r.retrievalMode, RETRIEVAL_MODES.ATLAS_VECTOR);
      },
    ));
  } finally {
    if (original !== undefined) process.env.VECTOR_SEARCH_ENABLED = original; else delete process.env.VECTOR_SEARCH_ENABLED;
  }
});
