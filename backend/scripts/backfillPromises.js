/**
 * backfillPromises.js
 * =====================
 * `npm run earnings:backfill-promises -- --symbol=INFY [--resume] [--from-year=2022 --to-year=2025] [--reset]`
 *
 * --reset clears promiseExtractionStatus back to PENDING before running --
 * scoped to --from-year/--to-year when both are given (never an unscoped
 * reset of every document for the symbol; a real incident this session
 * flipped already-completed FY2026/2027 documents back to PENDING by
 * mistake because the reset wasn't year-scoped).
 *
 * The PROMISE_EXTRACTION + OUTCOME_VERIFICATION stage that connects onto the
 * end of the automated fact-extraction pipeline (backfillHistoricalFacts.js /
 * backfillUniverse.js), closing the gap where that pipeline was populating
 * CompanyHistoricalFact but never ManagementPromise/PromiseCandidate:
 *
 *   DOCUMENT_DISCOVERY -> FINANCIAL_FACT_EXTRACTION -> PROMISE_EXTRACTION
 *   -> OUTCOME_VERIFICATION -> FAITH_SCORE_RECALCULATION
 *
 * Reuses CompanyDocumentRegistry entries already produced by the fact
 * pipeline (never re-discovers documents) and re-fetches only the PDF bytes
 * of documents realistically containing management guidance
 * (EARNINGS_CALL_TRANSCRIPT / FINANCIAL_RESULTS) -- one re-fetch per
 * document, since PDF bytes are never persisted (Render's filesystem is
 * ephemeral). Resumable via promiseExtractionStatus on the registry entry,
 * independent of the fact-extraction pipeline's own extractionStatus.
 *
 * Writes candidates to PromiseCandidate (reviewStatus: PENDING_REVIEW) via
 * the existing PromiseCandidateService.saveCandidates -- the same
 * collision-safe upsert used by the DocumentResearchService-sourced
 * candidate path. FAITH_SCORE_RECALCULATION happens automatically on read
 * (CuratedEarningsIntelligenceService.getCompanyTimeline) once a candidate is
 * ACCEPTED via the existing, protected npm run earnings:review CLI -- this
 * script never bypasses that human-review gate itself.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import { getDocumentBuffer } from '../providers/ExchangeFilingDocumentProvider.js';
import { extractPromisesFromPdfBuffer, buildPromiseCandidate, PROMISE_ELIGIBLE_SOURCE_TYPES } from '../services/PromiseExtractionService.js';
import { saveCandidates } from '../services/PromiseCandidateService.js';
import { getCompanyResearchProfile } from '../research/CompanyResearchProfiles.js';
import { logger } from '../utils/logger.js';

dotenv.config();

// Hard per-document wall-clock bound. Observed live: a single document can
// hang well past any reasonable batch expectation (a 7+ minute stall on one
// INFY FY2023 transcript, traced to an unbounded outcome-verification sweep
// -- since fixed separately in OutcomeEvidenceService.js's tier b, but this
// timeout stays as a second, independent safety net so no future slow path
// in extraction/outcome-verification can ever hang a whole batch run again).
// A timed-out document is marked FAILED (retryable via --resume), never left
// stuck in an ambiguous state.
const PER_DOCUMENT_TIMEOUT_MS = 120000;

const withTimeout = (promiseValue, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promiseValue, timeout]).finally(() => clearTimeout(timer));
};

/**
 * resetPromiseExtractionStatus - the ONLY sanctioned way to reset progress
 * markers for a re-run. Scoped by fiscalYear range when fromYear/toYear are
 * given -- NEVER resets every document for the symbol as a side effect of
 * narrowing to a range (a real bug hit live this session: resetting "for the
 * FY2022-2025 rediscovery" was implemented as an unscoped reset of ALL INFY
 * documents, including already-completed FY2026/2027 ones, discarding their
 * progress marker even though their candidates already existed).
 */
export const resetPromiseExtractionStatus = async (symbol, { fromYear = null, toYear = null } = {}) => {
  const normalized = String(symbol).toUpperCase();
  const filter = { symbol: normalized };
  if (fromYear && toYear) {
    const years = [];
    for (let y = fromYear; y <= toYear; y += 1) years.push(`FY${y}`);
    filter.fiscalYear = { $in: years };
  }
  const result = await CompanyDocumentRegistry.updateMany(filter, { $set: { promiseExtractionStatus: 'PENDING' } });
  return { symbol: normalized, scoped: Boolean(fromYear && toYear), modifiedCount: result.modifiedCount };
};

