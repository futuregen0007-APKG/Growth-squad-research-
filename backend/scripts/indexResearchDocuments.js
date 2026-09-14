/**
 * indexResearchDocuments.js
 * ============================
 * `npm run rag:index -- --symbols=TCS,INFY --dry-run`
 * `npm run rag:index -- --symbols=TCS,INFY --batch-size=5 --resume`
 * `npm run rag:index -- --status-only`
 *
 * Phase 4A RAG indexer: reads ALREADY-DOWNLOADED, durably-stored real
 * documents from CompanyDocumentRegistry + DocumentStorageService (GridFS/
 * S3 — see providers/ExchangeFilingDocumentProvider.js's
 * getDocumentBuffer), extracts page-aware text (services/
 * FactExtractionService.js's extractPdfPages, already page-boundary-aware
 * — reused, not reimplemented), chunks it deterministically (services/
 * DocumentChunkingService.js), embeds each chunk (services/
 * EmbeddingService.js), and upserts into ResearchDocumentChunk.
 *
 * Never indexes the full ~205-stock universe: with no --symbols flag, the
 * default is the small documented canary (TCS, INFY) — an unbounded run
 * requires an explicit, deliberate --symbols list naming every symbol.
 *
 * Idempotent: re-running against an unchanged document is a true no-op
 * (chunkHash-based upsert — see the model's own note); --resume
 * additionally skips a document whose current pdfHash already has at
 * least one indexed chunk, so a genuinely already-processed document is
 * never re-downloaded/re-extracted/re-chunked at all, not just
 * re-embedded-and-discarded.
 *
 * Never destructive: there is no "wipe and rebuild" mode. The only
 * removal path (--force-reindex-symbol=SYMBOL) is scoped to one exact
 * symbol, requires an explicit opt-in flag, and only ever deletes chunks
 * for THAT symbol before reprocessing it — never a blanket reset.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import { ResearchDocumentChunk } from '../models/ResearchDocumentChunk.js';
import { getDocumentBuffer } from '../providers/ExchangeFilingDocumentProvider.js';
import { extractPdfPages } from '../services/FactExtractionService.js';
import { chunkDocument, CHUNKING_VERSION } from '../services/DocumentChunkingService.js';
import { embedChunks } from '../services/EmbeddingService.js';
import { LLM_CONFIG } from '../llm/OpenAIClientFactory.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const DEFAULT_CANARY_SYMBOLS = ['TCS', 'INFY'];
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_RUNTIME_MIN = 30;

const now = () => Date.now();

/** A document is a candidate for a resume-skip once it has at least one chunk indexed against its CURRENT pdfHash — a changed document (new pdfHash) is never skipped, regardless of --resume. */
const hasCurrentChunks = async (registryDoc) => {
  if (!registryDoc.pdfHash) return false;
  const existing = await ResearchDocumentChunk.findOne({ registryDocumentId: registryDoc._id, documentHash: registryDoc.pdfHash }).select('_id').lean();
  return Boolean(existing);
};

const sourceAuthorityFor = (registryDoc) => (registryDoc.sourceType === 'EXCHANGE_FILING' ? 'EXCHANGE_FILING' : registryDoc.sourceType || 'UNKNOWN');

/**
 * run - the exported, testable core. `options.registryQuery` lets tests
 * inject a narrower/synthetic set of documents without touching the CLI
 * arg-parsing layer.
 */
