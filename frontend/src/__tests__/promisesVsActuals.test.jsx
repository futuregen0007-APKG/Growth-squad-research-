import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import EarningsIntelligence from '@/pages/EarningsIntelligence';
import apiClient from '@/services/apiClient';

jest.mock('@/services/apiClient', () => ({ get: jest.fn(), post: jest.fn() }));

/**
 * Promises vs Actuals tab: the guidance badge count, the two distinct empty
 * states, the two separately-labelled scores, filters, and row expansion.
 * Fixture rows follow the backend's /promises-vs-actuals response shape
 * (services/PromisesVsActualsService.js), including the real TCS attrition
 * record recomputed from its stored 13% ceiling vs 13.3% actual.
 */

const report = {
  company: { symbol: 'TCS', companyName: 'Tata Consultancy Services' },
  historicalFacts: [], promises: [], guidanceCount: 3, guidanceCountSource: 'CURATED',
  sourceDocuments: [], businessDevelopments: [], risksAndNegatives: [],
  financialDataStatus: { provider: 'UPSTOX', status: 'AVAILABLE' }, financialSnapshot: { quality: {}, annualSeries: [] },
  weightsUsed: { financialDelivery: 40, strategicExecution: 25, operationalDelivery: 20, capitalAllocation: 15 },
};

const row = (overrides) => ({
  recordSource: 'CURATED', category: 'OTHER', storedStatus: null, versionLabel: null, revisionOf: null, supersededBy: null, countsTowardScore: true,
  target: { value: 10, valueMax: null, unit: 'PERCENT', operator: 'AT_LEAST', comparisonType: 'MINIMUM', statementBasis: null },
  actual: { value: null, unit: null, asOfPeriod: null, source: null, statementBasis: null },
  achievementPercentage: null, achievementReason: null, shortfall: null, reason: null, calculationExplanation: 'calc',
  originalStatement: 'Statement', announcementDate: '2025-04-10', evidenceConfidence: 0.9,
  evidence: { targetSourceUrl: 'https://www.bseindia.com/p.pdf', targetDocTitle: 'Q4 call transcript', targetPage: 5, targetExcerpt: 'excerpt', actualSourceUrl: null, actualReportingPeriod: null },
  ...overrides,
});

const attritionRow = row({
  id: 'TCS-FY2025-001', year: 'FY2025', targetPeriod: 'FY2025', metric: 'OTHER', metricLabel: 'Other', storedStatus: 'PARTIAL',
  target: { value: 13, valueMax: null, unit: 'PERCENT', operator: 'AT_MOST', comparisonType: 'MAXIMUM' },
  actual: { value: 13.3, unit: 'PERCENT', asOfPeriod: 'FY2025', source: 'FY25 call transcript' },
  achievementPercentage: 97.74, outcome: 'MISSED', shortfall: { value: 0.3, unit: 'PERCENT', percentage: 2.31, direction: 'ABOVE_CEILING' },
  calculationExplanation: 'Comparison: MAXIMUM (at most / lower-is-better ceiling). Target 13 PERCENT for FY2025; actual 13.3 PERCENT. 13.3 PERCENT > 13 PERCENT (above the ceiling), so the outcome is MISSED.',
  originalStatement: 'Attrition within the 11%-13% comfort range.',
  evidence: { targetSourceUrl: 'https://www.bseindia.com/p.pdf', targetDocTitle: 'Q4 FY24 call transcript', targetPage: 5, targetExcerpt: 'in our comfort range of 11% to 13%', actualSourceUrl: 'https://www.bseindia.com/o.pdf', actualDocTitle: 'Q4 FY25 call transcript', actualReportingPeriod: 'FY2025', actualExcerpt: 'LTM attrition was stable at 13.3%' },
});
const originalRow = row({
  id: 'X-FY2026-001', year: 'FY2026', targetPeriod: 'FY2026', metric: 'REVENUE_GROWTH', metricLabel: 'Revenue growth', versionLabel: 'ORIGINAL', supersededBy: 'X-FY2026-002', countsTowardScore: false,
  actual: { value: 9, unit: 'PERCENT', asOfPeriod: 'FY2026' }, achievementPercentage: 90, outcome: 'MISSED', announcementDate: '2025-04-10',
});
const revisedRow = row({
  id: 'X-FY2026-002', year: 'FY2026', targetPeriod: 'FY2026', metric: 'REVENUE_GROWTH', metricLabel: 'Revenue growth', versionLabel: 'REVISED', revisionOf: 'X-FY2026-001',
  target: { value: 8.5, unit: 'PERCENT', operator: 'AT_LEAST', comparisonType: 'MINIMUM' }, actual: { value: 9, unit: 'PERCENT', asOfPeriod: 'FY2026' }, achievementPercentage: 105.88, outcome: 'MET', announcementDate: '2025-10-09',
});
const pendingRow = row({
  id: 'X-FY2027-001', year: 'FY2027', targetPeriod: 'FY2027', metric: 'REVENUE', metricLabel: 'Revenue', outcome: 'PENDING',
  achievementReason: 'Target period FY2027 ends 2027-03-31', reason: 'Target period FY2027 ends 2027-03-31; results are due by 2027-05-30 (SEBI LODR: 60 days after period end). The outcome is pending official reporting.',
});

