/**
 * quarantineHistoricalFact.js
 * ==============================
 * `npm run earnings:quarantine -- --expect-target=host/db --symbol=X --period="Q4 FY2022"
 *    --metric=REVENUE --source-url=https://... --reason="..." [--undo]`
 *
 * Marks (or, with --undo, unmarks) one stored CompanyHistoricalFact as
 * quarantined: read correctly from its source, but excluded from every
 * public-facing surface (report, timeline, financial snapshot, coverage
 * counting) because the value itself is implausible or internally
 * inconsistent with the company's own adjacent filings.
 *
 * NEVER changes the stored value -- see models/CompanyHistoricalFact.js's
 * `quarantine` field and services/factQuarantine.js for the philosophy this
 * extends to already-stored facts (that module screens at write time; this
 * one is for a problem only visible once cross-checked against sibling
 * filings, after storage).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import { assertMongoTarget } from '../utils/mongoTarget.js';

dotenv.config();

/**
 * quarantineFact - pure DB effect, no I/O side effects beyond the one
 * update. Matches on {symbol, period, metric, source.url} exactly, so it
 * only ever touches the specific fact identified by its full evidence
 * fingerprint. Returns the number of documents modified (0 or 1 in
 * practice, since that key is the model's own unique index).
 */
export const quarantineFact = async ({
  symbol, period, metric, sourceUrl, reason,
}) => {
  if (!reason || !reason.trim()) throw new Error('A non-empty reason is required to quarantine a fact.');
  const result = await CompanyHistoricalFact.updateMany(
    {
      symbol: String(symbol).toUpperCase(), period, 'metrics.metric': metric, 'source.url': sourceUrl,
    },
    { $set: { 'quarantine.quarantined': true, 'quarantine.reason': reason, 'quarantine.quarantinedAt': new Date() } },
  );
  return result.modifiedCount;
};

/** unquarantineFact - reverses quarantineFact for the same fact key. */
export const unquarantineFact = async ({
  symbol, period, metric, sourceUrl,
}) => {
  const result = await CompanyHistoricalFact.updateMany(
    {
      symbol: String(symbol).toUpperCase(), period, 'metrics.metric': metric, 'source.url': sourceUrl,
    },
    { $set: { 'quarantine.quarantined': false, 'quarantine.reason': null, 'quarantine.quarantinedAt': null } },
  );
  return result.modifiedCount;
};

const parseArgs = (argv) => {
  const get = (flag) => { const a = argv.find((x) => x.startsWith(`${flag}=`)); return a ? a.slice(flag.length + 1) : null; };
  return {
    expectTarget: get('--expect-target'),
    symbol: get('--symbol'),
    period: get('--period'),
    metric: get('--metric'),
    sourceUrl: get('--source-url'),
    reason: get('--reason'),
    undo: argv.includes('--undo'),
  };
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.symbol || !args.period || !args.metric || !args.sourceUrl) {
      throw new Error('--symbol, --period, --metric and --source-url are all required.');
    }
    const target = assertMongoTarget(process.env.MONGODB_URI, args.expectTarget);
    console.log(`Target database: ${target.label}${target.implicitDatabase ? '  (URI names no database -> driver default "test")' : ''}`);
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

    const modified = args.undo
      ? await unquarantineFact(args)
      : await quarantineFact(args);
    console.log(`${args.undo ? 'Un-quarantined' : 'Quarantined'} ${modified} document(s) for ${args.symbol} ${args.period} ${args.metric}.`);

    await mongoose.disconnect();
    process.exit(0);
  })().catch((error) => {
    console.error('Quarantine failed:', error.message);
    process.exit(1);
  });
}
