import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintToolCall } from '../graph/toolFingerprint.js';

test('two identical tool calls (same tool, same args) fingerprint identically', () => {
  const a = fingerprintToolCall({ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } });
  const b = fingerprintToolCall({ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } });
  assert.equal(a, b);
});

test('a different symbol produces a different fingerprint -- never deduplicated', () => {
  const a = fingerprintToolCall({ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } });
  const b = fingerprintToolCall({ tool: 'getCompanyFinancials', args: { symbol: 'INFY' } });
  assert.notEqual(a, b);
});

test('a different tool with the same args produces a different fingerprint', () => {
  const a = fingerprintToolCall({ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } });
  const b = fingerprintToolCall({ tool: 'getCompanyResearch', args: { symbol: 'TCS' } });
  assert.notEqual(a, b);
});

test('a different period/metric argument produces a different fingerprint -- never deduplicated', () => {
  const a = fingerprintToolCall({ tool: 'getManagementPromiseDetails', args: { symbol: 'TCS', period: 'FY2025' } });
  const b = fingerprintToolCall({ tool: 'getManagementPromiseDetails', args: { symbol: 'TCS', period: 'FY2026' } });
  assert.notEqual(a, b);
});

test('a different user context does not collapse into the same fingerprint when userId is part of args', () => {
  const a = fingerprintToolCall({ tool: 'getManagementPromiseDetails', args: { symbol: 'TCS', requestedBy: 'user-1' } });
  const b = fingerprintToolCall({ tool: 'getManagementPromiseDetails', args: { symbol: 'TCS', requestedBy: 'user-2' } });
  assert.notEqual(a, b);
});

test('symbol case and surrounding whitespace are normalized -- "tcs" and "TCS " fingerprint the same', () => {
  const a = fingerprintToolCall({ tool: 'getLiveQuote', args: { symbol: 'tcs' } });
  const b = fingerprintToolCall({ tool: 'getLiveQuote', args: { symbol: ' TCS ' } });
  assert.equal(a, b);
});

test('argument key order never affects the fingerprint', () => {
  const a = fingerprintToolCall({ tool: 'getManagementPromiseDetails', args: { symbol: 'TCS', metric: 'REVENUE', period: 'FY2026' } });
  const b = fingerprintToolCall({ tool: 'getManagementPromiseDetails', args: { period: 'FY2026', symbol: 'TCS', metric: 'REVENUE' } });
  assert.equal(a, b);
});

test('a symbols array is order- and case-insensitive for fingerprinting (compareStocks with the same pair in either order)', () => {
  const a = fingerprintToolCall({ tool: 'compareStocks', args: { symbols: ['TCS', 'INFY'] } });
  const b = fingerprintToolCall({ tool: 'compareStocks', args: { symbols: ['infy', 'tcs'] } });
  assert.equal(a, b);
});

test('a genuinely different symbols array produces a different fingerprint', () => {
  const a = fingerprintToolCall({ tool: 'compareStocks', args: { symbols: ['TCS', 'INFY'] } });
  const b = fingerprintToolCall({ tool: 'compareStocks', args: { symbols: ['TCS', 'HDFCBANK'] } });
  assert.notEqual(a, b);
});
