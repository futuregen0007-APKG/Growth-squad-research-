/**
 * PromisesVsActualsService.js
 * ============================
 * Backs GET /api/earnings-intelligence/:symbol/promises-vs-actuals: one row
 * per management target (year, metric, target, actual, achievement, outcome,
 * evidence), plus two deliberately SEPARATE scores:
 *
 *   managementDeliveryScore   - did management hit its own stated targets?
 *                               targetHitRate (simple ratio) + the existing
 *                               curated Faith Score (confidence-weighted),
 *                               labelled distinctly, never merged.
 *   financialPerformanceScore - the Financial / Execution score
 *                               (ExecutionScoreService), which no longer
 *                               includes guidance accuracy.
 *
 * Source of records: exactly the same as the Management Guidance tab -- the
 * curated timeline (CuratedEarningsIntelligenceService.getCompanyTimeline:
 * git-committed promises/<SYMBOL>.json + ACCEPTED PromiseCandidates, already
 * evidence-integrity filtered), falling back to the legacy public-safe
 * ManagementPromise collection only when the curated dataset is not
 * CURATED_VERIFIED for the symbol (the same order GET /:symbol/timeline uses).
 *
 * VERDICTS ARE RECOMPUTED, NEVER TRUSTED FROM STORAGE: each record's stored
 * target / actual / evidence fields are the verified research and are only
 * read here, never rewritten. The outcome shown (MET / EXCEEDED / MISSED /
 * PENDING / INSUFFICIENT_EVIDENCE / QUALITATIVE_ONLY) is always freshly
 * derived from those stored fields with the CURRENT calculatePromiseStatus,
 * so a record written under the pre-fix percentage bands (e.g. a 25%-vs-
 * at-least-26% result stored as "PARTIAL") is shown as what it is -- MISSED --
 * without bulk-rewriting any curated JSON file or Mongo document. The stored
 * status is still returned (`storedStatus`) for transparency.
 */

import { getCompanyTimeline as getCuratedCompanyTimeline, computeFaithScoreCoverage } from './CuratedEarningsIntelligenceService.js';
import { calculatePromiseStatus, getCompanyPromises as getLegacyCompanyPromises, getCompanySummary } from './ManagementPromiseService.js';
import { calculateTargetHitRate, EXECUTION_SCORE_METHODOLOGY } from './ExecutionScoreService.js';
import { loadEarningsAnnualFinancials } from './EarningsAnnualFinancials.js';
import {
  describeTargetPeriod, detectStatedBasis, canonicalOutcomeFromStoredStatus, canonicalUnit, toCandidateOutcomeStatus,
} from '../utils/promiseOutcome.js';
import { normalizePeriod } from '../utils/financialNormalization.js';
import { logger } from '../utils/logger.js';

const METRIC_LABELS = {
  REVENUE: 'Revenue', REVENUE_GROWTH: 'Revenue growth', EBITDA: 'EBITDA', EBITDA_MARGIN: 'EBITDA margin',
  MARGIN: 'Operating margin', PAT: 'Profit after tax', PAT_GROWTH: 'PAT growth', PROFITABILITY: 'Profitability',
  ORDER_BOOK: 'Order book', ORDER_INTAKE: 'Order intake', ARR: 'ARR', BOOKINGS: 'Bookings', CAPEX: 'Capex',
  DEBT: 'Debt', DEBT_REDUCTION: 'Debt reduction', MARKET_SHARE: 'Market share', CUSTOMER_COUNT: 'Customer count',
  EMPLOYEE_COUNT: 'Employee count', EMPLOYEE_PERCENTAGE: 'Employee share', FREE_CASH_FLOW: 'Free cash flow',
  LARGE_DEALS: 'Large deals', EXPORT_REVENUE: 'Export revenue', NIM: 'Net interest margin', CREDIT_GROWTH: 'Credit growth',
  LOAN_GROWTH: 'Loan growth', DEPOSIT_GROWTH: 'Deposit growth', CASA: 'CASA ratio', ASSET_QUALITY: 'Asset quality',
  GUIDANCE: 'Guidance', PRODUCT_LAUNCH: 'Product launch', EXPANSION: 'Expansion',
  OTHER_QUANTIFIABLE: 'Other (quantified)', OTHER: 'Other',
};
const metricLabelFor = (key) => {
  const upper = String(key || 'OTHER').toUpperCase();
  return METRIC_LABELS[upper] || upper.charAt(0) + upper.slice(1).toLowerCase().replace(/_/g, ' ');
};

