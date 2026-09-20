import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICING_TABLE, PRICING_ALIASES, PRICING_SOURCE, PRICING_VERSION, PRICING_LAST_UPDATED, PRICING_CURRENCY,
  PRICING_STALE_AFTER_DAYS, PRICING_VALIDATION_ERRORS,
  resolveModelId, getPricing, getPricingMetadata, isPricingStale, pricingAgeDays,
  validatePricingEntry, validatePricingTable, validateAliasMap,
} from '../services/telemetry/modelPricing.js';
import { estimateCallCost } from '../services/telemetry/costEstimation.js';

/**
 * modelPricing.test.js
 * =======================
 * Phase 5B goal 4. The invariant that matters most: an unknown model NEVER
 * receives an invented price. A wrong-but-plausible cost figure is worse
 * than an admitted unknown, because it looks like an answer.
 */

test('the shipped table validates cleanly -- no entry is silently dropped in production', () => {
  assert.deepEqual(PRICING_VALIDATION_ERRORS, [], 'a rejected entry would price as unknown without anyone noticing');
  assert.ok(Object.keys(PRICING_TABLE).length > 0);
});

test('the table records its own provenance: source, version, and when a human last confirmed it', () => {
  assert.ok(PRICING_SOURCE.length > 0);
  assert.match(PRICING_LAST_UPDATED, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof PRICING_VERSION, 'string');
  assert.equal(PRICING_CURRENCY, 'USD');

  const metadata = getPricingMetadata();
  assert.equal(metadata.source, PRICING_SOURCE);
  assert.equal(metadata.version, PRICING_VERSION);
  assert.equal(metadata.lastUpdated, PRICING_LAST_UPDATED);
  assert.equal(metadata.pricedModelCount, Object.keys(PRICING_TABLE).length);
  assert.equal(metadata.validationErrorCount, 0);
});

test('metadata carries no rates -- the ops endpoint reports provenance, not a price list', () => {
  const serialized = JSON.stringify(getPricingMetadata());
  assert.equal(serialized.includes('inputPer1M'), false);
  assert.equal(serialized.includes('outputPer1M'), false);
});

test('a known model resolves to itself and prices from the real table', () => {
  assert.equal(resolveModelId('gpt-4o-mini'), 'gpt-4o-mini');
  const pricing = getPricing('gpt-4o-mini');
  assert.ok(pricing.inputPer1M > 0);
  assert.ok(pricing.outputPer1M > 0);
});

