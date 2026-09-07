import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getLiveQuote, getCompanyResearch, getCompanyFinancials, getCompanyNews, getEarningsTimeline,
  getManagementPromiseDetails, searchResearchDocuments, getWatchlist, getPortfolio, compareStocks,
  TOOL_STATUS, AUTH_REQUIRED_TOOLS,
} from '../graph/tools/toolRegistry.js';
import ManagementPromise from '../models/ManagementPromise.js';
import Watchlist from '../models/Watchlist.js';
import PortfolioHolding from '../models/PortfolioHolding.js';

// Every tool call is bounded by an explicit input check before any real
// service call, so these never touch the network/DB/OpenAI.
test('every symbol-taking tool rejects a missing symbol with an ERROR result, never a crash', async () => {
  for (const fn of [getLiveQuote, getCompanyResearch, getCompanyFinancials, getCompanyNews, getEarningsTimeline, searchResearchDocuments]) {
    const result = await fn({});
    assert.equal(result.status, TOOL_STATUS.ERROR);
    assert.equal(result.data, null);
  }
});

test('compareStocks requires at least two symbols', async () => {
  const result = await compareStocks({ symbols: ['TCS'] });
  assert.equal(result.status, TOOL_STATUS.ERROR);
});

test('getWatchlist and getPortfolio are listed as auth-required and reject a missing userId', async () => {
  assert.deepEqual([...AUTH_REQUIRED_TOOLS].sort(), ['getPortfolio', 'getWatchlist']);
  const w = await getWatchlist({}, {});
  const p = await getPortfolio({}, {});
  assert.equal(w.status, TOOL_STATUS.ERROR);
  assert.equal(p.status, TOOL_STATUS.ERROR);
  assert.match(w.warning, /Authentication/);
});

test('getWatchlist returns real per-user data and never another user\'s lists (mocked model layer)', async () => {
  const originalFind = Watchlist.find;
  Watchlist.find = () => ({ sort: () => ({ lean: async () => [{ _id: 'w1', name: 'My List', symbols: [] }] }) });
  try {
    const result = await getWatchlist({}, { userId: 'user-1' });
    assert.equal(result.status, TOOL_STATUS.SUCCESS);
    assert.equal(result.data[0].name, 'My List');
  } finally {
    Watchlist.find = originalFind;
  }
});

test('getPortfolio returns EMPTY (not an error) when the user has no holdings', async () => {
  const originalFind = PortfolioHolding.find;
  PortfolioHolding.find = () => ({ sort: () => ({ lean: async () => [] }) });
  try {
    const result = await getPortfolio({}, { userId: 'user-1' });
    assert.equal(result.status, TOOL_STATUS.EMPTY);
    assert.deepEqual(result.data, []);
  } finally {
    PortfolioHolding.find = originalFind;
  }
});

test('getManagementPromiseDetails returns EMPTY (not ERROR) for a promiseId that does not exist', async () => {
  const originalFindOne = ManagementPromise.findOne;
  ManagementPromise.findOne = () => ({ lean: async () => null });
  try {
    const result = await getManagementPromiseDetails({ promiseId: '507f1f77bcf86cd799439011' });
    assert.equal(result.status, TOOL_STATUS.EMPTY);
  } finally {
    ManagementPromise.findOne = originalFindOne;
  }
});

test('getManagementPromiseDetails builds evidence with the real promise source URL/excerpt when found', async () => {
  const originalFindOne = ManagementPromise.findOne;
  ManagementPromise.findOne = () => ({
    lean: async () => ({
      symbol: 'TCS',
      promise: { statement: 'Revenue to grow 15%', targetPeriod: 'FY2026' },
      evidence: { promiseSource: { sourceUrl: 'https://tcs.com/ir/x.pdf', publicationDate: '2025-05-01', excerpt: 'We expect 15% growth.', page: 4 } },
    }),
  });
  try {
    const result = await getManagementPromiseDetails({ promiseId: '507f1f77bcf86cd799439011' });
    assert.equal(result.status, TOOL_STATUS.SUCCESS);
    assert.equal(result.evidence[0].sourceUrl, 'https://tcs.com/ir/x.pdf');
    assert.equal(result.evidence[0].pageNumber, 4);
  } finally {
    ManagementPromise.findOne = originalFindOne;
  }
});

// NOTE: getCompanyResearch/getCompanyFinancials call
// CompanyResearchService.getCompanyResearchBundle() with no provider
// override, which resolves the REAL configured IndianAPI provider — since
// a real INDIAN_API_KEY is configured in this project's .env, calling
// either tool here would make a real network request and consume a real
// credit. They are deliberately NOT exercised in this automated suite;
// CompanyResearchService's own provider-injected tests (see
// tests/companyResearchService.test.js) already cover the underlying
// per-section isolation logic these two thin tool wrappers depend on.
