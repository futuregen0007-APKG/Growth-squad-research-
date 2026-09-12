/**
 * syncLatestAnnouncements.js
 * =============================
 * `npm run earnings:sync-latest`
 *
 * Incremental refresh for companies ALREADY under active research (i.e.
 * they have at least one CompanyDocumentRegistry entry) -- not a cold
 * sweep of the full ~205-stock master. BSE's real announcement-search API
 * (confirmed live, see ExchangeFilingDocumentProvider.js) requires a scrip
 * code per query; there is no genuine "all companies" feed at this
 * endpoint, so processing "only new documents ... filtered against the
 * 205-stock master" is implemented as: check each ALREADY-TRACKED company
 * (a small, bounded set, never all 205) for announcements published since
 * the last successful sync, and skip any document whose hash is already
 * in the registry (download-once, enforced by downloadAndRegisterFiling).
 *
 * This is intentionally scoped smaller than "all 205 companies, every
 * time" -- a genuinely new (never-researched) company is only picked up
 * by scripts/backfillUniverse.js, not by this incremental sync.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { SyncState } from '../models/SyncState.js';
import CompanyDocumentRegistry from '../models/CompanyDocumentRegistry.js';
import { searchExchangeFilings, downloadAndRegisterFiling } from '../providers/ExchangeFilingDocumentProvider.js';
import { extractFactsFromDocument } from '../services/FactExtractionService.js';
import { upsertFacts } from './backfillHistoricalFacts.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const SYNC_NAME = 'earnings-latest';
const DEFAULT_LOOKBACK_DAYS = 10; // used only when this sync has never run before

const currentFiscalYear = () => {
  const now = new Date();
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
};

export const getTrackedSymbols = async () => {
  const symbols = await CompanyDocumentRegistry.distinct('symbol');
  return symbols.sort();
};

export const run = async () => {
  const state = (await SyncState.findOne({ name: SYNC_NAME }).lean()) || { lastCheckedAt: null, lastSuccessfulSync: null, lastAnnouncementId: null, syncErrors: [] };
  const since = state.lastSuccessfulSync ? new Date(state.lastSuccessfulSync) : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const trackedSymbols = await getTrackedSymbols();
  const fiscalYear = `FY${currentFiscalYear()}`; // only the current fiscal year can have genuinely "new" filings
  const results = [];
  const syncErrors = [];

  for (const symbol of trackedSymbols) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const filings = await searchExchangeFilings(symbol, fiscalYear);
      const newFilings = filings.filter((f) => f.publicationDate > since);
      let newDocuments = 0;
      let factsExtracted = 0;

      for (const filing of newFilings) {
        // eslint-disable-next-line no-await-in-loop
        const existing = await CompanyDocumentRegistry.findOne({ symbol, url: filing.url }).lean();
        if (existing?.extractionStatus === 'EXTRACTED') continue; // already processed -- never re-download an existing document hash

        // eslint-disable-next-line no-await-in-loop
        const { buffer, error } = await downloadAndRegisterFiling(filing);
        if (error || !buffer) continue;
        newDocuments += 1;

        // eslint-disable-next-line no-await-in-loop
        const facts = await extractFactsFromDocument(buffer, { symbol, companyName: filing.companyName, fiscalYear, sourceType: filing.documentType, url: filing.url, title: filing.title });
        // eslint-disable-next-line no-await-in-loop
        await upsertFacts(symbol, filing.companyName, filing.url, filing.publicationDate, filing.documentType, filing.title, facts);
        // eslint-disable-next-line no-await-in-loop
        await CompanyDocumentRegistry.updateOne({ symbol, url: filing.url }, { $set: { extractionStatus: 'EXTRACTED', factsExtracted: facts.length } });
        factsExtracted += facts.length;
      }

      if (newDocuments > 0) results.push({ symbol, newDocuments, factsExtracted });
    } catch (error) {
      logger.warn(`[syncLatestAnnouncements] ${symbol}: ${error.message}`);
      syncErrors.push({ at: new Date(), message: `${symbol}: ${error.message}` });
    }
  }

  await SyncState.findOneAndUpdate(
    { name: SYNC_NAME },
    { $set: { lastCheckedAt: new Date(), lastSuccessfulSync: new Date(), syncErrors: syncErrors.slice(-20) } },
    { upsert: true },
  );

  return { trackedSymbols: trackedSymbols.length, since: since.toISOString(), updated: results, syncErrors };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    const summary = await run();
    console.log(`Earnings incremental sync -- ${summary.trackedSymbols} tracked companies checked (since ${summary.since})`);
    for (const u of summary.updated) console.log(`  ${u.symbol}: ${u.newDocuments} new document(s), ${u.factsExtracted} facts`);
    if (!summary.updated.length) console.log('  No new documents found.');
    if (summary.syncErrors.length) console.log(`  ${summary.syncErrors.length} error(s):`, summary.syncErrors.map((e) => e.message).join('; '));

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[earnings:sync-latest] Failed: ${err.message}`);
    console.error('Sync failed:', err.message);
    process.exit(1);
  });
}

export default run;
