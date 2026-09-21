import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimPlan } from '../services/claimPlan.js';
import { buildResponseBlocks } from '../graph/nodes/buildResponseBlocks.js';

/**
 * buildResponseBlocksNode.test.js
 * ===================================
 * UI Phase 1B. graph/timing.js's withNodeTiming does NOT catch a node that
 * throws (see its own module note) — this node is on the publish path, so
 * "never cause the whole answer to fail" is not a style preference here,
 * it is the thing that stops a UI-only feature from being able to break
 * chat entirely. These tests exercise the wrapper's failure handling
 * directly, including a builder that misbehaves.
 */

test('an empty/minimal state produces responseBlocks: [] without throwing', () => {
  const result = buildResponseBlocks({});
  assert.deepEqual(result, { responseBlocks: [] });
});

test('a state with a real single-company claim plan produces the expected block types, INCLUDING news_list and chart when their evidence is actually cited', () => {
  const financial = {
    evidenceId: 'ev-1', symbol: 'TCS', claimType: 'FINANCIAL_DATA',
    excerpt: 'REVENUE: 240893 INR_CRORE (FY2024) - Revenue', reportingPeriod: 'FY2024',
    title: 'TCS Revenue', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'stored-verified-filings', publishedAt: '2026-05-01',
  };
  const news = {
    evidenceId: 'ev-2', symbol: 'TCS', claimType: 'COMPANY_NEWS',
    title: 'TCS wins major BFSI deal', sourceUrl: 'https://reuters.com/tcs-deal', provider: 'Reuters',
    publishedAt: '2026-09-01T00:00:00.000Z', imageUrl: 'https://reuters.com/img.jpg',
  };
  const priceHistory = {
    evidenceId: 'ev-3', symbol: 'TCS', claimType: 'MARKET_HISTORY',
    excerpt: 'PRICE_HISTORY: 3 points, INR, NSE_BHAVCOPY, NOT_REQUIRED (2026-08-01 to 2026-08-03)',
    chartSeries: [{ date: '2026-08-01', close: 100 }, { date: '2026-08-02', close: 101 }, { date: '2026-08-03', close: 102 }],
    sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv', provider: 'NSE_BHAVCOPY', publishedAt: '2026-08-03',
  };
  const evidence = [financial, news, priceHistory];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = {
    claimPlan, evidence,
    // All three were actually cited in the published answer -- exactly what
    // makes buildNewsListBlock/buildChartBlock (and every other citations-
    // driven builder) include them.
    citations: evidence,
    groundingStatus: null, valuationCoverage: [], coverage: null,
    intent: 'COMPANY_RESEARCH', entities: { symbols: ['TCS'] },
    // UI Phase 1C.1: present so company_header is also exercised here.
    companyProfiles: { TCS: { companyName: 'Tata Consultancy Services', sector: 'IT', exchange: 'NSE' } },
  };

  const { responseBlocks } = buildResponseBlocks(state);
  const types = responseBlocks.map((b) => b.type).sort();
  assert.deepEqual(types, ['chart', 'company_header', 'evidence_drawer', 'metric_grid', 'news_list', 'source_list', 'suggested_questions']);
  const newsBlock = responseBlocks.find((b) => b.type === 'news_list');
  assert.equal(newsBlock.articles[0].title, 'TCS wins major BFSI deal');
  const chartBlock = responseBlocks.find((b) => b.type === 'chart');
  assert.equal(chartBlock.points.length, 3);
  assert.equal(chartBlock.symbol, 'TCS');
});

test('a builder that throws on malformed state is skipped -- the OTHER builders still run and the node itself never throws', () => {
  // buildDataQualityBlock does `(state.valuationCoverage || []).flatMap(...)`
  // -- a truthy non-array (a string, here) passes the `|| []` guard and then
  // throws on .flatMap not existing, exercising the REAL per-builder
  // try/catch without mutating any frozen export.
  const state = {
    valuationCoverage: 'not-an-array', // deliberately malformed -> buildDataQualityBlock throws
    citations: [{ evidenceId: 'e1', title: 't', sourceUrl: null, provider: null, publishedAt: null, reportingPeriod: null }],
    intent: 'WATCHLIST_ANALYSIS',
    entities: {},
  };
  const result = buildResponseBlocks(state);
  assert.deepEqual(
    result.responseBlocks.map((b) => b.type).sort(),
    ['evidence_drawer', 'source_list', 'suggested_questions'],
    'the throwing builder (data_quality) is simply absent; unrelated builders still succeeded',
  );
});

test('responseBlocks is capped at MAX_RESPONSE_BLOCKS even if every builder somehow produced a block', () => {
  // With 8 Phase 1B/1C builders this cannot literally overflow today, but
  // the cap itself is asserted directly so a future block-type addition
  // cannot silently remove the bound.
  const evidence = [{
    evidenceId: 'ev-1', symbol: 'TCS', claimType: 'FINANCIAL_DATA',
    excerpt: 'REVENUE: 1 INR_CRORE (FY2024) - Revenue', reportingPeriod: 'FY2024',
    title: 'x', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'p', publishedAt: '2026-05-01',
  }];
  const claimPlan = buildClaimPlan({ evidence, symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const state = {
    claimPlan, evidence, citations: evidence, groundingStatus: 'grounded', valuationCoverage: [],
    coverage: { limitations: ['x'] }, intent: 'COMPANY_RESEARCH', entities: { symbols: ['TCS'] },
  };
  const { responseBlocks } = buildResponseBlocks(state);
  assert.ok(responseBlocks.length <= 10);
});
