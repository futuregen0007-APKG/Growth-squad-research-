import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preCheck, contentCheck, decideGroups, checkPeriodGrounding, explicitFiscalYears, fiscalYearOf, periodEndOf,
} from '../services/PromiseReviewGate.js';
import { acceptExtractedPromise, numberInText, excerptOnPage, findGuidancePages } from '../services/PromiseExtractionService.js';
import { searchActualOutcomeFromHistoricalFacts, searchActualOutcomesLocalFirst, describeXbrlFact } from '../services/OutcomeEvidenceService.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import { resolveCuratedRecordOutcome, evaluatePromiseOutcome } from '../utils/promiseOutcome.js';
import { classifyNseAnnouncement } from '../providers/NseAnnouncementProvider.js';
import { withFactsRows, incompleteRows } from '../scripts/earningsXbrlBatch.js';
import { buildManagementDelivery } from '../services/PromisesVsActualsService.js';
import { reviewCandidates, locateExcerpt } from '../scripts/autoReviewCandidates.js';
import { metricLabelFor } from '../utils/promiseMetrics.js';

/**
 * promiseCoverageExpansion.test.js
 * =================================
 * Regressions for the universe-wide guidance work: the evidence-review gate,
 * the v2 extraction checks, the strict like-for-like actual matcher, the one
 * shared outcome resolver, presentation discovery, fair rotation of the
 * scheduled jobs, and research-aware empty states. No database or network:
 * every I/O dependency is injected or mocked.
 */

// ---------------------------------------------------------------------------
// v2 extraction: deterministic acceptance of a model-proposed promise
// ---------------------------------------------------------------------------
const PAGE = 'Moderator: next question. Management: For FY27 we expect revenue growth of 12% to 14%, and capex of ₹1,500 crore. Analyst: Will margins be 20%?';
const proposal = (overrides = {}) => ({
  speaker: 'MANAGEMENT', metric: 'REVENUE_GROWTH', targetValue: 12, targetValueMax: 14, targetUnit: 'PERCENTAGE', operator: 'RANGE', targetPeriod: 'FY2027',
  excerpt: 'For FY27 we expect revenue growth of 12% to 14%', ...overrides,
});

test('v2 extraction accepts a management target whose excerpt and numbers are really on the page', () => {
  assert.deepEqual(acceptExtractedPromise(proposal(), PAGE), { ok: true, reason: null });
});

test('v2 extraction drops analyst speech, questions, numbers not in the excerpt, and a range without its upper bound', () => {
  assert.match(acceptExtractedPromise(proposal({ speaker: 'ANALYST' }), PAGE).reason, /not management/);
  assert.match(acceptExtractedPromise(proposal({ excerpt: 'Will margins be 20%?', metric: 'EBITDA_MARGIN', targetValue: 20, operator: 'EQ', targetValueMax: null }), PAGE).reason, /question/);
  // A midpoint the model computed (13) is not written in the excerpt.
  assert.match(acceptExtractedPromise(proposal({ targetValue: 13, operator: 'EQ', targetValueMax: null }), PAGE).reason, /not written in the excerpt/);
  assert.match(acceptExtractedPromise(proposal({ targetValueMax: null }), PAGE).reason, /upper bound/);
  assert.match(acceptExtractedPromise(proposal({ excerpt: 'We expect revenue growth of 30% next year' }), PAGE).reason, /not found verbatim/);
});

test('numberInText reads written numbers with thousands separators and decimals; excerptOnPage needs the whole excerpt', () => {
  assert.equal(numberInText(1500, 'capex of ₹1,500 crore'), true);
  assert.equal(numberInText(15.5, 'margin of 15.50%'), true);
  assert.equal(numberInText(15, '14%-16%'), false);
  assert.equal(excerptOnPage('we expect revenue growth', 'For FY27  we expect\nrevenue growth of 12%'), true);
  assert.equal(excerptOnPage('we expect revenue decline', 'we expect revenue growth'), false);
});

test('guidance pages include bank and capex language the fact-stage filter missed; boilerplate pages are skipped', () => {
  const pages = [
    { pageNumber: 1, text: 'This transcript is provided for information only. '.repeat(5) },
    { pageNumber: 2, text: 'We expect loan growth of around 14% this year and deposits to grow faster than that, aided by CASA. '.repeat(2) },
    { pageNumber: 3, text: 'Our capex for the coming year will be about Rs 2,000 crore as we add capacity in the new plant. '.repeat(2) },
  ];
  assert.deepEqual(findGuidancePages(pages).map((p) => p.pageNumber), [2, 3]);
});

