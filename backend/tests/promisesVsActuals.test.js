import test from 'node:test';
import assert from 'node:assert/strict';
import { getPromisesVsActuals, assignRevisions } from '../services/PromisesVsActualsService.js';
import { getCompanyTimeline } from '../services/CuratedEarningsIntelligenceService.js';

/**
 * promisesVsActuals.test.js
 * ==========================
 * GET /:symbol/promises-vs-actuals' service: outcomes recomputed from stored
 * target/actual (never the stored verdict), original vs revised guidance,
 * explicit empty states, and the two scores kept apart. No database or
 * network: the curated JSON dataset is read from disk (with no Mongo
 * connection there are simply no accepted candidates to merge), and every
 * other dependency is injected.
 */

const AS_OF = new Date('2026-10-02T00:00:00Z');
const financialScoreFn = async () => ({
  value: 71, ratingLabel: 'Good', weightsUsed: { financialDelivery: 40, strategicExecution: 25, operationalDelivery: 20, capitalAllocation: 15 },
  scoreBreakdown: {}, scoreMissingReasons: {}, guidanceAccuracyScore: 64, methodology: 'test methodology',
});

const evidence = (url, excerpt, publishedAt, pageNumber = 4) => ({ sourceTitle: `Doc ${publishedAt}`, sourceType: 'EARNINGS_TRANSCRIPT', sourceUrl: url, publishedAt, pageNumber, excerpt });

// Same shape CuratedEarningsIntelligenceService.toTimelineEntry produces.
const entry = ({
  id, category = 'REVENUE_GROWTH', metric = null, period, promiseDate, value, valueMax = null, unit = 'PERCENT', operator = 'AT_LEAST',
  type = 'PERCENTAGE', status = 'PENDING', actual = null, actualUnit = unit, explanation = null, statement = 'Management target.', revisesPromiseId = null,
  outcomeExcerpt = 'Reported figure.',
}) => ({
  id, category, metric, period, statement, originalExcerpt: statement, promiseDate, revisesPromiseId,
  target: { value, valueMax, unit, operator, type },
  status,
  outcome: { actualValue: actual, actualUnit: actual == null ? null : actualUnit, evaluationDate: actual == null ? null : '2026-04-20', explanation },
  promiseEvidence: evidence(`https://www.bseindia.com/${id}-promise.pdf`, statement, promiseDate),
  outcomeEvidence: actual == null ? null : evidence(`https://nsearchives.nseindia.com/${id}-outcome.pdf`, outcomeExcerpt, '2026-04-20', 2),
  evidenceConfidence: 0.9,
  dataMode: 'CURATED_VERIFIED',
});

const timelineOf = (entries, extra = {}) => async () => ({
  symbol: 'TESTCO', companyName: 'Test Co', dataMode: 'CURATED_VERIFIED', coverageStatus: 'PARTIAL', lastVerifiedAt: '2026-09-11',
  summary: { faithScore: null, faithScoreLabel: 'Insufficient verified history', scoreStatus: 'INSUFFICIENT_EVIDENCE' },
  timeline: entries, sources: [], disclaimer: 'test', ...extra,
});

