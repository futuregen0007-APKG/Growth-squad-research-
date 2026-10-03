import test from 'node:test';
import assert from 'node:assert/strict';
import { searchActualOutcomeFromHistoricalFacts } from '../services/OutcomeEvidenceService.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';

/**
 * outcomeEvidenceQuarantine.test.js
 * ==================================
 * Tier (a) of the outcome lookup must never return a quarantined
 * CompanyHistoricalFact as an actual. No database: CompanyHistoricalFact.find
 * is mocked with an in-memory store that honours the query's filter, so the
 * test proves both that the filter is in the query and that a quarantined
 * fact therefore cannot match.
 */

// Tier (a) reads exchange XBRL facts only (a transcript-derived fact is never an actual), so the fixture
// is an XBRL revenue fact whose own sentence states its line and basis, as the real collector writes it.
const GOOD_URL = 'https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_ZZGOOD_WEB.xml';
const fact = (overrides = {}) => ({
  dataOrigin: 'REAL_RESEARCH',
  symbol: 'ZZQUARANTINE',
  date: new Date('2026-04-15'),
  period: 'FY2026',
  fact: 'ZZ Ltd reported Revenue from operations of 2200 INR_CRORE for FY2026 (Consolidated, Audited).',
  metrics: { metric: 'REVENUE', actualValue: 2200, unit: 'INR_CRORE' },
  source: { title: 'Q4 FY2026 results', url: GOOD_URL, publishedAt: new Date('2026-04-15') },
  confidence: 0.9,
  quarantine: { quarantined: false },
  ...overrides,
});

// Minimal evaluator for the operators the tier-(a) query uses.
const matchesQuery = (doc, query) => Object.entries(query).every(([key, cond]) => {
  const value = key.split('.').reduce((obj, part) => (obj == null ? undefined : obj[part]), doc);
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && '$ne' in cond) {
    return cond.$ne === null ? value !== null && value !== undefined : value !== cond.$ne;
  }
  return value === cond;
});

const mockFind = (t, docs) => {
  const queries = [];
  t.mock.method(CompanyHistoricalFact, 'find', (query) => {
    queries.push(query);
    const result = docs.filter((d) => matchesQuery(d, query));
    const chain = { sort: () => chain, lean: async () => result };
    return chain;
  });
  return queries;
};

const promise = { metric: 'REVENUE', targetValue: 2000, targetUnit: 'INR_CRORE', targetPeriod: 'FY2026' };
const isMatch = (m) => m && m.actualValue != null;

test('the tier-(a) query excludes quarantined facts', async (t) => {
  const queries = mockFind(t, []);
  await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]['quarantine.quarantined'], { $ne: true });
  assert.equal(queries[0].dataOrigin, 'REAL_RESEARCH');
});

test('a quarantined fact is never returned as a match, even when it is the only compatible fact', async (t) => {
  mockFind(t, [fact({ quarantine: { quarantined: true, reason: 'provenance' } })]);
  const result = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise);
  assert.equal(isMatch(result), false);
  assert.match(result.unavailableReason, /no exchange XBRL/);
});

test('with a quarantined and a clean fact on file, only the clean one can match', async (t) => {
  mockFind(t, [
    fact({ date: new Date('2026-05-01'), metrics: { metric: 'REVENUE', actualValue: 9900, unit: 'INR_CRORE' }, fact: 'ZZ Ltd reported Revenue from operations of 9900 INR_CRORE for FY2026 (Consolidated, Audited).', source: { title: 'bad', url: 'https://nsearchives.nseindia.com/corporate/xbrl/ZZBAD_WEB.xml' }, quarantine: { quarantined: true } }),
    fact(),
  ]);
  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise);
  assert.ok(isMatch(match));
  assert.equal(match.actualValue, 2200);
  assert.equal(match.outcomeSourceUrl, GOOD_URL);
});

test('a fact with no quarantine sub-document (pre-quarantine data) is still eligible', async (t) => {
  const legacy = fact();
  delete legacy.quarantine;
  mockFind(t, [legacy]);
  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise);
  assert.equal(match?.actualValue, 2200);
});
