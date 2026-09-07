import test from 'node:test';
import assert from 'node:assert/strict';
import { IndianApiProvider } from '../providers/indian-api/IndianApiProvider.js';
import { INDIAN_API_ERROR_CODES } from '../providers/indian-api/IndianApiErrorMapper.js';

const SAMPLE_STOCK_RESPONSE = {
  tickerId: 'ZZTESTCO',
  companyName: 'Tata Consultancy Services Limited',
  industry: 'IT Services',
  companyProfile: {
    companyDescription: 'A leading IT services company.',
    exchangeCodeNse: 'ZZTESTCO',
    exchangeCodeBse: '532540',
  },
  currentPrice: { BSE: 0, NSE: 4120.5 }, // BSE: 0 is a legitimate value and must be preserved, not treated as missing
  percentChange: -0.5,
  yearHigh: 4400,
  yearLow: 3400,
  financials: [
    { period: 'FY2025', date: '2025-05-15', revenue: 250000, netProfit: 45000 },
  ],
  keyMetrics: { peRatio: 28.4 },
  shareholding: [{ period: 'Q1FY26', date: '2025-07-10', promoter: 72.3 }],
  stockCorporateActionData: [{ date: '2025-06-01', title: 'Final Dividend', amount: 28 }],
  recentNews: [
    { title: 'TCS wins large deal', url: 'https://example.com/news/1', date: '2025-08-01' },
    { title: 'No URL article' }, // must be rejected — no usable source
  ],
};

// No mocking library in this repo's dependencies (see package.json) — tests
// replace the provider's internal axios instance's `.get` directly, which
// is how the existing codebase's HTTP-touching services are already tested.
const withMockedClient = (provider, implementation) => {
  provider.client.get = implementation;
  return provider;
};

test('IndianApiProvider throws CONFIGURATION_ERROR when no API key is configured', async () => {
  const provider = new IndianApiProvider({ apiKey: '', baseUrl: 'https://stock.indianapi.in' });
  assert.equal(provider.isConfigured, false);
  await assert.rejects(
    () => provider.getCompanyProfile('ZZTESTCO'),
    (error) => error.errorCode === INDIAN_API_ERROR_CODES.CONFIGURATION_ERROR,
  );
});

test('IndianApiProvider never includes the API key in a thrown error message', async () => {
  const provider = new IndianApiProvider({ apiKey: 'super-secret-key-value', baseUrl: 'https://stock.indianapi.in' });
  withMockedClient(provider, async () => {
    const error = new Error('Request failed with status code 401');
    error.response = { status: 401, data: { message: 'Invalid API key' } };
    throw error;
  });
  await assert.rejects(
    () => provider.getCompanyProfile('ZZTESTCO'),
    (error) => {
      assert.equal(error.errorCode, INDIAN_API_ERROR_CODES.AUTHENTICATION_ERROR);
      assert.ok(!error.message.includes('super-secret-key-value'));
      return true;
    },
  );
});

test('IndianApiProvider maps company profile with zero-value preservation and missing-field safety', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key', baseUrl: 'https://stock.indianapi.in' });
  withMockedClient(provider, async () => ({ data: SAMPLE_STOCK_RESPONSE }));

  const result = await provider.getCompanyProfile('ZZTESTCO');
  assert.equal(result.supported, true);
  assert.equal(result.data.identity.companyName, 'Tata Consultancy Services Limited');
  assert.equal(result.data.identity.nseCode, 'ZZTESTCO');
  assert.equal(result.data.marketSnapshot.bsePrice, 0); // preserved, not dropped/null'd
  assert.equal(result.data.marketSnapshot.nsePrice, 4120.5);
});

test('IndianApiProvider financials/shareholding/corporateActions are normalized arrays with dates and no fabricated values', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => ({ data: SAMPLE_STOCK_RESPONSE }));

  const financials = await provider.getFinancials('ZZTESTCO');
  assert.equal(financials.data.length, 1);
  assert.equal(financials.data[0].period, 'FY2025');
  assert.equal(financials.data[0].raw.revenue, 250000);

  const shareholding = await provider.getShareholding('ZZTESTCO');
  assert.equal(shareholding.data.length, 1);

  const corporateActions = await provider.getCorporateActions('ZZTESTCO');
  assert.equal(corporateActions.data.length, 1);
  assert.equal(corporateActions.data[0].title, 'Final Dividend');
});