test('real curated TCS data: the stored PARTIAL attrition record is shown MISSED, the qualitative one is never scored', async () => {
  const data = await getPromisesVsActuals('TCS', { financialScoreFn, asOf: AS_OF });
  assert.equal(data.dataSource, 'CURATED');
  const byId = Object.fromEntries(data.rows.map((row) => [row.id, row]));
  assert.ok(!byId['TCS-FY2026-001'], 'a QUARANTINED record stays out of every public surface');

  const attrition = byId['TCS-FY2025-001'];
  assert.equal(attrition.storedStatus, 'PARTIAL');
  assert.equal(attrition.outcome, 'MISSED');
  assert.equal(attrition.year, 'FY2025');
  assert.equal(attrition.target.comparisonType, 'MAXIMUM');
  assert.deepEqual({ value: attrition.shortfall.value, direction: attrition.shortfall.direction }, { value: 0.3, direction: 'ABOVE_CEILING' });
  assert.equal(attrition.achievementPercentage, 97.74);
  assert.equal(attrition.evidence.targetPage, 5);
  assert.equal(attrition.evidence.actualReportingPeriod, 'FY2025');
  assert.match(attrition.evidence.targetSourceUrl, /^https:\/\/www\.bseindia\.com\//);

  const qualitative = byId['TCS-FY2026-002'];
  assert.equal(qualitative.outcome, 'QUALITATIVE_ONLY');
  assert.equal(qualitative.achievementPercentage, null);

  const delivery = data.summary.managementDeliveryScore;
  assert.equal(delivery.targetHitRate, 0);
  assert.equal(delivery.targetHitRateDenominator, 1);
  assert.equal(delivery.qualitativeOnlyCount, 1);
  // The Faith Score is the existing, untouched calculation (null below 3 resolved records -- never 0).
  const timeline = await getCompanyTimeline('TCS');
  assert.equal(delivery.faithScore, timeline.summary.faithScore);
  assert.equal(delivery.evidenceCoverage.confidence, 'LOW', 'one completed target can never be labelled HIGH confidence');
  assert.equal(data.summary.financialPerformanceScore.excludesGuidanceAccuracy, true);
});

test('original vs revised guidance: both rows returned and labelled, only the latest counts toward the target-hit rate', async () => {
  const data = await getPromisesVsActuals('TESTCO', {
    asOf: AS_OF,
    financialScoreFn,
    getTimelineFn: timelineOf([
      entry({ id: 'TESTCO-FY2026-001', metric: 'REVENUE_GROWTH', period: 'FY2026', promiseDate: '2025-04-10', value: 10, actual: 9, status: 'PARTIAL' }),
      entry({ id: 'TESTCO-FY2026-002', metric: 'REVENUE_GROWTH', period: 'FY2026', promiseDate: '2025-10-09', value: 8.5, actual: 9, status: 'ACHIEVED' }),
      // Same period, different metric: never linked.
      entry({ id: 'TESTCO-FY2026-003', category: 'MARGIN', metric: 'EBITDA_MARGIN', period: 'FY2026', promiseDate: '2025-10-09', value: 20, actual: 21, status: 'ACHIEVED' }),
      // Coarse OTHER category with no precise metric: never auto-grouped either.
      entry({ id: 'TESTCO-FY2026-004', category: 'OTHER', period: 'FY2026', promiseDate: '2025-04-10', value: 13, operator: 'AT_MOST', actual: 12, status: 'ACHIEVED' }),
      entry({ id: 'TESTCO-FY2026-005', category: 'OTHER', period: 'FY2026', promiseDate: '2025-10-09', value: 5, operator: 'AT_LEAST', actual: 5.2, status: 'ACHIEVED' }),
    ]),
  });
  const byId = Object.fromEntries(data.rows.map((row) => [row.id, row]));
  assert.equal(byId['TESTCO-FY2026-001'].versionLabel, 'ORIGINAL');
  assert.equal(byId['TESTCO-FY2026-001'].outcome, 'MISSED');
  assert.equal(byId['TESTCO-FY2026-001'].countsTowardScore, false);
  assert.equal(byId['TESTCO-FY2026-001'].supersededBy, 'TESTCO-FY2026-002');
  assert.equal(byId['TESTCO-FY2026-002'].versionLabel, 'REVISED');
  assert.equal(byId['TESTCO-FY2026-002'].revisionOf, 'TESTCO-FY2026-001');
  assert.equal(byId['TESTCO-FY2026-002'].outcome, 'MET');
  assert.equal(byId['TESTCO-FY2026-002'].countsTowardScore, true);
  for (const id of ['TESTCO-FY2026-003', 'TESTCO-FY2026-004', 'TESTCO-FY2026-005']) {
    assert.equal(byId[id].versionLabel, null, id);
    assert.equal(byId[id].countsTowardScore, true, id);
  }
  const delivery = data.summary.managementDeliveryScore;
  assert.equal(delivery.totalTargets, 5);
  assert.equal(delivery.supersededCount, 1);
  assert.equal(delivery.completedCount, 4, 'the superseded original is not in the denominator');
  assert.equal(delivery.targetHitRate, 100);
  // Annual summary counts match the rows.
  const fy2026 = data.annualSummary.find((bucket) => bucket.year === 'FY2026');
  assert.deepEqual({ total: fy2026.total, completed: fy2026.completed, superseded: fy2026.superseded, met: fy2026.met, missed: fy2026.missed }, { total: 5, completed: 4, superseded: 1, met: 4, missed: 0 });
});

test('an explicit revisesPromiseId links versions even without a shared metric field', () => {
  const base = { target: { value: 1, unit: 'PERCENT' }, targetPeriod: 'FY2026', metric: null };
  const labels = assignRevisions([
    { ...base, id: 'A', promiseDate: '2025-04-01' },
    { ...base, id: 'B', promiseDate: '2025-07-01', revisesPromiseId: 'A' },
    { ...base, id: 'C', promiseDate: '2025-08-01' },
  ]);
  assert.equal(labels.get('A').versionLabel, 'ORIGINAL');
  assert.equal(labels.get('B').revisionOf, 'A');
  assert.equal(labels.get('B').countsTowardScore, true);
  assert.equal(labels.get('A').countsTowardScore, false);
  assert.equal(labels.get('C').versionLabel, null);
});

test('empty states are distinct: no guidance vs no measurable guidance vs guidance found but not yet verifiable', async () => {
  const none = await getPromisesVsActuals('TESTCO', { asOf: AS_OF, financialScoreFn, getTimelineFn: timelineOf([]) });
  assert.equal(none.emptyState, 'NO_GUIDANCE');
  assert.equal(none.summary.managementDeliveryScore.targetHitRate, null);

  const qualitative = await getPromisesVsActuals('TESTCO', {
    asOf: AS_OF, financialScoreFn,
    getTimelineFn: timelineOf([entry({ id: 'TESTCO-FY2026-010', period: 'FY2026', promiseDate: '2025-04-10', value: null, unit: null, operator: 'QUALITATIVE', type: 'QUALITATIVE', status: 'ACHIEVED', actual: 0.6, actualUnit: 'PERCENT' })]),
  });
  assert.equal(qualitative.emptyState, 'NO_MEASURABLE_GUIDANCE');

  const pending = await getPromisesVsActuals('TESTCO', {
    asOf: AS_OF, financialScoreFn,
    getTimelineFn: timelineOf([entry({ id: 'TESTCO-FY2027-001', metric: 'REVENUE_GROWTH', period: 'FY2027', promiseDate: '2026-04-15', value: 10 })]),
  });
  assert.equal(pending.emptyState, 'GUIDANCE_UNVERIFIED');
  assert.equal(pending.rows[0].outcome, 'PENDING');
  assert.match(pending.rows[0].reason, /2027-03-31/);
  assert.equal(pending.summary.managementDeliveryScore.targetHitRate, null, 'null, never 0, with nothing evaluable');
  assert.equal(pending.summary.managementDeliveryScore.pendingCount, 1);
});

test('a closed period with no actual is INSUFFICIENT_EVIDENCE with the specific recorded reason (e.g. a failed actual-side lookup), never a fallback value', async () => {
  const data = await getPromisesVsActuals('TESTCO', {
    asOf: AS_OF, financialScoreFn,
    getTimelineFn: timelineOf([
      entry({ id: 'TESTCO-FY2025-001', metric: 'REVENUE', period: 'FY2025', promiseDate: '2024-04-10', value: 1000, unit: 'INR_CRORE', type: 'ABSOLUTE', status: 'INSUFFICIENT_EVIDENCE', explanation: 'Actual-result provider returned HTTP 503 during verification; no figure recorded.' }),
      entry({ id: 'TESTCO-FY2024-001', metric: 'PAT', period: 'FY2024', promiseDate: '2023-04-10', value: 200, unit: 'INR_CRORE', type: 'ABSOLUTE', status: 'PENDING' }),
    ]),
  });
  const byId = Object.fromEntries(data.rows.map((row) => [row.id, row]));
  assert.equal(byId['TESTCO-FY2025-001'].outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(byId['TESTCO-FY2025-001'].reason, /HTTP 503/);
  assert.equal(byId['TESTCO-FY2025-001'].actual.value, null);
  assert.equal(byId['TESTCO-FY2024-001'].outcome, 'INSUFFICIENT_EVIDENCE', 'a stale stored PENDING is re-derived from the calendar');
  assert.match(byId['TESTCO-FY2024-001'].reason, /closed on 2024-03-31/);
  assert.equal(data.summary.managementDeliveryScore.insufficientEvidenceCount, 2);
  assert.equal(data.summary.managementDeliveryScore.targetHitRate, null);
});

test('a non-comparable actual (standalone target, consolidated actual) is INSUFFICIENT_EVIDENCE, not a forced comparison', async () => {
  const data = await getPromisesVsActuals('TESTCO', {
    asOf: AS_OF, financialScoreFn,
    getTimelineFn: timelineOf([entry({
      id: 'TESTCO-FY2025-002', metric: 'REVENUE', period: 'FY2025', promiseDate: '2024-04-10', value: 1000, unit: 'INR_CRORE', type: 'ABSOLUTE', status: 'ACHIEVED', actual: 1300,
      statement: 'We target standalone revenue of at least Rs 1,000 crore in FY2025.', outcomeExcerpt: 'Consolidated revenue for FY2025 was Rs 1,300 crore.',
    })]),
  });
  assert.equal(data.rows[0].outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(data.rows[0].reason, /Statement-basis mismatch/);
  assert.equal(data.rows[0].target.statementBasis, 'STANDALONE');
  assert.equal(data.rows[0].actual.statementBasis, 'CONSOLIDATED');
});

test('a failing financial-score provider leaves the guidance rows intact and reports why the score is unavailable', async () => {
  const data = await getPromisesVsActuals('TESTCO', {
    asOf: AS_OF,
    financialScoreFn: async () => { throw new Error('Upstox request timed out'); },
    getTimelineFn: timelineOf([entry({ id: 'TESTCO-FY2025-003', metric: 'REVENUE', period: 'FY2025', promiseDate: '2024-04-10', value: 1000, unit: 'INR_CRORE', type: 'ABSOLUTE', actual: 800, status: 'PARTIAL' })]),
  });
  assert.equal(data.rows[0].outcome, 'MISSED');
  assert.equal(data.rows[0].achievementPercentage, 80);
  assert.equal(data.summary.financialPerformanceScore.value, null);
  assert.match(data.summary.financialPerformanceScore.unavailableReason, /timed out/);
});

test('legacy fallback is used only when the curated dataset is not CURATED_VERIFIED; a legacy lookup failure degrades to no guidance', async () => {
  const pendingTimeline = timelineOf([], { dataMode: 'RESEARCH_PENDING', coverageStatus: 'RESEARCH_PENDING' });
  const legacyDoc = {
    _id: 'abc123', promise: { statement: 'Order book of at least 5,000 crore', metric: 'ORDER_BOOK', targetValue: 5000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2025', operator: 'GTE', promiseDate: new Date('2024-05-01') },
    outcome: { actualValue: 5200, actualUnit: 'INR_CRORE', actualPeriod: 'FY2025', sourceUrl: 'https://www.bseindia.com/o.pdf', statement: 'Order book 5,200 crore' },
    verification: { status: 'FULFILLED', confidence: 0.9 },
    evidence: { promiseSource: { sourceUrl: 'https://www.bseindia.com/p.pdf', title: 'Call', excerpt: 'at least 5,000 crore', page: 3, sourceDate: new Date('2024-05-01') } },
  };
  const legacy = await getPromisesVsActuals('TESTCO', { asOf: AS_OF, financialScoreFn, getTimelineFn: pendingTimeline, getLegacyPromisesFn: async () => [legacyDoc] });
  assert.equal(legacy.dataSource, 'LEGACY');
  assert.equal(legacy.rows[0].outcome, 'MET');
  assert.equal(legacy.summary.managementDeliveryScore.faithScore, null, 'the curated Faith Score is never borrowed for legacy rows');

  const failing = await getPromisesVsActuals('TESTCO', { asOf: AS_OF, financialScoreFn, getTimelineFn: pendingTimeline, getLegacyPromisesFn: async () => { throw new Error('db down'); } });
  assert.equal(failing.emptyState, 'NO_GUIDANCE');
  assert.equal(await getPromisesVsActuals('NOTASTOCK', { getTimelineFn: async () => null }), null);
});
