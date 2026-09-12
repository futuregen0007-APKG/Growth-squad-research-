/**
 * earningsImport.js
 * ==================
 * `npm run earnings:import` (add `-- --dry-run` to preview with no writes).
 *
 * Upserts every CURATED_VERIFIED promise record from the curated file-based
 * dataset into the existing `ManagementPromise` Mongo collection, so other
 * consumers of that collection (e.g. /api/earnings-intelligence/promise/:id)
 * can see curated records too. This is optional/secondary: the curated
 * timeline API (Step 9) reads the JSON files directly and does NOT require
 * this import to have run.
 *
 * - Never imports DEMO_SYNTHETIC records (getCompanyPromises() without
 *   mode:'DEMO' structurally cannot return them).
 * - Idempotent: matches existing documents by `curatedRecordId` and only
 *   writes when content actually changed (reports "unchanged" otherwise).
 * - Never deletes anything, and never touches a document that isn't tagged
 *   with a `curatedRecordId` it owns -- so it can't disturb documents from
 *   the live DocumentResearchService pipeline or any user data.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import ManagementPromise from '../models/ManagementPromise.js';
import { listSupportedCompanies, getCompanyPromises, getCompanyCoverage } from '../services/CuratedEarningsIntelligenceService.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

export const CATEGORY_TO_LEGACY_METRIC = {
  REVENUE_GROWTH: 'REVENUE_GROWTH',
  MARGIN: 'MARGIN',
  ORDER_BOOK: 'ORDER_BOOK',
  CAPEX: 'CAPEX',
  DEBT_REDUCTION: 'DEBT_REDUCTION',
  PROFITABILITY: 'OTHER_QUANTIFIABLE',
  LOAN_GROWTH: 'CREDIT_GROWTH',
  DEPOSIT_GROWTH: 'DEPOSIT_GROWTH',
  ASSET_QUALITY: 'OTHER_QUANTIFIABLE',
  GUIDANCE: 'OTHER',
  PRODUCT_LAUNCH: 'OTHER',
  EXPANSION: 'OTHER',
  OTHER: 'OTHER',
};

export const UNIT_MAP = { PERCENT: 'PERCENTAGE', INR_CRORE: 'INR_CRORE', INR_LAKH: 'INR_LAKH', USD_MILLION: 'USD_MILLION', USD_BILLION: 'USD_BILLION', COUNT: 'COUNT' };

export const OPERATOR_MAP = {
  AT_LEAST: { direction: 'AT_LEAST', operator: 'GTE' },
  AT_MOST: { direction: 'AT_MOST', operator: 'LTE' },
  EXACT: { direction: 'EXACT', operator: 'EQ' },
  RANGE: { direction: 'RANGE', operator: 'RANGE' },
  QUALITATIVE: { direction: 'OTHER', operator: null },
};

export const STATUS_MAP = {
  ACHIEVED: 'FULFILLED',
  PARTIAL: 'PARTIALLY_FULFILLED',
  MISSED: 'MISSED',
  PENDING: 'PENDING',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
};

export const toEvidenceSource = (evidence) => {
  if (!evidence) return undefined;
  return {
    sourceType: evidence.sourceType || null,
    sourceName: evidence.sourceTitle || null,
    sourceUrl: evidence.sourceUrl,
    sourceDate: evidence.publishedAt ? new Date(evidence.publishedAt) : null,
    publicationDate: evidence.publishedAt ? new Date(evidence.publishedAt) : null,
    page: evidence.pageNumber ?? null,
    title: evidence.sourceTitle,
    excerpt: evidence.excerpt,
    documentType: evidence.sourceType || null,
    authorityLevel: null,
  };
};

export const toManagementPromiseDoc = (record, coverage) => {
  const operatorInfo = OPERATOR_MAP[record.promise.operator] || OPERATOR_MAP.QUALITATIVE;
  const achievementPercentage = (typeof record.promise.targetValue === 'number' && record.promise.targetValue !== 0 && typeof record.outcome.actualValue === 'number')
    ? Math.round((record.outcome.actualValue / record.promise.targetValue) * 10000) / 100
    : null;

  return {
    dataOrigin: 'REAL_RESEARCH',
    companyId: record.symbol,
    symbol: record.symbol,
    companyName: coverage?.companyName || record.symbol,
    curatedRecordId: record.id,
    promise: {
      statement: record.promise.statement,
      metric: CATEGORY_TO_LEGACY_METRIC[record.promise.category] || 'OTHER',
      targetValue: typeof record.promise.targetValue === 'number' ? record.promise.targetValue : 0,
      targetUnit: UNIT_MAP[record.promise.targetUnit] || 'OTHER',
      targetPeriod: record.promise.targetPeriod,
      promiseDate: new Date(record.promise.promiseDate),
      direction: operatorInfo.direction,
      operator: operatorInfo.operator,
      importance: 'MEDIUM',
    },
    outcome: {
      actualValue: record.outcome.actualValue ?? null,
      actualUnit: UNIT_MAP[record.outcome.actualUnit] || null,
      actualPeriod: record.promise.targetPeriod,
      statement: record.outcome.explanation || null,
      sourceUrl: record.outcomeEvidence?.sourceUrl || null,
      sourceDate: record.outcome.evaluationDate ? new Date(record.outcome.evaluationDate) : null,
      excerpt: record.outcomeEvidence?.excerpt || null,
    },
    verification: {
      achievementPercentage,
      status: STATUS_MAP[record.outcome.status] || 'INSUFFICIENT_EVIDENCE',
      calculationExplanation: record.outcome.explanation || null,
      confidence: record.verification?.evidenceConfidence ?? null,
      evidenceQuality: record.verification?.evidenceConfidence >= 0.9 ? 'HIGH' : record.verification?.evidenceConfidence >= 0.7 ? 'MEDIUM' : 'LOW',
      verifiedAt: record.verification?.verifiedAt ? new Date(record.verification.verifiedAt) : null,
    },
    evidence: {
      promiseSource: toEvidenceSource(record.promiseEvidence),
      outcomeSource: toEvidenceSource(record.outcomeEvidence),
    },
  };
};

export const documentsAreEquivalent = (existing, next) => {
  // Compare only the fields import actually controls, so unrelated fields set
  // by other pipelines never cause a false "changed" report.
  const pick = (doc) => JSON.stringify({
    statement: doc.promise?.statement,
    targetValue: doc.promise?.targetValue,
    targetUnit: doc.promise?.targetUnit,
    targetPeriod: doc.promise?.targetPeriod,
    outcomeStatus: doc.verification?.status,
    actualValue: doc.outcome?.actualValue,
    promiseSourceUrl: doc.evidence?.promiseSource?.sourceUrl,
    outcomeSourceUrl: doc.evidence?.outcomeSource?.sourceUrl,
    confidence: doc.verification?.confidence,
  });
  return pick(existing) === pick(next);
};

const run = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai';
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
  }

  const counts = { inserted: 0, updated: 0, unchanged: 0, rejected: 0 };
  const details = [];

  for (const symbol of listSupportedCompanies()) {
    const coverage = await getCompanyCoverage(symbol);
    const records = await getCompanyPromises(symbol); // CURATED_VERIFIED only, by construction (JSON records + Mongo-accepted candidates)
    for (const record of records) {
      const nextDoc = toManagementPromiseDoc(record, coverage);
      const existing = await ManagementPromise.findOne({ curatedRecordId: record.id }).lean();

      if (!existing) {
        counts.inserted++;
        details.push({ id: record.id, action: 'INSERT' });
        if (!DRY_RUN) await ManagementPromise.create(nextDoc);
        continue;
      }

      if (documentsAreEquivalent(existing, nextDoc)) {
        counts.unchanged++;
        details.push({ id: record.id, action: 'UNCHANGED' });
        continue;
      }

      counts.updated++;
      details.push({ id: record.id, action: 'UPDATE' });
      if (!DRY_RUN) {
        await ManagementPromise.findOneAndUpdate({ curatedRecordId: record.id }, nextDoc, { upsert: true, new: true });
      }
    }
  }

  console.log(`Earnings Intelligence curated import${DRY_RUN ? ' (DRY RUN -- no writes made)' : ''}`);
  console.log('='.repeat(60));
  for (const detail of details) console.log(`  [${detail.action}] ${detail.id}`);
  console.log('');
  console.log(`Inserted:  ${counts.inserted}`);
  console.log(`Updated:   ${counts.updated}`);
  console.log(`Unchanged: ${counts.unchanged}`);
  console.log(`Rejected:  ${counts.rejected}`);

  await mongoose.disconnect();
  process.exit(0);
};

// Only run when executed directly (`node scripts/earningsImport.js`) -- importing
// this module's exported helpers from tests must never open a DB connection
// or call process.exit().
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  run().catch((err) => {
    logger.error(`[earnings:import] Failed: ${err.message}`);
    console.error('Import failed:', err.message);
    process.exit(1);
  });
}

export { run };