// ---------------------------------------------------------------------------
// The evidence-review gate
// ---------------------------------------------------------------------------
const candidate = (overrides = {}, promise = {}, evidence = {}) => ({
  id: 'TESTCO-FY2027-CAND-001',
  symbol: 'TESTCO',
  extractionVersion: 'v2',
  reviewStatus: 'PENDING_REVIEW',
  promise: {
    statement: 'Management expects revenue growth of 12% to 14% in FY27.', category: 'REVENUE_GROWTH', metric: 'REVENUE_GROWTH', promiseDate: '2026-05-10', targetPeriod: 'FY2027',
    targetType: 'PERCENTAGE', targetValue: 12, targetValueMax: 14, targetUnit: 'PERCENT', operator: 'RANGE', scope: 'COMPANY', speaker: 'MANAGEMENT', ...promise,
  },
  outcome: { status: 'PENDING', actualValue: null, actualUnit: null, evaluationDate: null, explanation: null },
  promiseEvidence: {
    sourceTitle: 'Transcript', sourceType: 'EARNINGS_TRANSCRIPT', sourceUrl: 'https://nsearchives.nseindia.com/corporate/TESTCO_Transcript.pdf', publishedAt: '2026-05-10', pageNumber: 4,
    excerpt: 'For FY27 we expect revenue growth of 12% to 14%', ...evidence,
  },
  ...overrides,
});

test('gate: a clean v2 management target passes every pre-check', () => {
  assert.deepEqual(preCheck(candidate()), []);
});

test('gate: legacy v1 records, unidentified metrics, an unstated margin type and non-exchange sources stay pending', () => {
  assert.match(preCheck(candidate({ extractionVersion: null }))[0], /^LEGACY_V1/);
  assert.ok(preCheck(candidate({}, { metric: 'OTHER' })).some((r) => /^METRIC_UNIDENTIFIED/.test(r)));
  assert.ok(preCheck(candidate({}, { metric: 'MARGIN' })).some((r) => /^MARGIN_TYPE_UNSTATED/.test(r)));
  assert.ok(preCheck(candidate({}, {}, { sourceUrl: 'https://www.company.com/transcript.pdf' })).some((r) => /^SOURCE_NOT_EXCHANGE/.test(r)));
});

test('gate: questions, hypotheticals, multi-year CAGR / cumulative targets and segment wording stay pending', () => {
  assert.ok(preCheck(candidate({}, {}, { excerpt: 'Can we expect revenue growth of 12% to 14% in FY27?' })).some((r) => /^QUESTION/.test(r)));
  assert.ok(preCheck(candidate({}, {}, { excerpt: 'If we assume revenue growth of 12% to 14% in FY27' })).some((r) => /^HYPOTHETICAL/.test(r)));
  assert.ok(preCheck(candidate({}, {}, { excerpt: 'LTTS Revenue: 12-14% CAGR growth' })).some((r) => /^MULTI_YEAR/.test(r)));
  assert.ok(preCheck(candidate({}, {}, { excerpt: 'we expect orders of 12 to 14 thousand crores in total over the next 2 years' })).some((r) => /^MULTI_YEAR/.test(r)));
  assert.ok(preCheck(candidate({}, {}, { excerpt: 'For FY27 we expect export revenue growth of 12% to 14%' })).some((r) => /^SCOPE_AMBIGUOUS/.test(r)));
  assert.ok(preCheck(candidate({}, { metric: 'CREDIT_GROWTH', category: 'OTHER' }, { excerpt: 'our corporate guidance is 12 to 14% for FY27' })).some((r) => /^SCOPE_AMBIGUOUS/.test(r)));
});

