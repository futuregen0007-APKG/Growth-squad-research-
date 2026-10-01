import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStockDetail } from '../services/StockDetailAggregationService.js';
import { buildStockDetailFinancials } from '../services/StockDetailFinancials.js';

// Every dependency is injected (no Mongo/Redis/IndianAPI/Upstox). The stubbed
// fundamentals deliberately carry the SUSPECT derived growth figures the
// earliest-vs-latest CompanyHistoricalFact derivation produced in
// production (-53.95% / -60.69%), plus an IndianAPI-style P/E, to prove none
// of them can reach the score or the page any more.
const SUSPECT_FUNDAMENTALS = {
  pe: 99.9, roe: 30, revenueGrowth: -53.95, profitGrowth: -60.69, operatingMargin: null, debtTrend: null,
  source: 'REAL_RESEARCH_DERIVED', dataAsOf: '2026-03-31T00:00:00.000Z',
};
const HISTORICAL = {
  volatility: 21.07, oneYearReturn: -4.2, maxDrawdown: -18.5, lastClose: 3000, dataAsOf: '2026-09-30T00:00:00.000Z',
  fiftyTwoWeekHigh: 4000, fiftyTwoWeekLow: 2800,
};

const baseDeps = (getFinancials) => ({
  findProfile: async () => ({ symbol: 'TCS', companyName: 'Tata Consultancy Services Ltd.', isin: 'INE467B01029', marketCapCr: 1000000 }),
  getMetrics: async () => HISTORICAL,
  getFundamentalsFn: async () => SUSPECT_FUNDAMENTALS,
  getResearchBundle: async () => ({
    provider: 'INDIAN_API',
    sections: { profile: { available: true, data: { profile: { description: 'IndianAPI description that must not be used' } }, asOf: '2026-01-01' } },
  }),
  getFinancials,
});

const upstoxFailure = async () => buildStockDetailFinancials(null, { failure: { code: 'UPSTREAM_UNAVAILABLE', message: 'Upstox 503' } });

const upstoxSuccess = async () => buildStockDetailFinancials({
  success: true,
  data: {
    symbol: 'TCS',
    sections: {
      profile: { available: true, status: 'AVAILABLE', asOf: '2026-10-01T07:40:44.314Z', fromCache: true, error: null, data: { companyProfile: 'Tata Consultancy Services Ltd is an India-based company.', sector: 'Information Technology' } },
      incomeStatement: {
        available: true, status: 'AVAILABLE', asOf: '2026-10-01T07:40:44.314Z', fromCache: false, error: null,
        data: {
          units: 'INR_CRORE',
          metrics: [
            { label: 'revenue', financialYear: 'FY2026', value: 271423, changePct: 4.68, verifiedDefinition: 'TOTAL_INCOME', verifiedLabel: 'Total income' },
            { label: 'revenue', financialYear: 'FY2025', value: 259286, changePct: 5.7, verifiedDefinition: 'TOTAL_INCOME', verifiedLabel: 'Total income' },
            { label: 'net_profit', financialYear: 'FY2026', value: 49454, changePct: 1.35, verifiedDefinition: 'PROFIT_AFTER_TAX', verifiedLabel: 'Profit after tax (consolidated)' },
            { label: 'net_profit', financialYear: 'FY2025', value: 48797, changePct: 5.85, verifiedDefinition: 'PROFIT_AFTER_TAX', verifiedLabel: 'Profit after tax (consolidated)' },
          ],
          epsMetrics: [],
        },
      },
      keyRatios: { available: true, status: 'AVAILABLE', asOf: '2026-10-01T07:40:44.314Z', fromCache: false, error: null, data: { ratios: [{ name: 'P/E', companyValue: 14.82, companyValueUnit: 'NUMBER' }] } },
    },
  },
});

test('score path: StockDetailAggregationService no longer imports the derived-growth service (HistoricalFundamentalsDerivationService / deriveGrowthMetric)', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../services/StockDetailAggregationService.js', import.meta.url)), 'utf8');
  assert.ok(!/HistoricalFundamentalsDerivationService/.test(source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.ok(!/deriveGrowthMetric/.test(source));
  assert.ok(!/fundamentals\?\.revenueGrowth|fundamentals\?\.profitGrowth/.test(source), 'derived growth must not be read on the score path');
});

test('Upstox failure: revenueGrowth/profitGrowth/valuation are MISSING score inputs -- never the suspect derived growth or IndianAPI P/E', async () => {
  const detail = await getStockDetail('TCS', { deps: baseDeps(upstoxFailure) });
  const { ownScore } = detail.research.analystData;
  for (const metric of ['revenueGrowth', 'profitGrowth', 'valuation']) {
    assert.ok(ownScore.missingMetrics.includes(metric), `${metric} must be missing`);
    assert.ok(!ownScore.availableMetrics.includes(metric));
  }
  assert.equal(ownScore.inputSources.revenueGrowth, null);
  assert.equal(ownScore.inputSources.profitGrowth, null);
  assert.equal(ownScore.totalMetrics, 9);
  assert.equal(detail.summaryMetrics.pe, null, 'no silent IndianAPI P/E fallback');
  assert.equal(detail.overview.description, null, 'no silent IndianAPI description fallback');
  assert.equal(detail.companyFinancials.status, 'UNAVAILABLE');
  // The legacy fallback rows no longer surface the derived growth either.
  assert.ok(!detail.research.financials.rows.some((r) => /growth/i.test(r.title)));
  assert.ok(!JSON.stringify(detail.research).includes('-53.95'));
  assert.ok(!JSON.stringify(detail.research).includes('-60.69'));
});

test('Upstox dependency throwing outright still leaves growth unavailable (never restores the derived value)', async () => {
  const detail = await getStockDetail('TCS', { deps: baseDeps(async () => { throw new Error('boom'); }) });
  const { ownScore } = detail.research.analystData;
  assert.ok(ownScore.missingMetrics.includes('revenueGrowth'));
  assert.ok(ownScore.missingMetrics.includes('profitGrowth'));
  assert.equal(detail.companyFinancials, null);
});

test('Upstox success: score uses Upstox verified changePct and Upstox P/E; description comes from Upstox', async () => {
  const detail = await getStockDetail('TCS', { deps: baseDeps(upstoxSuccess) });
  const { ownScore } = detail.research.analystData;
  assert.ok(ownScore.availableMetrics.includes('revenueGrowth'));
  assert.ok(ownScore.availableMetrics.includes('profitGrowth'));
  assert.ok(ownScore.availableMetrics.includes('valuation'));
  assert.match(ownScore.inputSources.revenueGrowth, /Total income YoY change, FY2026/);
  assert.match(ownScore.inputSources.profitGrowth, /Profit after tax/);
  assert.equal(detail.summaryMetrics.pe, 14.82);
  assert.equal(detail.overview.description, 'Tata Consultancy Services Ltd is an India-based company.');
  assert.equal(detail.overview.provider, 'UPSTOX');
  assert.equal(detail.overview.fromCache, true);
  assert.equal(detail.companyFinancials.growthInputs.revenueGrowth.value, 4.68);
});

test('prefetchedFinancials is reused instead of calling Upstox again', async () => {
  let calls = 0;
  const prefetched = await upstoxSuccess();
  const detail = await getStockDetail('TCS', { prefetchedFinancials: prefetched, deps: baseDeps(async () => { calls += 1; return upstoxFailure(); }) });
  assert.equal(calls, 0);
  assert.equal(detail.summaryMetrics.pe, 14.82);
});
