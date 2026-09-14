/**
 * recoverTcsDurability.js
 * ==========================
 * `npm run rag:recover-tcs -- --dry-run`
 * `npm run rag:recover-tcs -- --batch-size=30 --max-runtime=15`
 * `npm run rag:recover-tcs -- --status-only`
 *
 * Phase 4A.1 hardening, item 5: TCS is the only symbol whose
 * CompanyDocumentRegistry records currently have NO durable copy at all
 * (storageKey/storageBackend both null on all 27 EXTRACTED TCS rows,
 * confirmed in the Phase 4A report) -- meaning the RAG canary indexer
 * (scripts/indexResearchDocuments.js) could never find any TCS bytes to
 * chunk. This script recovers a durable copy for as many of those 27 as
 * still have a reachable source, WITHOUT touching the shared
 * providers/ExchangeFilingDocumentProvider.js `getDocumentBuffer` used by
 * the rest of the pipeline (Phase 1-3 earnings extraction included) --
 * this is a dedicated, narrowly-scoped script built on the same
 * lower-level primitives (fetchRawDocumentBuffer, alternateBseUrl,
 * saveDocument) so it can add its own stricter validation (genuine-PDF
 * check, hash verification against any pre-existing pdfHash) without
 * changing shared pipeline behavior.
 *
 * EXPLICITLY SCOPED TO TCS ONLY in this phase -- `run()` refuses any
 * other symbol outright.
 *
 * Recovery order per document:
 *   1. If a pdfHash is already known, check GridFS directly for an
 *      already-durable copy under that exact hash (content-addressed
 *      storage — see DocumentStorageService.saveDocument) with ZERO
 *      network calls before ever attempting a fetch.
 *   2. Otherwise fetch the original source URL, then (for BSE URLs) the
 *      AttachLive<->AttachHis alternate path.
 *   3. Validate the downloaded bytes are a genuine PDF (a %PDF- magic-byte
 *      check) and are not an HTML challenge/interstitial page.
 *   4. If a pdfHash was already recorded, verify the newly-fetched bytes'
 *      hash matches it -- a mismatch means the URL now serves different
 *      content than what was originally extracted, and is REJECTED
 *      (never silently overwrites provenance with a different document).
 *   5. Only then persist via DocumentStorageService.saveDocument and
 *      update ONLY storageKey/storageBackend/pdfHash on the matching
 *      registry record -- url/companyName/fiscalYear/sourceType and every
 *      other provenance field are left untouched.
 *
 * Never marks a document durable on failure. Never overwrites a record
 * that already has storageKey+storageBackend set (the query itself
 * excludes such rows; the final update is additionally guarded with the
 * same condition as a second safety net).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import { fetchRawDocumentBuffer, alternateBseUrl, hashDocumentContent } from '../providers/ExchangeFilingDocumentProvider.js';
import { saveDocument, getGridFsBucket } from '../services/DocumentStorageService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const REQUIRED_SYMBOL = 'TCS'; // Phase 4A.1 explicitly scopes this recovery to TCS only.
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_MAX_RUNTIME_MIN = 15;

const now = () => Date.now();

/** A real %PDF- magic-byte check -- rejects an HTML 404/challenge page or a truncated download that a bare HTTP 200 wouldn't reveal. */
export const isGenuinePdf = (buffer) => Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';

const CHALLENGE_PATTERNS = /<html|<!doctype|are you a robot|captcha|access denied|enable javascript|page not found|\b404\b|\bforbidden\b/i;
export const looksLikeChallengePage = (buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  const head = buffer.subarray(0, Math.min(2000, buffer.length)).toString('utf8');
  return CHALLENGE_PATTERNS.test(head);
};