test('gate: a unit the excerpt does not support, a plain count for a non-count metric, and a period already over stay pending', () => {
  assert.ok(preCheck(candidate({}, {}, { excerpt: 'For FY27 we expect revenue growth of 12 to 14' })).some((r) => /^UNIT/.test(r)));
  assert.ok(preCheck(candidate({}, { metric: 'ORDER_INTAKE', targetUnit: 'COUNT', operator: 'EQ', targetValueMax: null }, { excerpt: 'For FY27 we will deliver 12 engines' })).some((r) => /^UNIT/.test(r)));
  assert.ok(preCheck(candidate({}, { targetPeriod: 'FY2026', promiseDate: '2026-05-10' })).some((r) => /^PAST_PERIOD/.test(r)));
  assert.ok(preCheck(candidate({}, { targetPeriod: 'FY2034' })).some((r) => /^HORIZON/.test(r)));
});

test('gate: fiscal calendar helpers follow the Indian April-March year', () => {
  assert.equal(fiscalYearOf('2026-05-10'), 2027);
  assert.equal(fiscalYearOf('2026-02-10'), 2026);
  assert.equal(periodEndOf('FY2027').toISOString().slice(0, 10), '2027-03-31');
  assert.equal(periodEndOf('Q1 FY2027').toISOString().slice(0, 10), '2026-06-30');
  assert.equal(periodEndOf('H1 FY2027').toISOString().slice(0, 10), '2026-09-30');
  assert.deepEqual(explicitFiscalYears("FY'26 and FY2027, also 2027-28 and fiscal '29").sort(), [2026, 2027, 2028, 2029]);
});

test('gate: the target period must be stated -- an explicit year must match, and "this/next year" must resolve to it from the filing date', () => {
  const base = { publicationDate: '2026-05-10' };
  assert.equal(checkPeriodGrounding({ ...base, targetPeriod: 'FY2027', excerpt: 'For FY27 we expect 12% growth' }).ok, true);
  assert.match(checkPeriodGrounding({ ...base, targetPeriod: 'FY2027', excerpt: 'For FY28 we expect 12% growth' }).reason, /names FY2028/);
  assert.equal(checkPeriodGrounding({ ...base, targetPeriod: 'FY2027', excerpt: 'This year we expect 12% growth' }).ok, true);
  assert.equal(checkPeriodGrounding({ ...base, targetPeriod: 'FY2028', excerpt: 'Next year we expect 12% growth' }).ok, true);
  assert.equal(checkPeriodGrounding({ ...base, targetPeriod: 'FY2027', excerpt: 'Next year we expect 12% growth' }).ok, false);
  assert.match(checkPeriodGrounding({ ...base, targetPeriod: 'FY2027', excerpt: 'we expect 12% growth' }).reason, /not stated/);
  assert.equal(checkPeriodGrounding({ ...base, targetPeriod: 'FY2027', excerpt: 'we expect 12% growth', context: 'Analyst: what is your outlook for FY27?' }).ok, true);
});

test('gate: the excerpt must be re-found on the cited page and the metric named nearby', () => {
  assert.deepEqual(contentCheck(candidate(), { found: true, context: '' }), []);
  assert.match(contentCheck(candidate(), { found: false })[0], /^EXCERPT_NOT_FOUND/);
  assert.match(contentCheck(candidate(), { error: 'HTTP 404' })[0], /^SOURCE_UNAVAILABLE/);
  const unnamed = candidate({}, {}, { excerpt: 'For FY27 we expect growth of 12% to 14%' });
  assert.ok(contentCheck(unnamed, { found: true, context: 'we are pleased with the order book' }).some((r) => /^METRIC_NOT_STATED/.test(r)));
  assert.deepEqual(contentCheck(unnamed, { found: true, context: 'Analyst: what is your revenue outlook?' }), []);
});

