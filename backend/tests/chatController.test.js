import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { sendMessage, legacySendMessage } from '../controllers/ChatController.js';
import { graph } from '../graph/graph.js';
import ChatThread from '../models/ChatThread.js';
import ChatMessage from '../models/ChatMessage.js';

const USER_ID = new mongoose.Types.ObjectId().toString();
const THREAD_ID = new mongoose.Types.ObjectId().toString();

/**
 * A minimal fake Express response that captures SSE frames written to it.
 * `on`/`writableEnded` mirror real http.ServerResponse: the controller
 * listens for res's own 'close' event (not req's -- see ChatController.js's
 * note on why req.on('close') fires as soon as the request body is fully
 * read, long before any response completes) to detect a genuine client
 * disconnect, guarded by writableEnded so a normal end() is never
 * misread as one.
 */
const makeFakeRes = () => {
  const frames = [];
  let ended = false;
  const closeHandlers = [];
  return {
    frames,
    ended: () => ended,
    get writableEnded() { return ended; },
    writeHead: () => {},
    write: (chunk) => { frames.push(chunk); },
    end: () => { ended = true; },
    on: (event, handler) => { if (event === 'close') closeHandlers.push(handler); },
    emitClose: () => closeHandlers.forEach((h) => h()),
    json: function json(body) { this.jsonBody = body; return this; },
    status: function status(code) { this.statusCode = code; return this; },
  };
};

const makeFakeReq = (overrides = {}) => ({
  body: {}, params: {}, userId: USER_ID, on: () => {}, ...overrides,
});

const parseFrames = (frames) => frames
  .filter((f) => f.startsWith('data: '))
  .map((f) => JSON.parse(f.slice('data: '.length).trim()));

/** A complete, self-consistent fake ChatThread document — every test that
 * touches the DB layer uses this so no path is left un-mocked (a missed
 * mock here would fall through to a real, connection-less Mongoose call
 * and hang the test on its buffering timeout instead of failing fast). */
const makeFakeThreadDoc = (overrides = {}) => ({
  _id: THREAD_ID, userId: USER_ID, deletedAt: null, messageCount: 0, title: 'New chat',
  activeEntities: { symbols: [], companyNames: [] },
  save: async function save() { return this; },
  toObject: function toObject() { return { _id: this._id, userId: this.userId, title: this.title, activeEntities: this.activeEntities }; },
  ...overrides,
});

/** Installs mocks for every model call sendMessage's happy path touches; returns a restore function. */
const installDbMocks = ({ threadDoc = makeFakeThreadDoc(), existingMessages = [], duplicateMessage = null } = {}) => {
  const originalThreadFindOne = ChatThread.findOne;
  const originalMessageFind = ChatMessage.find;
  const originalMessageFindOne = ChatMessage.findOne;
  const originalMessageCreate = ChatMessage.create;

  ChatThread.findOne = () => Promise.resolve(threadDoc);
  ChatMessage.find = () => ({ sort: () => ({ lean: async () => existingMessages }) });
  ChatMessage.findOne = () => Promise.resolve(duplicateMessage);
  ChatMessage.create = async (doc) => ({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
    toObject: function toObject() { return { ...doc, _id: this._id }; },
  });

  return () => {
    ChatThread.findOne = originalThreadFindOne;
    ChatMessage.find = originalMessageFind;
    ChatMessage.findOne = originalMessageFindOne;
    ChatMessage.create = originalMessageCreate;
  };
};

test('sendMessage streams message.started, token, and message.completed events in order', async () => {
  const restoreDb = installDbMocks();
  const originalInvoke = graph.invoke;
  graph.invoke = async ({ onEvent }) => {
    onEvent({ type: 'status', message: 'Understanding your question…' });
    onEvent({ type: 'token', token: 'Hello' });
    onEvent({ type: 'token', token: ' world' });
    return { answer: 'Hello world', citations: [], warnings: [], intent: 'GENERAL_EDUCATION' };
  };

  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: 'Hi', clientMessageId: 'cmid-1' } });
    const res = makeFakeRes();
    await sendMessage(req, res, (err) => { throw err; });

    const events = parseFrames(res.frames).map((e) => e.type);
    assert.deepEqual(events, ['message.started', 'status', 'token', 'token', 'message.completed']);
    assert.equal(res.ended(), true);
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

// UI Phase 1B ---------------------------------------------------------------

test('message.completed carries responseBlocks from the graph\'s final state, additively', async () => {
  const restoreDb = installDbMocks();
  const originalInvoke = graph.invoke;
  const fakeBlocks = [{ type: 'suggested_questions', questions: ['What is TCS revenue?'] }];
  graph.invoke = async () => ({ answer: 'TCS revenue was ₹1 Cr.', citations: [], warnings: [], intent: 'COMPANY_RESEARCH', responseBlocks: fakeBlocks });

  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: 'TCS revenue?', clientMessageId: 'cmid-blocks' } });
    const res = makeFakeRes();
    await sendMessage(req, res, (err) => { throw err; });

    const completed = parseFrames(res.frames).find((e) => e.type === 'message.completed');
    assert.deepEqual(completed.responseBlocks, fakeBlocks);
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

