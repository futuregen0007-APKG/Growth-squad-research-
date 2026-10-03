import React from 'react';
import { render, screen } from '@testing-library/react';
import { ManagementDeliveryLine } from '@/pages/EarningsIntelligence';

jest.mock('@/services/apiClient', () => ({ get: jest.fn(), post: jest.fn() }));

/**
 * The company card's management-delivery line reads the same computation as
 * the Promises vs Actuals tab (backend managementDelivery). It replaces the
 * old "Guidance 100 · 1 achieved · 1 partial" line that disagreed with that
 * tab: a target-hit rate is always shown with its denominator, there is no
 * "partial", and no evaluable target means "score unavailable", never 0%.
 */

test('completed targets render as "X of Y met" with the met / exceeded / missed split and unresolved count', () => {
  render(<ManagementDeliveryLine delivery={{
    targetHitRate: 50, targetHitRateNumerator: 2, targetHitRateDenominator: 4, metCount: 1, exceededCount: 1, missedCount: 2, pendingCount: 1, insufficientEvidenceCount: 2,
  }} />);
  const line = screen.getByTestId('card-management-delivery');
  expect(line).toHaveTextContent('2 of 4 completed targets met (50%)');
  expect(line).toHaveTextContent('1 met · 1 exceeded · 2 missed · 3 unresolved');
  expect(line).not.toHaveTextContent(/partial/i);
});

test('the real TCS case reads 0 of 1, matching the Promises vs Actuals tab', () => {
  render(<ManagementDeliveryLine delivery={{ targetHitRate: 0, targetHitRateNumerator: 0, targetHitRateDenominator: 1, metCount: 0, exceededCount: 0, missedCount: 1, qualitativeOnlyCount: 1 }} />);
  expect(screen.getByTestId('card-management-delivery')).toHaveTextContent('0 of 1 completed targets met (0%)');
});

test.each([
  ['NOT_RESEARCHED', 'Guidance not yet researched'],
  ['NO_MEASURABLE_GUIDANCE', 'Researched: no measurable numeric guidance found'],
  ['GUIDANCE_PENDING_REVIEW', 'Guidance found: awaiting evidence review'],
  ['GUIDANCE_UNVERIFIED', 'Targets published: outcomes not yet verifiable'],
])('no evaluable target (%s) says why and shows no percentage', (emptyState, text) => {
  render(<ManagementDeliveryLine delivery={{ targetHitRate: null, targetHitRateDenominator: 0, emptyState }} />);
  const line = screen.getByTestId('card-management-delivery');
  expect(line).toHaveTextContent(`${text} · score unavailable`);
  expect(line).not.toHaveTextContent('%');
});

test('no delivery data at all renders nothing rather than a guessed figure', () => {
  const { container } = render(<ManagementDeliveryLine delivery={null} />);
  expect(container).toBeEmptyDOMElement();
});
