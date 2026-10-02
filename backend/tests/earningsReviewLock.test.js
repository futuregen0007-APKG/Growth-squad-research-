import test from 'node:test';
import assert from 'node:assert/strict';
import { lockCandidate, unlockCandidate } from '../scripts/earningsReview.js';
import PromiseCandidate from '../models/PromiseCandidate.js';

/**
 * earningsReviewLock.test.js
 * ===========================
 * earningsReview.js --lock / --unlock: same EARNINGS_REVIEW_SECRET gate as
 * accept/reject, a reviewer is required, and only the reevaluation.lock*
 * fields are written. No database: PromiseCandidate.findOne/updateOne are mocked.
 */

const SECRET = 'test-lock-secret';

const withSecret = (t) => {
  const previous = process.env.EARNINGS_REVIEW_SECRET;
  process.env.EARNINGS_REVIEW_SECRET = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.EARNINGS_REVIEW_SECRET; else process.env.EARNINGS_REVIEW_SECRET = previous;
  });
};

const mockModel = (t, doc) => {
  const updates = [];
  t.mock.method(PromiseCandidate, 'findOne', () => ({ lean: async () => doc }));
  t.mock.method(PromiseCandidate, 'updateOne', async (filter, update) => { updates.push({ filter, update }); return { matchedCount: 1 }; });
  return updates;
};

test('lock/unlock refuse without the review secret or a reviewer, touching nothing', async (t) => {
  withSecret(t);
  const updates = mockModel(t, { id: 'TCS-FY2025-CAND-001', reevaluation: null });
  assert.equal((await lockCandidate('TCS', 'TCS-FY2025-CAND-001', { reviewer: 'r', secret: 'wrong' })).ok, false);
  assert.equal((await unlockCandidate('TCS', 'TCS-FY2025-CAND-001', { reviewer: 'r', secret: 'wrong' })).ok, false);
  assert.equal((await lockCandidate('TCS', 'TCS-FY2025-CAND-001', { secret: SECRET })).ok, false);
  assert.equal(updates.length, 0);
});

test('lock sets locked/lockedBy/lockedAt/lockReason (initialising a null reevaluation first)', async (t) => {
  withSecret(t);
  const updates = mockModel(t, { id: 'TCS-FY2025-CAND-001', reviewStatus: 'ACCEPTED', reevaluation: null });
  const result = await lockCandidate('TCS', 'TCS-FY2025-CAND-001', { reviewer: 'alice', secret: SECRET, reason: 'restatement under review' });
  assert.equal(result.ok, true);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].filter, { symbol: 'TCS', id: 'TCS-FY2025-CAND-001', reevaluation: null });
  const { $set } = updates[1].update;
  assert.equal($set['reevaluation.locked'], true);
  assert.equal($set['reevaluation.lockedBy'], 'alice');
  assert.ok($set['reevaluation.lockedAt'] instanceof Date);
  assert.equal($set['reevaluation.lockReason'], 'restatement under review');
  assert.deepEqual(Object.keys($set).sort(), ['reevaluation.lockReason', 'reevaluation.locked', 'reevaluation.lockedAt', 'reevaluation.lockedBy']);
});

test('unlock clears the lock fields; unlocking an unlocked candidate is a no-op', async (t) => {
  withSecret(t);
  const updates = mockModel(t, { id: 'TCS-FY2025-CAND-001', reevaluation: { locked: true, lockedBy: 'alice', lockedAt: new Date(), lockReason: 'x' } });
  const result = await unlockCandidate('TCS', 'TCS-FY2025-CAND-001', { reviewer: 'bob', secret: SECRET });
  assert.equal(result.ok, true);
  assert.deepEqual(updates[0].update.$set, {
    'reevaluation.locked': false, 'reevaluation.lockedBy': null, 'reevaluation.lockedAt': null, 'reevaluation.lockReason': null,
  });

  const t2updates = [];
  PromiseCandidate.findOne.mock.mockImplementation(() => ({ lean: async () => ({ id: 'TCS-FY2025-CAND-001', reevaluation: { locked: false } }) }));
  PromiseCandidate.updateOne.mock.mockImplementation(async (f, u) => { t2updates.push(u); });
  const again = await unlockCandidate('TCS', 'TCS-FY2025-CAND-001', { reviewer: 'bob', secret: SECRET });
  assert.equal(again.idempotent, true);
  assert.equal(t2updates.length, 0);
});

test('lock on an unknown candidate id fails cleanly', async (t) => {
  withSecret(t);
  const updates = mockModel(t, null);
  const result = await lockCandidate('TCS', 'NOPE', { reviewer: 'alice', secret: SECRET });
  assert.equal(result.ok, false);
  assert.match(result.error, /No candidate/);
  assert.equal(updates.length, 0);
});
