import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ResearchGuidanceAnnotation } from '../models/ResearchGuidanceAnnotation.js';
import { getVerifiedAnnotationsByChunkIds } from '../services/guidanceAnnotationLookup.js';

dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

const TEST_SYMBOL = 'ZZLOOKUPTEST';
const cleanup = async () => { await ResearchGuidanceAnnotation.deleteMany({ symbol: TEST_SYMBOL }); };
test.beforeEach(cleanup);
after(async () => { await cleanup(); await mongoose.disconnect().catch(() => {}); });

const baseAnnotationEntry = (overrides = {}) => ({
  status: 'VERIFIED',
  metric: 'operating margin',
  metricKey: 'operating_margin',
  guidanceKind: 'ORIGINAL',
  valueType: 'range',
  lowerBound: 26,
  upperBound: 28,
  unit: 'PERCENTAGE',
  supportingSpan: 'We are targeting operating margin of 26% to 28%.',
  extractionMethod: 'DETERMINISTIC',
  confidence: 0.9,
  ...overrides,
});

const baseRow = ({ annotations = [baseAnnotationEntry()], ...overrides } = {}) => ({
  chunkId: new mongoose.Types.ObjectId(),
  chunkHash: 'hash-1',
  extractionVersion: '1',
  symbol: TEST_SYMBOL,
  documentType: 'EARNINGS_CALL_TRANSCRIPT',
  fiscalYear: 'FY2026',
  fiscalQuarter: 'Q2',
  sourceUrl: 'https://example.com/f.pdf',
  pageStart: 1,
  pageEnd: 1,
  isCandidateChunk: true,
  candidateSignals: ['MARGIN'],
  annotations,
  hasVerifiedAnnotation: annotations.some((a) => a.status === 'VERIFIED'),
  ...overrides,
});

test('verified-annotation preference: a row with a VERIFIED entry is returned by chunkId', async () => {
  const row = await ResearchGuidanceAnnotation.create(baseRow());
  const map = await getVerifiedAnnotationsByChunkIds([row.chunkId]);
  assert.ok(map.has(String(row.chunkId)));
  assert.equal(map.get(String(row.chunkId)).status, 'VERIFIED');
});

test('unverified annotation ignored: a row whose entries are all REJECTED/UNRESOLVED is never returned', async () => {
  const rejected = await ResearchGuidanceAnnotation.create(baseRow({
    annotations: [baseAnnotationEntry({ status: 'REJECTED', rejectionReasons: ['ANALYST_QUESTION_LANGUAGE'], metricKey: null, valueType: null, lowerBound: null, upperBound: null, unit: null, confidence: 0 })],
  }));
  const unresolved = await ResearchGuidanceAnnotation.create(baseRow({
    chunkId: new mongoose.Types.ObjectId(),
    annotations: [baseAnnotationEntry({ status: 'UNRESOLVED', metricKey: null, valueType: null, lowerBound: null, upperBound: null, unit: null, confidence: 0, unresolvedReason: 'NO_KNOWN_METRIC_MATCHED' })],
  }));

  const map = await getVerifiedAnnotationsByChunkIds([rejected.chunkId, unresolved.chunkId]);
  assert.equal(map.size, 0);
});

test('current-version selection: when a chunk has rows at multiple extractionVersions, the highest-numbered VERIFIED row wins', async () => {
  const chunkId = new mongoose.Types.ObjectId();
  await ResearchGuidanceAnnotation.create(baseRow({ chunkId, extractionVersion: '1', annotations: [baseAnnotationEntry({ lowerBound: 20, upperBound: 22 })] }));
  await ResearchGuidanceAnnotation.create(baseRow({ chunkId, extractionVersion: '10', annotations: [baseAnnotationEntry({ lowerBound: 26, upperBound: 28 })] }));
  await ResearchGuidanceAnnotation.create(baseRow({ chunkId, extractionVersion: '2', annotations: [baseAnnotationEntry({ lowerBound: 24, upperBound: 25 })] }));

  const map = await getVerifiedAnnotationsByChunkIds([chunkId]);
  const current = map.get(String(chunkId));
  assert.equal(current.extractionVersion, '10');
  assert.equal(current.lowerBound, 26);
});

test('multiple VERIFIED entries in the SAME row: the highest-confidence entry is returned (one canonicalGuidance slot per chunk)', async () => {
  const chunkId = new mongoose.Types.ObjectId();
  await ResearchGuidanceAnnotation.create(baseRow({
    chunkId,
    annotations: [
      baseAnnotationEntry({ metricKey: 'revenue_growth', lowerBound: 5, upperBound: 6, confidence: 0.6 }),
      baseAnnotationEntry({ metricKey: 'operating_margin', lowerBound: 26, upperBound: 28, confidence: 0.9 }),
    ],
  }));
  const map = await getVerifiedAnnotationsByChunkIds([chunkId]);
  const current = map.get(String(chunkId));
  assert.equal(current.metricKey, 'operating_margin');
  assert.equal(current.confidence, 0.9);
});

test('a chunkId with no annotation at all is simply absent from the returned map', async () => {
  const map = await getVerifiedAnnotationsByChunkIds([new mongoose.Types.ObjectId()]);
  assert.equal(map.size, 0);
});
