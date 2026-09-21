import test from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, buildClaimPlan, buildVerdict, formatValue } from '../services/claimPlan.js';
import { renderDeterministicAnswer, renderUnavailableAnswer } from '../services/answerRenderer.js';

/**
 * claimPlanRendering.test.js
 * =============================
 * Phase 6A reliability. The deterministic composition path exists so the
 * model cannot invent, re-period, or mis-cite a figure. These pin that
 * guarantee, plus the comparison-correctness rules Phase 6A requires.
 */

const ev = (symbol, excerpt, period = null) => ({ symbol, excerpt, reportingPeriod: period, publishedAt: '2026-05-01' });

const BANK_EVIDENCE = [
  ev('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2024) - Net Interest Margin', 'FY2024'),
  ev('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2024) - Net Interest Margin', 'FY2024'),
  ev('HDFCBANK', 'GNPA: 1.23 PERCENTAGE (FY2024) - Gross NPA', 'FY2024'),
  ev('ICICIBANK', 'GNPA: 1.58 PERCENTAGE (FY2024) - Gross NPA', 'FY2024'),
  ev('HDFCBANK', 'PAT: 17616 INR_CRORE (FY2024) - Net Profit', 'FY2024'),
  ev('ICICIBANK', 'PAT: 14805 INR_CRORE (FY2024) - Net Profit', 'FY2024'),
];

const bankPlan = (evidence = BANK_EVIDENCE) => buildClaimPlan({
  evidence,
  symbols: ['HDFCBANK', 'ICICIBANK'],
  sectorKindBySymbol: { HDFCBANK: 'BANKING', ICICIBANK: 'BANKING' },
});

test('claims are extracted with their evidence index, so every citation is correct by construction', () => {
  const claims = extractClaims(BANK_EVIDENCE);
  assert.equal(claims.length, 6);
  assert.equal(claims[0].citation, 1);
  assert.equal(claims[1].citation, 2, 'citation is the 1-based position in the same array the verifier sees');
  assert.equal(claims[0].metric, 'NIM');
  assert.equal(claims[0].value, 4);
  assert.equal(claims[0].unit, 'PERCENTAGE');
  assert.equal(claims[0].period, 'FY2024');
});

test('a value is never rescaled or reformatted into a different magnitude', () => {
  assert.equal(formatValue(4.78, 'PERCENTAGE'), '4.78%');
  assert.equal(formatValue(17616, 'INR_CRORE'), '₹17,616 Cr');
  assert.equal(formatValue(3030, 'USD_MILLION'), '$3,030M');
  assert.equal(formatValue(null, 'PERCENTAGE'), null);
});

test('metrics sharing a period are comparable; metrics in different periods are not', () => {
  const plan = bankPlan();
  const nim = plan.rows.find((r) => r.metric === 'NIM');
  assert.equal(nim.comparable, true);
  assert.equal(nim.commonPeriod, 'FY2024');

  const mixed = bankPlan([
    ev('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2022) - NIM', 'FY2022'),
    ev('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2024) - NIM', 'FY2024'),
  ]);
  const mixedNim = mixed.rows.find((r) => r.metric === 'NIM');
  assert.equal(mixedNim.comparable, false);
  assert.equal(mixedNim.periodsDiffer, true, 'FY2022 vs FY2024 is not a like-for-like gap');
});

test('the latest period both companies share is preferred over a newer one only one reports', () => {
  const plan = bankPlan([
    ev('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2023) - NIM', 'FY2023'),
    ev('HDFCBANK', 'NIM: 4.2 PERCENTAGE (FY2024) - NIM', 'FY2024'),
    ev('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2023) - NIM', 'FY2023'),
  ]);
  const nim = plan.rows.find((r) => r.metric === 'NIM');
  assert.equal(nim.commonPeriod, 'FY2023', 'FY2023 is the latest period BOTH report');
  assert.equal(nim.values.HDFCBANK.value, 4, 'and each company contributes its own FY2023 figure');
});

test('a verdict rests only on ratios -- a bigger bank is never called the better one', () => {
  const verdict = buildVerdict(bankPlan());
  assert.equal(verdict.comparable, true);
  const metrics = verdict.supporting.map((s) => s.metric);
  assert.ok(metrics.includes('NIM'));
  assert.ok(metrics.includes('GNPA'));
  assert.equal(metrics.includes('PAT'), false, 'absolute profit is scale, not profitability');
  assert.equal(metrics.includes('REVENUE'), false);
});

test('asset quality is scored the right way round -- lower NPA wins', () => {
  const verdict = buildVerdict(bankPlan());
  const gnpa = verdict.supporting.find((s) => s.metric === 'GNPA');
  assert.equal(gnpa.leader, 'HDFCBANK', '1.23% GNPA is better than 1.58%');
  const nim = verdict.supporting.find((s) => s.metric === 'NIM');
  assert.equal(nim.leader, 'ICICIBANK', 'but a higher NIM is better');
});

