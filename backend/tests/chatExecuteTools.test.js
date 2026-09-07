import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTools } from '../graph/nodes/executeTools.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';

const makeState = (toolPlan, overrides = {}) => ({
  errors: [], toolPlan, userId: 'user-1', onEvent: null, ...overrides,
});

test('executeTools returns {} immediately when the plan is empty (no wasted work)', async () => {
  const result = await executeTools(makeState([]));
  assert.deepEqual(result, {});
});

test('one tool failing (rejecting) does not discard the other tools\' successful results', async () => {
  const originalA = TOOL_REGISTRY.getLiveQuote;
  const originalB = TOOL_REGISTRY.getCompanyNews;
  TOOL_REGISTRY.getLiveQuote = async () => { throw new Error('boom'); };
  TOOL_REGISTRY.getCompanyNews = async () => ({ tool: 'getCompanyNews', status: 'SUCCESS', data: [{ title: 'ok' }], evidence: [{ evidenceId: 'e1' }], fetchedAt: new Date().toISOString(), warning: null });
  try {
    const result = await executeTools(makeState([
      { tool: 'getLiveQuote', args: { symbol: 'TCS' } },
      { tool: 'getCompanyNews', args: { symbol: 'TCS' } },
    ]));
    assert.equal(result.toolResults.length, 2);
    const failed = result.toolResults.find((r) => r.tool === 'getLiveQuote');
    const succeeded = result.toolResults.find((r) => r.tool === 'getCompanyNews');
    assert.equal(failed.status, 'ERROR');
    assert.equal(succeeded.status, 'SUCCESS');
    assert.equal(result.evidence.length, 1);
  } finally {
    TOOL_REGISTRY.getLiveQuote = originalA;
    TOOL_REGISTRY.getCompanyNews = originalB;
  }
});

test('tool calls for independent tools run in parallel, not sequentially', async () => {
  const originalA = TOOL_REGISTRY.getLiveQuote;
  const originalB = TOOL_REGISTRY.getCompanyNews;
  const DELAY_MS = 50;
  const started = [];
  TOOL_REGISTRY.getLiveQuote = async () => { started.push(Date.now()); await new Promise((r) => setTimeout(r, DELAY_MS)); return { tool: 'getLiveQuote', status: 'SUCCESS', data: {}, evidence: [], fetchedAt: '', warning: null }; };
  TOOL_REGISTRY.getCompanyNews = async () => { started.push(Date.now()); await new Promise((r) => setTimeout(r, DELAY_MS)); return { tool: 'getCompanyNews', status: 'SUCCESS', data: [], evidence: [], fetchedAt: '', warning: null }; };
  try {
    const t0 = Date.now();
    await executeTools(makeState([{ tool: 'getLiveQuote', args: {} }, { tool: 'getCompanyNews', args: {} }]));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < DELAY_MS * 2, `expected parallel execution (<${DELAY_MS * 2}ms), took ${elapsed}ms`);
    assert.ok(Math.abs(started[0] - started[1]) < DELAY_MS, 'both tools should start nearly simultaneously');
  } finally {
    TOOL_REGISTRY.getLiveQuote = originalA;
    TOOL_REGISTRY.getCompanyNews = originalB;
  }
});

test('an unknown tool name in the plan produces an ERROR entry instead of throwing', async () => {
  const result = await executeTools(makeState([{ tool: 'notARealTool', args: {} }]));
  assert.equal(result.toolResults[0].status, 'ERROR');
});