export const run = async (options = {}) => {
  const symbols = options.symbols?.length ? options.symbols.map((s) => s.toUpperCase()) : DEFAULT_CANARY_SYMBOLS;
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const dryRun = Boolean(options.dryRun);
  const resume = Boolean(options.resume);
  const maxRuntimeMs = (options.maxRuntimeMin ?? DEFAULT_MAX_RUNTIME_MIN) * 60 * 1000;
  const chunkingOptions = options.chunkingOptions || {};
  const embeddingOptions = options.embeddingOptions || {};
  const forceReindexSymbol = options.forceReindexSymbol ? String(options.forceReindexSymbol).toUpperCase() : null;

  const startedAt = now();
  const summary = {
    symbols,
    dryRun,
    documentsConsidered: 0,
    documentsProcessed: 0,
    documentsSkippedResume: 0,
    documentsFailed: 0,
    pagesExtracted: 0,
    pagesRejected: 0,
    chunksCreated: 0,
    chunksEmbedded: 0,
    chunksSkippedUnchanged: 0,
    chunksFailed: 0,
    stoppedForRuntime: false,
    perDocument: [],
  };

  if (forceReindexSymbol) {
    if (dryRun) {
      summary.wouldForceReindex = forceReindexSymbol;
    } else {
      const deleted = await ResearchDocumentChunk.deleteMany({ symbol: forceReindexSymbol });
      logger.info(`[indexResearchDocuments] --force-reindex-symbol=${forceReindexSymbol}: removed ${deleted.deletedCount} existing chunk(s) for this symbol only`);
      summary.forceReindexedSymbol = forceReindexSymbol;
      summary.forceReindexDeletedChunks = deleted.deletedCount;
    }
  }

  const registryQuery = options.registryDocs
    ? Promise.resolve(options.registryDocs)
    : CompanyDocumentRegistry.find({
      symbol: { $in: symbols },
      extractionStatus: 'EXTRACTED',
      storageKey: { $ne: null },
      storageBackend: { $ne: null },
    }).limit(500).lean();

  const registryDocs = await registryQuery;
  summary.documentsConsidered = registryDocs.length;

  for (const registryDoc of registryDocs) {
    if (now() - startedAt > maxRuntimeMs) { summary.stoppedForRuntime = true; break; }
    if (summary.documentsProcessed - summary.documentsSkippedResume >= batchSize) break;

    const docSummary = { symbol: registryDoc.symbol, url: registryDoc.url, fiscalYear: registryDoc.fiscalYear, status: null };

    if (resume && await hasCurrentChunks(registryDoc)) {
      docSummary.status = 'SKIPPED_RESUME';
      summary.documentsSkippedResume += 1;
      summary.perDocument.push(docSummary);
      continue;
    }

    if (dryRun) {
      docSummary.status = 'WOULD_PROCESS';
      summary.documentsProcessed += 1;
      summary.perDocument.push(docSummary);
      continue;
    }

    try {
      const { buffer, source } = await getDocumentBuffer(registryDoc);
      if (!buffer) {
        docSummary.status = 'FAILED';
        docSummary.error = 'No document bytes available (durable copy missing and re-fetch failed)';
        summary.documentsFailed += 1;
        summary.perDocument.push(docSummary);
        continue; // never deletes any previously-successful chunks for this or any other document
      }

      const pages = await extractPdfPages(buffer);
      summary.pagesExtracted += pages.length;

      const { chunks, rejectedPages, pagesConsidered, truncatedToPageLimit, truncatedToChunkLimit } = chunkDocument(pages, {
        documentHash: registryDoc.pdfHash,
        ...chunkingOptions,
      });
      summary.pagesRejected += rejectedPages.length;
      docSummary.pagesExtracted = pages.length;
      docSummary.pagesRejected = rejectedPages.length;
      docSummary.truncatedToPageLimit = truncatedToPageLimit;
      docSummary.truncatedToChunkLimit = truncatedToChunkLimit;

      if (!chunks.length) {
        docSummary.status = 'FAILED';
        docSummary.error = 'No usable chunks extracted (all pages rejected or corrupted)';
        summary.documentsFailed += 1;
        summary.perDocument.push(docSummary);
        continue;
      }

      const { results: embedResults, diagnostics: embedDiag } = await embedChunks(
        chunks.map((c) => ({ ...c, embedding: undefined, embeddingModel: null, embeddingVersion: null })),
        { model: LLM_CONFIG.embeddingModel, embeddingVersion: LLM_CONFIG.embeddingVersion, ...embeddingOptions },
      );

      let created = 0;
      for (const item of embedResults) {
        const chunk = item.chunk;
        const baseDoc = {
          symbol: registryDoc.symbol,
          registryDocumentId: registryDoc._id,
          documentHash: registryDoc.pdfHash,
          chunkHash: chunk.chunkHash,
          documentType: registryDoc.sourceType && ['ANNUAL_REPORT', 'FINANCIAL_RESULTS', 'INVESTOR_PRESENTATION', 'EARNINGS_CALL_TRANSCRIPT', 'PRESS_RELEASE', 'EXCHANGE_FILING'].includes(registryDoc.sourceType)
            ? registryDoc.sourceType : 'OTHER',
          title: registryDoc.companyName ? `${registryDoc.companyName} — ${registryDoc.sourceType}` : null,
          fiscalYear: registryDoc.fiscalYear,
          publishedAt: registryDoc.publicationDate || null,
          sourceUrl: registryDoc.url,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          approximateTokenCount: chunk.approximateTokenCount,
          sourceAuthority: sourceAuthorityFor(registryDoc),
          storageBackend: registryDoc.storageBackend,
          storageKey: registryDoc.storageKey,
          extractedWithVersion: CHUNKING_VERSION,
        };

        const setFields = { ...baseDoc };
        // Only a genuinely successful embedding ever overwrites the
        // embedding fields — a FAILED embed still upserts the chunk's
        // text/metadata (so it exists for a future embed-only retry) but
        // leaves embedding/embeddingModel/embeddingVersion/indexedAt
        // completely alone, never nulling out a prior success.
        if (item.status === 'EMBEDDED') {
          setFields.embedding = item.embedding;
          setFields.embeddingModel = item.embeddingModel;
          setFields.embeddingVersion = item.embeddingVersion;
          setFields.indexedAt = new Date();
        }

        await ResearchDocumentChunk.updateOne(
          { chunkHash: chunk.chunkHash },
          { $set: setFields },
          { upsert: true },
        );
        created += 1;
      }

      summary.chunksCreated += created;
      summary.chunksEmbedded += embedDiag.embedded;
      summary.chunksSkippedUnchanged += embedDiag.skipped;
      summary.chunksFailed += embedDiag.failed;

      docSummary.status = 'PROCESSED';
      docSummary.chunksCreated = created;
      docSummary.chunksEmbedded = embedDiag.embedded;
      docSummary.chunksFailed = embedDiag.failed;
      docSummary.storageSource = source;
      summary.documentsProcessed += 1;
      summary.perDocument.push(docSummary);
    } catch (error) {
      logger.warn(`[indexResearchDocuments] ${registryDoc.symbol} ${registryDoc.url} failed: ${error.message}`);
      docSummary.status = 'FAILED';
      docSummary.error = error.message;
      summary.documentsFailed += 1;
      summary.perDocument.push(docSummary);
      // Never delete previously-successful chunks for this document — a
      // failure here simply leaves whatever chunks already existed alone.
    }
  }

  return summary;
};