test('gate: original, reiteration, revision and same-day conflict -- a target is never counted twice', () => {
  const v = (id, date, low, high = null) => candidate({ id }, { promiseDate: date, targetValue: low, targetValueMax: high, operator: high == null ? 'AT_LEAST' : 'RANGE' });
  const decisions = decideGroups([
    v('A', '2026-05-10', 12, 14), // original
    v('B', '2026-08-10', 12, 14), // same target again -> reiteration
    v('C', '2026-11-10', 10, 12), // changed -> revision of A
    v('D', '2027-01-20', 10, 12), // restates the revision -> reiteration of C
  ]);
  assert.deepEqual(Object.fromEntries([...decisions].map(([id, d]) => [id, [d.decision, d.revisesPromiseId || d.reiterationOf || null]])), {
    A: ['ACCEPTED', null], B: ['REITERATION', 'A'], C: ['ACCEPTED', 'A'], D: ['REITERATION', 'C'],
  });
  const conflict = decideGroups([v('E', '2026-05-10', 12, 14), v('F', '2026-05-10', 15, 16)]);
  assert.deepEqual([...conflict.values()].map((d) => d.decision), ['KEPT_PENDING', 'KEPT_PENDING']);
  // An already-published record anchors the group: restating it is a reiteration, not a second promise.
  const anchored = decideGroups([v('G', '2026-08-10', 12, 14)], [{ ...v('PUB-1', '2026-05-10', 12, 14), id: 'PUB-1' }]);
  assert.deepEqual(anchored.get('G'), { decision: 'REITERATION', reasons: [anchored.get('G').reasons[0]], reiterationOf: 'PUB-1', groupKey: anchored.get('G').groupKey });
  // Different metric or scope is a different target.
  const separate = decideGroups([v('H', '2026-05-10', 12, 14), { ...v('I', '2026-08-10', 12, 14), promise: { ...v('I', '2026-08-10', 12, 14).promise, scope: 'SEGMENT', segment: 'Exports' } }]);
  assert.deepEqual([...separate.values()].map((d) => d.decision), ['ACCEPTED', 'ACCEPTED']);
});

test('gate end to end: only what passes every check is accepted; a failed download keeps it pending with the reason', async () => {
  const good = candidate({ id: 'TESTCO-FY2027-CAND-010' });
  const reiterated = candidate({ id: 'TESTCO-FY2027-CAND-011' }, { promiseDate: '2026-08-10' }, { sourceUrl: 'https://nsearchives.nseindia.com/corporate/TESTCO_Q1.pdf', publishedAt: '2026-08-10' });
  const offline = candidate({ id: 'TESTCO-FY2027-CAND-012' }, { metric: 'PAT_GROWTH', category: 'PROFITABILITY', promiseDate: '2026-08-10' }, { sourceUrl: 'https://nsearchives.nseindia.com/corporate/gone.pdf', excerpt: 'For FY27 we expect profit growth of 12% to 14%' });
  const legacy = candidate({ id: 'TESTCO-FY2025-CAND-001', extractionVersion: null });
  const pageFor = { 'https://nsearchives.nseindia.com/corporate/TESTCO_Transcript.pdf': PAGE, 'https://nsearchives.nseindia.com/corporate/TESTCO_Q1.pdf': PAGE };
  const fetched = [];
  const { results, summary } = await reviewCandidates([good, reiterated, offline, legacy], {
    fetchPages: async (url) => { fetched.push(url); if (!pageFor[url]) throw new Error('HTTP 404'); return [{ pageNumber: 4, text: pageFor[url] }]; },
  });
  const by = Object.fromEntries(results.map((r) => [r.candidate.id, r]));
  assert.equal(by['TESTCO-FY2027-CAND-010'].decision, 'ACCEPTED');
  assert.equal(by['TESTCO-FY2027-CAND-011'].decision, 'REITERATION');
  assert.equal(by['TESTCO-FY2027-CAND-012'].decision, 'KEPT_PENDING');
  assert.match(by['TESTCO-FY2027-CAND-012'].reasons[0], /^SOURCE_UNAVAILABLE/);
  assert.match(by['TESTCO-FY2025-CAND-001'].reasons[0], /^LEGACY_V1/);
  assert.equal(fetched.includes(legacy.promiseEvidence.sourceUrl) && legacy.promiseEvidence.sourceUrl !== good.promiseEvidence.sourceUrl, false, 'a legacy record never triggers a download');
  assert.deepEqual({ accepted: summary.accepted, reiterations: summary.reiterations, keptPending: summary.keptPending }, { accepted: 1, reiterations: 1, keptPending: 2 });
});

test('locateExcerpt returns the text just before the excerpt as context', () => {
  const r = locateExcerpt('we expect revenue growth of 12%', 'Analyst: what about FY27? Management: we expect revenue growth of 12% for the year.');
  assert.equal(r.found, true);
  assert.match(r.context, /what about fy27\?/);
});

