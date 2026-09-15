import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveResearchScope } from '../graph/researchScope.js';
import { RESEARCH_ROUTING_FIXTURES } from '../fixtures/researchRoutingFixtures.js';

/**
 * researchRoutingFixtures.test.js
 * ===================================
 * Phase 4C Part 10's "focused routing evaluation": runs every fixture in
 * fixtures/researchRoutingFixtures.js through the real, deterministic
 * resolveResearchScope and asserts every field the fixture specifies.
 * The summary test independently recomputes the required-gate metrics
 * (natural research intent/tool-selection accuracy >= 95%, company/period
 * isolation 100%, ambiguous/unsupported safety 100%) rather than relying
 * on shared mutable state from the per-fixture tests above it, so this
 * file's result is correct regardless of test execution order.
 */

for (const fixture of RESEARCH_ROUTING_FIXTURES) {
  test(`routing fixture [${fixture.id}]: "${fixture.query}"`, () => {
    const scope = resolveResearchScope({ text: fixture.query, entities: fixture.entities, intent: fixture.intent });

    assert.equal(scope.researchQuestionType, fixture.expected.researchQuestionType, 'researchQuestionType mismatch');
    assert.equal(scope.needsResearchCorpus, fixture.expected.needsResearchCorpus, 'needsResearchCorpus mismatch');
    assert.equal(scope.mergeEarningsIntelligence, fixture.expected.mergeEarningsIntelligence, 'mergeEarningsIntelligence mismatch');
    assert.equal(scope.ambiguousCompany, fixture.expected.ambiguousCompany, 'ambiguousCompany mismatch');

    // Company/period isolation: the resolved symbol/fiscalYear/fiscalQuarter
    // must match EXACTLY what the fixture expects, never a substitute.
    if ('symbol' in fixture.expected) assert.equal(scope.symbol, fixture.expected.symbol, 'symbol isolation mismatch');
    if ('fiscalYear' in fixture.expected) assert.equal(scope.fiscalYear, fixture.expected.fiscalYear, 'fiscalYear isolation mismatch');
    if ('fiscalQuarter' in fixture.expected) assert.equal(scope.fiscalQuarter, fixture.expected.fiscalQuarter, 'fiscalQuarter isolation mismatch');

    // Ambiguous/unsupported safety: whenever ambiguousCompany is expected
    // true, resolveResearchScope must NEVER resolve a substitute symbol.
    if (fixture.expected.ambiguousCompany) assert.equal(scope.symbol, null, 'an ambiguous/unsupported company must never resolve a substitute symbol');
  });
}

test('routing fixture summary: required accuracy/isolation/safety gates', () => {
  const total = RESEARCH_ROUTING_FIXTURES.length;
  let correctQuestionType = 0;
  let correctNeedsCorpus = 0;
  let isolationFailures = 0;
  let safetyFailures = 0;

  for (const fixture of RESEARCH_ROUTING_FIXTURES) {
    const scope = resolveResearchScope({ text: fixture.query, entities: fixture.entities, intent: fixture.intent });
    if (scope.researchQuestionType === fixture.expected.researchQuestionType) correctQuestionType += 1;
    if (scope.needsResearchCorpus === fixture.expected.needsResearchCorpus) correctNeedsCorpus += 1;
    if ('symbol' in fixture.expected && scope.symbol !== fixture.expected.symbol) isolationFailures += 1;
    if ('fiscalYear' in fixture.expected && scope.fiscalYear !== fixture.expected.fiscalYear) isolationFailures += 1;
    if ('fiscalQuarter' in fixture.expected && scope.fiscalQuarter !== fixture.expected.fiscalQuarter) isolationFailures += 1;
    if (fixture.expected.ambiguousCompany && scope.symbol !== null) safetyFailures += 1;
  }

  const questionTypeAccuracy = correctQuestionType / total;
  const needsCorpusAccuracy = correctNeedsCorpus / total;

  assert.ok(total >= 30, `expected at least 30 fixtures, got ${total}`);
  assert.ok(questionTypeAccuracy >= 0.95, `researchQuestionType accuracy ${(questionTypeAccuracy * 100).toFixed(1)}% below the 95% gate`);
  assert.ok(needsCorpusAccuracy >= 0.95, `needsResearchCorpus (tool-selection) accuracy ${(needsCorpusAccuracy * 100).toFixed(1)}% below the 95% gate`);
  assert.equal(isolationFailures, 0, 'company/period isolation must be 100%');
  assert.equal(safetyFailures, 0, 'ambiguous/unsupported safety must be 100% (never a substitute company)');
});
