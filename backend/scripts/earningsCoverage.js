/**
 * earningsCoverage.js
 * ====================
 * `npm run earnings:coverage` (add `-- --all` to list every RESEARCH_PENDING
 * symbol too; by default only companies with curated data are itemized and
 * the rest are summarized as a count, since there are ~150+ of them).
 *
 * Lists every supported stock (from the authoritative SUPPORTED_STOCKS list),
 * its coverage status, promise counts, Faith Score eligibility (>= 3 resolved
 * verified promises), and last verification date. Identifies which symbols
 * still have no curated promise data at all. Connects to MongoDB so an
 * ACCEPTED PromiseCandidate is reflected here exactly as it would be via the
 * public API, even before its companies.json/promises/<SYMBOL>.json commit.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import {
  listSupportedCompanies,
  getCompanyCoverage,
  getCompanyTimeline,
} from '../services/CuratedEarningsIntelligenceService.js';

dotenv.config();

const showAll = process.argv.includes('--all');

const run = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
  if (mongoose.connection.readyState === 0) {
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    } catch (err) {
      console.log(`(MongoDB unavailable -- accepted-but-not-yet-committed candidates will not appear: ${err.message})\n`);
    }
  }

  const symbols = listSupportedCompanies();
  const rows = [];
  for (const symbol of symbols) {
    // eslint-disable-next-line no-await-in-loop
    const coverage = await getCompanyCoverage(symbol);
    // eslint-disable-next-line no-await-in-loop
    const timeline = await getCompanyTimeline(symbol);
    rows.push({
      symbol,
      companyName: coverage.companyName,
      dataMode: coverage.dataMode,
      coverageStatus: coverage.coverageStatus,
      totalPromises: timeline.summary.totalPromises,
      resolvedPromises: timeline.summary.resolvedPromises,
      scoreEligible: timeline.summary.faithScore != null ? 'YES' : 'no',
      lastVerifiedAt: coverage.lastVerifiedAt || '-',
    });
  }

  const withCuratedData = rows.filter((r) => r.coverageStatus !== 'RESEARCH_PENDING');
  const pending = rows.filter((r) => r.coverageStatus === 'RESEARCH_PENDING');

  console.log('Earnings Intelligence coverage report');
  console.log('='.repeat(70));
  console.log(`Total supported stocks: ${rows.length}`);
  console.log(`  With curated data (COMPLETE/PARTIAL/STALE): ${withCuratedData.length}`);
  console.log(`  RESEARCH_PENDING (no curated data yet): ${pending.length}`);
  console.log(`  Score-eligible (>= 3 resolved verified promises): ${rows.filter((r) => r.scoreEligible === 'YES').length}`);
  console.log('');

  const printTable = (list, title) => {
    if (!list.length) return;
    console.log(title);
    console.log('-'.repeat(70));
    for (const r of list) {
      console.log(
        `${r.symbol.padEnd(10)} ${r.coverageStatus.padEnd(16)} promises=${String(r.totalPromises).padStart(2)} `
        + `resolved=${String(r.resolvedPromises).padStart(2)} scoreEligible=${r.scoreEligible.padEnd(3)} lastVerified=${r.lastVerifiedAt}`
      );
    }
    console.log('');
  };

  printTable(withCuratedData, 'Companies with curated research:');

  if (showAll) {
    printTable(pending, 'RESEARCH_PENDING (all):');
  } else {
    console.log(`${pending.length} symbol(s) are RESEARCH_PENDING. Re-run with "--all" to list them individually.`);
  }

  await mongoose.disconnect().catch(() => {});
  process.exit(0);
};

run().catch((err) => {
  console.error('earnings:coverage failed:', err.message);
  process.exit(1);
});
