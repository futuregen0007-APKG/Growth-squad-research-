/**
 * captureDocumentDurability.js
 * ===============================
 * `npm run earnings:capture-durability -- --symbol=HDFCBANK`
 *
 * A one-time migration pass for documents registered BEFORE durable storage
 * existed (no storageKey/storageBackend on their CompanyDocumentRegistry
 * entry). For each such document it calls the same durable-first accessor
 * every other stage uses (getDocumentBuffer): a successful re-fetch (via the
 * original URL or the alternate BSE AttachLive<->AttachHis path) is
 * durably stored as a side effect, so this is genuinely "capture", not a
 * throwaway read -- every document this reaches either becomes durable now,
 * or is reported as UNAVAILABLE (a dead source link, never silently
 * dropped). Never downloads a document that already has a storageKey.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { CompanyDocumentRegistry } from '../models/CompanyDocumentRegistry.js';
import { getDocumentBuffer } from '../providers/ExchangeFilingDocumentProvider.js';
import { logger } from '../utils/logger.js';

dotenv.config();

export const captureDocumentDurabilityForSymbol = async (symbol) => {
  const normalized = String(symbol).toUpperCase();
  const documents = await CompanyDocumentRegistry.find({
    symbol: normalized,
    $or: [{ storageKey: null }, { storageKey: { $exists: false } }],
  }).sort({ publicationDate: 1 }).lean();

  const summary = {
    symbol: normalized, documentsConsidered: documents.length, captured: 0, unavailable: 0, bySource: {},
  };

  for (const doc of documents) {
    // eslint-disable-next-line no-await-in-loop
    const { buffer, source } = await getDocumentBuffer(doc);
    summary.bySource[source] = (summary.bySource[source] || 0) + 1;
    if (buffer) summary.captured += 1;
    else summary.unavailable += 1;
  }

  return summary;
};

const parseArgs = (argv) => ({
  symbol: (argv.find((a) => a.startsWith('--symbol=')) || '').split('=')[1]?.toUpperCase() || null,
  symbols: (argv.find((a) => a.startsWith('--symbols=')) || '').split('=')[1]?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) || null,
});

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const { symbol, symbols } = parseArgs(process.argv.slice(2));
    const targets = symbols || (symbol ? [symbol] : null);
    if (!targets) throw new Error('--symbol or --symbols is required');

    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri);

    console.log('Document durability capture');
    console.log('='.repeat(70));
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop
      const summary = await captureDocumentDurabilityForSymbol(target);
      console.log(`${target.padEnd(12)} considered=${summary.documentsConsidered} captured=${summary.captured} unavailable=${summary.unavailable} sources=${JSON.stringify(summary.bySource)}`);
    }

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    logger.error(`[earnings:capture-durability] Failed: ${err.message}`);
    console.error('Durability capture failed:', err.message);
    process.exit(1);
  });
}

export default captureDocumentDurabilityForSymbol;
