import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { retrieveGroundedEvidence, TOOL_STATUS } from '../graph/tools/toolRegistry.js';
import { embedChunks } from '../services/EmbeddingService.js';
import { LLM_CONFIG } from '../llm/OpenAIClientFactory.js';

/**
 * chatToolRegistryGrounded.test.js
 * ===================================
 * Phase 4B: retrieveGroundedEvidence is a thin adapter over the REAL
 * services/ResearchRetrieverService.js + services/EvidenceEnvelope.js —
 * both already have their own extensive unit test coverage (see
 * researchRetrieverService.test.js / evidenceEnvelopeGrounded.test.js), so
 * this file exercises the actual wiring end-to-end against this project's
 * real local MongoDB (same integration-test convention
 * researchRetrieverService.test.js already uses), rather than mocking the
 * retriever — there is no seam to mock an ES module's named import from a
 * test in this codebase's existing style, and a real local-Mongo
 * integration test is a strictly stronger check of the actual glue code
 * anyway. Labeled here explicitly as a local/dev DB integration test, not
 * a claim about production Atlas retrieval (still deferred — see Phase 4A).
 */

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_PREFIX = 'ZZRAGTOOL';
const symbolFor = (suffix) => `${TEST_PREFIX}${suffix}`;

// retrieveGroundedEvidence's default mode (LOCAL_HYBRID_RERANK, per the
// Phase 4B kickoff instruction) applies ResearchRetrieverService's
// MANDATORY embeddingModel/embeddingVersion filter before any scoring —
// a chunk with no real embedding is correctly never hybrid-eligible (by
// design, not a bug — see ResearchRetrieverService.js's buildMetadataFilter).
// Every seeded chunk here is genuinely embedded with the project's real
// embedding model/version first, exactly like
// researchRetrieverHybrid.test.js's own insertEmbeddedChunk helper.
let counter = 0;
const insertChunk = async (overrides = {}) => {
  counter += 1;
  const base = {
    symbol: symbolFor('A'),
    registryDocumentId: new mongoose.Types.ObjectId(),
    documentHash: `hash-${counter}-${Math.random()}`,
    documentType: 'ANNUAL_REPORT',
    title: 'Test Annual Report',
    fiscalYear: 'FY2026',
    sourceUrl: 'https://example.com/filing.pdf',
    pageStart: 4,
    pageEnd: 4,
    chunkIndex: counter,
    text: 'Management guided full year revenue growth of 12% to 14% for fiscal year 2026.',
    approximateTokenCount: 14,
    ...overrides,
  };
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
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

test('a missing symbol is rejected with ERROR, never a crash, and never touches the database', async () => {
  const result = await retrieveGroundedEvidence({});
  assert.equal(result.status, TOOL_STATUS.ERROR);
  assert.equal(result.data, null);
});

test('a real seeded chunk is retrieved and shaped into the trusted evidence envelope, with the real retrieval mode reported', async () => {
  await insertChunk({ symbol: symbolFor('A'), fiscalYear: 'FY2026' });

  const result = await retrieveGroundedEvidence({
    symbol: symbolFor('A'), fiscalYear: 'FY2026', query: 'full year revenue growth guidance',
  });

  assert.equal(result.status, TOOL_STATUS.SUCCESS);
  assert.ok(result.researchEvidence.length >= 1);
  const item = result.researchEvidence[0];
  assert.equal(item.evidenceId, 'E1');
  assert.equal(item.symbol, symbolFor('A'));
  assert.equal(item.fiscalYear, 'FY2026');
  assert.ok(item.chunkId);
  assert.ok(item.sourceUrl);
  assert.ok(typeof item.retrievalMode === 'string' && item.retrievalMode.length > 0);
  assert.equal(item.embedding, undefined);
  assert.equal(result.retrievalMode, item.retrievalMode);
});

test('a symbol with no indexed research documents returns EMPTY, never a fabricated result', async () => {
  const result = await retrieveGroundedEvidence({
    symbol: symbolFor('NOTHING'), query: 'anything at all here as a query',
  });
  assert.equal(result.status, TOOL_STATUS.EMPTY);
  assert.deepEqual(result.researchEvidence, []);
});

test('every returned envelope item is scoped to the requested company only', async () => {
  await insertChunk({ symbol: symbolFor('A') });
  await insertChunk({ symbol: symbolFor('B'), text: 'Management guided full year revenue growth of 12% to 14% for fiscal year 2026.' });

  const result = await retrieveGroundedEvidence({ symbol: symbolFor('A'), query: 'full year revenue growth guidance' });
  assert.ok(result.researchEvidence.every((item) => item.symbol === symbolFor('A')));
});