/** Read-only status report — counts only, never a write. */
export const status = async (options = {}) => {
  const symbols = options.symbols?.length ? options.symbols.map((s) => s.toUpperCase()) : DEFAULT_CANARY_SYMBOLS;
  const registryCounts = await CompanyDocumentRegistry.aggregate([
    { $match: { symbol: { $in: symbols } } },
    { $group: { _id: { symbol: '$symbol', extractionStatus: '$extractionStatus' }, count: { $sum: 1 } } },
  ]);
  const chunkCounts = await ResearchDocumentChunk.aggregate([
    { $match: { symbol: { $in: symbols } } },
    { $group: { _id: '$symbol', chunks: { $sum: 1 }, embedded: { $sum: { $cond: [{ $ne: ['$indexedAt', null] }, 1, 0] } } } },
  ]);
  return { symbols, registryCounts, chunkCounts };
};

const parseArgs = (argv) => {
  const get = (flag) => { const arg = argv.find((x) => x.startsWith(`${flag}=`)); return arg ? arg.split('=').slice(1).join('=') : null; };
  const symbolsArg = get('--symbols');
  return {
    symbols: symbolsArg ? symbolsArg.split(',').map((s) => s.trim()).filter(Boolean) : null,
    dryRun: argv.includes('--dry-run'),
    resume: argv.includes('--resume'),
    statusOnly: argv.includes('--status-only'),
    batchSize: Number(get('--batch-size')) || DEFAULT_BATCH_SIZE,
    maxRuntimeMin: Number(get('--max-runtime')) || DEFAULT_MAX_RUNTIME_MIN,
    forceReindexSymbol: get('--force-reindex-symbol'),
    fiscalYearFrom: get('--fiscal-year-from'),
    fiscalYearTo: get('--fiscal-year-to'),
    documentTypes: get('--document-types') ? get('--document-types').split(',').map((s) => s.trim()) : null,
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    const args = parseArgs(process.argv.slice(2));

    if (args.statusOnly) {
      const report = await status(args);
      console.log(JSON.stringify(report, null, 2));
    } else {
      const summary = await run(args);
      console.log(JSON.stringify(summary, null, 2));
    }

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[indexResearchDocuments] Failed: ${err.message}`);
    console.error('Indexing failed:', err.message);
    process.exit(1);
  });
}

export default run;
