/**
 * productionStatus.js
 * =====================
 * `npm run data:production-status`
 *
 * READ-ONLY. Never writes, never deletes, never seeds anything. Connects
 * using whatever MONGODB_URI is already set in the environment it runs in
 * (a local .env locally, Render's own configured env var when run there --
 * this script never hardcodes or falls back to a different database) and
 * reports collection counts relevant to the Goals / Stock Detail /
 * Earnings Intelligence "why is production empty" diagnosis.
 *
 * The connection string itself is NEVER printed -- only a masked
 * host/database-name summary (credentials stripped) so the operator can
 * confirm which cluster/database this ran against without this script's
 * output ever being a credential leak if pasted into a chat, ticket, or
 * log aggregator.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import StockHistoricalMetricsSnapshot from '../models/StockHistoricalMetricsSnapshot.js';
import StockFundamentalsSnapshot from '../models/StockFundamentalsSnapshot.js';
import InvestmentProductSnapshot from '../models/InvestmentProductSnapshot.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import CompanyDocumentRegistry from '../models/CompanyDocumentRegistry.js';
import PromiseCandidate from '../models/PromiseCandidate.js';
import ManagementPromise from '../models/ManagementPromise.js';
import ResearchRun from '../models/ResearchRun.js';
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { getRedisClient, initializeRedis } from '../utils/redisClient.js';

dotenv.config();

/** Strips credentials from a mongodb(+srv):// URI -- host and database name only, never user/pass. */
const maskMongoUri = (uri) => {
  if (!uri) return '(not set)';
  const match = uri.match(/^mongodb(\+srv)?:\/\/(?:[^@\/]+@)?([^\/?]+)\/?([^?]*)/);
  if (!match) return '(unparseable -- not printing raw value)';
  const [, srv, host, db] = match;
  return `mongodb${srv || ''}://<credentials-hidden>@${host}/${db || '(default)'}`;
};

const byProvenance = async (Model, field = 'dataOrigin') => {
  const rows = await Model.aggregate([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }]);
  const out = {};
  for (const row of rows) out[row._id === null || row._id === undefined ? 'MISSING_FIELD' : row._id] = row.count;
  return out;
};

export const collectProductionStatus = async () => {
  const universeSize = Object.keys(SUPPORTED_STOCKS).length;

  const [
    companyResearchProfileCount,
    companyResearchProfileWithMarketCap,
    companyResearchProfileWithIsin,
    historicalMetricsCount,
    fundamentalsSnapshotCount,
    investmentProductCount,
    investmentProductByType,
    historicalFactCount,
    historicalFactByOrigin,
    documentRegistryCount,
    promiseCandidateCount,
    promiseCandidateByStatus,
    managementPromiseCount,
    managementPromiseByOrigin,
    researchRunCount,
    researchRunByOrigin,
  ] = await Promise.all([
    CompanyResearchProfile.countDocuments({}),
    CompanyResearchProfile.countDocuments({ marketCapCr: { $ne: null } }),
    CompanyResearchProfile.countDocuments({ isin: { $ne: null } }),
    StockHistoricalMetricsSnapshot.countDocuments({}),
    StockFundamentalsSnapshot.countDocuments({}),
    InvestmentProductSnapshot.countDocuments({}),
    InvestmentProductSnapshot.aggregate([{ $group: { _id: '$productType', count: { $sum: 1 } } }]),
    CompanyHistoricalFact.countDocuments({}),
    byProvenance(CompanyHistoricalFact),
    CompanyDocumentRegistry.countDocuments({}),
    PromiseCandidate.countDocuments({}),
    PromiseCandidate.aggregate([{ $group: { _id: '$reviewStatus', count: { $sum: 1 } } }]),
    ManagementPromise.countDocuments({}),
    byProvenance(ManagementPromise),
    ResearchRun.countDocuments({}),
    byProvenance(ResearchRun),
  ]);

  const investmentByType = {};
  for (const row of investmentProductByType) investmentByType[row._id || 'UNKNOWN'] = row.count;
  const promiseByStatus = {};
  for (const row of promiseCandidateByStatus) promiseByStatus[row._id || 'UNKNOWN'] = row.count;

  let redisAvailable = false;
  try {
    await initializeRedis();
    const client = getRedisClient();
    redisAvailable = Boolean(client && client.isOpen);
  } catch {
    redisAvailable = false;
  }

  return {
    universeSize,
    collections: {
      CompanyResearchProfile: {
        total: companyResearchProfileCount,
        withMarketCapCr: companyResearchProfileWithMarketCap,
        withIsin: companyResearchProfileWithIsin,
        coveragePct: universeSize ? Math.round((companyResearchProfileCount / universeSize) * 100) : 0,
      },
      StockHistoricalMetricsSnapshot: {
        total: historicalMetricsCount,
        coveragePct: universeSize ? Math.round((historicalMetricsCount / universeSize) * 100) : 0,
      },
      StockFundamentalsSnapshot: {
        total: fundamentalsSnapshotCount,
        coveragePct: universeSize ? Math.round((fundamentalsSnapshotCount / universeSize) * 100) : 0,
      },
      InvestmentProductSnapshot: { total: investmentProductCount, byProductType: investmentByType },
      CompanyHistoricalFact: { total: historicalFactCount, byDataOrigin: historicalFactByOrigin },
      CompanyDocumentRegistry: { total: documentRegistryCount },
      PromiseCandidate: { total: promiseCandidateCount, byReviewStatus: promiseByStatus },
      ManagementPromise: { total: managementPromiseCount, byDataOrigin: managementPromiseByOrigin },
      ResearchRun: { total: researchRunCount, byDataOrigin: researchRunByOrigin },
    },
    redisAvailable,
  };
};

