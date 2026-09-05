import test from 'node:test';
import assert from 'node:assert/strict';
import { getIstMarketStatus } from '../utils/marketStatus.js';

// All instants below are given in UTC and chosen so that, once converted to
// IST (UTC+5:30), they land on the intended weekday and time-of-day without
// crossing a calendar-day boundary.

test('market is closed on Saturday, even during normal trading hours', () => {
  // 2026-09-05 is a Saturday; 04:30 UTC = 10:00 IST
  const status = getIstMarketStatus(new Date('2026-09-05T04:30:00Z'));
  assert.equal(status.isOpen, false);
  assert.equal(status.session, 'CLOSED');
});

test('market is closed on Sunday, even during normal trading hours', () => {
  // 2026-09-06 is a Sunday; 04:30 UTC = 10:00 IST
  const status = getIstMarketStatus(new Date('2026-09-06T04:30:00Z'));
  assert.equal(status.isOpen, false);
  assert.equal(status.session, 'CLOSED');
});

test('market is closed on a weekday before the 09:15 IST open', () => {
  // 2026-09-07 is a Monday; 03:30 UTC = 09:00 IST
  const status = getIstMarketStatus(new Date('2026-09-07T03:30:00Z'));
  assert.equal(status.isOpen, false);
  assert.equal(status.session, 'CLOSED');
});

test('market is open on a weekday during trading hours', () => {
  // 2026-09-07 is a Monday; 06:30 UTC = 12:00 IST
  const status = getIstMarketStatus(new Date('2026-09-07T06:30:00Z'));
  assert.equal(status.isOpen, true);
  assert.equal(status.session, 'REGULAR');
});

test('market is closed on a weekday after the 15:30 IST close', () => {
  // 2026-09-07 is a Monday; 10:30 UTC = 16:00 IST
  const status = getIstMarketStatus(new Date('2026-09-07T10:30:00Z'));
  assert.equal(status.isOpen, false);
  assert.equal(status.session, 'CLOSED');
});
