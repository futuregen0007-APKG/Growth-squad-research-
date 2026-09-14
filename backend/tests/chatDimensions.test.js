import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequestedDimensions, DEFAULT_COMPARISON_DIMENSIONS, REQUESTED_DIMENSIONS } from '../graph/dimensions.js';

test('the confirmed Phase 0/1 scenario resolves exactly FINANCIALS, GUIDANCE, NEWS -- no more, no less', () => {
  const dims = extractRequestedDimensions('Compare TCS and Infosys using financial growth, management guidance and recent news', 'STOCK_COMPARISON');
  assert.deepEqual(new Set(dims), new Set(['FINANCIALS', 'GUIDANCE', 'NEWS']));
  assert.equal(dims.length, 3);
});

test('a bare "compare X and Y" with no qualifier falls back to the documented default comparison dimensions', () => {
  const dims = extractRequestedDimensions('Compare HAL and BEL', 'STOCK_COMPARISON');
  assert.deepEqual(new Set(dims), new Set(DEFAULT_COMPARISON_DIMENSIONS));
});

test('every extracted dimension is drawn from the closed enum', () => {
  const dims = extractRequestedDimensions('price, revenue, guidance, news, filings, profile, my portfolio, my watchlist', 'STOCK_COMPARISON');
  dims.forEach((d) => assert.ok(REQUESTED_DIMENSIONS.includes(d)));
});

test('LIVE_MARKET_DATA with no explicit dimension keyword implies PRICE from intent alone', () => {
  const dims = extractRequestedDimensions('How is HAL doing right now?', 'LIVE_MARKET_DATA');
  assert.deepEqual(dims, ['PRICE']);
});

test('NEWS_RESEARCH implies NEWS from intent alone', () => {
  const dims = extractRequestedDimensions('Anything new on Infosys?', 'NEWS_RESEARCH');
  assert.deepEqual(dims, ['NEWS']);
});

test('EARNINGS_INTELLIGENCE implies GUIDANCE + FINANCIALS from intent alone', () => {
  const dims = extractRequestedDimensions('What did HAL report last quarter?', 'EARNINGS_INTELLIGENCE');
  assert.deepEqual(new Set(dims), new Set(['GUIDANCE', 'FINANCIALS']));
});

test('GENERAL_EDUCATION always resolves to GENERAL', () => {
  assert.deepEqual(extractRequestedDimensions('What is a P/E ratio?', 'GENERAL_EDUCATION'), ['GENERAL']);
});

test('an explicit keyword in a non-comparison message overrides the intent-based default', () => {
  const dims = extractRequestedDimensions('Show me the latest news on HAL', 'LIVE_MARKET_DATA');
  assert.ok(dims.includes('NEWS'));
});

test('a message with no keywords and an unmapped intent (e.g. FOLLOW_UP) resolves to an empty set rather than guessing', () => {
  assert.deepEqual(extractRequestedDimensions('what about that', 'FOLLOW_UP'), []);
});
