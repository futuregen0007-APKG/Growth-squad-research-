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

const fact = (overrides = {}) => ({
  dataOrigin: 'REAL_RESEARCH',
  symbol: 'ZZQUARANTINE',
  date: new Date('2026-04-15'),
  period: 'FY2026',
  metrics: { metric: 'OPERATING_MARGIN', actualValue: 22, unit: 'PERCENTAGE' },
  source: { title: 'Q4 FY2026 results', url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/zz-good.pdf', publishedAt: new Date('2026-04-15') },
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

const promise = { metric: 'MARGIN', targetValue: 20, targetUnit: 'PERCENTAGE', targetPeriod: 'FY2026' };

test('the tier-(a) query excludes quarantined facts', async (t) => {
  const queries = mockFind(t, []);
  await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]['quarantine.quarantined'], { $ne: true });
  assert.equal(queries[0].dataOrigin, 'REAL_RESEARCH');
});

test('a quarantined fact is never returned as a match, even when it is the only compatible fact', async (t) => {
  mockFind(t, [fact({ quarantine: { quarantined: true, reason: 'provenance' } })]);
  assert.equal(await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise), null);
});

test('with a quarantined and a clean fact on file, only the clean one can match', async (t) => {
  mockFind(t, [
    fact({ metrics: { metric: 'OPERATING_MARGIN', actualValue: 99, unit: 'PERCENTAGE' }, source: { title: 'bad', url: 'https://example.invalid/bad.pdf' }, quarantine: { quarantined: true } }),
    fact(),
  ]);
  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise);
  assert.ok(match);
  assert.equal(match.actualValue, 22);
  assert.equal(match.outcomeSourceUrl, 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/zz-good.pdf');
});

test('a fact with no quarantine sub-document (pre-quarantine data) is still eligible', async (t) => {
  const legacy = fact();
  delete legacy.quarantine;
  mockFind(t, [legacy]);
  const match = await searchActualOutcomeFromHistoricalFacts({ symbol: 'ZZQUARANTINE' }, promise);
  assert.equal(match?.actualValue, 22);
});