test('message.completed sends responseBlocks: [] (never omitted/undefined) when the final state has none -- an existing client reading only answer/citations sees an unchanged payload shape', async () => {
  const restoreDb = installDbMocks();
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'Hello.', citations: [], warnings: [], intent: 'GENERAL_EDUCATION' }); // no responseBlocks key at all, exactly like a pre-Phase-1B graph state

  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: 'Hi', clientMessageId: 'cmid-noblocks' } });
    const res = makeFakeRes();
    await sendMessage(req, res, (err) => { throw err; });

    const completed = parseFrames(res.frames).find((e) => e.type === 'message.completed');
    assert.deepEqual(completed.responseBlocks, []);
    assert.equal(completed.answer, 'Hello.', 'answer is unaffected');
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

test('sendMessage rejects a request for a thread the caller does not own (404), before invoking the graph', async () => {
  const originalThreadFindOne = ChatThread.findOne;
  const originalInvoke = graph.invoke;
  ChatThread.findOne = () => Promise.resolve(null); // not owned / not found
  let graphCalled = false;
  graph.invoke = async () => { graphCalled = true; return { answer: '', citations: [] }; };

  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: 'Hi' } });
    const res = makeFakeRes();
    let capturedError = null;
    await sendMessage(req, res, (err) => { capturedError = err; });
    assert.equal(capturedError?.statusCode, 404);
    assert.equal(graphCalled, false);
  } finally {
    ChatThread.findOne = originalThreadFindOne;
    graph.invoke = originalInvoke;
  }
});

test('sendMessage rejects an empty message before touching the database or the graph', async () => {
  const originalThreadFindOne = ChatThread.findOne;
  let dbCalled = false;
  ChatThread.findOne = () => { dbCalled = true; return Promise.resolve(null); };
  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: '   ' } });
    const res = makeFakeRes();
    let capturedError = null;
    await sendMessage(req, res, (err) => { capturedError = err; });
    assert.equal(capturedError?.statusCode, 400);
    assert.equal(dbCalled, false);
  } finally {
    ChatThread.findOne = originalThreadFindOne;
  }
});

test('a duplicate clientMessageId returns the existing message instead of running the graph again', async () => {
  const duplicateMessage = { _id: new mongoose.Types.ObjectId(), content: 'Hi', toObject: function toObject() { return { _id: this._id, content: 'Hi' }; } };
  const restoreDb = installDbMocks({ threadDoc: makeFakeThreadDoc({ messageCount: 1, title: 'Existing' }), duplicateMessage });
  const originalInvoke = graph.invoke;
  let graphCalled = false;
  graph.invoke = async () => { graphCalled = true; return { answer: 'should not run', citations: [] }; };

  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: 'Hi', clientMessageId: 'cmid-dup' } });
    const res = makeFakeRes();
    await sendMessage(req, res, (err) => { throw err; });
    assert.equal(graphCalled, false);
    const events = parseFrames(res.frames);
    assert.ok(events.some((e) => e.type === 'message.completed' && e.note?.includes('Duplicate')));
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

test('a client disconnect mid-stream stops further writes after the abort is detected', async () => {
  const restoreDb = installDbMocks();
  const originalInvoke = graph.invoke;
  const res = makeFakeRes();

  graph.invoke = async ({ onEvent, aborted }) => {
    onEvent({ type: 'token', token: 'partial' });
    res.emitClose(); // simulate the client disconnecting mid-generation (res's 'close', not req's -- see ChatController.js)
    assert.equal(aborted(), true);
    return { answer: 'partial', citations: [] };
  };

  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: 'Hi' } });
    await sendMessage(req, res, (err) => { throw err; });
    const events = parseFrames(res.frames).map((e) => e.type);
    assert.ok(!events.includes('message.completed'), 'must not send message.completed after the client disconnected');
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

test('res emitting close AFTER the response has already ended (writableEnded) is never misread as a disconnect', async () => {
  const restoreDb = installDbMocks();
  const originalInvoke = graph.invoke;
  const res = makeFakeRes();
  let observedAborted = null;

  graph.invoke = async ({ aborted }) => {
    observedAborted = aborted;
    return { answer: 'complete answer', citations: [] };
  };

  try {
    const req = makeFakeReq({ params: { threadId: THREAD_ID }, body: { message: 'Hi' } });
    await sendMessage(req, res, (err) => { throw err; });
    res.emitClose(); // a normal end-of-response 'close' firing after the fact -- a real Node ServerResponse does this too
    assert.equal(observedAborted(), false, 'a close event after the response already ended must never be treated as a client disconnect');
  } finally {
    restoreDb();
    graph.invoke = originalInvoke;
  }
});

test('legacySendMessage preserves the original {message} -> {reply} contract', async () => {
  const originalInvoke = graph.invoke;
  graph.invoke = async () => ({ answer: 'Legacy reply text' });
  try {
    const req = { body: { message: 'Hello' } };
    const res = makeFakeRes();
    await legacySendMessage(req, res);
    assert.equal(res.jsonBody.reply, 'Legacy reply text');
  } finally {
    graph.invoke = originalInvoke;
  }
});

test('legacySendMessage returns 400 for an empty message without calling the graph', async () => {
  const originalInvoke = graph.invoke;
  let called = false;
  graph.invoke = async () => { called = true; return {}; };
  try {
    const res = makeFakeRes();
    await legacySendMessage({ body: { message: '' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  } finally {
    graph.invoke = originalInvoke;
  }
});