const summary = (overrides = {}) => ({
  managementDeliveryScore: {
    targetHitRate: null, targetHitRateDenominator: 0, targetHitRateNumerator: 0, faithScore: null, faithScoreLabel: 'Insufficient verified history',
    completedCount: 0, metCount: 0, exceededCount: 0, missedCount: 0, pendingCount: 0, insufficientEvidenceCount: 0, qualitativeOnlyCount: 0, supersededCount: 0,
    evidenceCoverage: { confidence: 'LOW', completedQuarters: 0, expectedQuarters: 20 }, yearsCovered: [],
    ...overrides,
  },
  financialPerformanceScore: {
    value: 74, ratingLabel: 'Good', weightsUsed: { financialDelivery: 40, strategicExecution: 25, operationalDelivery: 20, capitalAllocation: 15 },
    scoreMissingReasons: {}, excludesGuidanceAccuracy: true, unavailableReason: null,
  },
});

function renderWith(pva) {
  apiClient.get.mockImplementation((url) => {
    if (url.endsWith('/featured')) return Promise.resolve({ data: [] });
    if (url.endsWith('/promises-vs-actuals')) return Promise.resolve({ data: pva });
    return Promise.resolve({ data: report });
  });
  return render(<MemoryRouter initialEntries={['/earnings-intelligence/TCS']}><Routes>
    <Route path="/earnings-intelligence/:symbol" element={<EarningsIntelligence />} />
  </Routes></MemoryRouter>);
}

async function openTab() {
  fireEvent.click(await screen.findByRole('button', { name: /Promises vs Actuals/ }));
}

beforeEach(() => jest.clearAllMocks());

test('the Management Guidance badge counts the same curated source as the tab body, not the empty legacy list', async () => {
  renderWith({ rows: [], annualSummary: [], emptyState: 'NO_GUIDANCE', summary: summary() });
  expect(await screen.findByRole('button', { name: /Management Guidance \(3\)/ })).toBeInTheDocument();
});

test('researched with nothing measurable renders that state and an unavailable (not 0) hit rate', async () => {
  renderWith({ rows: [], annualSummary: [], emptyState: 'NO_MEASURABLE_GUIDANCE', researchState: { status: 'RESEARCHED', documentsRead: 14 }, summary: summary() });
  await openTab();
  expect(await screen.findByText('No measurable guidance found for this company')).toBeInTheDocument();
  expect(screen.getByText(/14 earnings-call transcript\(s\) \/ presentation\(s\) were read in full/)).toBeInTheDocument();
  expect(screen.queryByText('Guidance found, outcome not yet verified')).not.toBeInTheDocument();
  expect(screen.getByText('Score unavailable — no completed, evaluable targets yet')).toBeInTheDocument();
  expect(apiClient.get).toHaveBeenCalledWith('/api/earnings-intelligence/TCS/promises-vs-actuals');
});

test.each([
  ['NOT_RESEARCHED', { status: 'NOT_RESEARCHED' }, 'Guidance not researched yet'],
  ['GUIDANCE_PENDING_REVIEW', { status: 'CANDIDATES_PENDING_REVIEW', candidatesPendingReview: 8 }, 'Guidance found, awaiting evidence review'],
  ['SOURCES_FAILED', { status: 'SOURCES_FAILED', documentsFailed: 3 }, 'Guidance documents could not be read'],
])('empty state %s has its own message, never "no guidance"', async (emptyState, researchState, title) => {
  renderWith({ rows: [], annualSummary: [], emptyState, researchState, summary: summary() });
  await openTab();
  expect(await screen.findByText(title)).toBeInTheDocument();
  expect(screen.queryByText('No measurable guidance found for this company')).not.toBeInTheDocument();
});

test('guidance that exists but is not yet verifiable renders a different message and lists the pending reason on expand', async () => {
  renderWith({
    rows: [pendingRow], emptyState: 'GUIDANCE_UNVERIFIED',
    annualSummary: [{ year: 'FY2027', total: 1, completed: 0, met: 0, exceeded: 0, missed: 0, pending: 1, insufficientEvidence: 0, qualitativeOnly: 0, superseded: 0 }],
    summary: summary({ pendingCount: 1 }),
  });
  await openTab();
  expect(await screen.findByText('Guidance found, outcome not yet verified')).toBeInTheDocument();
  expect(screen.queryByText('No measurable guidance found for this company')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Show evidence for Revenue FY2027/ }));
  expect(within(screen.getByTestId('pva-detail-X-FY2027-001')).getByText(/results are due by 2027-05-30/)).toBeInTheDocument();
});

