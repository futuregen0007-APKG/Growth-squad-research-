import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  getLiveQuote, getCompanyResearch, getCompanyFinancials, getCompanyNews, getEarningsTimeline,
  getManagementPromiseDetails, searchResearchDocuments, getWatchlist, getPortfolio, compareStocks,
  TOOL_STATUS, AUTH_REQUIRED_TOOLS,
} from '../graph/tools/toolRegistry.js';
import ManagementPromise from '../models/ManagementPromise.js';
import Watchlist from '../models/Watchlist.js';
import PortfolioHolding from '../models/PortfolioHolding.js';

// getManagementPromiseDetails(symbol) goes through ManagementPromiseService's
// getCompanyPromises, which starts with `if (!isDbConnected()) return [];`
// (a real mongoose.connection.readyState check, not mockable — it's a
// local, unexported const in that service module) — so the Phase 2
// regression tests below need a real connection open before their
// ManagementPromise.find mock is ever reached, exactly like
// tests/backfillPromises.test.js and this project's other Mongo-backed
// test files already do.
dotenv.config();
if (mongoose.connection.readyState === 0) {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_market_ai');
}

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

// ---------------------------------------------------------------------------
// Phase 2 regression: getManagementPromiseDetails(symbol) previously
// returned `evidence: []` unconditionally on the symbol path (the path an
// actual GUIDANCE-dimension request reaches — see toolRegistry.js's
// compareStocks), discarding every real promise record it had just
// fetched. Fixed via the shared buildPromiseEvidence helper. Mocked at the
// ManagementPromise.find MODEL level (a mutable static, same technique
// already used above for ManagementPromise.findOne) rather than mocking
// ManagementPromiseService's getCompanyPromises export directly — that
// export is a plain ES module named binding and can't be monkey-patched
// (the same limitation documented in tests/chatToolRegistryPhase1.test.js
// for NewsAPIService.getStockNews).
// ---------------------------------------------------------------------------
const withMockedPromiseFind = async (records, fn) => {
  const original = ManagementPromise.find;
  ManagementPromise.find = () => ({ sort: () => ({ lean: async () => records }) });
  try {
    await fn();
  } finally {
    ManagementPromise.find = original;
  }
};

const realResearchPromise = (overrides = {}) => ({
  symbol: 'TCS',
  promise: { statement: 'Revenue to grow 12-14% in FY2026', targetPeriod: 'FY2026' },
  verification: { status: 'PENDING' },
  evidence: {
    promiseSource: {
      sourceUrl: 'https://tcs.com/ir/q1-fy26-call.pdf', sourceDate: '2025-05-01', publicationDate: '2025-05-01',
      title: 'Q1 FY26 earnings call transcript', excerpt: 'We expect revenue growth of 12-14% for FY2026.', page: 3,
    },
  },
  outcome: {},
  ...overrides,
});

test('getManagementPromiseDetails(symbol) builds real evidence from fetched promise records (Phase 2 regression -- previously always [])', async () => {
  await withMockedPromiseFind([realResearchPromise()], async () => {
    const result = await getManagementPromiseDetails({ symbol: 'TCS' });
    assert.equal(result.status, TOOL_STATUS.SUCCESS);
    assert.ok(result.evidence.length >= 1, 'a genuine promise record must produce at least one citable evidence record');
    assert.equal(result.evidence[0].claimType, 'MANAGEMENT_PROMISE');
    assert.equal(result.evidence[0].sourceUrl, 'https://tcs.com/ir/q1-fy26-call.pdf');
  });
});

test('getManagementPromiseDetails(symbol) never builds a PROMISE_OUTCOME record for a still-PENDING promise (forecast must never look like an achieved outcome)', async () => {
  await withMockedPromiseFind([realResearchPromise({ verification: { status: 'PENDING' } })], async () => {
    const result = await getManagementPromiseDetails({ symbol: 'TCS' });
    assert.ok(!result.evidence.some((e) => e.claimType === 'PROMISE_OUTCOME'), 'a PENDING promise has no real outcome yet');
  });
});

test('getManagementPromiseDetails(symbol) builds a distinct PROMISE_OUTCOME record once a promise has genuinely been evaluated', async () => {
  const evaluated = realResearchPromise({
    verification: { status: 'FULFILLED' },
    evidence: {
      promiseSource: realResearchPromise().evidence.promiseSource,
      outcomeSource: {
        sourceUrl: 'https://tcs.com/ir/q4-fy26-results.pdf', sourceDate: '2026-04-20', publicationDate: '2026-04-20',
        title: 'Q4 FY26 results', excerpt: 'Full-year revenue grew 13.2%, within guided range.',
      },
    },
  });
  await withMockedPromiseFind([evaluated], async () => {
    const result = await getManagementPromiseDetails({ symbol: 'TCS' });
    const promiseRecord = result.evidence.find((e) => e.claimType === 'MANAGEMENT_PROMISE');
    const outcomeRecord = result.evidence.find((e) => e.claimType === 'PROMISE_OUTCOME');
    assert.ok(promiseRecord, 'the original forecast is still cited');
    assert.ok(outcomeRecord, 'a genuinely evaluated promise gets its own distinct outcome evidence');
    assert.equal(outcomeRecord.sourceUrl, 'https://tcs.com/ir/q4-fy26-results.pdf');
    assert.notEqual(promiseRecord.claimType, outcomeRecord.claimType);
  });
});

test('getManagementPromiseDetails(symbol) never fabricates evidence for a record missing required provenance', async () => {
  const malformed = realResearchPromise({ evidence: { promiseSource: { sourceUrl: null, excerpt: null } } });
  await withMockedPromiseFind([malformed], async () => {
    const result = await getManagementPromiseDetails({ symbol: 'TCS' });
    assert.equal(result.status, TOOL_STATUS.EMPTY, 'no citable source means EMPTY, never a fabricated SUCCESS');
    assert.deepEqual(result.evidence, []);
  });
});

test('getManagementPromiseDetails(symbol) returns EMPTY (not an error) when the company has no promise records at all', async () => {
  await withMockedPromiseFind([], async () => {
    const result = await getManagementPromiseDetails({ symbol: 'UNKNOWNCO' });
    assert.equal(result.status, TOOL_STATUS.EMPTY);
  });
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

after(async () => {
  await mongoose.disconnect().catch(() => {});
});