test('with no shared period there is no verdict, and the answer says so', () => {
  const plan = bankPlan([
    ev('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2022) - NIM', 'FY2022'),
    ev('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2024) - NIM', 'FY2024'),
  ]);
  const answer = renderDeterministicAnswer(plan);
  assert.match(answer, /do not share a reporting period/i);
  assert.equal(/ahead on/.test(answer), false, 'no winner is declared across mismatched periods');
});

test('the verdict is conditional and never a buy recommendation', () => {
  const answer = renderDeterministicAnswer(bankPlan());
  assert.match(answer, /conditional/i);
  assert.match(answer, /not a recommendation/i);
  assert.match(answer, /depends on horizon and risk appetite/i);
  // Targets an actual directive, not the word "hold" appearing innocently
  // in "I hold no valuation multiples".
  assert.equal(/\b(buy|sell) (this|now|it)\b|recommend(ation)? to (buy|sell)|\b(strong )?(buy|sell|hold) rating\b/i.test(answer), false, 'no directive');
  assert.match(answer, /not investment advice/i);
});

test('every figure in the rendered answer carries a citation', () => {
  const answer = renderDeterministicAnswer(bankPlan());
  const tableLines = answer.split('\n').filter((l) => l.startsWith('| ') && !l.includes('Metric |') && !l.startsWith('|---'));
  assert.ok(tableLines.length > 0);
  for (const line of tableLines) {
    assert.match(line, /\[\d+\]/, `table row must cite: ${line}`);
  }
});

test('mismatched-period metrics are reported per company, never side by side in the table', () => {
  const plan = bankPlan([
    ev('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2022) - NIM', 'FY2022'),
    ev('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2024) - NIM', 'FY2024'),
  ]);
  const answer = renderDeterministicAnswer(plan);
  assert.match(answer, /Reported in different periods/);
  // Each mismatched figure is on its own single-company line.
  assert.match(answer, /- HDFCBANK Net interest margin \(NIM\): 4% \(FY2022\) \[\d+\]/);
  assert.match(answer, /- ICICIBANK Net interest margin \(NIM\): 4\.78% \(FY2024\) \[\d+\]/);
});

test('a metric held for only one company is omitted from the table rather than asserted absent', () => {
  const plan = bankPlan([
    ev('HDFCBANK', 'ROE: 17 PERCENTAGE (FY2024) - Return on Equity', 'FY2024'),
    ev('HDFCBANK', 'NIM: 4 PERCENTAGE (FY2024) - NIM', 'FY2024'),
    ev('ICICIBANK', 'NIM: 4.78 PERCENTAGE (FY2024) - NIM', 'FY2024'),
  ]);
  const answer = renderDeterministicAnswer(plan);
  assert.equal(/not reported/i.test(answer), false, 'an absence is never asserted in a cell');
  assert.match(answer, /I hold Return on equity/i, 'it is described as what the data holds instead');
});

test('a bank answer never frames itself on operating margin, and says why', () => {
  const answer = renderDeterministicAnswer(bankPlan());
  assert.match(answer, /Net interest margin/);
  assert.match(answer, /not meaningful measures for a bank/);
});

test('a market-only plan still renders a real answer rather than abstaining', () => {
  const plan = buildClaimPlan({
    evidence: [ev('BEL', 'close INR 404.35, 1-year return 1.48%, 52-week range INR 380.45-473.45')],
    symbols: ['BEL'],
    sectorKindBySymbol: { BEL: 'GENERAL' },
  });
  const answer = renderDeterministicAnswer(plan);
  assert.match(answer, /Share-price history/);
  assert.match(answer, /historical, not a live quote/, 'never passed off as a current price');
  assert.match(answer, /\[1\]/);
});

test('a plan with nothing substantive renders nothing, so the caller abstains precisely', () => {
  const empty = buildClaimPlan({ evidence: [], symbols: ['BEL'], sectorKindBySymbol: {} });
  assert.equal(renderDeterministicAnswer(empty), null);
});

test('the precise abstention names the company and the reason, never generically', () => {
  const answer = renderUnavailableAnswer({
    symbols: ['BEL', 'HAL'],
    missing: [{ symbol: 'BEL', dimension: 'FINANCIALS', status: 'EMPTY' }],
  });
  assert.match(answer, /\*\*BEL\*\*/);
  assert.match(answer, /\*\*HAL\*\*/);
  assert.match(answer, /no verified filing data/i);
  assert.equal(/temporarily unavailable/i.test(answer), false, 'never implies a retry will help');
});

// ---------------------------------------------------------------------------
// UI Phase 1C.3: PRICE_HISTORY claims -- distinct from MARKET (renderMarket's
// single aggregate close), never colliding with it (see claimPlan.js's own
// PRICE_HISTORY_EXCERPT note on why the two excerpt formats can never match
// the same evidence item).
// ---------------------------------------------------------------------------