// Never auto-grouped as revisions of one another: too coarse to be "the same target".
const UNGROUPABLE_METRICS = new Set(['OTHER', 'OTHER_QUANTIFIABLE', 'GUIDANCE']);

const isoDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

/** Curated timeline entry (CuratedEarningsIntelligenceService.toTimelineEntry) -> internal shape. */
const fromCuratedEntry = (entry) => ({
  id: entry.id,
  recordSource: 'CURATED',
  metric: entry.metric || null,
  category: entry.category || null,
  statement: entry.statement,
  originalExcerpt: entry.originalExcerpt || entry.promiseEvidence?.excerpt || null,
  promiseDate: entry.promiseDate,
  targetPeriod: entry.period,
  target: {
    value: entry.target?.value ?? null,
    valueMax: entry.target?.valueMax ?? null,
    unit: entry.target?.unit ?? null,
    operator: entry.target?.operator ?? null,
    direction: null,
    type: entry.target?.type ?? null,
  },
  actual: {
    value: entry.outcome?.actualValue ?? null,
    unit: entry.outcome?.actualUnit ?? null,
    period: entry.outcome?.actualPeriod ?? null,
    evaluationDate: entry.outcome?.evaluationDate ?? null,
    explanation: entry.outcome?.explanation ?? null,
  },
  storedStatus: entry.status,
  promiseEvidence: entry.promiseEvidence ? {
    url: entry.promiseEvidence.sourceUrl, title: entry.promiseEvidence.sourceTitle, page: entry.promiseEvidence.pageNumber ?? null,
    excerpt: entry.promiseEvidence.excerpt, publishedAt: entry.promiseEvidence.publishedAt, type: entry.promiseEvidence.sourceType,
  } : null,
  outcomeEvidence: entry.outcomeEvidence ? {
    url: entry.outcomeEvidence.sourceUrl, title: entry.outcomeEvidence.sourceTitle, page: entry.outcomeEvidence.pageNumber ?? null,
    excerpt: entry.outcomeEvidence.excerpt, publishedAt: entry.outcomeEvidence.publishedAt, type: entry.outcomeEvidence.sourceType,
  } : null,
  evidenceConfidence: entry.evidenceConfidence ?? null,
  revisesPromiseId: entry.revisesPromiseId ?? null,
});

/** Legacy ManagementPromise document (already public-safe filtered) -> internal shape. */
const fromLegacyDocument = (doc) => {
  const promise = doc.promise || {};
  const outcome = doc.outcome || {};
  const promiseSource = doc.evidence?.promiseSource || {};
  const outcomeSource = doc.evidence?.outcomeSource || {};
  const outcomeUrl = outcome.sourceUrl || outcomeSource.sourceUrl || null;
  return {
    id: String(doc._id || doc.id),
    recordSource: 'LEGACY',
    metric: promise.metric || doc.metric || null,
    category: promise.metric || doc.metric || null,
    statement: promise.statement || doc.promiseText || doc.promiseTitle || '',
    originalExcerpt: promiseSource.excerpt || null,
    promiseDate: isoDate(promise.promiseDate || doc.announcementDate || doc.guidanceDate),
    targetPeriod: promise.targetPeriod || doc.targetPeriod || '',
    target: {
      value: promise.targetValue ?? doc.targetValue ?? null,
      valueMax: promise.targetValueMax ?? null,
      unit: promise.targetUnit ?? doc.targetUnit ?? null,
      operator: promise.operator ?? null,
      direction: promise.direction ?? null,
      type: null,
    },
    actual: {
      value: outcome.actualValue ?? doc.actualValue ?? null,
      unit: outcome.actualUnit ?? doc.actualUnit ?? null,
      period: outcome.actualPeriod ?? doc.actualPeriod ?? null,
      evaluationDate: isoDate(outcome.sourceDate),
      explanation: outcome.statement ?? null,
    },
    storedStatus: doc.verification?.status || doc.status || null,
    promiseEvidence: promiseSource.sourceUrl ? {
      url: promiseSource.sourceUrl, title: promiseSource.title || promiseSource.sourceName, page: promiseSource.page ?? null,
      excerpt: promiseSource.excerpt, publishedAt: isoDate(promiseSource.sourceDate), type: promiseSource.sourceType,
    } : null,
    outcomeEvidence: outcomeUrl ? {
      url: outcomeUrl, title: outcomeSource.title || outcomeSource.sourceName || outcome.provider || 'Outcome source', page: null,
      excerpt: outcome.excerpt || outcomeSource.excerpt || null, publishedAt: isoDate(outcome.sourceDate || outcomeSource.sourceDate), type: outcomeSource.sourceType || null,
    } : null,
    evidenceConfidence: doc.verification?.confidence ?? null,
    revisesPromiseId: promise.revisesPromiseId ?? null,
  };
};