test('an explicit alias resolves to its canonical model and prices identically', () => {
  assert.equal(resolveModelId('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini');
  assert.deepEqual(getPricing('gpt-4o-mini-2024-07-18'), getPricing('gpt-4o-mini'));
  assert.equal(
    estimateCallCost({ model: 'gpt-4o-mini-2024-07-18', inputTokens: 1_000_000, outputTokens: 0 }),
    estimateCallCost({ model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 }),
  );
});

test('every declared alias points at a model that really is priced', () => {
  for (const [alias, canonical] of Object.entries(PRICING_ALIASES)) {
    assert.ok(PRICING_TABLE[canonical], `alias ${alias} must resolve to a priced model`);
    assert.equal(PRICING_TABLE[alias], undefined, `${alias} must not also be a table entry`);
  }
});

test('an UNLISTED dated variant is unknown -- the date suffix is never stripped to guess a price', () => {
  // This is the whole point of an explicit alias map: a genuinely new model
  // that merely looks like an old one must not inherit its price.
  assert.equal(resolveModelId('gpt-4o-mini-2099-01-01'), null);
  assert.equal(getPricing('gpt-4o-mini-2099-01-01'), null);
  assert.equal(estimateCallCost({ model: 'gpt-4o-mini-2099-01-01', inputTokens: 1_000_000, outputTokens: 0 }), null);
});

test('a prefix or partial match never resolves', () => {
  assert.equal(resolveModelId('gpt-4o-mini-turbo-ultra'), null);
  assert.equal(resolveModelId('gpt-4'), null);
  assert.equal(resolveModelId('gpt'), null);
  assert.equal(resolveModelId('my-gpt-4o-mini'), null);
});

test('a missing, empty, or non-string model is unknown, never priced', () => {
  for (const value of [undefined, null, '', '   ', 42, {}, []]) {
    assert.equal(resolveModelId(value), null, `${JSON.stringify(value)} must not resolve`);
    assert.equal(getPricing(value), null);
  }
});

test('surrounding whitespace and casing are tolerated on an otherwise exact id', () => {
  assert.equal(resolveModelId('  gpt-4o-mini  '), 'gpt-4o-mini');
  assert.equal(resolveModelId('GPT-4O-MINI'), 'gpt-4o-mini');
});

test('validation rejects a missing, zero, or negative rate', () => {
  assert.ok(validatePricingEntry('m', { outputPer1M: 1 }).some((e) => e.includes('inputPer1M')));
  assert.ok(validatePricingEntry('m', { inputPer1M: 0, outputPer1M: 1 }).some((e) => e.includes('greater than zero')));
  assert.ok(validatePricingEntry('m', { inputPer1M: -1, outputPer1M: 1 }).some((e) => e.includes('greater than zero')));
  assert.ok(validatePricingEntry('m', { inputPer1M: 'free', outputPer1M: 1 }).some((e) => e.includes('finite')));
  assert.deepEqual(validatePricingEntry('m', { inputPer1M: 1, outputPer1M: 2 }), []);
});

test('validation rejects a cached rate that costs more than fresh input -- always a typo', () => {
  const errors = validatePricingEntry('m', { inputPer1M: 1, outputPer1M: 2, cachedInputPer1M: 5 });
  assert.ok(errors.some((e) => e.includes('must not exceed inputPer1M')));
});

test('validation rejects an unknown pricing field, so a typo cannot be silently ignored', () => {
  const errors = validatePricingEntry('m', { inputPer1M: 1, outputPer1M: 2, inputPer1k: 0.001 });
  assert.ok(errors.some((e) => e.includes('unknown pricing field')));
});

test('an invalid entry is DROPPED from the usable table, so it prices as unknown rather than wrong', () => {
  const { valid, errors } = validatePricingTable({
    'good-model': { inputPer1M: 1, outputPer1M: 2 },
    'broken-model': { inputPer1M: -1, outputPer1M: 2 },
  });

  assert.ok(valid['good-model']);
  assert.equal(valid['broken-model'], undefined, 'a broken price is never usable');
  assert.ok(errors.length > 0, 'and the rejection is reported, not swallowed');
});

test('a model with no published cached rate is priced at the full input rate, never at zero', () => {
  const { valid } = validatePricingTable({ 'no-cache-model': { inputPer1M: 3, outputPer1M: 6 } });
  assert.equal(valid['no-cache-model'].cachedInputPer1M, 3, 'defaulting to 0 would under-report a real cost');
});

test('the validated table is frozen, so nothing can mutate a price at runtime', () => {
  assert.equal(Object.isFrozen(PRICING_TABLE), true);
  assert.equal(Object.isFrozen(PRICING_TABLE['gpt-4o-mini']), true);
  const { valid } = validatePricingTable({ m: { inputPer1M: 1, outputPer1M: 2 } });
  assert.equal(Object.isFrozen(valid), true);
});

test('alias validation rejects a dangling, self-referential, or shadowing alias', () => {
  const table = { real: { inputPer1M: 1, outputPer1M: 2 } };
  const { valid, errors } = validateAliasMap({
    'points-nowhere': 'does-not-exist',
    real: 'real',
    'good-alias': 'real',
  }, table);

  assert.equal(valid['good-alias'], 'real');
  assert.equal(valid['points-nowhere'], undefined);
  assert.ok(errors.some((e) => e.includes('not a priced model')));
  assert.ok(errors.some((e) => e.includes('points at itself')));
});

test('staleness is computed from the last-confirmed date, and reported honestly', () => {
  const confirmedAt = Date.parse(`${PRICING_LAST_UPDATED}T00:00:00Z`);
  const dayMs = 86_400_000;

  assert.equal(isPricingStale(confirmedAt + dayMs), false, 'a day-old table is current');
  assert.equal(isPricingStale(confirmedAt + (PRICING_STALE_AFTER_DAYS - 1) * dayMs), false);
  assert.equal(isPricingStale(confirmedAt + (PRICING_STALE_AFTER_DAYS + 1) * dayMs), true, 'past the window it is stale');

  assert.equal(pricingAgeDays(confirmedAt + 10 * dayMs), 10);
  const staleMetadata = getPricingMetadata(confirmedAt + (PRICING_STALE_AFTER_DAYS + 30) * dayMs);
  assert.equal(staleMetadata.stale, true);
  assert.equal(staleMetadata.ageDays, PRICING_STALE_AFTER_DAYS + 30);
  assert.equal(staleMetadata.staleAfterDays, PRICING_STALE_AFTER_DAYS);
});

test('a stale table still PRICES -- staleness is a warning to an operator, not an outage', () => {
  const farFuture = Date.parse(`${PRICING_LAST_UPDATED}T00:00:00Z`) + 10_000 * 86_400_000;
  assert.equal(isPricingStale(farFuture), true);
  assert.equal(estimateCallCost({ model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 }), 0.15);
});

test('cost arithmetic is unchanged by the move to a configuration module', () => {
  const pricing = getPricing('gpt-4o');
  assert.equal(
    estimateCallCost({ model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    pricing.inputPer1M + pricing.outputPer1M,
  );
  assert.equal(
    estimateCallCost({ model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }),
    pricing.cachedInputPer1M,
  );
});
