import { v4 as uuidv4 } from 'uuid';
import { HumanMessage } from '@langchain/core/messages';
import { graph } from '../graph/graph.js';
import {
  createThread, listThreads, getThread, renameThread, deleteThread, appendUserMessage,
} from '../services/ChatThreadService.js';
import { createNotFoundError, createInvalidInputError, AppError } from '../utils/errorHandler.js';
import { MAX_INPUT_LENGTH } from '../graph/nodes/validateInput.js';
import { resolveTotalDeadlineMs } from '../graph/requestBudget.js';
import { logger } from '../utils/logger.js';
import { resolveTraceId, TRACE_ID_HEADER } from '../services/telemetry/traceContext.js';
import { emitEvent } from '../services/telemetry/ragTelemetry.js';
import { metricsStore } from '../services/telemetry/metricsStore.js';

/**
 * makeRequestScope - one AbortController + deadline per HTTP request, the
 * Phase 1 "request identity and total deadline" / "real cancellation"
 * primitives shared by both sendMessage and legacySendMessage. The signal
 * aborts when EITHER the client disconnects OR the total deadline
 * elapses — never persisted anywhere (not on the request record, not in
 * Mongo), exactly like the pre-existing onEvent/aborted callbacks this
 * mirrors.
 */
const makeRequestScope = () => {
  const deadlineAt = Date.now() + resolveTotalDeadlineMs();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  const dispose = () => clearTimeout(deadlineTimer);
  return { deadlineAt, signal: controller.signal, abort: () => controller.abort(), dispose };
};

/**
 * ChatController.js
 * ==================
 * Thread CRUD (JSON) + the streaming send-message endpoint (SSE-over-fetch:
 * a normal POST whose response is `text/event-stream`, read with
 * `response.body.getReader()` on the client — not a native EventSource,
 * because EventSource cannot send an Authorization header or a POST body
 * and this project's existing Socket.IO (socket/stock.socket.js) is
 * tightly coupled to the Angel One live-price feed, which "do not replace
 * working Angel One" rules out repurposing).
 */

const inFlightClientMessages = new Set();

const writeEvent = (res, type, payload) => {
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
};

// ---------------------------------------------------------------------------
// Thread CRUD
// ---------------------------------------------------------------------------
export const listUserThreads = async (req, res, next) => {
  try {
    const threads = await listThreads(req.userId);
    res.json({ success: true, data: threads });
  } catch (error) { next(error); }
};

export const createUserThread = async (req, res, next) => {
  try {
    const thread = await createThread(req.userId, { title: req.body?.title });
    res.status(201).json({ success: true, data: thread });
  } catch (error) { next(error); }
};