test('IndianApiProvider news rejects entries without a usable source URL (never presents unsourced claims)', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => ({ data: SAMPLE_STOCK_RESPONSE }));

  const news = await provider.getCompanyNews('ZZTESTCO');
  assert.equal(news.data.length, 1);
  assert.equal(news.data[0].sourceUrl, 'https://example.com/news/1');
});

test('IndianApiProvider analyst data is tagged as informational, never treated as an actual outcome', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => ({ data: { ...SAMPLE_STOCK_RESPONSE, recosBar: { rating: 'BUY', targetPrice: 4600 } } }));

  const analyst = await provider.getAnalystData('ZZTESTCO');
  assert.equal(analyst.data.note.includes('forecast'), true);
});

test('IndianApiProvider maps 404 to NOT_FOUND and resolveCompany returns null instead of throwing', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => {
    const error = new Error('Not found');
    error.response = { status: 404 };
    throw error;
  });

  const resolved = await provider.resolveCompany('NOT_A_REAL_COMPANY');
  assert.equal(resolved, null);
});

test('IndianApiProvider maps 429 to RATE_LIMITED', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => {
    const error = new Error('Too many requests');
    error.response = { status: 429 };
    throw error;
  });
  await assert.rejects(
    () => provider.getCompanyProfile('ZZTESTCO'),
    (error) => error.errorCode === INDIAN_API_ERROR_CODES.RATE_LIMITED,
  );
});

test('IndianApiProvider maps a request timeout to TIMEOUT', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => {
    const error = new Error('timeout of 15000ms exceeded');
    error.code = 'ECONNABORTED';
    throw error;
  });
  await assert.rejects(
    () => provider.getCompanyProfile('ZZTESTCO'),
    (error) => error.errorCode === INDIAN_API_ERROR_CODES.TIMEOUT,
  );
});

test('IndianApiProvider maps upstream 500 to UPSTREAM_UNAVAILABLE and retries once before failing', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  let attempts = 0;
  withMockedClient(provider, async () => {
    attempts += 1;
    const error = new Error('Internal Server Error');
    error.response = { status: 503 };
    throw error;
  });
  await assert.rejects(
    () => provider.getCompanyProfile('ZZTESTCO'),
    (error) => error.errorCode === INDIAN_API_ERROR_CODES.UPSTREAM_UNAVAILABLE,
  );
  assert.equal(attempts, 2); // one bounded retry, not a retry storm
});

test('IndianApiProvider maps ENOTFOUND (wrong base URL for the plan) to PLAN_OR_BASE_URL_ERROR', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key', baseUrl: 'https://pro.indianapi.in' });
  withMockedClient(provider, async () => {
    const error = new Error('getaddrinfo ENOTFOUND pro.indianapi.in');
    error.code = 'ENOTFOUND';
    throw error;
  });
  await assert.rejects(
    () => provider.getCompanyProfile('ZZTESTCO'),
    (error) => error.errorCode === INDIAN_API_ERROR_CODES.PLAN_OR_BASE_URL_ERROR,
  );
});

test('IndianApiProvider throws INVALID_RESPONSE for a non-JSON-object payload', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => ({ data: 'not json' }));
  await assert.rejects(
    () => provider.getCompanyProfile('ZZTESTCO'),
    (error) => error.errorCode === INDIAN_API_ERROR_CODES.INVALID_RESPONSE,
  );
});

test('IndianApiProvider getOutcomeEvidence returns typed, dated, provider-tagged candidates', async () => {
  const provider = new IndianApiProvider({ apiKey: 'test-key' });
  withMockedClient(provider, async () => ({ data: SAMPLE_STOCK_RESPONSE }));

  const evidence = await provider.getOutcomeEvidence('ZZTESTCO', {});
  const types = new Set(evidence.map((item) => item.evidenceType));
  assert.ok(types.has('FINANCIAL_ACTUAL'));
  assert.ok(types.has('CORPORATE_ACTION'));
  assert.ok(types.has('SHAREHOLDING_CHANGE'));
  assert.ok(evidence.every((item) => item.provider === 'indian-api'));
});