/** Content-addressed storage means the SAME bytes may already be durably stored under a different symbol/document -- checked directly against GridFS, no network call, before any fetch is attempted. */
const findExistingDurableCopyByHash = async (pdfHash) => {
  if (!pdfHash) return null;
  try {
    const bucket = getGridFsBucket();
    const existing = await bucket.find({ filename: pdfHash }).limit(1).toArray();
    if (existing.length) return { storageKey: pdfHash, storageBackend: 'GRIDFS' };
  } catch (error) {
    logger.warn(`[recoverTcsDurability] GridFS lookup failed for hash ${pdfHash}: ${error.message}`);
  }
  return null;
};

const attemptFetch = async (url) => {
  try {
    const buffer = await fetchRawDocumentBuffer(url);
    return { buffer, error: null };
  } catch (error) {
    return { buffer: null, error };
  }
};

export const classifyFetchFailure = (error) => {
  if (!error) return 'UNKNOWN';
  const status = error.response?.status;
  if (status === 404) return 'STALE_URL_404';
  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) return 'TIMEOUT';
  if (status && status >= 400) return `HTTP_${status}`;
  return 'NETWORK_ERROR';
};

export const run = async (options = {}) => {
  const symbol = (options.symbol || REQUIRED_SYMBOL).toUpperCase();
  if (symbol !== REQUIRED_SYMBOL) {
    throw new Error(`recoverTcsDurability is explicitly scoped to ${REQUIRED_SYMBOL} only in Phase 4A.1 — refusing to run for ${symbol}`);
  }
  const dryRun = Boolean(options.dryRun);
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const maxRuntimeMs = (options.maxRuntimeMin ?? DEFAULT_MAX_RUNTIME_MIN) * 60 * 1000;
  const startedAt = now();

  const summary = {
    symbol,
    dryRun,
    registryRecordsExamined: 0,
    alreadyDurable: 0,
    recoveredFromExistingStorage: 0,
    recoveredFromFetch: 0,
    staleOrUnavailable: 0,
    failedValidation: 0,
    hashMismatch: 0,
    challengePage: 0,
    timeout: 0,
    stoppedForRuntime: false,
    perDocument: [],
  };

  const query = options.registryDocs
    ? Promise.resolve(options.registryDocs)
    // --resume is inherently satisfied by this filter: any document a
    // prior partial run already recovered now HAS storageKey+
    // storageBackend set and is automatically excluded here, so a second
    // invocation never re-attempts an already-recovered document.
    : CompanyDocumentRegistry.find({ symbol, $or: [{ storageKey: null }, { storageBackend: null }] }).lean();
  const docs = await query;
  summary.registryRecordsExamined = docs.length;
  const bounded = docs.slice(0, batchSize);

  for (const doc of bounded) {
    if (now() - startedAt > maxRuntimeMs) { summary.stoppedForRuntime = true; break; }

    if (doc.storageKey && doc.storageBackend) {
      // Should never happen given the query filter — a defensive no-op.
      summary.alreadyDurable += 1;
      summary.perDocument.push({ url: doc.url, outcome: 'ALREADY_DURABLE' });
      continue;
    }

    if (doc.pdfHash) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await findExistingDurableCopyByHash(doc.pdfHash);
      if (existing) {
        summary.recoveredFromExistingStorage += 1;
        if (!dryRun) {
          // eslint-disable-next-line no-await-in-loop
          await CompanyDocumentRegistry.updateOne(
            { _id: doc._id, $or: [{ storageKey: null }, { storageBackend: null }] },
            { $set: { storageKey: existing.storageKey, storageBackend: existing.storageBackend } },
          );
        }
        summary.perDocument.push({ url: doc.url, outcome: 'RECOVERED_FROM_EXISTING_STORAGE' });
        continue;
      }
    }

    if (dryRun) {
      summary.perDocument.push({ url: doc.url, outcome: 'WOULD_ATTEMPT_FETCH' });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    let fetchResult = await attemptFetch(doc.url);
    let sourceUsed = 'ORIGINAL_URL';
    if (!fetchResult.buffer) {
      const alt = alternateBseUrl(doc.url);
      if (alt) {
        // eslint-disable-next-line no-await-in-loop
        const altResult = await attemptFetch(alt);
        if (altResult.buffer) { fetchResult = altResult; sourceUsed = 'ALTERNATE_BSE_PATH'; }
      }
    }

    if (!fetchResult.buffer) {
      const category = classifyFetchFailure(fetchResult.error);
      summary.staleOrUnavailable += 1;
      if (category === 'TIMEOUT') summary.timeout += 1;
      summary.perDocument.push({ url: doc.url, outcome: 'UNAVAILABLE', reason: category });
      continue;
    }

    const { buffer } = fetchResult;
    if (looksLikeChallengePage(buffer)) {
      summary.challengePage += 1;
      summary.perDocument.push({ url: doc.url, outcome: 'FAILED_VALIDATION', reason: 'CHALLENGE_PAGE' });
      continue;
    }
    if (!isGenuinePdf(buffer)) {
      summary.failedValidation += 1;
      summary.perDocument.push({ url: doc.url, outcome: 'FAILED_VALIDATION', reason: 'NOT_A_PDF' });
      continue;
    }

    const newHash = hashDocumentContent(buffer);
    if (doc.pdfHash && doc.pdfHash !== newHash) {
      summary.hashMismatch += 1;
      summary.perDocument.push({
        url: doc.url, outcome: 'FAILED_VALIDATION', reason: 'HASH_MISMATCH', expectedHash: doc.pdfHash, actualHash: newHash,
      });
      continue; // never mark durable, never overwrite provenance with a different document
    }

    // eslint-disable-next-line no-await-in-loop
    const saved = await saveDocument(buffer, { symbol, url: doc.url });
    // eslint-disable-next-line no-await-in-loop
    const updateResult = await CompanyDocumentRegistry.updateOne(
      { _id: doc._id, $or: [{ storageKey: null }, { storageBackend: null }] }, // never overwrite an existing successful durable record
      { $set: { storageKey: saved.storageKey, storageBackend: saved.storageBackend, pdfHash: saved.documentHash } },
    );
    if (updateResult.modifiedCount > 0) {
      summary.recoveredFromFetch += 1;
      summary.perDocument.push({ url: doc.url, outcome: 'RECOVERED', source: sourceUsed });
    } else {
      // Lost a race with another process that durably stored this
      // document between our read and our write — not a failure, just
      // redundant work; already-durable, never overwritten.
      summary.alreadyDurable += 1;
      summary.perDocument.push({ url: doc.url, outcome: 'ALREADY_DURABLE_RACE' });
    }
  }

  return summary;
};