const priceHistoryEvidence = (symbol, series, overrides = {}) => ({
  symbol,
  chartSeries: series,
  publishedAt: '2026-09-01T00:00:00.000Z',
  sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv',
  excerpt: `PRICE_HISTORY: ${series.length} points, INR, NSE_BHAVCOPY, NOT_REQUIRED (${series[0].date} to ${series[series.length - 1].date})`,
  ...overrides,
});

const SERIES = [{ date: '2026-08-01', close: 100 }, { date: '2026-08-02', close: 101 }, { date: '2026-08-03', close: 102 }];

test('a PRICE_HISTORY excerpt is extracted as its own claim kind, carrying the real series verbatim (never re-derived from the excerpt string)', () => {
  const claims = extractClaims([priceHistoryEvidence('TCS', SERIES)]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'PRICE_HISTORY');
  assert.equal(claims[0].symbol, 'TCS');
  assert.deepEqual(claims[0].series, SERIES);
  assert.equal(claims[0].citation, 1);
});

test('a PRICE_HISTORY excerpt never matches MARKET_EXCERPT -- the two claim kinds never collide over the same evidence item', () => {
  const marketAndHistory = [
    ev('BEL', 'close INR 404.35, 1-year return 1.48%, 52-week range INR 380.45-473.45'),
    priceHistoryEvidence('BEL', SERIES),
  ];
  const plan = buildClaimPlan({ evidence: marketAndHistory, symbols: ['BEL'], sectorKindBySymbol: { BEL: 'GENERAL' } });
  assert.ok(plan.market.BEL, 'the aggregate MARKET claim is still there, untouched');
  assert.ok(plan.priceHistory.BEL, 'the PRICE_HISTORY claim is ALSO present, as its own separate entry');
  assert.equal(plan.market.BEL.citation, 1);
  assert.equal(plan.priceHistory.BEL.citation, 2);
});

