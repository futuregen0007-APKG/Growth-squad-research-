import { OpenAIClientFactory, LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { mapOpenAIError, OPENAI_ERROR_CODES } from '../llm/errors.js';
import { logger } from '../utils/logger.js';

/**
 * EmbeddingService.js
 * =====================
 * Phase 4A: turns bounded chunk TEXT (never a whole PDF — see
 * DocumentChunkingService.js, which already caps each chunk at a few
 * hundred tokens) into OpenAI embedding vectors, via the same
 * OpenAIClientFactory every other LLM call in this project uses.
 *
 * Design points required by the phase spec:
 *   - configurable model (LLM_CONFIG.embeddingModel, env OPENAI_EMBEDDING_MODEL)
 *   - real batching (one API call embeds up to `batchSize` chunks at once —
 *     OpenAI's embeddings endpoint natively accepts an array of inputs)
 *   - bounded concurrency across batches (no new dependency — a tiny
 *     hand-rolled worker pool, same style as this project's other
 *     concurrency-limited scripts)
 *   - retries ONLY the error codes classified as genuinely retryable by
 *     the SAME mapOpenAIError this project's other OpenAI call sites use
 *     (RATE_LIMITED / TIMEOUT / UPSTREAM_ERROR) — never retries
 *     AUTHENTICATION_FAILED / INSUFFICIENT_QUOTA / MODEL_UNAVAILABLE /
 *     NOT_CONFIGURED, which retrying can never fix
 *   - a per-request timeout + AbortSignal, same pattern as every other
 *     OpenAI call in this codebase
 *   - resume support: a chunk that already has a real embedding vector
 *     for the SAME model+version is skipped, never re-sent
 *   - a chunk that fails is reported as FAILED and left completely alone
 *     by the caller — this module never invents a partial/zero vector,
 *     and the caller (the indexing CLI) is the one responsible for only
 *     writing DB updates for chunks that actually succeeded, so a failed
 *     refresh attempt can never clobber a previously-successful embedding
 *   - usage/count diagnostics (embedded/skipped/failed/apiCalls/tokens)
 *   - never logs the API key — only counts, codes, and short messages
 */

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 250;

const RETRYABLE_CODES = new Set([
  OPENAI_ERROR_CODES.RATE_LIMITED, OPENAI_ERROR_CODES.TIMEOUT, OPENAI_ERROR_CODES.UPSTREAM_ERROR,
]);

/** Tiny hand-rolled concurrency-limited worker pool — no new dependency. */
const runWithConcurrency = async (items, limit, worker) => {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
};

const embedBatchOnce = async (client, model, inputs, timeoutMs, signal) => {
  const localController = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, localController.signal]) : localController.signal;
  const timer = setTimeout(() => localController.abort(), timeoutMs);
  try {
    const response = await client.embeddings.create({ model, input: inputs }, { signal: combinedSignal });
    return { items: response.data, usage: response.usage };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * embedChunks - `chunks` is an array of plain objects each carrying at
 * least `{text, embedding?, embeddingModel?, embeddingVersion?}` (the
 * shape a ResearchDocumentChunk document or a not-yet-saved chunk both
 * satisfy). Returns `{ results, diagnostics }`:
 *   - results: one entry per input chunk, `{chunk, status, embedding?,
 *     embeddingModel?, embeddingVersion?, error?}` — status is one of
 *     SKIPPED_UNCHANGED / EMBEDDED / FAILED / NOT_CONFIGURED.
 *   - diagnostics: safe counts only — never prompt/response content, never
 *     the API key.
 */
export const embedChunks = async (chunks, options = {}) => {
  const model = options.model || LLM_CONFIG.embeddingModel;
  const embeddingVersion = options.embeddingVersion || LLM_CONFIG.embeddingVersion;
  const batchSize = Math.max(1, options.batchSize || DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, options.concurrency || DEFAULT_CONCURRENCY);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const diagnostics = {
    embedded: 0, skipped: 0, failed: 0, apiCalls: 0, batches: 0, totalInputTokens: 0, model, embeddingVersion,
  };

  if (!OpenAIClientFactory.isConfigured()) {
    return {
      results: chunks.map((chunk) => ({ chunk, status: 'NOT_CONFIGURED' })),
      diagnostics,
    };
  }

  const client = OpenAIClientFactory.getClient();
  const results = [];
  const toEmbed = [];

  // Resume support: a chunk already embedded with the SAME model+version
  // is left untouched — vectors are never mixed across model/version, and
  // an unchanged chunk is never re-sent to the API.
  for (const chunk of chunks) {
    const alreadyEmbedded = Array.isArray(chunk.embedding) && chunk.embedding.length > 0
      && chunk.embeddingModel === model && chunk.embeddingVersion === embeddingVersion;
    if (alreadyEmbedded) {
      diagnostics.skipped += 1;
      results.push({ chunk, status: 'SKIPPED_UNCHANGED' });
    } else {
      toEmbed.push(chunk);
    }
  }

  const batches = [];
  for (let i = 0; i < toEmbed.length; i += batchSize) batches.push(toEmbed.slice(i, i + batchSize));

  await runWithConcurrency(batches, concurrency, async (batch) => {
    let attempt = 0;
    let lastMapped = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        diagnostics.apiCalls += 1;
        diagnostics.batches += 1;
        const { items, usage } = await embedBatchOnce(client, model, batch.map((c) => c.text), timeoutMs, signal);
        diagnostics.totalInputTokens += usage?.total_tokens ?? usage?.prompt_tokens ?? 0;
        items.forEach((item, i) => {
          diagnostics.embedded += 1;
          results.push({
            chunk: batch[i], status: 'EMBEDDED', embedding: item.embedding, embeddingModel: model, embeddingVersion,
          });
        });
        if (onProgress) onProgress({ embedded: diagnostics.embedded, skipped: diagnostics.skipped, failed: diagnostics.failed, total: toEmbed.length });
        return;
      } catch (error) {
        const mapped = mapOpenAIError(error, { operation: 'embedChunks' });
        if (mapped.isAbort) {
          batch.forEach((chunk) => results.push({ chunk, status: 'FAILED', error: 'CANCELLED' }));
          diagnostics.failed += batch.length;
          return;
        }
        lastMapped = mapped;
        const retryable = RETRYABLE_CODES.has(mapped.errorCode);
        if (!retryable || attempt >= MAX_RETRIES) break;
        attempt += 1;
        await new Promise((resolve) => { setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt); });
      }
    }
    logger.warn(`[EmbeddingService] batch of ${batch.length} chunks failed (${lastMapped?.errorCode || 'UNKNOWN'}): ${lastMapped?.message || 'unknown error'}`);
    batch.forEach((chunk) => {
      diagnostics.failed += 1;
      results.push({ chunk, status: 'FAILED', error: lastMapped?.errorCode || 'UNKNOWN' });
    });
  });

  return { results, diagnostics };
};

export default { embedChunks };
