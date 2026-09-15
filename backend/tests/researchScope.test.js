import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveResearchScope, classifyGuidanceIntent, splitFiscalPeriod, RESEARCH_GROUNDED_INTENTS,
} from '../graph/researchScope.js';

test('splitFiscalPeriod parses "Q2 FY2026" into fiscal year + quarter', () => {
  assert.deepEqual(splitFiscalPeriod('Q2 FY2026'), { fiscalYear: 'FY2026', fiscalQuarter: 'Q2' });
});

test('splitFiscalPeriod parses a year-only "FY2026" with no quarter', () => {
  assert.deepEqual(splitFiscalPeriod('FY2026'), { fiscalYear: 'FY2026', fiscalQuarter: null });
});

test('splitFiscalPeriod returns nulls for an unrecognized/empty period', () => {
  assert.deepEqual(splitFiscalPeriod(null), { fiscalYear: null, fiscalQuarter: null });
  assert.deepEqual(splitFiscalPeriod('not a period'), { fiscalYear: null, fiscalQuarter: null });
});

test('classifyGuidanceIntent recognizes revised guidance', () => {
  assert.equal(classifyGuidanceIntent('What is the revised guidance for FY2024?'), 'revised_guidance');
});

test('classifyGuidanceIntent recognizes an outcome/achieved question', () => {
  assert.equal(classifyGuidanceIntent('Did the company achieve its FY2023 guidance?'), 'outcome');
});

test('classifyGuidanceIntent recognizes a comparison question', () => {
  assert.equal(classifyGuidanceIntent('Compare TCS and Infosys guidance'), 'comparison');
});

test('classifyGuidanceIntent recognizes a current-guidance question', () => {
  assert.equal(classifyGuidanceIntent('What is the current guidance?'), 'current_guidance');
});

test('classifyGuidanceIntent defaults to historical for a plain past-period question (never assumes "current")', () => {
  assert.equal(classifyGuidanceIntent('What was FY2023 guidance?'), 'historical');
});

test('resolveResearchScope: non-grounded intent short-circuits with needsResearchCorpus false', () => {
  const scope = resolveResearchScope({ text: 'TCS price?', entities: { symbols: ['TCS'] }, intent: 'LIVE_MARKET_DATA' });
  assert.equal(scope.needsResearchCorpus, false);
  assert.equal(scope.ambiguousCompany, false);
  assert.equal(scope.symbol, null);
});

test('resolveResearchScope: exactly one resolved symbol is never ambiguous', () => {
  const scope = resolveResearchScope({
    text: 'What was TCS FY2023 guidance?', entities: { symbols: ['TCS'], periods: ['FY2023'] }, intent: 'DOCUMENT_RESEARCH',
  });
  assert.equal(scope.needsResearchCorpus, true);
  assert.equal(scope.ambiguousCompany, false);
  assert.equal(scope.symbol, 'TCS');
  assert.equal(scope.fiscalYear, 'FY2023');
  assert.equal(scope.fiscalQuarter, null);
});

test('resolveResearchScope: zero resolved symbols is ambiguous -- never guesses', () => {
  const scope = resolveResearchScope({ text: 'What was the guidance?', entities: { symbols: [] }, intent: 'DOCUMENT_RESEARCH' });
  assert.equal(scope.ambiguousCompany, true);
  assert.equal(scope.symbol, null);
});

test('resolveResearchScope: more than one resolved symbol is ambiguous -- never silently retrieves for only the first one', () => {
  const scope = resolveResearchScope({
    text: 'What was the guidance for TCS and Infosys?', entities: { symbols: ['TCS', 'INFY'] }, intent: 'DOCUMENT_RESEARCH',
  });
  assert.equal(scope.ambiguousCompany, true);
  assert.equal(scope.symbol, null);
});

test('resolveResearchScope: a quarter-specific question resolves both fiscalYear and fiscalQuarter', () => {
  const scope = resolveResearchScope({
    text: 'Q4 FY2023 revenue for TCS', entities: { symbols: ['TCS'], periods: ['Q4 FY2023'] }, intent: 'DOCUMENT_RESEARCH',
  });
  assert.equal(scope.fiscalYear, 'FY2023');
  assert.equal(scope.fiscalQuarter, 'Q4');
});

test('RESEARCH_GROUNDED_INTENTS contains exactly DOCUMENT_RESEARCH', () => {
  assert.deepEqual([...RESEARCH_GROUNDED_INTENTS], ['DOCUMENT_RESEARCH']);
});
