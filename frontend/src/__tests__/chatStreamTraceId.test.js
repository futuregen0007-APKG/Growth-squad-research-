import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatStream } from '@/hooks/useChatStream';
import { sendMessageStream } from '@/services/chatApi';

/**
 * chatStreamTraceId.test.js
 * ============================
 * Phase 5A Part 14: the server's observability trace id reaches the UI on
 * both the success and the failure path, so a user can quote one reference
 * on a support request — and nothing else about the run leaks with it.
 */
jest.mock('@/services/chatApi', () => ({ sendMessageStream: jest.fn() }));

const TRACE_ID = '123e4567-e89b-42d3-a456-426614174000';

/**
 * Drives sendMessageStream's onEvent callback with a scripted sequence of
 * server events, exactly as the real SSE reader does.
 */
const scriptStream = (events) => {
  sendMessageStream.mockImplementation(({ onEvent }) => {
    const promise = Promise.resolve().then(() => { events.forEach(onEvent); });
    return { promise, abort: jest.fn() };
  });
};

beforeEach(() => { jest.clearAllMocks(); });

/**
 * useChatStream resolves send()'s promise as soon as `message.completed`
 * arrives, while its OWN cleanup (setIsStreaming(false), clearing the draft)
 * runs a few microtasks later in the promise chain's `.finally()`. That is
 * deliberate — the caller gets its answer without waiting for teardown — so
 * the trailing state update lands after an `act()` that only awaited send.
 *
 * This flushes that tail INSIDE act, which is the correct way to model it in
 * a test. There is nothing to fix in the hook: in the real app React handles
 * the update normally.
 */
const flushHookCleanup = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

test('a completed turn resolves with the server trace id', async () => {
  scriptStream([
    { type: 'message.started', threadId: 't1' },
    { type: 'message.completed', answer: 'TCS guided 15% growth.', citations: [], traceId: TRACE_ID },
  ]);

  const { result } = renderHook(() => useChatStream({ threadId: 't1' }));
  let resolved;
  await act(async () => { resolved = await result.current.send('what did TCS guide?'); });
  await flushHookCleanup();

  expect(resolved.traceId).toBe(TRACE_ID);
  expect(resolved.content).toBe('TCS guided 15% growth.');
});

test('a turn whose server sent no trace id resolves with null -- never an invented one', async () => {
  scriptStream([{ type: 'message.completed', answer: 'An ordinary answer.' }]);

  const { result } = renderHook(() => useChatStream({ threadId: 't1' }));
  let resolved;
  await act(async () => { resolved = await result.current.send('hello'); });
  await flushHookCleanup();

  expect(resolved.traceId).toBeNull();
});

test('a failed turn rejects with an Error carrying the trace id, so it can be shown beside the failure', async () => {
  scriptStream([
    { type: 'message.error', code: 'INTERNAL_ERROR', message: 'GS Copilot ran into a problem answering that.', traceId: TRACE_ID },
  ]);

  const { result } = renderHook(() => useChatStream({ threadId: 't1' }));
  let caught = null;
  await act(async () => {
    try { await result.current.send('what did TCS guide?'); } catch (error) { caught = error; }
  });
  await flushHookCleanup();

  expect(caught).toBeInstanceOf(Error);
  expect(caught.traceId).toBe(TRACE_ID);
  expect(caught.message).toMatch(/ran into a problem/i);
});

test('a failure with no trace id still rejects cleanly, with traceId null', async () => {
  scriptStream([{ type: 'message.error', message: 'Something went wrong.' }]);

  const { result } = renderHook(() => useChatStream({ threadId: 't1' }));
  let caught = null;
  await act(async () => {
    try { await result.current.send('hi'); } catch (error) { caught = error; }
  });
  await flushHookCleanup();

  expect(caught).toBeInstanceOf(Error);
  expect(caught.traceId).toBeNull();
});

test('the trace id never carries internal diagnostics alongside it', async () => {
  scriptStream([
    {
      type: 'message.completed',
      answer: 'An answer.',
      traceId: TRACE_ID,
      // A server that (incorrectly) included internals must not have them
      // surface through the hook's own resolved shape.
      nodeTimings: [{ node: 'composeAnswer', durationMs: 42 }],
      prompt: 'the full system prompt',
    },
  ]);

  const { result } = renderHook(() => useChatStream({ threadId: 't1' }));
  let resolved;
  await act(async () => { resolved = await result.current.send('hello'); });
  await flushHookCleanup();

  expect(resolved.traceId).toBe(TRACE_ID);
  expect(resolved.nodeTimings).toBeUndefined();
  expect(resolved.prompt).toBeUndefined();
});

test('streaming state settles after a turn completes, with the trace id already delivered', async () => {
  scriptStream([{ type: 'message.completed', answer: 'Done.', traceId: TRACE_ID }]);

  const { result } = renderHook(() => useChatStream({ threadId: 't1' }));
  await act(async () => { await result.current.send('hello'); });
  await flushHookCleanup();

  await waitFor(() => expect(result.current.isStreaming).toBe(false));
});