test('buildClaimPlan.hasAnything is true for a plan whose ONLY content is price history', () => {
  const plan = buildClaimPlan({ evidence: [priceHistoryEvidence('TCS', SERIES)], symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  assert.equal(plan.hasAnything, true);
});

test('renderDeterministicAnswer cites the price-history claim with a real [N] marker and its point count/range, never a fabricated price', () => {
  const plan = buildClaimPlan({ evidence: [priceHistoryEvidence('TCS', SERIES)], symbols: ['TCS'], sectorKindBySymbol: { TCS: 'GENERAL' } });
  const answer = renderDeterministicAnswer(plan);
  assert.match(answer, /Price history chart available/);
  assert.match(answer, /3-point/);
  assert.match(answer, /2026-08-01 to 2026-08-03/);
  assert.match(answer, /\[1\]/);
  assert.equal(/₹\s?100|₹\s?101|₹\s?102/.test(answer), false, 'the prose line never states an individual price -- the chart is what presents the data');
});

test('a PRICE_HISTORY excerpt whose evidence item carries no chartSeries at all produces no claim (never a chart with zero real points)', () => {
  const claims = extractClaims([priceHistoryEvidence('TCS', SERIES, { chartSeries: undefined })]);
  assert.equal(claims.length, 0);
});

/**
 * Phase 6B: valuation reaches the answer, with its formula and provenance.
 * The renderer previously hard-coded "I hold no valuation multiples (P/E,
 * P/B) for these companies" unconditionally — untrue when multiples exist,
 * and wrongly plural for a single company.
 */

test('a held multiple is rendered with its formula, inputs and as-of date', () => {
  const plan = buildClaimPlan({
    evidence: BANK_EVIDENCE,
    symbols: ['HDFCBANK', 'ICICIBANK'],
    sectorKindBySymbol: { HDFCBANK: 'BANKING', ICICIBANK: 'BANKING' },
    valuationBySymbol: {
      HDFCBANK: {
        available: [{
          metric: 'PE', label: 'Price/earnings', value: 18.4, source: 'COMPUTED',
          formula: 'share price ÷ trailing-twelve-month earnings per share',
          inputs: {
            price: { value: 731, asOf: '2026-09-11' },
            earningsPerShare: { value: 39.7, periods: ['Q3 FY2025', 'Q2 FY2025', 'Q1 FY2025', 'Q4 FY2024'] },
          },
        }],
        unavailable: [],
      },
    },
  });

  const answer = renderDeterministicAnswer(plan);
  assert.match(answer, /\*\*Valuation\.\*\*/);
  assert.match(answer, /HDFCBANK Price\/earnings: 18\.4/);
  assert.match(answer, /share price ÷ trailing-twelve-month earnings per share/, 'the formula is shown, so the figure is auditable');
  assert.match(answer, /Q3 FY2025, Q2 FY2025, Q1 FY2025, Q4 FY2024/, 'and the exact periods behind it');
  assert.match(answer, /as of 2026-09-11/);
  assert.doesNotMatch(answer, /I hold no PE/, 'a held multiple is not also reported as missing');
});

test('a missing multiple is NOT asserted in the answer -- an absence cannot be cited', () => {
  // Measured on "What is the net interest margin of HAL?", same evidence,
  // same draft: without a gap sentence 6/6 runs PASSED verification; with
  // one, 4/6 -- the verifier extracted it as a claim and rejected it
  // MISSING_CITATION, abstaining an otherwise fully supported answer.
  // Valuation gaps are reported in diagnostics instead.
  const plan = buildClaimPlan({
    evidence: BANK_EVIDENCE,
    symbols: ['HDFCBANK', 'ICICIBANK'],
    sectorKindBySymbol: { HDFCBANK: 'BANKING', ICICIBANK: 'BANKING' },
    valuationBySymbol: {
      HDFCBANK: { available: [], unavailable: [{ metric: 'PE', reason: 'no per-share earnings are held for a compatible period' }] },
    },
  });

  const answer = renderDeterministicAnswer(plan);
  assert.doesNotMatch(answer, /I hold no PE|no per-share earnings/, 'the gap is not asserted as prose');
  assert.doesNotMatch(answer, /for these companies/, 'and the old blanket sentence is gone');
  assert.doesNotMatch(answer, /\*\*Valuation\.\*\*/, 'no valuation section when nothing is held');
});

test('a bank answer carries no unattributed editorial generalisation', () => {
  // Measured: an explanatory sentence about price-to-book versus
  // price-to-earnings cost query 1 two MISSING_CITATION claims and abstained
  // the answer. The bank preference lives in buildValuation /
  // bankValuationContext and in the sector metric vocabulary, where it
  // changes behaviour — not in prose the verifier must accept on faith.
  const answer = renderDeterministicAnswer(bankPlan());
  assert.doesNotMatch(answer, /more informative than|earnings move with provisioning/i);
  assert.match(answer, /Net interest margin|NIM/, 'the bank vocabulary still frames the answer');
});

test('valuation is absent, not invented, when no valuation data was supplied at all', () => {
  const answer = renderDeterministicAnswer(bankPlan());
  assert.doesNotMatch(answer, /\*\*Valuation\.\*\*/);
  assert.doesNotMatch(answer, /P\/E of|price to earnings of/i, 'no multiple is conjured from the metrics held');
});

test('no limitations note names a company symbol -- an absence cannot be cited', () => {
  // Measured: "I hold no PE ... for HAL" was extracted by the verifier as a
  // company-specific claim, rejected MISSING_CITATION, and abstained an
  // otherwise fully SUPPORTED answer on 3 of 3 runs. Every note in this
  // block states what I hold, never a fact about a named company.
  const plan = buildClaimPlan({
    evidence: BANK_EVIDENCE,
    symbols: ['HDFCBANK', 'ICICIBANK'],
    sectorKindBySymbol: { HDFCBANK: 'BANKING', ICICIBANK: 'BANKING' },
    valuationBySymbol: {
      HDFCBANK: { available: [], unavailable: [{ metric: 'PE', reason: 'no per-share earnings are held for a compatible period' }] },
      ICICIBANK: { available: [], unavailable: [{ metric: 'PB', reason: 'no book value per share is held' }] },
    },
  });

  const answer = renderDeterministicAnswer(plan);
  const limitations = answer.slice(answer.indexOf('**Data limitations.**'));
  for (const symbol of ['HDFCBANK', 'ICICIBANK']) {
    assert.ok(!limitations.includes(symbol), `limitations must not name ${symbol}`);
  }
  assert.doesNotMatch(limitations, /no per-share earnings|book value per share/, 'valuation gaps live in diagnostics, not in a claim');
});

test('an empty limitations heading is never emitted', () => {
  // A heading with nothing under it tells the reader limitations were
  // considered and then shows none. Regression: removing the unconditional
  // valuation sentence left exactly that on single-company answers.
  const plan = buildClaimPlan({
    evidence: [ev('HAL', 'REVENUE: 14768.75 INR_CRORE (Q4 FY2024) - Revenue', 'Q4 FY2024')],
    symbols: ['HAL'],
    sectorKindBySymbol: { HAL: 'GENERAL' },
  });
  const answer = renderDeterministicAnswer(plan);
  assert.doesNotMatch(answer, /\*\*Data limitations\.\*\*\s*\n\s*\n/, 'no dangling heading');
  assert.ok(
    !answer.includes('**Data limitations.**') || /\*\*Data limitations\.\*\*\n- /.test(answer),
    'if the heading appears it has at least one bullet',
  );
});
