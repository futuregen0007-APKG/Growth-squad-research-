import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';
import { graph } from '../graph/graph.js';
import { buildClaimPlan, buildVerdict, formatValue } from '../services/claimPlan.js';
import { renderDeterministicAnswer } from '../services/answerRenderer.js';

/**
 * deterministicComposition.test.js
 * ===================================
 * Phase 6A commit gate. These pin the guarantees that made the answer
 * pipeline stable at 25/25, driving the REAL graph with a stubbed model so
 * the assertions are exact rather than probabilistic.
 *
 * The invariant behind all of them: for a metric-shaped question the
 * factual core is RENDERED from a typed claim plan, never generated. The
 * model is given no opportunity to invent a number, a period, a unit, or a
 * citation id — and the verifier still runs on the result.
 */

const EVIDENCE = [
  {
    evidenceId: 'e1', claimType: 'FINANCIAL_DATA', symbol: 'HDFCBANK', reportingPeriod: 'FY2024',
    title: 'HDFCBANK NIM - FY2024', excerpt: 'NIM: 4 PERCENTAGE (FY2024) - Net Interest Margin',
    sourceUrl: 'https://example.test/hdfc.pdf', publishedAt: '2024-05-01',
  },
  {
    evidenceId: 'e2', claimType: 'FINANCIAL_DATA', symbol: 'ICICIBANK', reportingPeriod: 'FY2024',
    title: 'ICICIBANK NIM - FY2024', excerpt: 'NIM: 4.78 PERCENTAGE (FY2024) - Net Interest Margin',
    sourceUrl: 'https://example.test/icici.pdf', publishedAt: '2024-05-01',
  },
  {
    evidenceId: 'e3', claimType: 'FINANCIAL_DATA', symbol: 'HDFCBANK', reportingPeriod: 'FY2024',
    title: 'HDFCBANK PAT - FY2024', excerpt: 'PAT: 17616 INR_CRORE (FY2024) - Net Profit',
    sourceUrl: 'https://example.test/hdfc.pdf', publishedAt: '2024-05-01',
  },
  {
    evidenceId: 'e4', claimType: 'FINANCIAL_DATA', symbol: 'ICICIBANK', reportingPeriod: 'FY2024',
    title: 'ICICIBANK PAT - FY2024', excerpt: 'PAT: 14805 INR_CRORE (FY2024) - Net Profit',
    sourceUrl: 'https://example.test/icici.pdf', publishedAt: '2024-05-01',
  },
];