/** Read-only status report — real registry counts, never a write. */
export const status = async (options = {}) => {
  const symbol = (options.symbol || REQUIRED_SYMBOL).toUpperCase();
  const total = await CompanyDocumentRegistry.countDocuments({ symbol });
  const durable = await CompanyDocumentRegistry.countDocuments({ symbol, storageKey: { $ne: null }, storageBackend: { $ne: null } });
  const missing = total - durable;
  return { symbol, total, durable, missing };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    const argv = process.argv.slice(2);
    const get = (flag) => { const arg = argv.find((x) => x.startsWith(`${flag}=`)); return arg ? arg.split('=').slice(1).join('=') : null; };
    const args = {
      dryRun: argv.includes('--dry-run'),
      batchSize: Number(get('--batch-size')) || DEFAULT_BATCH_SIZE,
      maxRuntimeMin: Number(get('--max-runtime')) || DEFAULT_MAX_RUNTIME_MIN,
    };

    if (argv.includes('--status-only')) {
      console.log(JSON.stringify(await status(), null, 2));
    } else {
      console.log(JSON.stringify(await run(args), null, 2));
    }

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[recoverTcsDurability] Failed: ${err.message}`);
    console.error('TCS durability recovery failed:', err.message);
    process.exit(1);
  });
}

export default run;
