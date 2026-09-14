import test from 'node:test';
import assert from 'node:assert/strict';
import { embedChunks } from '../services/EmbeddingService.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

const chunk = (text, overrides = {}) => ({ text, ...overrides });

const withFakeClient = async (createImpl, fn) => {
  const originalGetClient = OpenAIClientFactory.getClient;
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({ embeddings: { create: createImpl } });
  try {
    return await fn();
  } finally {
    OpenAIClientFactory.getClient = originalGetClient;
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
};

test('embeds a small set of chunks in one batch, returning a real-shaped vector per chunk', async () => {
  const calls = [];
  await withFakeClient(async (args) => {
    calls.push(args);
    return { data: args.input.map((_, i) => ({ embedding: [i, i + 1, i + 2] })), usage: { total_tokens: 30 } };
  }, async () => {
    const { results, diagnostics } = await embedChunks([chunk('a'), chunk('b'), chunk('c')], { batchSize: 32 });
    assert.equal(calls.length, 1, 'three chunks under the batch size must be a single API call');
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === 'EMBEDDED'));
    assert.deepEqual(results[1].embedding, [1, 2, 3]);
    assert.equal(diagnostics.embedded, 3);
    assert.equal(diagnostics.apiCalls, 1);
    assert.equal(diagnostics.totalInputTokens, 30);
  });
});

test('batches: chunks beyond batchSize are split into multiple API calls', async () => {
  const calls = [];
  await withFakeClient(async (args) => {
    calls.push(args.input.length);
    return { data: args.input.map(() => ({ embedding: [0] })), usage: {} };
  }, async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => chunk(`chunk-${i}`));
    const { diagnostics } = await embedChunks(chunks, { batchSize: 4, concurrency: 1 });
    assert.deepEqual(calls, [4, 4, 2]);
    assert.equal(diagnostics.batches, 3);
    assert.equal(diagnostics.embedded, 10);
  });
});

test('resume support: a chunk already embedded with the SAME model+version is skipped, never re-sent', async () => {
  let calls = 0;
  await withFakeClient(async (args) => {
    calls += 1;
    return { data: args.input.map(() => ({ embedding: [9] })), usage: {} };
  }, async () => {
    const chunks = [
      chunk('new chunk'),
      chunk('already done', { embedding: [1, 2, 3], embeddingModel: 'text-embedding-3-small', embeddingVersion: '1' }),
    ];
    const { results, diagnostics } = await embedChunks(chunks, { model: 'text-embedding-3-small', embeddingVersion: '1' });
    assert.equal(diagnostics.skipped, 1);
    assert.equal(diagnostics.embedded, 1);
    const sentInputs = calls; // only the new chunk's batch should have been sent
    assert.equal(sentInputs, 1);
    assert.equal(results.find((r) => r.chunk.text === 'already done').status, 'SKIPPED_UNCHANGED');
  });
});

test('a chunk previously embedded under a DIFFERENT model is re-embedded, never mixed with the old vector', async () => {
  await withFakeClient(async (args) => ({ data: args.input.map(() => ({ embedding: [7] })), usage: {} }), async () => {
    const chunks = [chunk('text', { embedding: [1, 2, 3], embeddingModel: 'text-embedding-ada-002', embeddingVersion: '1' })];
    const { results, diagnostics } = await embedChunks(chunks, { model: 'text-embedding-3-small', embeddingVersion: '1' });
    assert.equal(diagnostics.skipped, 0);
    assert.equal(results[0].status, 'EMBEDDED');
    assert.equal(results[0].embeddingModel, 'text-embedding-3-small');
  });
});

test('retry classification: a RATE_LIMITED (retryable) failure is retried once and then succeeds', async () => {
  let attempts = 0;
  await withFakeClient(async (args) => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error('rate limited'); err.status = 429; err.name = 'RateLimitError';
      throw err;
    }
    return { data: args.input.map(() => ({ embedding: [1] })), usage: {} };
  }, async () => {
    const { results, diagnostics } = await embedChunks([chunk('a')]);
    assert.equal(attempts, 2, 'must retry exactly once on a retryable failure');
    assert.equal(results[0].status, 'EMBEDDED');
    assert.equal(diagnostics.failed, 0);
  });
});

test('retry classification: a non-retryable failure (authentication) is never retried', async () => {
  let attempts = 0;
  await withFakeClient(async () => {
    attempts += 1;
    const err = new Error('bad key'); err.status = 401; err.name = 'AuthenticationError';
    throw err;
  }, async () => {
    const { results, diagnostics } = await embedChunks([chunk('a')]);
    assert.equal(attempts, 1, 'an authentication failure must never be retried');
    assert.equal(results[0].status, 'FAILED');
    assert.equal(diagnostics.failed, 1);
  });
});

test('retry classification: retries are capped at once even for a persistently retryable failure', async () => {
  let attempts = 0;
  await withFakeClient(async () => {
    attempts += 1;
    const err = new Error('still limited'); err.status = 429; err.name = 'RateLimitError';
    throw err;
  }, async () => {
    const { results } = await embedChunks([chunk('a')]);
    assert.equal(attempts, 2, 'exactly one retry (2 total attempts), never unbounded');
    assert.equal(results[0].status, 'FAILED');
  });
});

test('partial failure and resume: one batch failing never affects another batch\'s successful results', async () => {
  await withFakeClient(async (args) => {
    if (args.input[0].includes('bad')) {
      const err = new Error('upstream down'); err.status = 500; err.name = 'InternalServerError';
      throw err;
    }
    return { data: args.input.map(() => ({ embedding: [1] })), usage: {} };
  }, async () => {
    const chunks = [chunk('good-1'), chunk('good-2'), chunk('bad-1'), chunk('bad-2')];
    const { results, diagnostics } = await embedChunks(chunks, { batchSize: 2, concurrency: 2 });
    assert.equal(diagnostics.embedded, 2);
    assert.equal(diagnostics.failed, 2);
    assert.equal(results.find((r) => r.chunk.text === 'good-1').status, 'EMBEDDED');
    assert.equal(results.find((r) => r.chunk.text === 'bad-1').status, 'FAILED');
  });
});

test('timeout: a hung request is aborted at the configured per-request timeout', async () => {
  await withFakeClient(async (args, { signal } = {}) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'APIConnectionTimeoutError'; reject(e); });
  }), async () => {
    const { results } = await embedChunks([chunk('a')], { timeoutMs: 30 });
    assert.equal(results[0].status, 'FAILED');
  });
});

test('never calls the API when OpenAI is not configured, and reports NOT_CONFIGURED honestly', async () => {
  const originalIsConfigured = OpenAIClientFactory.isConfigured;
  OpenAIClientFactory.isConfigured = () => false;
  try {
    const { results, diagnostics } = await embedChunks([chunk('a')]);
    assert.equal(results[0].status, 'NOT_CONFIGURED');
    assert.equal(diagnostics.embedded, 0);
  } finally {
    OpenAIClientFactory.isConfigured = originalIsConfigured;
  }
});

test('diagnostics never contain the API key or chunk text, only counts/codes/model names', async () => {
  await withFakeClient(async (args) => ({ data: args.input.map(() => ({ embedding: [1] })), usage: { total_tokens: 5 } }), async () => {
    const { diagnostics } = await embedChunks([chunk('secret-looking-text-content')]);
    const serialized = JSON.stringify(diagnostics);
    assert.ok(!serialized.includes('secret-looking-text-content'));
    assert.ok(!/sk-[a-zA-Z0-9]/.test(serialized));
  });
});