export const runPromiseBackfillForSymbol = async (symbol, {
  resume = false, fromYear = null, toYear = null, onProgress = () => {},
} = {}) => {
  const normalized = String(symbol).toUpperCase();
  const profile = getCompanyResearchProfile(normalized);

  const query = { symbol: normalized, sourceType: { $in: [...PROMISE_ELIGIBLE_SOURCE_TYPES] }, extractionStatus: 'EXTRACTED' };
  if (resume) query.promiseExtractionStatus = { $ne: 'EXTRACTED' };
  if (fromYear && toYear) {
    const years = [];
    for (let y = fromYear; y <= toYear; y += 1) years.push(`FY${y}`);
    query.fiscalYear = { $in: years };
  }
  const documents = await CompanyDocumentRegistry.find(query).sort({ publicationDate: 1 }).lean();

  const summary = { symbol: normalized, documentsConsidered: documents.length, documentsProcessed: 0, candidatesGenerated: 0, candidatesSaved: 0, errors: [] };
  let sequence = await CompanyDocumentRegistry.countDocuments({ symbol: normalized, promiseExtractionStatus: 'EXTRACTED' });

  for (let i = 0; i < documents.length; i += 1) {
    const doc = documents[i];
    const progressPrefix = `[${i + 1}/${documents.length}] ${normalized} ${doc.fiscalYear} ${doc.url.slice(-45)}`;
    onProgress(`${progressPrefix} -- starting`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTimeout((async () => {
        const { buffer, source } = await getDocumentBuffer(doc);
        if (!buffer) throw new Error(`No durable copy and source re-fetch failed (${source})`);

        const extracted = await extractPromisesFromPdfBuffer(buffer, {
          symbol: normalized, companyName: doc.companyName, sourceType: doc.sourceType, url: doc.url, title: doc.sourceType,
        });
        onProgress(`${progressPrefix} -- extracted ${extracted.length} raw promise candidate(s), verifying outcomes`);

        const candidates = [];
        for (const item of extracted) {
          sequence += 1;
          // eslint-disable-next-line no-await-in-loop
          const record = await buildPromiseCandidate(item, {
            symbol: normalized, url: doc.url, sourceType: doc.sourceType, title: `${doc.companyName} -- ${doc.sourceType} (${doc.fiscalYear})`, publicationDate: doc.publicationDate, profile,
          }, sequence);
          if (record) candidates.push(record);
        }

        let saved = 0;
        if (candidates.length) {
          const results = await saveCandidates(candidates);
          saved = results.filter((r) => r.action === 'INSERTED' || r.action === 'UPDATED').length;
        }

        await CompanyDocumentRegistry.updateOne({ _id: doc._id }, { $set: { promiseExtractionStatus: 'EXTRACTED', promisesExtracted: candidates.length } });
        summary.documentsProcessed += 1;
        summary.candidatesGenerated += candidates.length;
        summary.candidatesSaved += saved;
        onProgress(`${progressPrefix} -- done: ${candidates.length} candidate(s), ${saved} saved`);
      })(), PER_DOCUMENT_TIMEOUT_MS);
    } catch (error) {
      logger.warn(`[backfillPromises] ${normalized} ${doc.url}: ${error.message}`);
      onProgress(`${progressPrefix} -- FAILED: ${error.message}`);
      summary.errors.push({ url: doc.url, error: error.message });
      // eslint-disable-next-line no-await-in-loop
      await CompanyDocumentRegistry.updateOne({ _id: doc._id }, { $set: { promiseExtractionStatus: 'FAILED' } });
    }
  }

  return summary;
};

const parseArgs = (argv) => ({
  symbol: (argv.find((a) => a.startsWith('--symbol=')) || '').split('=')[1]?.toUpperCase() || null,
  resume: argv.includes('--resume'),
  reset: argv.includes('--reset'),
  fromYear: Number((argv.find((a) => a.startsWith('--from-year=')) || '').split('=')[1]) || null,
  toYear: Number((argv.find((a) => a.startsWith('--to-year=')) || '').split('=')[1]) || null,
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const {
      symbol, resume, reset, fromYear, toYear,
    } = parseArgs(process.argv.slice(2));
    if (!symbol) throw new Error('--symbol is required');

    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    if (reset) {
      const resetResult = await resetPromiseExtractionStatus(symbol, { fromYear, toYear });
      console.log(`Reset promiseExtractionStatus for ${resetResult.modifiedCount} document(s)${resetResult.scoped ? ` (scoped to FY${fromYear}-FY${toYear})` : ' (ALL fiscal years -- no --from-year/--to-year given)'}`);
    }

    const summary = await runPromiseBackfillForSymbol(symbol, {
      resume, fromYear, toYear, onProgress: (line) => console.log(line),
    });
    console.log(`Promise backfill for ${symbol}`);
    console.log('='.repeat(60));
    console.log(`Documents considered: ${summary.documentsConsidered}, processed: ${summary.documentsProcessed}`);
    console.log(`Candidates generated: ${summary.candidatesGenerated}, saved: ${summary.candidatesSaved}`);
    if (summary.errors.length) console.log(`Errors: ${summary.errors.map((e) => `${e.url} -- ${e.error}`).join('; ')}`);

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[earnings:backfill-promises] Failed: ${err.message}`);
    console.error('Promise backfill failed:', err.message);
    process.exit(1);
  });
}

export default runPromiseBackfillForSymbol;