/** Maps each observed gap onto the exact UI symptom it produces -- pure, no I/O, so this is unit-testable. */
export const explainSymptoms = (status) => {
  const symptoms = [];
  const c = status.collections;

  if (c.CompanyResearchProfile.total === 0 || c.CompanyResearchProfile.withIsin === 0) {
    symptoms.push('Stock Detail missing market cap / ISIN / BSE identity <- CompanyResearchProfile is empty or has no ISIN/marketCapCr populated (needs the BSE scrip-master sync stage).');
  }
  if (c.StockHistoricalMetricsSnapshot.total === 0) {
    symptoms.push('Stock Detail missing 52W range / 1Y return / volatility / drawdown, AND Goals rejects every stock for missing historical data <- StockHistoricalMetricsSnapshot is empty (needs NSE bhavcopy ingestion, then historical-metrics computation).');
  }
  if (c.InvestmentProductSnapshot.total === 0) {
    symptoms.push('Mutual Fund / Debt / Gold / Liquid recommendations show "product provider unavailable" <- InvestmentProductSnapshot is empty (needs the AMFI + mfapi investment-product refresh).');
  }
  const realResearchFacts = c.CompanyHistoricalFact.byDataOrigin?.REAL_RESEARCH || 0;
  if (realResearchFacts === 0) {
    symptoms.push('Earnings Intelligence reports "insufficient verified history" <- CompanyHistoricalFact has no REAL_RESEARCH-origin records (SEEDED_DEMO records exist but are deliberately excluded from scoring). Needs document discovery + historical-fact extraction for real companies.');
  }
  return symptoms;
};

const isMainModule = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMainModule) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
    console.log(`Connecting to: ${maskMongoUri(mongoUri)}`);
    if (mongoose.connection.readyState === 0) await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });

    const status = await collectProductionStatus();
    console.log('\n=== Production Data Status (read-only) ===');
    console.log(JSON.stringify(status, null, 2));

    console.log('\n=== Diagnosed UI symptoms ===');
    const symptoms = explainSymptoms(status);
    if (!symptoms.length) console.log('No obvious data gaps detected from these counts.');
    else symptoms.forEach((s) => console.log(`- ${s}`));

    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    console.error('Status check failed:', err.message);
    process.exit(1);
  });
}

export default collectProductionStatus;