/**
 * recomputeOutcome - the fresh verdict for one record (see module header:
 * stored target/actual are read, the stored status is NOT trusted).
 */
export const recomputeOutcome = (record, { asOf = new Date() } = {}) => {
  const targetBasis = detectStatedBasis(record.statement, record.originalExcerpt, record.promiseEvidence?.excerpt);
  // The actual's basis is read from the outcome SOURCE's own words only, never the curator's narrative.
  const actualBasis = detectStatedBasis(record.outcomeEvidence?.excerpt);
  const storedCanonical = canonicalOutcomeFromStoredStatus(record.storedStatus);
  const hasActual = record.actual.value !== null && record.actual.value !== undefined;
  // A curator who recorded INSUFFICIENT_EVIDENCE with a note gives the most specific reason available.
  const evidenceUnavailableReason = !hasActual && storedCanonical === 'INSUFFICIENT_EVIDENCE' && record.actual.explanation
    ? record.actual.explanation
    : null;

  const verdict = calculatePromiseStatus({
    targetValue: record.target.value,
    targetValueMax: record.target.valueMax,
    targetUnit: record.target.unit,
    actualValue: hasActual ? record.actual.value : null,
    actualUnit: record.actual.unit ?? record.target.unit,
    operator: record.target.operator,
    direction: record.target.direction,
    metric: record.metric || record.category || '',
    targetType: record.target.type,
    targetPeriod: record.targetPeriod,
    actualPeriod: record.actual.period,
    targetBasis,
    actualBasis,
    asOf,
    evidenceUnavailableReason,
  });

  // A human-resolved met/missed verdict with no single actual figure (rare)
  // has nothing numeric to recompute from; it is kept rather than downgraded.
  if (!hasActual && verdict.outcome === 'INSUFFICIENT_EVIDENCE' && ['MET', 'EXCEEDED', 'MISSED'].includes(storedCanonical)) {
    return {
      ...verdict,
      outcome: storedCanonical,
      reason: null,
      calculationExplanation: `No single actual figure is recorded; the curated verdict (${record.storedStatus}) is shown as recorded. ${record.actual.explanation || ''}`.trim(),
      targetBasis,
      actualBasis,
    };
  }
  return { ...verdict, targetBasis, actualBasis };
};

/**
 * assignRevisions - groups versions of the SAME target and labels them.
 *
 * Rule (documented, conservative): two records are versions of one target
 * only when (a) one explicitly names the other in `revisesPromiseId`, or
 * (b) both carry the same precise `metric` (never the coarse category, never
 * OTHER/OTHER_QUANTIFIABLE/GUIDANCE), the same target period, the same unit,
 * and both have a numeric target. Nothing is linked across different
 * metrics or periods and nothing is guessed. Within a group, ordered by
 * announcement date, the earliest is ORIGINAL and later ones are REVISED.
 * Every version stays visible as its own row with its own outcome, but ONLY
 * the latest version counts toward the target-hit rate -- once guidance is
 * revised, the revised target is the live commitment, so counting both would
 * score one commitment twice. Earlier versions carry countsTowardScore:false
 * and `supersededBy`.
 */