export const getUserThread = async (req, res, next) => {
  try {
    const data = await getThread(req.userId, req.params.threadId);
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

export const renameUserThread = async (req, res, next) => {
  try {
    const title = String(req.body?.title || '').trim();
    if (!title) throw createInvalidInputError('title is required');
    const thread = await renameThread(req.userId, req.params.threadId, title);
    res.json({ success: true, data: thread });
  } catch (error) { next(error); }
};

export const deleteUserThread = async (req, res, next) => {
  try {
    const data = await deleteThread(req.userId, req.params.threadId);
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ---------------------------------------------------------------------------
// Streaming send-message
// ---------------------------------------------------------------------------
export const sendMessage = async (req, res, next) => {
  const { message, clientMessageId } = req.body || {};
  const text = typeof message === 'string' ? message.trim() : '';

  if (!text) return next(createInvalidInputError('message is required'));
  if (text.length > MAX_INPUT_LENGTH) return next(createInvalidInputError(`message exceeds ${MAX_INPUT_LENGTH} characters`));

  let threadId = req.params.threadId;
  try {
    if (!threadId) {
      const thread = await createThread(req.userId, {});
      threadId = String(thread._id);
    } else {
      await getThread(req.userId, threadId); // throws 404 if not owned/found
    }
  } catch (error) {
    return next(error);
  }

  const dedupeKey = clientMessageId ? `${threadId}:${clientMessageId}` : null;
  if (dedupeKey && inFlightClientMessages.has(dedupeKey)) {
    return next(new AppError('This message is already being processed.', 409, 'DUPLICATE_IN_FLIGHT'));
  }
  if (dedupeKey) inFlightClientMessages.add(dedupeKey);

  // Phase 5A Part 2: a caller-supplied trace id is accepted only after
  // strict validation (see traceContext.js) — never trusted verbatim into
  // logs/metrics otherwise. Distinct from `requestId` below, which keeps
  // its own pre-existing, unrelated meaning.
  const traceId = resolveTraceId(req.headers?.[TRACE_ID_HEADER.toLowerCase()]);
  const requestStartedAt = performance.now();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    [TRACE_ID_HEADER]: traceId,
  });

  const requestId = uuidv4();
  emitEvent('rag.request.started', { traceId, requestId, route: 'POST /api/chat/messages' });
  let clientDisconnected = false;
  let graphCompleted = false;
  const scope = makeRequestScope();
  // res.on('close') -- not req.on('close') -- is the correct disconnect
  // signal; see legacySendMessage's fuller note below for why. This was
  // pre-existing (req.on('close')) code before Phase 1 and is corrected
  // here as part of implementing real cancellation properly, not left as
  // a silently-broken listener.
  res.on?.('close', () => { if (!res.writableEnded) { clientDisconnected = true; scope.abort(); } });

  try {
    const { message: userMessage, duplicate } = await appendUserMessage(req.userId, threadId, { content: text, clientMessageId });

    writeEvent(res, 'message.started', { threadId, requestId, userMessageId: String(userMessage._id) });

    if (duplicate) {
      writeEvent(res, 'message.completed', { threadId, note: 'Duplicate submission ignored.' });
      return res.end();
    }

    const onEvent = (event) => {
      if (clientDisconnected) return;
      if (event.type === 'status') writeEvent(res, 'status', { message: event.message });
      else if (event.type === 'tool.started') writeEvent(res, 'tool.started', { tool: event.tool });
      else if (event.type === 'tool.completed') {
        // Full diagnostic payload for the dev-only tool activity panel
        // (frontend gates its display behind REACT_APP_SHOW_TOOL_PANEL —
        // sending it is harmless either way since it's already the safe,
        // non-secret shape logDiagnostics.js logs server-side: status/
        // counts/errorCode, never a raw provider error or payload).
        writeEvent(res, 'tool.completed', {
          tool: event.tool, status: event.status,
          resultCount: event.resultCount ?? 0, evidenceCount: event.evidenceCount ?? 0,
          errorCode: event.errorCode ?? null,
        });
      } else if (event.type === 'token') writeEvent(res, 'token', { token: event.token });
    };

    const finalState = await graph.invoke({
      messages: [new HumanMessage(text)],
      userId: req.userId,
      threadId,
      requestId,
      traceId,
      currentMessageId: String(userMessage._id),
      onEvent,
      aborted: () => clientDisconnected,
      deadlineAt: scope.deadlineAt,
      abortSignal: scope.signal,
    });
    // Phase 5A: from here on, logDiagnostics (a graph node) has ALREADY
    // recorded this request and emitted rag.request.completed. Anything that
    // throws after this point must not also be counted as a failed request —
    // that would count one turn twice, once in each direction.
    graphCompleted = true;

    if (clientDisconnected) return res.end();

    for (const citation of finalState.citations || []) {
      writeEvent(res, 'citation', citation);
    }

    writeEvent(res, 'message.completed', {
      threadId,
      answer: finalState.answer,
      citations: finalState.citations || [],
      warnings: finalState.warnings || [],
      intent: finalState.intent,
      // Phase 4B Part 9: additive-only fields — absent/null for every
      // non-grounded turn (finalState.groundingStatus/coverage/
      // retrievalMode stay at their state.js defaults of null unless the
      // grounded branch actually ran), so an existing client reading only
      // answer/citations/warnings/intent is completely unaffected.
      claims: finalState.groundedClaims || [],
      groundingStatus: finalState.groundingStatus || null,
      coverage: finalState.coverage || null,
      retrievalMode: finalState.retrievalMode || null,
      repairAttempted: Boolean(finalState.repairAttempted),
      // Phase 5A Part 14: lets the frontend show/report the trace id on a
      // support request — never internal node names or diagnostics.
      traceId,
    });
    res.end();
  } catch (error) {
    logger.error(`[Chat] sendMessage failed: ${error.message}`);
    // Phase 5A: the graph itself always resolves to a safe fallback
    // answer internally (buildSafeFallback.js) — reaching this catch means
    // something OUTSIDE that safety net threw (a genuine bug, or the
    // client aborting mid-await). Recorded distinctly from a normal
    // completion so operators can tell "the graph answered honestly" apart
    // from "the request itself blew up."
    if (!graphCompleted) {
      metricsStore.recordRequest({ completionStatus: 'failed', isResearch: false });
      metricsStore.recordErrorCategory(clientDisconnected ? 'CLIENT_ABORTED' : 'INTERNAL_ERROR');
      emitEvent('rag.request.failed', {
        traceId, requestId, route: 'POST /api/chat/messages',
        errorCategory: clientDisconnected ? 'CLIENT_ABORTED' : 'INTERNAL_ERROR',
        durationMs: Math.round(performance.now() - requestStartedAt),
      });
    }
    if (!clientDisconnected) {
      writeEvent(res, 'message.error', { code: error.errorCode || 'INTERNAL_ERROR', message: 'GS Copilot ran into a problem answering that. Please try again.', traceId });
      res.end();
    }
  } finally {
    if (dedupeKey) inFlightClientMessages.delete(dedupeKey);
    scope.dispose();
  }
};

/**
 * legacySendMessage - preserves the original `/api/chat` contract
 * ({ message } -> { reply }) for any existing consumer that hasn't moved
 * to the threaded/streaming API yet. Runs the same graph, buffered
 * (non-streaming), WITHOUT thread persistence (no userId/threadId is
 * available on this route — see routes/chat.js, mounted without auth for
 * backward compatibility).
 */
export const legacySendMessage = async (req, res) => {
  // Previously invoked the graph with no requestId at all (GraphState's
  // default null survived all the way to logDiagnostics) — the earliest
  // missing propagation point traced in Phase 0. Fixed by generating one
  // here, exactly like sendMessage already does; never a second id
  // downstream (classifyIntent/etc. only ever read state.requestId, they
  // never create one).
  const requestId = uuidv4();
  const traceId = resolveTraceId(req?.headers?.[TRACE_ID_HEADER.toLowerCase()]);
  // Phase 5A: the legacy route emits the SAME request lifecycle events as the
  // streaming route, so one turn is observable identically whichever entry
  // point served it. rag.request.completed is emitted by logDiagnostics (a
  // graph node), so it is already shared by both paths.
  emitEvent('rag.request.started', { traceId, requestId, route: 'POST /api/chat' });
  const requestStartedAt = performance.now();
  const scope = makeRequestScope();
  let clientDisconnected = false;
  let graphCompleted = false;

  try {
    // req.on is guarded (optional chaining) — legacySendMessage is also
    // called directly in tests with a minimal { body } object rather than
    // a real Express request, and scope's deadline timer must still be
    // disposed via `finally` below even when a caller's req has no event
    // emitter at all.
    // res.on('close') -- NOT req.on('close') -- is the correct signal here.
    // Confirmed empirically while building this: req's 'close' fires once
    // the INCOMING request body has been fully read (Node's own docs:
    // "the request has been completed"), which for a small JSON POST body
    // happens within milliseconds of the request arriving -- i.e. it fired
    // almost immediately on every single call, long before any response
    // was sent, silently cancelling every request. res's 'close' fires
    // only when the underlying connection is actually torn down before
    // the response finishes, which is the real "client went away" signal.
    res.on?.('close', () => { if (!res.writableEnded) { clientDisconnected = true; scope.abort(); } });
    const text = String(req.body?.message || '').trim();
    if (!text) return res.status(400).json({ error: 'message is required' });

    const finalState = await graph.invoke({
      messages: [new HumanMessage(text)],
      requestId,
      traceId,
      deadlineAt: scope.deadlineAt,
      abortSignal: scope.signal,
      aborted: () => clientDisconnected,
    });
    graphCompleted = true; // see the streaming path's own note on why
    res.setHeader?.(TRACE_ID_HEADER, traceId);
    res.json({ reply: finalState.answer, traceId });
  } catch (error) {
    logger.error(`[Chat] legacySendMessage failed: ${error.message}`);
    if (!graphCompleted) {
      metricsStore.recordRequest({ completionStatus: 'failed', isResearch: false });
      metricsStore.recordErrorCategory(clientDisconnected ? 'CLIENT_ABORTED' : 'INTERNAL_ERROR');
      emitEvent('rag.request.failed', {
        traceId, requestId, route: 'POST /api/chat',
        errorCategory: clientDisconnected ? 'CLIENT_ABORTED' : 'INTERNAL_ERROR',
        durationMs: Math.round(performance.now() - requestStartedAt),
      });
    }
    res.status(500).json({ error: error.message, traceId });
  } finally {
    scope.dispose();
  }
};

export default {
  listUserThreads, createUserThread, getUserThread, renameUserThread, deleteUserThread, sendMessage, legacySendMessage,
};