// ---------------------------------------------------------------------------
// Strict like-for-like actuals (tier (a))
// ---------------------------------------------------------------------------
const XBRL = (n) => `https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_${n}_WEB.xml`;
const xfact = (period, value, { line = 'Revenue from operations', basis = 'Consolidated', metric = 'REVENUE', url = XBRL(period), date = '2026-05-05' } = {}) => ({
  dataOrigin: 'REAL_RESEARCH', symbol: 'ZZ', period, date: new Date(date), fact: `ZZ Ltd reported ${line} of ${value} INR_CRORE for ${period} (${basis}, Audited).`,
  metrics: { metric, actualValue: value, unit: 'INR_CRORE' }, source: { url, publishedAt: new Date(date) }, quarantine: { quarantined: false },
});
const mockFacts = (t, docs) => {
  t.mock.method(CompanyHistoricalFact, 'find', (query) => {
    const rows = docs.filter((d) => d.symbol === query.symbol && d.metrics.metric === query['metrics.metric'] && !d.quarantine?.quarantined);
    const chain = { sort: () => chain, lean: async () => rows };
    return chain;
  });
};

test('describeXbrlFact reads the line, basis and period from the fact\'s own sentence', () => {
  const d = describeXbrlFact(xfact('FY2026', 100, { line: 'Total income', basis: 'Standalone' }));
  assert.deepEqual([d.definition, d.basis, d.period.granularity, d.isXbrl], ['TOTAL_INCOME', 'STANDALONE', 'ANNUAL', true]);
});

test('revenue growth is derived from two annual figures of the same line and basis', async (t) => {
  mockFacts(t, [xfact('FY2026', 1100), xfact('FY2025', 1000), xfact('Q4 FY2026', 300)]);
  const m = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZ' }, { metric: 'REVENUE_GROWTH', targetPeriod: 'FY2026', targetValue: 12, targetUnit: 'PERCENT' });
  assert.equal(m.actualValue, 10);
  assert.equal(m.actualPeriod, 'FY2026');
  assert.match(m.outcomeStatement, /reported-currency/);
  // Scored against the target: 10% < 12% floor -> MISSED, with the shortfall.
  const verdict = evaluatePromiseOutcome({ targetValue: 12, targetUnit: 'PERCENT', actualValue: m.actualValue, actualUnit: 'PERCENT', operator: 'GTE', targetPeriod: 'FY2026', actualPeriod: m.actualPeriod, asOf: new Date('2026-10-01') });
  assert.equal(verdict.outcome, 'MISSED');
});