export const assignRevisions = (records) => {
  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (id) => { let root = id; while (parent.get(root) !== root) root = parent.get(root); return root; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };

  for (const record of records) {
    if (record.revisesPromiseId && parent.has(record.revisesPromiseId)) union(record.revisesPromiseId, record.id);
  }
  const byKey = new Map();
  for (const record of records) {
    const metric = String(record.metric || '').toUpperCase();
    if (!metric || UNGROUPABLE_METRICS.has(metric)) continue;
    if (record.target.value === null || record.target.value === undefined) continue;
    const key = `${metric}|${normalizePeriod(record.targetPeriod)}|${canonicalUnit(record.target.unit) || ''}`;
    if (byKey.has(key)) union(byKey.get(key), record.id);
    else byKey.set(key, record.id);
  }

  const groups = new Map();
  for (const record of records) {
    const root = find(record.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  }

  const labels = new Map();
  for (const members of groups.values()) {
    if (members.length === 1) {
      labels.set(members[0].id, { versionLabel: null, revisionOf: null, supersededBy: null, countsTowardScore: true });
      continue;
    }
    const ordered = [...members].sort((a, b) => String(a.promiseDate || '').localeCompare(String(b.promiseDate || '')) || String(a.id).localeCompare(String(b.id)));
    ordered.forEach((record, index) => {
      labels.set(record.id, {
        versionLabel: index === 0 ? 'ORIGINAL' : 'REVISED',
        revisionOf: index === 0 ? null : (record.revisesPromiseId && parent.has(record.revisesPromiseId) ? record.revisesPromiseId : ordered[index - 1].id),
        supersededBy: index < ordered.length - 1 ? ordered[index + 1].id : null,
        countsTowardScore: index === ordered.length - 1,
      });
    });
  }
  return labels;
};

const toRow = (record, verdict, revision) => {
  const period = describeTargetPeriod(record.targetPeriod);
  const metricKey = record.metric || record.category || 'OTHER';
  const hasActual = record.actual.value !== null && record.actual.value !== undefined;
  return {
    id: record.id,
    recordSource: record.recordSource,
    year: period?.fiscalYear ? `FY${period.fiscalYear}` : (record.targetPeriod || 'Unspecified'),
    targetPeriod: record.targetPeriod,
    metric: metricKey,
    metricLabel: metricLabelFor(metricKey),
    category: record.category,
    target: {
      value: record.target.value,
      valueMax: record.target.valueMax,
      unit: record.target.unit,
      operator: record.target.operator,
      direction: record.target.direction,
      comparisonType: verdict.comparisonType,
      statementBasis: verdict.targetBasis.statementBasis,
      basis: verdict.targetBasis,
    },
    actual: {
      value: hasActual ? record.actual.value : null,
      unit: hasActual ? (record.actual.unit ?? record.target.unit) : null,
      // Curated records are verified by a human for the target period itself; a recorded actualPeriod wins when present.
      asOfPeriod: hasActual ? (record.actual.period || record.targetPeriod) : null,
      reportedOn: record.actual.evaluationDate,
      source: record.outcomeEvidence?.title || null,
      statementBasis: verdict.actualBasis.statementBasis,
      basis: verdict.actualBasis,
    },
    // Always returned together with `outcome` -- a percentage alone is never a verdict.
    achievementPercentage: verdict.achievementPercentage,
    achievementReason: verdict.achievementPercentage === null
      ? (verdict.achievementReason || verdict.reason || 'No comparable actual to compute an achievement percentage from.')
      : null,
    outcome: verdict.outcome,
    shortfall: verdict.outcome === 'MISSED' && verdict.shortfall ? { value: verdict.shortfall.value, unit: verdict.shortfall.unit, percentage: verdict.shortfall.percentage, direction: verdict.shortfall.direction } : null,
    reason: verdict.reason,
    calculationExplanation: verdict.calculationExplanation,
    storedStatus: record.storedStatus,
    originalStatement: record.statement,
    originalExcerpt: record.originalExcerpt,
    announcementDate: record.promiseDate,
    versionLabel: revision.versionLabel,
    revisionOf: revision.revisionOf,
    supersededBy: revision.supersededBy,
    countsTowardScore: revision.countsTowardScore,
    evidence: {
      targetSourceUrl: record.promiseEvidence?.url || null,
      targetDocTitle: record.promiseEvidence?.title || null,
      targetPage: record.promiseEvidence?.page ?? null,
      targetExcerpt: record.promiseEvidence?.excerpt || null,
      targetPublishedAt: record.promiseEvidence?.publishedAt || null,
      actualSourceUrl: record.outcomeEvidence?.url || null,
      actualDocTitle: record.outcomeEvidence?.title || null,
      actualPage: record.outcomeEvidence?.page ?? null,
      actualExcerpt: record.outcomeEvidence?.excerpt || null,
      actualPublishedAt: record.outcomeEvidence?.publishedAt || null,
      actualReportingPeriod: hasActual ? (record.actual.period || record.targetPeriod) : null,
    },
    evidenceConfidence: record.evidenceConfidence,
  };
};

const emptyCounts = () => ({ total: 0, completed: 0, met: 0, exceeded: 0, missed: 0, pending: 0, insufficientEvidence: 0, qualitativeOnly: 0, superseded: 0 });
const OUTCOME_COUNT_KEY = { MET: 'met', EXCEEDED: 'exceeded', MISSED: 'missed', PENDING: 'pending', INSUFFICIENT_EVIDENCE: 'insufficientEvidence', QUALITATIVE_ONLY: 'qualitativeOnly' };

/** Per-year counts. Superseded (revised-away) versions are listed but not counted as outcomes. */
export const buildAnnualSummary = (rows) => {
  const byYear = new Map();
  for (const row of rows) {
    if (!byYear.has(row.year)) byYear.set(row.year, { year: row.year, ...emptyCounts() });
    const bucket = byYear.get(row.year);
    bucket.total += 1;
    if (!row.countsTowardScore) { bucket.superseded += 1; continue; }
    const key = OUTCOME_COUNT_KEY[row.outcome];
    if (key) bucket[key] += 1;
    if (['MET', 'EXCEEDED', 'MISSED'].includes(row.outcome)) bucket.completed += 1;
  }
  return [...byYear.values()].sort((a, b) => String(b.year).localeCompare(String(a.year)));
};

const defaultFinancialScore = async (symbol) => {
  const annualFinancials = await loadEarningsAnnualFinancials(symbol).catch(() => ({ facts: [], provider: 'UPSTOX', status: 'UNAVAILABLE', reason: 'PROVIDER_ERROR' }));
  const summary = await getCompanySummary(symbol, { annualFinancials });
  return {
    value: summary.executionScore ?? null,
    ratingLabel: summary.ratingLabel ?? null,
    weightsUsed: summary.weightsUsed || {},
    scoreBreakdown: summary.scoreBreakdown || {},
    scoreMissingReasons: summary.scoreMissingReasons || {},
    guidanceAccuracyScore: summary.guidanceAccuracyScore ?? null,
    methodology: summary.executionScoreMethodology || EXECUTION_SCORE_METHODOLOGY,
  };
};

/**
 * getPromisesVsActuals - returns null only for an unsupported symbol (the
 * route answers 404). Every dependency is injectable so tests never touch
 * Mongo, the network or the clock.
 */
export const getPromisesVsActuals = async (symbol, {
  getTimelineFn = getCuratedCompanyTimeline,
  getLegacyPromisesFn = getLegacyCompanyPromises,
  financialScoreFn = defaultFinancialScore,
  asOf = new Date(),
} = {}) => {
  const normalized = String(symbol || '').toUpperCase().trim();
  if (!normalized) return null;

  const timeline = await getTimelineFn(normalized);
  if (!timeline) return null;

  let records = [];
  let dataSource = 'NONE';
  if (timeline.dataMode === 'CURATED_VERIFIED') {
    records = (timeline.timeline || []).map(fromCuratedEntry);
    dataSource = 'CURATED';
  } else {
    const legacy = await Promise.resolve(getLegacyPromisesFn(normalized)).catch((err) => {
      logger.warn(`[PromisesVsActuals] legacy promise lookup failed for ${normalized}: ${err.message}`);
      return [];
    });
    if (legacy?.length) {
      records = legacy.map(fromLegacyDocument);
      dataSource = 'LEGACY';
    }
  }

  const revisions = assignRevisions(records);
  const rows = records
    .map((record) => toRow(record, recomputeOutcome(record, { asOf }), revisions.get(record.id)))
    .sort((a, b) => String(b.targetPeriod || '').localeCompare(String(a.targetPeriod || '')) || String(b.announcementDate || '').localeCompare(String(a.announcementDate || '')));

  const counting = rows.filter((row) => row.countsTowardScore);
  const hitRate = calculateTargetHitRate(counting.map((row) => ({ canonicalOutcome: row.outcome })));
  // Same coverage/confidence guard the Faith Score uses (computeFaithScoreCoverage),
  // fed with the RECOMPUTED outcomes of the counted rows, so a HIGH label can
  // only appear when there genuinely are >=10 completed targets over >=8 quarters.
  const evidenceCoverage = computeFaithScoreCoverage(
    counting.map((row) => ({ promise: { targetPeriod: row.targetPeriod }, outcome: { status: toCandidateOutcomeStatus(row.outcome) } })),
    { coverageStatus: timeline.coverageStatus, dataAsOf: timeline.lastVerifiedAt },
  );

  let financialPerformanceScore;
  try {
    const financial = await financialScoreFn(normalized);
    financialPerformanceScore = { ...financial, excludesGuidanceAccuracy: true, unavailableReason: financial?.value == null ? 'Insufficient verified comparable annual history to calculate a score.' : null };
  } catch (err) {
    logger.warn(`[PromisesVsActuals] financial score unavailable for ${normalized}: ${err.message}`);
    financialPerformanceScore = {
      value: null, ratingLabel: null, weightsUsed: {}, scoreBreakdown: {}, scoreMissingReasons: {}, guidanceAccuracyScore: null,
      methodology: EXECUTION_SCORE_METHODOLOGY, excludesGuidanceAccuracy: true, unavailableReason: `Financial score could not be computed right now: ${err.message}`,
    };
  }

  let emptyState = null;
  if (!rows.length) emptyState = 'NO_GUIDANCE';
  else if (rows.every((row) => row.outcome === 'QUALITATIVE_ONLY')) emptyState = 'NO_MEASURABLE_GUIDANCE';
  else if (hitRate.completed === 0) emptyState = 'GUIDANCE_UNVERIFIED';

  const yearsCovered = [...new Set(rows.map((row) => row.year))].sort();

  return {
    symbol: normalized,
    companyName: timeline.companyName,
    dataSource,
    dataMode: timeline.dataMode,
    coverageStatus: timeline.coverageStatus,
    lastVerifiedAt: timeline.lastVerifiedAt ?? null,
    asOf: new Date(asOf).toISOString(),
    emptyState,
    rows,
    annualSummary: buildAnnualSummary(rows),
    summary: {
      managementDeliveryScore: {
        targetHitRate: hitRate.targetHitRate,
        targetHitRateDenominator: hitRate.completed,
        targetHitRateNumerator: hitRate.hits,
        targetHitRateConfidence: evidenceCoverage.confidence,
        targetHitRateMethodology: 'Target-hit rate = (met + exceeded) / (met + exceeded + missed) among completed, evaluable targets. Pending, insufficient-evidence and qualitative targets are excluded from both sides; only the latest version of a revised target counts. Outcomes are recomputed from the stored target and actual with the current rules.',
        // The existing curated Faith Score, untouched: confidence-weighted, computed from stored curated statuses.
        faithScore: dataSource === 'CURATED' ? (timeline.summary?.faithScore ?? null) : null,
        faithScoreLabel: dataSource === 'CURATED' ? (timeline.summary?.faithScoreLabel ?? null) : null,
        faithScoreStatus: dataSource === 'CURATED' ? (timeline.summary?.scoreStatus ?? null) : null,
        completedCount: hitRate.completed,
        metCount: hitRate.met,
        exceededCount: hitRate.exceeded,
        missedCount: hitRate.missed,
        pendingCount: hitRate.pending,
        insufficientEvidenceCount: hitRate.insufficientEvidence,
        qualitativeOnlyCount: hitRate.qualitativeOnly,
        supersededCount: rows.length - counting.length,
        totalTargets: rows.length,
        evidenceCoverage,
        yearsCovered,
      },
      financialPerformanceScore,
    },
    disclaimer: timeline.disclaimer || null,
  };
};

export default { getPromisesVsActuals, recomputeOutcome, assignRevisions, buildAnnualSummary };
