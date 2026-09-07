import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenAIError, OPENAI_ERROR_CODES } from '../llm/errors.js';
import { OpenAIClientFactory } from '../llm/OpenAIClientFactory.js';

test('missing API key surfaces OPENAI_NOT_CONFIGURED when getClient() is called', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  OpenAIClientFactory._resetForTests();
  try {
    assert.equal(OpenAIClientFactory.isConfigured(), false);
    assert.throws(() => OpenAIClientFactory.getClient(), (error) => error.errorCode === OPENAI_ERROR_CODES.NOT_CONFIGURED);
  } finally {
    if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    OpenAIClientFactory._resetForTests();
  }
});

test('invalid API key (401) maps to AUTHENTICATION_FAILED', () => {
  const error = { name: 'AuthenticationError', status: 401, message: 'Incorrect API key provided' };
  assert.equal(mapOpenAIError(error).errorCode, OPENAI_ERROR_CODES.AUTHENTICATION_FAILED);
});

test('unsupported model (400 mentioning model) maps to MODEL_UNAVAILABLE', () => {
  const error = { name: 'BadRequestError', status: 400, message: "The model 'gpt-not-real' does not exist" };
  assert.equal(mapOpenAIError(error).errorCode, OPENAI_ERROR_CODES.MODEL_UNAVAILABLE);
});

test('model_not_found error code maps to MODEL_UNAVAILABLE', () => {
  const error = { name: 'NotFoundError', status: 404, code: 'model_not_found', message: 'model not found' };
  assert.equal(mapOpenAIError(error).errorCode, OPENAI_ERROR_CODES.MODEL_UNAVAILABLE);
});

test('rate limit (429) maps to RATE_LIMITED', () => {
  const error = { name: 'RateLimitError', status: 429, message: 'Rate limit reached' };
  assert.equal(mapOpenAIError(error).errorCode, OPENAI_ERROR_CODES.RATE_LIMITED);
});

test('insufficient quota (429 + insufficient_quota code) maps to INSUFFICIENT_QUOTA, not RATE_LIMITED', () => {
  const error = { name: 'RateLimitError', status: 429, code: 'insufficient_quota', message: 'You exceeded your quota' };
  assert.equal(mapOpenAIError(error).errorCode, OPENAI_ERROR_CODES.INSUFFICIENT_QUOTA);
});

test('a timeout maps to TIMEOUT', () => {
  const error = { name: 'APIConnectionTimeoutError', message: 'Request timed out.' };
  assert.equal(mapOpenAIError(error).errorCode, OPENAI_ERROR_CODES.TIMEOUT);
});

test('a 5xx upstream failure maps to UPSTREAM_ERROR', () => {
  const error = { name: 'InternalServerError', status: 500, message: 'Server error' };
  assert.equal(mapOpenAIError(error).errorCode, OPENAI_ERROR_CODES.UPSTREAM_ERROR);
});

test('a user-initiated abort is returned as a plain isAbort marker, not an OpenAIServiceError', () => {
  const error = { name: 'APIUserAbortError', message: 'Request was aborted.' };
  const mapped = mapOpenAIError(error);
  assert.equal(mapped.isAbort, true);
  assert.equal(mapped.errorCode, undefined);
});

test('mapOpenAIError never includes an API key in its message', () => {
  const error = { name: 'AuthenticationError', status: 401, message: 'Incorrect API key provided: sk-sensitivevalue1234' };
  const mapped = mapOpenAIError(error);
  assert.equal(mapped.message.includes('sk-sensitivevalue1234'), false);
});