test('revenue guidance is never compared with total income (the bank case)', async (t) => {
  mockFacts(t, [xfact('FY2026', 9000, { line: 'Total income' }), xfact('FY2025', 8000, { line: 'Total income' })]);
  const m = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZ' }, { metric: 'REVENUE', targetPeriod: 'FY2026', targetValue: 8500, targetUnit: 'INR_CRORE' });
  assert.equal(m.actualValue, undefined);
  assert.match(m.unavailableReason, /revenue from operations, but the company's filings report total income/);
  // ...and it is authoritative: a looser tier is never asked to supply a figure instead.
  let looserCalled = false;
  const viaAll = await searchActualOutcomesLocalFirst({ symbol: 'ZZ' }, { metric: 'REVENUE', targetPeriod: 'FY2026', targetValue: 8500, targetUnit: 'INR_CRORE' }, {
    persistedDocumentsFn: async () => { looserCalled = true; return null; }, indianApiFn: async () => { looserCalled = true; return { actualValue: 1 }; },
  });
  assert.equal(looserCalled, false);
  assert.match(viaAll.unavailableReason, /total income/);
});

test('an unstated basis is only scored when consolidated and standalone agree; a stated basis is honoured', async (t) => {
  mockFacts(t, [xfact('FY2026', 1000), xfact('FY2026', 700, { basis: 'Standalone', url: XBRL('S26') })]);
  const unstated = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZ' }, { metric: 'REVENUE', targetPeriod: 'FY2026', targetValue: 900, targetUnit: 'INR_CRORE' });
  assert.match(unstated.unavailableReason, /basis would decide the verdict/);
  const standalone = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZ' }, { metric: 'REVENUE', targetPeriod: 'FY2026', targetValue: 900, targetUnit: 'INR_CRORE', statementText: 'standalone revenue of 900 crore' });
  assert.equal(standalone.actualValue, 700);
});

test('a half-year target is never matched against the annual figure, and quarterly growth is not derived', async (t) => {
  mockFacts(t, [xfact('FY2026', 1000), xfact('FY2025', 900)]);
  const h1 = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZ' }, { metric: 'REVENUE', targetPeriod: 'H1 FY2026', targetValue: 500, targetUnit: 'INR_CRORE' });
  assert.equal(h1.actualValue, undefined);
  const q = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZ' }, { metric: 'REVENUE_GROWTH', targetPeriod: 'Q1 FY2026', targetValue: 10, targetUnit: 'PERCENT' });
  assert.match(q.unavailableReason, /quarter-on-quarter or year-on-year/);
});

test('growth from a loss or zero base is never computed', async (t) => {
  mockFacts(t, [xfact('FY2026', 50, { line: 'Profit for the period', metric: 'PAT' }), xfact('FY2025', -20, { line: 'Profit for the period', metric: 'PAT' })]);
  const m = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZ' }, { metric: 'PAT_GROWTH', targetPeriod: 'FY2026', targetValue: 10, targetUnit: 'PERCENT' });
  assert.match(m.unavailableReason, /zero or negative/);
});

// ---------------------------------------------------------------------------
// The one shared outcome resolver
// ---------------------------------------------------------------------------
const record = (promise, outcome, outcomeExcerpt = null) => ({
  promise: { statement: 'Management target.', targetType: 'ABSOLUTE', promiseDate: '2025-05-01', ...promise },
  outcome: { status: 'PENDING', ...outcome },
  promiseEvidence: { excerpt: promise.statement || 'Management target.' },
  outcomeEvidence: outcomeExcerpt ? { excerpt: outcomeExcerpt } : null,
});

test('₹1,000 crore minimum target with ₹800 crore actual is MISSED at 80% with a ₹200 crore / 20% shortfall', () => {
  const v = resolveCuratedRecordOutcome(record({ metric: 'REVENUE', targetValue: 1000, targetUnit: 'INR_CRORE', operator: 'AT_LEAST', targetPeriod: 'FY2026' }, { actualValue: 800, actualUnit: 'INR_CRORE' }), { asOf: new Date('2026-10-01') });
  assert.equal(v.outcome, 'MISSED');
  assert.equal(v.achievementPercentage, 80);
  assert.deepEqual([v.shortfall.value, v.shortfall.percentage], [200, 20]);
});

test('a segment target is never scored against a company-level actual', () => {
  const v = resolveCuratedRecordOutcome(record({ metric: 'REVENUE_GROWTH', targetValue: 10, targetUnit: 'PERCENT', operator: 'AT_LEAST', targetPeriod: 'FY2026', scope: 'SEGMENT' }, { actualValue: 12, actualUnit: 'PERCENT' }), { asOf: new Date('2026-10-01') });
  assert.equal(v.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(v.reason, /Scope mismatch/);
});

test('constant-currency guidance is never scored against reported-currency growth', () => {
  const v = resolveCuratedRecordOutcome(record({ metric: 'REVENUE_GROWTH', statement: 'revenue growth of 8% in constant currency', targetValue: 8, targetUnit: 'PERCENT', operator: 'AT_LEAST', targetPeriod: 'FY2026' }, { actualValue: 9, actualUnit: 'PERCENT' }, 'Year-on-year growth of 9% [reported-currency (INR) growth]'), { asOf: new Date('2026-10-01') });
  assert.equal(v.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(v.reason, /Currency-basis mismatch/);
});

test('plain "revenue" guidance is never scored against a total-income actual', () => {
  const v = resolveCuratedRecordOutcome(record({ metric: 'REVENUE', statement: 'revenue of 1,000 crore', targetValue: 1000, targetUnit: 'INR_CRORE', operator: 'AT_LEAST', targetPeriod: 'FY2026' }, { actualValue: 1100, actualUnit: 'INR_CRORE' }, 'ZZ reported Total income of 1100 INR_CRORE for FY2026 (Consolidated, Audited).'), { asOf: new Date('2026-10-01') });
  assert.equal(v.outcome, 'INSUFFICIENT_EVIDENCE');
  assert.match(v.reason, /Metric-definition mismatch/);
});

test('a record with no numeric target keeps its recorded status unless it is marked qualitative', () => {
  assert.equal(resolveCuratedRecordOutcome(record({ targetValue: null, operator: 'AT_LEAST' }, { status: 'PENDING' })).outcome, 'PENDING');
  assert.equal(resolveCuratedRecordOutcome(record({ targetValue: null, operator: 'QUALITATIVE' }, { status: 'ACHIEVED' })).outcome, 'QUALITATIVE_ONLY');
});

test('metric labels name the actual metric (Attrition), and only an unidentified metric reads as "Other"', () => {
  assert.equal(metricLabelFor('ATTRITION'), 'Attrition');
  assert.match(metricLabelFor('OTHER'), /not identified/);
});

// ---------------------------------------------------------------------------
// Discovery and scheduling
// ---------------------------------------------------------------------------
test('NSE discovery classifies investor / analyst presentations, but not meeting intimations or recordings', () => {
  const row = (desc, text) => ({ desc, attchmntText: text, attchmntFile: 'https://nsearchives.nseindia.com/corporate/x.pdf' });
  assert.equal(classifyNseAnnouncement(row('Updates', 'Larsen & Toubro Limited has informed the Exchange regarding Analyst Presentation.- Q4 / FY26.')), 'INVESTOR_PRESENTATION');
  assert.equal(classifyNseAnnouncement(row('Investor Presentation', 'Investor presentation for the quarter ended March 31, 2026')), 'INVESTOR_PRESENTATION');
  assert.equal(classifyNseAnnouncement(row('Analysts/Institutional Investor Meet/Con. Call Updates', 'Transcript of the earnings call')), 'EARNINGS_CALL_TRANSCRIPT');
  assert.equal(classifyNseAnnouncement(row('Analysts/Institutional Investor Meet/Con. Call Updates', 'Intimation of schedule of analyst meet and investor presentation')), null);
  assert.equal(classifyNseAnnouncement(row('Updates', 'Audio recording link of the investor presentation')), null);
  assert.equal(classifyNseAnnouncement({ ...row('Updates', 'Analyst Presentation'), attchmntFile: 'https://x/y.zip' }), null);
});

test('the scheduled XBRL refresh rotates least-recently-attempted first, including completed companies, never alphabetically', () => {
  const r = (symbol, lastAttemptAt, extra = {}) => ({ symbol, facts: { real: 10, missingYears: [] }, category: 'COMPLETE', job: { status: 'COMPLETED', lastAttemptAt, updatedAt: '2025-01-01T00:00:00Z' }, ...extra });
  const rows = [r('AAA', '2026-09-30T00:00:00Z'), r('ZZZ', null), r('MMM', '2026-06-01T00:00:00Z'), r('BBB', '2026-07-01T00:00:00Z')];
  assert.deepEqual(withFactsRows(rows).map((x) => x.symbol), ['ZZZ', 'MMM', 'BBB', 'AAA']);
  const incomplete = [r('BBB', '2026-07-01T00:00:00Z', { category: 'PARTIAL', facts: { real: 3, missingYears: [2022] } }), r('AAA', '2026-09-01T00:00:00Z', { category: 'PARTIAL', facts: { real: 3, missingYears: [2022] } })];
  assert.deepEqual(incompleteRows(incomplete).map((x) => x.symbol), ['BBB', 'AAA']);
});

// ---------------------------------------------------------------------------
// Research-aware empty states
// ---------------------------------------------------------------------------
test('an empty Promises vs Actuals table says which kind of empty it is', async () => {
  const timeline = async () => ({ symbol: 'ZZ', companyName: 'ZZ', dataMode: 'RESEARCH_PENDING', coverageStatus: 'RESEARCH_PENDING', timeline: [], summary: {} });
  const state = (status) => async () => ({ status });
  const empty = async (status) => (await buildManagementDelivery('ZZ', { getTimelineFn: timeline, getLegacyPromisesFn: async () => [], getResearchStateFn: state(status) })).emptyState;
  assert.equal(await empty('NOT_RESEARCHED'), 'NOT_RESEARCHED');
  assert.equal(await empty('RESEARCHED'), 'NO_MEASURABLE_GUIDANCE');
  assert.equal(await empty('CANDIDATES_PENDING_REVIEW'), 'GUIDANCE_PENDING_REVIEW');
  assert.equal(await empty('SOURCES_FAILED'), 'SOURCES_FAILED');
});
