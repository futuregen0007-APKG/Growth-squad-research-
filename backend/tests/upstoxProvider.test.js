import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstoxProvider } from '../providers/upstox/UpstoxProvider.js';
import { UPSTOX_ERROR_CODES } from '../providers/upstox/UpstoxErrorMapper.js';

const TEST_ISIN = 'INE467B01029'; // TCS's real ISIN, used only as a realistic-looking fixture identifier

// FIXTURE response -- hand-authored to match Upstox's documented v2
// fundamentals shape, never live-verified data (no real
// UPSTOX_ANALYTICS_TOKEN exists in this environment).
const PROFILE_FIXTURE = {
  data: {
    company_profile: 'A leading IT services company.',
    sector: 'Information Technology',
    sector_market_cap_inr: { value: 1500000, unit: 'Cr', formatted: '₹15,00,000 Cr' },
    sector_market_cap_usd: { value: 180000, unit: 'Mn', formatted: '$180,000 Mn' },
  },
};

// No mocking library in this repo's dependencies -- tests replace the
// provider's internal axios instance's `.get` directly, mirroring
// tests/indianApiProvider.test.js's exact mocking mechanism.
const withMockedClient = (provider, implementation) => {
  provider.client.get = implementation;
  return provider;
};

test('UpstoxProvider.isConfigured is false and getProfile throws CONFIGURATION_ERROR when no token is set (today\'s real environment state)', async () => {
  const provider = new UpstoxProvider({ token: '' });
  assert.equal(provider.isConfigured, false);
  await assert.rejects(
    () => provider.getProfile(TEST_ISIN),
    (error) => error.errorCode === UPSTOX_ERROR_CODES.CONFIGURATION_ERROR,
  );
});

test('UpstoxProvider never includes the bearer token in a thrown error message', async () => {
  const provider = new UpstoxProvider({ token: 'super-secret-upstox-token-value' });
  withMockedClient(provider, async () => {
    const error = new Error('Request failed with status code 401');
    error.response = { status: 401, data: { errors: [{ errorCode: 'UDAPI1001', message: 'Invalid token' }] } };
    throw error;
  });
  await assert.rejects(
    () => provider.getProfile(TEST_ISIN),
    (error) => {
      assert.equal(error.errorCode, UPSTOX_ERROR_CODES.AUTHENTICATION_ERROR);
      assert.ok(!error.message.includes('super-secret-upstox-token-value'));
      return true;
    },
  );
});

test('UpstoxProvider maps UDAPI1206 body error code to INVALID_ISIN', async () => {
  const provider = new UpstoxProvider({ token: 'test-token' });
  withMockedClient(provider, async () => {
    const error = new Error('Request failed with status code 400');
    error.response = { status: 400, data: { status: 'error', errors: [{ errorCode: 'UDAPI1206', message: 'Invalid ISIN' }] } };
    throw error;
  });
  await assert.rejects(
    () => provider.getProfile('NOT-A-REAL-ISIN'),
    (error) => error.errorCode === UPSTOX_ERROR_CODES.INVALID_ISIN,
  );
});

test('UpstoxProvider maps 429 to RATE_LIMITED', async () => {
  const provider = new UpstoxProvider({ token: 'test-token' });
  withMockedClient(provider, async () => {
    const error = new Error('Too many requests');
    error.response = { status: 429 };
    throw error;
  });
  await assert.rejects(
    () => provider.getKeyRatios(TEST_ISIN),
    (error) => error.errorCode === UPSTOX_ERROR_CODES.RATE_LIMITED,
  );
});

test('UpstoxProvider maps a request timeout to TIMEOUT', async () => {
  const provider = new UpstoxProvider({ token: 'test-token' });
  withMockedClient(provider, async () => {
    const error = new Error('timeout of 10000ms exceeded');
    error.code = 'ECONNABORTED';
    throw error;
  });
  await assert.rejects(
    () => provider.getBalanceSheet(TEST_ISIN),
    (error) => error.errorCode === UPSTOX_ERROR_CODES.TIMEOUT,
  );
});

test('UpstoxProvider retries once on a 503 before failing (bounded retry, not a storm)', async () => {
  const provider = new UpstoxProvider({ token: 'test-token' });
  let attempts = 0;
  withMockedClient(provider, async () => {
    attempts += 1;
    const error = new Error('Service Unavailable');
    error.response = { status: 503 };
    throw error;
  });
  await assert.rejects(
    () => provider.getCashFlow(TEST_ISIN),
    (error) => error.errorCode === UPSTOX_ERROR_CODES.UPSTREAM_UNAVAILABLE,
  );
  assert.equal(attempts, 2); // one bounded retry (MAX_RETRIES=1), never more
});

test('UpstoxProvider normalizes profile data and never labels sector market cap as company market cap', async () => {
  const provider = new UpstoxProvider({ token: 'test-token' });
  withMockedClient(provider, async () => ({ data: PROFILE_FIXTURE }));

  const result = await provider.getProfile(TEST_ISIN, { symbol: 'TCS' });
  assert.equal(result.fromCache, false);
  assert.equal(result.data.sector, 'Information Technology');
  assert.equal(result.data.sectorMarketCapInr.value, 1500000);
});

test('UpstoxProvider fetches all sections concurrently without crashing when unconfigured (graceful degrade, mirrors IndianApiProvider.isConfigured behavior)', async () => {
  const provider = new UpstoxProvider({ token: null });
  assert.equal(provider.isConfigured, false);
  const results = await Promise.allSettled([
    provider.getProfile(TEST_ISIN),
    provider.getBalanceSheet(TEST_ISIN),
    provider.getCashFlow(TEST_ISIN),
    provider.getIncomeStatement(TEST_ISIN),
    provider.getKeyRatios(TEST_ISIN),
  ]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.ok(results.every((r) => r.reason.errorCode === UPSTOX_ERROR_CODES.CONFIGURATION_ERROR));
});

test('UpstoxProvider.getCachedStatementsOnly never calls the network and degrades to all-null sections when nothing is cached (no Redis connected in this test process)', async () => {
  const provider = new UpstoxProvider({ token: 'test-token' });
  let networkCalled = false;
  withMockedClient(provider, async () => { networkCalled = true; return { data: {} }; });

  const sections = await provider.getCachedStatementsOnly(TEST_ISIN, { symbol: 'TCS' });
  assert.equal(networkCalled, false, 'getCachedStatementsOnly must never hit Upstox');
  assert.deepEqual(Object.keys(sections).sort(), ['balanceSheet', 'cashFlow', 'incomeStatement', 'keyRatios', 'profile'].sort());
  assert.ok(Object.values(sections).every((section) => section === null));
});
