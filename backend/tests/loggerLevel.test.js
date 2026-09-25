import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * loggerLevel.test.js
 * =====================
 * LOG_LEVEL used to be matched exactly, so LOG_LEVEL=info matched no level and
 * silenced every log line, errors included. The level is read once at import,
 * so each case loads a fresh copy of the module (the query string makes it a
 * distinct module URL) under its own LOG_LEVEL and records what it prints.
 */

let counter = 0;
const emitted = async (logLevel) => {
  const saved = process.env.LOG_LEVEL;
  if (logLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = logLevel;
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const seen = [];
  const capture = (...args) => { seen.push(args.join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    counter += 1;
    const { logger } = await import(`../utils/logger.js?case=${counter}`);
    logger.error('e'); logger.warn('w'); logger.info('i'); logger.debug('d'); logger.trace('t');
  } finally {
    Object.assign(console, originals);
    if (saved === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved;
  }
  return ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].filter((level) => seen.some((line) => line.includes(`[${level}]`)));
};

test('lowercase and uppercase levels behave identically', async () => {
  assert.deepEqual(await emitted('info'), ['ERROR', 'WARN', 'INFO']);
  assert.deepEqual(await emitted('INFO'), ['ERROR', 'WARN', 'INFO']);
  assert.deepEqual(await emitted(' Warn '), ['ERROR', 'WARN']);
  assert.deepEqual(await emitted('error'), ['ERROR']);
});

test('an unset or blank level keeps the development default of DEBUG', async () => {
  assert.deepEqual(await emitted(undefined), ['ERROR', 'WARN', 'INFO', 'DEBUG']);
  assert.deepEqual(await emitted(''), ['ERROR', 'WARN', 'INFO', 'DEBUG']);
});

test('trace is only emitted when asked for', async () => {
  assert.deepEqual(await emitted('trace'), ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']);
});

test('an unrecognised level falls back to INFO instead of silencing everything', async () => {
  assert.deepEqual(await emitted('verbose'), ['ERROR', 'WARN', 'INFO']);
});