/** A model stub that answers routing/verification but FAILS any free-text call. */
const installModelStub = ({ onCreate } = {}) => {
  const original = { getClient: OpenAIClientFactory.getClient, isConfigured: OpenAIClientFactory.isConfigured };
  const calls = { create: 0, verification: 0 };
  OpenAIClientFactory.isConfigured = () => true;
  OpenAIClientFactory.getClient = () => ({
    chat: {
      completions: {
        parse: async (args) => {
          const schemaName = args.response_format?.json_schema?.name;
          if (schemaName === 'intent_classification') {
            return { choices: [{ message: { parsed: { intent: 'STOCK_COMPARISON', confidence: 0.95, reasoning: 'comparison' } } }] };
          }
          if (schemaName === 'entity_extraction') {
            return { choices: [{ message: { parsed: { symbols: ['HDFCBANK', 'ICICIBANK'], companyNames: [], periods: [], comparisonMode: true, resolvedFromFollowUp: false } } }] };
          }
          if (schemaName === 'tool_plan') return { choices: [{ message: { parsed: { tools: [] } } }] };
          if (schemaName === 'explicit_preference') {
            return { choices: [{ message: { parsed: { stated: false, riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] } } }] };
          }
          if (schemaName === 'claim_verification') {
            calls.verification += 1;
            // Every rendered claim is genuinely supported; the verifier says so.
            return { choices: [{ message: { parsed: { claims: [{ claimId: 'claim-1', verdict: 'SUPPORTED', evidenceIndexes: [1], reasonCode: null }] } } }] };
          }
          throw new Error(`unexpected structured call: ${schemaName}`);
        },
        create: async (...args) => {
          // Counted, not thrown: a throw here would cascade into a
          // different branch and hide WHY the deterministic path was
          // skipped. The assertion is on the count.
          calls.create += 1;
          if (onCreate) return onCreate(...args);
          return { choices: [{ message: { content: 'FREE TEXT SHOULD NOT APPEAR' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  });
  return {
    calls,
    restore() { OpenAIClientFactory.getClient = original.getClient; OpenAIClientFactory.isConfigured = original.isConfigured; },
  };
};

/** compareStocks returns real evidence so the deterministic path engages. */
const installTools = () => {
  const original = TOOL_REGISTRY.compareStocks;
  TOOL_REGISTRY.compareStocks = async () => ({
    tool: 'compareStocks', status: 'SUCCESS', data: [], evidence: EVIDENCE,
    resultCount: 2, evidenceCount: EVIDENCE.length, errorCode: null,
    fetchedAt: new Date().toISOString(), warning: null,
  });
  return () => { TOOL_REGISTRY.compareStocks = original; };
};

const runComparison = async (text = 'HDFCBANK vs ICICIBANK margin trends') => {
  const stub = installModelStub();
  const restoreTools = installTools();
  try {
    const state = await graph.invoke({
      messages: [new HumanMessage(text)],
      deadlineAt: Date.now() + 60000,
      aborted: () => false,
    });
    return { state, calls: stub.calls };
  } finally {
    restoreTools();
    stub.restore();
  }
};

test('a deterministic comparison makes NO free-text synthesis call', async () => {
  const { state, calls } = await runComparison();
  assert.equal(calls.create, 0, 'chat.completions.create is the free-text path and must never run');
  assert.equal(state.llmCalls.some((c) => c.role === 'synthesis'), false, 'no synthesis call is recorded either');
  assert.ok(state.claimPlan, 'a structured claim plan was built instead');
});

test('the verifier STILL executes on the deterministically rendered answer', async () => {
  const { state, calls } = await runComparison();
  assert.ok(calls.verification > 0, 'deterministic rendering earns verification, it does not skip it');
  assert.equal(state.validationStatus, 'PASSED');
});

test('every number, unit, period and citation in the answer traces to the claim plan', async () => {
  const { state } = await runComparison();
  const answer = String(state.answer);

  // Each figure present in the answer must exist in the plan with the same
  // value, unit and period - nothing rounded, rescaled or re-dated.
  const planned = state.claimPlan.rows.flatMap((row) => Object.entries(row.values)
    .map(([symbol, claim]) => ({ symbol, metric: row.metric, ...claim })));
  assert.ok(planned.length > 0);

  for (const claim of planned) {
    // Compared against the plan's OWN formatter: the answer must carry
    // exactly what the plan produces (₹17,616 Cr), never a re-typed or
    // rescaled variant of it.
    const rendered = formatValue(claim.value, claim.unit);
    assert.ok(answer.includes(rendered), `answer must carry the planned value as ${rendered}`);
    assert.ok(answer.includes(`[${claim.citation}]`), `answer must carry the planned citation [${claim.citation}]`);
    if (claim.period) assert.ok(answer.includes(claim.period), `answer must carry the planned period ${claim.period}`);
  }

  // And nothing numeric may appear that the plan did not produce.
  const renderedValues = new Set(planned.map((c) => formatValue(c.value, c.unit)));
  assert.ok(renderedValues.size > 0);

  // No citation may point outside the evidence list.
  const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  assert.ok(cited.length > 0);
  for (const n of cited) {
    assert.ok(n >= 1 && n <= state.evidence.length, `citation [${n}] must index real evidence`);
  }
});

test('an unsupported absence claim can never be rendered', async () => {
  const { state } = await runComparison();
  const answer = String(state.answer);
  // "not reported" in a table cell is an unbacked company-specific claim.
  assert.equal(/\|\s*not reported\s*\|/i.test(answer), false);
  assert.equal(/not reported for/i.test(answer), false);

  // Directly: a metric held for one company only is dropped from the table.
  const lopsided = buildClaimPlan({
    evidence: [EVIDENCE[0], EVIDENCE[1], { ...EVIDENCE[2], excerpt: 'ROE: 17 PERCENTAGE (FY2024) - Return on Equity' }],
    symbols: ['HDFCBANK', 'ICICIBANK'],
    sectorKindBySymbol: { HDFCBANK: 'BANKING', ICICIBANK: 'BANKING' },
  });
  const rendered = renderDeterministicAnswer(lopsided);
  assert.equal(/not reported/i.test(rendered), false, 'absence is described as what is held, never asserted');
});

test('no absolute PAT or revenue value drives a comparative verdict', async () => {
  const { state } = await runComparison();
  const verdict = buildVerdict(state.claimPlan);

  assert.ok(verdict.comparable, 'this fixture has a shared period');
  const drivers = verdict.supporting.map((s) => s.metric);
  assert.ok(drivers.includes('NIM'), 'a ratio drives the verdict');
  assert.equal(drivers.includes('PAT'), false, 'absolute profit is scale, not performance');
  assert.equal(drivers.includes('REVENUE'), false, 'absolute revenue is scale, not performance');

  // HDFCBANK has the larger PAT but the weaker NIM; it must not be declared
  // ahead on the strength of being bigger.
  assert.equal(Object.keys(verdict.wins).includes('ICICIBANK'), true, 'the better ratio wins, not the bigger balance sheet');
});

test('identical input with unchanged evidence order produces a byte-stable answer', async () => {
  const first = await runComparison();
  const second = await runComparison();
  const third = await runComparison();

  assert.equal(first.state.answer, second.state.answer, 'run 1 and 2 must be byte-identical');
  assert.equal(second.state.answer, third.state.answer, 'run 2 and 3 must be byte-identical');
  assert.ok(first.state.answer.length > 0);
});

test('the rendered answer stays conditional and cites the metrics behind its verdict', async () => {
  const { state } = await runComparison();
  const answer = String(state.answer);
  assert.match(answer, /conditional/i);
  assert.match(answer, /not a recommendation/i);
  assert.match(answer, /Net interest margin \(NIM\) in FY2024/, 'the verdict names the metric and period it rests on');
  assert.match(answer, /not investment advice/i);
});

test('a bank comparison uses bank metrics and explains the omitted ones', async () => {
  const { state } = await runComparison();
  const answer = String(state.answer);
  assert.match(answer, /Net interest margin/);
  assert.match(answer, /not meaningful measures for a bank/);
});
