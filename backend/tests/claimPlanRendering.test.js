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
  assert.equal(/(buy|sell) (this|now|it)|recommend(ation)? to (buy|sell)|(strong )?(buy|sell|hold) rating/i.test(answer), false, 'no directive');
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
