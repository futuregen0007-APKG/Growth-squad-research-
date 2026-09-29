import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CompanyFinancials from '@/pages/CompanyFinancials';
import * as companyFinancialsApi from '@/services/companyFinancialsApi';

jest.mock('@/services/companyFinancialsApi', () => ({
  searchCompanyFinancials: jest.fn(),
  explainCompanyFinancials: jest.fn(),
}));

function renderPage(initialEntry) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/company-financials" element={<CompanyFinancials />} />
        <Route path="/company-financials/:symbol" element={<CompanyFinancials />} />
      </Routes>
    </MemoryRouter>,
  );
}

const SECTION_KEYS = ['profile', 'balanceSheet', 'cashFlow', 'incomeStatement', 'keyRatios', 'shareholding', 'corporateActions'];

const unavailableSection = () => ({
  available: false, data: null, status: 'UNAVAILABLE', error: null, asOf: null, fromCache: false,
});

const baseSections = () => Object.fromEntries(SECTION_KEYS.map((key) => [key, unavailableSection()]));

describe('CompanyFinancials page', () => {
  beforeEach(() => {
    companyFinancialsApi.searchCompanyFinancials.mockReset();
    companyFinancialsApi.explainCompanyFinancials.mockReset();
    companyFinancialsApi.explainCompanyFinancials.mockResolvedValue({ available: false, reason: 'AI explanation is not available right now.' });
  });

  it('shows a loading state before the search resolves', async () => {
    companyFinancialsApi.searchCompanyFinancials.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ success: true, ambiguous: false, data: null }), 50)));
    renderPage('/company-financials/TCS');
    expect(screen.getByTestId('company-financials-loading')).toBeInTheDocument();
    await waitFor(() => expect(companyFinancialsApi.searchCompanyFinancials).toHaveBeenCalledWith('TCS', expect.anything()));
  });

  it('prompts disambiguation instead of guessing when the query is ambiguous', async () => {
    companyFinancialsApi.searchCompanyFinancials.mockResolvedValue({
      success: true, ambiguous: true, query: 'Tata', candidates: ['TCS', 'TATAMOTORS'],
    });
    renderPage('/company-financials/Tata');

    await waitFor(() => expect(screen.getByTestId('company-financials-ambiguous')).toBeInTheDocument());
    expect(screen.getByText('TCS')).toBeInTheDocument();
    expect(screen.getByText('TATAMOTORS')).toBeInTheDocument();
  });

  it('renders each section independently by its own status -- one UNAVAILABLE section never blanks an AVAILABLE one', async () => {
    const sections = baseSections();
    sections.profile = {
      available: true,
      data: {
        symbol: 'TCS', isin: 'INE467B01029', provider: 'UPSTOX', fetchedAt: '2026-09-29T00:00:00.000Z',
        companyProfile: 'A leading IT services company.', sector: 'Information Technology', sectorMarketCapInr: null, sectorMarketCapUsd: null,
      },
      status: 'AVAILABLE',
      error: null,
      asOf: '2026-09-29T00:00:00.000Z',
      fromCache: false,
    };
    sections.balanceSheet = {
      available: false, data: null, status: 'PROVIDER_ERROR', error: { code: 'RATE_LIMITED', message: 'Upstox rate limit hit' }, asOf: null, fromCache: false,
    };

    companyFinancialsApi.searchCompanyFinancials.mockResolvedValue({
      success: true,
      ambiguous: false,
      data: {
        symbol: 'TCS', companyName: 'Tata Consultancy Services Ltd.', isin: 'INE467B01029', provider: 'UPSTOX',
        generatedAt: '2026-09-29T00:00:00.000Z', sections, missingSections: SECTION_KEYS.slice(1), dataCoveragePct: 14,
      },
    });

    renderPage('/company-financials/TCS');

    await waitFor(() => expect(screen.getByText('A leading IT services company.')).toBeInTheDocument());
    // The failed section shows its own error + retry, never blanking the page.
    expect(screen.getByText('Upstox rate limit hit')).toBeInTheDocument();
    expect(screen.getAllByText('Retry').length).toBeGreaterThan(0);
    // Never labeled as a real-time quote.
    expect(screen.getByText(/not a real-time quote/i)).toBeInTheDocument();
  });

  it('fetches the AI explanation only after the figures resolve, and never blocks them when it fails', async () => {
    const sections = baseSections();
    companyFinancialsApi.searchCompanyFinancials.mockResolvedValue({
      success: true,
      ambiguous: false,
      data: {
        symbol: 'TCS', companyName: 'Tata Consultancy Services Ltd.', isin: 'INE467B01029', provider: 'UPSTOX',
        generatedAt: '2026-09-29T00:00:00.000Z', sections, missingSections: SECTION_KEYS, dataCoveragePct: 0,
      },
    });
    let resolveExplain;
    companyFinancialsApi.explainCompanyFinancials.mockImplementation(() => new Promise((resolve) => { resolveExplain = resolve; }));

    renderPage('/company-financials/TCS');

    await waitFor(() => expect(screen.getByTestId('company-financials-ai-explanation')).toHaveTextContent(/Generating a grounded explanation/i));
    // The figures themselves are already visible while the explanation is still pending -- never gated behind it.
    expect(screen.getByText('TCS')).toBeInTheDocument();

    resolveExplain({ available: false, reason: 'AI explanation is not configured on the server.' });
    await waitFor(() => expect(screen.getByTestId('company-financials-ai-explanation')).toHaveTextContent('AI explanation is not configured on the server.'));
  });

  it('reports a not-found query without crashing', async () => {
    companyFinancialsApi.searchCompanyFinancials.mockResolvedValue({ success: true, ambiguous: false, notFound: true, query: 'Nonexistent Co' });
    renderPage('/company-financials/Nonexistent%20Co');
    await waitFor(() => expect(screen.getByTestId('company-financials-notfound')).toBeInTheDocument());
  });
});
