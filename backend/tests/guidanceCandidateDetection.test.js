import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGuidanceCandidate } from '../services/guidanceCandidateDetection.js';

test('detectGuidanceCandidate: broad recall over the required Part 2 signal list', () => {
  const cases = [
    'We expect strong growth next year.',
    'Our outlook for the segment remains positive.',
    'Management forecasts a recovery in H2.',
    'We are targeting double-digit growth.',
    'The company revised its estimates upward.',
    'We maintained our full-year guidance.',
    'The board decided to raise the dividend payout.',
    'Margins improved sequentially this quarter.',
    'Revenue growth guidance stands at 8-10%.',
    'Capex for the year will be higher than planned.',
    'We continue hiring across geographies.',
    'Our deal pipeline remains healthy.',
    'Management expects a gradual recovery.',
  ];
  for (const text of cases) {
    const result = detectGuidanceCandidate(text);
    assert.equal(result.isCandidate, true, `expected a candidate for: "${text}"`);
    assert.ok(result.signals.length > 0);
  }
});

test('detectGuidanceCandidate: every candidate decision records at least one machine-readable signal name', () => {
  const result = detectGuidanceCandidate('We expect margin expansion of 200 basis points.');
  assert.ok(Array.isArray(result.signals) && result.signals.length > 0);
});

test('detectGuidanceCandidate: a chunk matching no signal at all is never a candidate, with an explicit reason', () => {
  const result = detectGuidanceCandidate('The Jaguar TCS Racing team competes in the Formula E championship.');
  assert.equal(result.isCandidate, false);
  assert.equal(result.reason, 'NO_SIGNAL_MATCHED');
});

test('detectGuidanceCandidate never asserts a chunk IS valid guidance -- only that it is worth attempting extraction on', () => {
  const result = detectGuidanceCandidate('We expect this to be an unrelated sentence with no real numbers.');
  assert.equal(result.isCandidate, true);
  assert.equal(typeof result.isCandidate, 'boolean');
  assert.equal(result.reason, 'SIGNAL_MATCHED');
});