test('scores are labelled separately, filters narrow the table, and rows expand to their evidence', async () => {
  renderWith({
    rows: [revisedRow, originalRow, attritionRow], emptyState: null,
    annualSummary: [
      { year: 'FY2026', total: 2, completed: 1, met: 1, exceeded: 0, missed: 0, pending: 0, insufficientEvidence: 0, qualitativeOnly: 0, superseded: 1 },
      { year: 'FY2025', total: 1, completed: 1, met: 0, exceeded: 0, missed: 1, pending: 0, insufficientEvidence: 0, qualitativeOnly: 0, superseded: 0 },
    ],
    summary: summary({ targetHitRate: 50, targetHitRateDenominator: 2, targetHitRateNumerator: 1, completedCount: 2, metCount: 1, missedCount: 1, supersededCount: 1 }),
  });
  await openTab();

  const delivery = await screen.findByTestId('management-delivery-card');
  // (Text is matched on the card: dynamic values render in their own nodes.)
  expect(delivery).toHaveTextContent('Target-hit rate50%');
  expect(delivery).toHaveTextContent('1 of 2 completed targets met or exceeded');
  expect(delivery).toHaveTextContent('Faith Score (curated, confidence-weighted — a different measure)');
  expect(delivery).toHaveTextContent(/Confidence: LOW — based on 2 completed targets/);
  const financial = screen.getByTestId('financial-performance-card');
  expect(financial).toHaveTextContent('This score no longer includes guidance-delivery accuracy');
  expect(financial).toHaveTextContent('Financial Delivery40%');
  expect(financial).toHaveTextContent('Capital Allocation15%');
  expect(financial).not.toHaveTextContent('Guidance');

  // An achievement percentage is always shown with its outcome label.
  const attrition = screen.getByTestId('pva-row-TCS-FY2025-001');
  expect(attrition).toHaveTextContent('97.74% of target · Missed');
  expect(attrition).toHaveTextContent('≤ 13%');

  const table = screen.getByTestId('pva-table');
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  fireEvent.change(screen.getByLabelText('Filter by outcome'), { target: { value: 'MISSED' } });
  expect(within(table).queryByTestId('pva-row-X-FY2026-002')).not.toBeInTheDocument();
  expect(within(table).getByTestId('pva-row-TCS-FY2025-001')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Filter by year'), { target: { value: 'FY2026' } });
  expect(within(table).getByTestId('pva-row-X-FY2026-001')).toBeInTheDocument();
  expect(within(table).queryByTestId('pva-row-TCS-FY2025-001')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Filter by year'), { target: { value: 'ALL' } });
  fireEvent.change(screen.getByLabelText('Filter by outcome'), { target: { value: 'ALL' } });
  fireEvent.change(screen.getByLabelText('Filter by metric'), { target: { value: 'REVENUE_GROWTH' } });
  expect(within(table).getAllByTestId(/^pva-row-/)).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Filter by metric'), { target: { value: 'ALL' } });

  fireEvent.click(screen.getByRole('button', { name: /Show evidence for Other FY2025/ }));
  const detail = screen.getByTestId('pva-detail-TCS-FY2025-001');
  expect(within(detail).getByText(/so the outcome is MISSED/)).toBeInTheDocument();
  expect(detail).toHaveTextContent('Stored verdict was PARTIAL; the outcome above is recomputed');
  expect(within(detail).getByRole('link', { name: /Open target document/ })).toHaveAttribute('href', 'https://www.bseindia.com/p.pdf');
  expect(within(detail).getByRole('link', { name: /Open result document/ })).toHaveAttribute('href', 'https://www.bseindia.com/o.pdf');
  expect(detail).toHaveTextContent('Reporting period: FY2025');

  // Revised row is listed first; expanding it shows the original version in its history.
  fireEvent.click(screen.getAllByRole('button', { name: /Show evidence for Revenue growth FY2026/ })[0]);
  const revisedDetail = screen.getByTestId('pva-detail-X-FY2026-002');
  expect(revisedDetail).toHaveTextContent('This is the revised guidance for Revenue growth (FY2026)');
  expect(revisedDetail).toHaveTextContent('counts toward the target-hit rate');
  expect(revisedDetail).toHaveTextContent(/Original \(.*\): ≥ 10% → Missed/);
});
