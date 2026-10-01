import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import EarningsIntelligence from '@/pages/EarningsIntelligence';
import apiClient from '@/services/apiClient';

jest.mock('@/services/apiClient', () => ({ get: jest.fn(), post: jest.fn() }));

function renderReport(snapshot, status = 'AVAILABLE') {
  apiClient.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/featured') ? [] : {
    symbol: 'HDFCBANK', companyName: 'HDFC Bank', confidence: 'LOW', coverage: 'FY2025–FY2026',
    historicalFacts: [], promises: [], sourceDocuments: [], businessDevelopments: [], risksAndNegatives: [],
    financialDataStatus: { provider: 'UPSTOX', status, sections: { incomeStatement: { fromCache: true, fetchedAt: '2026-10-01T00:00:00Z' } } },
    financialSnapshot: snapshot,
  } }));
  return render(<MemoryRouter initialEntries={['/earnings-intelligence/HDFCBANK']}><Routes>
    <Route path="/earnings-intelligence/:symbol" element={<EarningsIntelligence />} />
  </Routes></MemoryRouter>);
}

test('annual table uses provider definitions and actual growth window, with missing values withheld', async () => {
  renderReport({ revenueLabel: 'Total income', patLabel: 'Profit after tax', epsLabel: 'EPS (basis unverified)',
    revenueCagr: 5.21, patCagr: 7.87, revenueWindow: 'FY2025–FY2026 (1 year(s) elapsed)',
    patWindow: 'FY2025–FY2026 (1 year(s) elapsed)', debtTrend: 'Unavailable',
    quality: { historicalExcludedFactsCount: 3 },
    annualSeries: [{ year: 2025, period: 'FY2025', revenue: 470915.93, pat: 73440.17 },
      { year: 2026, period: 'FY2026', revenue: 495462.81, pat: 79219.46 }],
  });
  const table = await screen.findByRole('table');
  expect(table).toHaveTextContent('Total income (₹ Cr)');
  expect(screen.getByText('495462.81')).toBeInTheDocument();
  expect(screen.getByText('79219.46')).toBeInTheDocument();
  expect(document.body).toHaveTextContent('FY2025–FY2026 (1 year(s) elapsed)');
  expect(screen.getByText(/Conflicting historical financial extracts were excluded/)).toBeInTheDocument();
  expect(document.body).toHaveTextContent('Financial source: UPSTOX');
  expect(screen.queryByText(/5-Year Verified Financial Track Record/)).not.toBeInTheDocument();
  expect(screen.queryByText('Diluted EPS (₹)')).not.toBeInTheDocument();
  expect(screen.queryByText('Stable')).not.toBeInTheDocument();
  expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
});

test('provider failure displays unavailable without inventing annual data', async () => {
  renderReport({ quality: {}, annualSeries: [], debtTrend: 'Unavailable' }, 'UNAVAILABLE');
  await waitFor(() => expect(document.body).toHaveTextContent('Financial source: UPSTOX — UNAVAILABLE'));
  expect(screen.queryByText('495462.81')).not.toBeInTheDocument();
  expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
});
