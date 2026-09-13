import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTools } from '../graph/nodes/executeTools.js';
import { TOOL_REGISTRY } from '../graph/tools/toolRegistry.js';

const makeState = (toolPlan, overrides = {}) => ({
  errors: [], toolPlan, userId: 'user-1', onEvent: null, deadlineAt: null, abortSignal: null, ...overrides,
});

const withMockedTool = async (name, impl, fn) => {
  const original = TOOL_REGISTRY[name];
  TOOL_REGISTRY[name] = impl;
  try {
    await fn();
  } finally {
    TOOL_REGISTRY[name] = original;
  }
};

test('an exact duplicate tool call (same tool + same normalized args) executes the underlying tool only once', async () => {
  let calls = 0;
  await withMockedTool('getCompanyFinancials', async ({ symbol }) => {
    calls += 1;
    return { tool: 'getCompanyFinancials', status: 'SUCCESS', data: { symbol }, evidence: [{ evidenceId: `ev-${symbol}` }], resultCount: 1, evidenceCount: 1, fetchedAt: '', warning: null };
  }, async () => {
    const result = await executeTools(makeState([
      { tool: 'getCompanyFinancials', args: { symbol: 'TCS' } },
      { tool: 'getCompanyFinancials', args: { symbol: 'TCS' } }, // the exact live-observed duplicate-plan bug
    ]));
    assert.equal(calls, 1, 'the real tool must only run once for two identical planned calls');
    assert.equal(result.toolResults.length, 2, 'every originally-planned step still gets its own toolResults entry');
    assert.equal(result.deduplicatedToolCalls.length, 1);
    assert.equal(result.deduplicatedToolCalls[0].tool, 'getCompanyFinancials');
  });
});

test('two calls to the same tool with DIFFERENT arguments are never deduplicated', async () => {
  let calls = 0;
  await withMockedTool('getCompanyFinancials', async ({ symbol }) => {
    calls += 1;
    return { tool: 'getCompanyFinancials', status: 'SUCCESS', data: { symbol }, evidence: [{ evidenceId: `ev-${symbol}` }], resultCount: 1, evidenceCount: 1, fetchedAt: '', warning: null };
  }, async () => {
    const result = await executeTools(makeState([
      { tool: 'getCompanyFinancials', args: { symbol: 'TCS' } },
      { tool: 'getCompanyFinancials', args: { symbol: 'INFY' } },
    ]));
    assert.equal(calls, 2);
    assert.equal(result.deduplicatedToolCalls.length, 0);
  });
});

test('evidence is never duplicated for a deduplicated call -- one copy of the shared evidence, not one per planned step', async () => {
  await withMockedTool('getCompanyFinancials', async ({ symbol }) => ({
    tool: 'getCompanyFinancials', status: 'SUCCESS', data: { symbol }, evidence: [{ evidenceId: 'shared-ev-1' }], resultCount: 1, evidenceCount: 1, fetchedAt: '', warning: null,
  }), async () => {
    const result = await executeTools(makeState([
      { tool: 'getCompanyFinancials', args: { symbol: 'TCS' } },
      { tool: 'getCompanyFinancials', args: { symbol: 'TCS' } },
      { tool: 'getCompanyFinancials', args: { symbol: 'TCS' } },
    ]));
    assert.equal(result.evidence.length, 1, 'three duplicate-fingerprint calls must contribute exactly one evidence record, not three');
  });
});

test('every originally-planned step still emits its own tool.started/tool.completed SSE events, even when deduplicated', async () => {
  const events = [];
  await withMockedTool('getCompanyFinancials', async ({ symbol }) => ({
    tool: 'getCompanyFinancials', status: 'SUCCESS', data: { symbol }, evidence: [], resultCount: 1, evidenceCount: 0, fetchedAt: '', warning: null,
  }), async () => {
    await executeTools(makeState(
      [{ tool: 'getCompanyFinancials', args: { symbol: 'TCS' } }, { tool: 'getCompanyFinancials', args: { symbol: 'TCS' } }],
      { onEvent: (e) => events.push(e.type) },
    ));
  });
  assert.deepEqual(events, ['tool.started', 'status', 'tool.started', 'status', 'tool.completed', 'tool.completed']);
});

test('a step is skipped (never attempted) once the request deadline is already exhausted, reported as DEADLINE_EXCEEDED', async () => {
  let called = false;
  await withMockedTool('getLiveQuote', async () => { called = true; return { tool: 'getLiveQuote', status: 'SUCCESS', data: {}, evidence: [], resultCount: 1, evidenceCount: 0, fetchedAt: '', warning: null }; }, async () => {
    const result = await executeTools(makeState([{ tool: 'getLiveQuote', args: { symbol: 'TCS' } }], { deadlineAt: Date.now() - 1000 }));
    assert.equal(called, false, 'a tool must never even start once the budget is already gone');
    assert.equal(result.toolResults[0].errorCode, 'DEADLINE_EXCEEDED');
  });
});

test('an already-aborted signal cancels a tool softly (result classified CANCELLED), never counted as a provider failure', async () => {
  const controller = new AbortController();
  controller.abort();
  await withMockedTool('getLiveQuote', async (args, context) => {
    // Simulates a tool that honors context.signal for soft cancellation,
    // the same pattern toolRegistry.js's withTimeout implements.
    if (context?.signal?.aborted) {
      return { tool: 'getLiveQuote', status: 'ERROR', data: null, evidence: [], resultCount: 0, evidenceCount: 0, errorCode: 'CANCELLED', fetchedAt: '', warning: 'Request was cancelled.' };
    }
    return { tool: 'getLiveQuote', status: 'SUCCESS', data: {}, evidence: [], resultCount: 1, evidenceCount: 0, fetchedAt: '', warning: null };
  }, async () => {
    const result = await executeTools(makeState([{ tool: 'getLiveQuote', args: { symbol: 'TCS' } }], { abortSignal: controller.signal }));
    assert.equal(result.toolResults[0].errorCode, 'CANCELLED');
    assert.notEqual(result.toolResults[0].errorCode, 'TOOL_REJECTED', 'a cancellation must be distinguishable from a genuine provider failure');
  });
});

test('partial successful results are preserved: one tool timing out/failing never discards a sibling tool\'s real data', async () => {
  await withMockedTool('getLiveQuote', async () => { throw new Error('timed out'); }, async () => {
    await withMockedTool('getCompanyNews', async () => ({ tool: 'getCompanyNews', status: 'SUCCESS', data: [{ title: 'real news' }], evidence: [{ evidenceId: 'e1' }], resultCount: 1, evidenceCount: 1, fetchedAt: '', warning: null }), async () => {
      const result = await executeTools(makeState([
        { tool: 'getLiveQuote', args: { symbol: 'TCS' } },
        { tool: 'getCompanyNews', args: { symbol: 'TCS' } },
      ]));
      const news = result.toolResults.find((r) => r.tool === 'getCompanyNews');
      assert.equal(news.status, 'SUCCESS');
      assert.equal(result.evidence.length, 1);
    });
  });
});
