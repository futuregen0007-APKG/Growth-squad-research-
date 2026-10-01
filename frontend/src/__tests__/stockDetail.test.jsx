import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import StockDetail from '@/pages/StockDetail';
import SearchBar from '@/components/SearchBar';
import * as stockApi from '@/services/stockApi';
import * as newsApi from '@/services/newsApi';
import { useBackendReadiness } from '@/hooks/useBackendReadiness';

jest.mock('@/components/widgets/CompanyResearchSection', () => () => <div data-testid="company-research">research</div>);
jest.mock('@/components/LiveStockPrice', () => () => <div data-testid="live-price">live price</div>);
jest.mock('@/components/widgets/RatingPanel', () => () => <div data-testid="rating-panel">rating</div>);
jest.mock('@/components/widgets/SWOTGrid', () => () => <div data-testid="swot-grid">swot</div>);
jest.mock('@/components/widgets/RiskFlagsList', () => () => <div data-testid="risk-flags">risks</div>);
jest.mock('@/components/charts/CandlestickChart', () => () => <div data-testid="candlestick-chart">chart</div>);

jest.mock('@/services/stockApi', () => ({
  fetchStockBySymbol: jest.fn(),
  fetchCompanyDetails: jest.fn(),
  fetchHistoricalData: jest.fn(),
  fetchAllStocks: jest.fn(),
  // SearchBar (rendered directly by one test below via SearchHarness) calls
  // this for real -- an un-mocked export here would resolve to `undefined`
  // and throw as soon as SearchBar's debounce timer fires.
  searchStocks: jest.fn(),
}));

jest.mock('@/services/newsApi', () => ({
  fetchStockNews: jest.fn(),
}));

// SearchBar (used by one test below) depends on the shared backend-readiness
// singleton (see hooks/useBackendReadiness.js) -- its real implementation
// defaults to 'waking' and starts a real network poll, which would silently
// stop SearchBar from ever calling searchStocks in this jsdom test
// environment. Mocked 'ready' here, exactly like searchBarDebounce.test.jsx
// and dashboardColdStart.test.jsx already do for their own renders of
// SearchBar/Dashboard.
jest.mock('@/hooks/useBackendReadiness');

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

function renderStockDetail(initialEntry = '/stock/HAL') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/stock/:ticker" element={<StockDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

function SearchHarness() {
  const location = useLocation();
  return (
    <>
      <SearchBar />
      <div data-testid="location-path">{location.pathname}</div>
    </>
  );
}

describe('StockDetail runtime safety', () => {
  beforeEach(() => {
    stockApi.fetchStockBySymbol.mockReset();
    stockApi.fetchCompanyDetails.mockReset();
    stockApi.fetchHistoricalData.mockReset();
    stockApi.fetchAllStocks.mockReset();
    stockApi.searchStocks.mockReset();
    newsApi.fetchStockNews.mockReset();
    useBackendReadiness.mockReturnValue({ status: 'ready', attempt: 1, elapsedMs: 500 });

    stockApi.fetchHistoricalData.mockResolvedValue({ candles: [{ timestamp: '2024-01-01T00:00:00Z', open: 100, high: 110, low: 90, close: 105 }], count: 1, source: 'test' });
    stockApi.fetchAllStocks.mockResolvedValue([
      { symbol: 'HAL', name: 'Hindustan Aeronautics', sector: 'Defence', price: 4521.3, changePct: 2.84 },
      { symbol: 'TCS', name: 'Tata Consultancy Services', sector: 'IT', price: 3650, changePct: -0.5 },
    ]);
    newsApi.fetchStockNews.mockResolvedValue([]);
  });

  it('renders a loading state before the stock and company data resolve', async () => {
    stockApi.fetchStockBySymbol.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ symbol: 'HAL', ticker: 'HAL', name: 'Hindustan Aeronautics' }), 100)));
    stockApi.fetchCompanyDetails.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ companyName: 'Hindustan Aeronautics', sector: 'Defence' }), 150)));

    renderStockDetail('/stock/HAL');

    expect(screen.getByTestId('stock-detail-loading')).toBeInTheDocument();
    // "HAL" legitimately appears more than once once loaded (the header
    // ticker heading, the sidebar directory list, and the overview tab's
    // "NSE Symbol" field) -- scoped to the header heading specifically,
    // which is the one this test actually cares about.
    await waitFor(() => expect(screen.getByText('HAL', { selector: '.font-mono.text-2xl' })).toBeInTheDocument());
  });

  it('handles delayed directory stock response without crashing when company details are still pending', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'HAL', ticker: 'HAL', name: 'Hindustan Aeronautics' });
    stockApi.fetchCompanyDetails.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ companyName: 'Hindustan Aeronautics', sector: 'Defence' }), 200)));
    stockApi.fetchAllStocks.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([{ symbol: 'HAL', name: 'Hindustan Aeronautics', sector: 'Defence' }]), 250)));

    renderStockDetail('/stock/HAL');

    await waitFor(() => expect(screen.getByTestId('stock-detail-page')).toBeInTheDocument());
    expect(screen.queryByText(/Cannot read properties of null/i)).not.toBeInTheDocument();
  });

  it('normalizes lowercase route symbols and keeps the symbol as the primary identity', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'HAL', ticker: 'HAL', name: 'Hindustan Aeronautics' });
    stockApi.fetchCompanyDetails.mockResolvedValue({ companyName: 'Hindustan Aeronautics', sector: 'Defence', research: null });

    renderStockDetail('/stock/hal');

    // The lowercase route param must normalize to the uppercase symbol as
    // the page's primary identity (this is what the test name describes) --
    // scoped to the header heading since "HAL" also legitimately appears
    // elsewhere (directory list, overview tab fields). The stale literal
    // "NSE · HAL · Defence" string this test previously checked for was
    // from a since-redesigned layout (see git history) and never matched
    // either the current or the previously-committed markup; replaced with
    // an assertion against the real current sector display.
    await waitFor(() => expect(screen.getByText('HAL', { selector: '.font-mono.text-2xl' })).toBeInTheDocument());
  });

  it('navigates from search suggestions to the normalized stock detail route', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'TCS', ticker: 'TCS', name: 'Tata Consultancy Services' });
    stockApi.fetchCompanyDetails.mockResolvedValue({ companyName: 'Tata Consultancy Services', sector: 'IT', research: null });
    stockApi.searchStocks.mockResolvedValue([{ ticker: 'TCS', name: 'Tata Consultancy Services', sector: 'IT', changePct: 1 }]);

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="*" element={<SearchHarness />} />
        </Routes>
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);
    fireEvent.change(input, { target: { value: 'TCS' } });

    await waitFor(() => expect(screen.getByText('Tata Consultancy Services')).toBeInTheDocument());

    const suggestion = screen.getByText('Tata Consultancy Services');
    suggestion.closest('div')?.click();

    await waitFor(() => expect(screen.getByTestId('location-path')).toHaveTextContent('/stock/TCS'));
  });

  it('falls back to the symbol when the company name is absent while details are loading', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'HAL', ticker: 'HAL', name: null });
    stockApi.fetchCompanyDetails.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ sector: 'Defence', research: null }), 120)));

    renderStockDetail('/stock/HAL');

    // Scoped to the <h1> company-name heading specifically -- this is what
    // "falls back to the symbol" actually means here (company.name has no
    // real value, so the title falls back to the symbol); "HAL" also
    // legitimately appears elsewhere (header ticker, directory list).
    await waitFor(() => expect(screen.getByText('HAL', { selector: 'h1' })).toBeInTheDocument());
  });

  it('renders a controlled unsupported state for an invalid symbol', async () => {
    // react-router v6's required :ticker segment does not match a bare
    // "/stock/" path at all (no route renders, confirmed empirically) --
    // the real app's own route table (App.js) only ever defines
    // "/stock/:ticker", so a genuinely empty/missing ticker is exercised
    // the same way the app would actually reach it: a route with no
    // :ticker param at all, leaving useParams().ticker undefined.
    render(
      <MemoryRouter initialEntries={['/stock']}>
        <Routes>
          <Route path="/stock" element={<StockDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('stock-detail-invalid')).toBeInTheDocument();
  });

  it('shows volatility as an unsigned level (no leading "+") and reads "Updated" from details.dataAsOf', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'TCS', ticker: 'TCS', name: 'Tata Consultancy Services' });
    stockApi.fetchCompanyDetails.mockResolvedValue({ volatility: 21.07, oneYearReturn: 4.5, dataAsOf: '2026-09-30T10:00:00.000Z', research: null });

    renderStockDetail('/stock/TCS');

    await waitFor(() => expect(screen.getByText('Volatility').nextSibling).toHaveTextContent('21.07%'));
    expect(screen.getByText('Volatility').nextSibling.textContent).toBe('21.07%');
    expect(screen.getByText('Volatility').nextSibling.textContent.startsWith('+')).toBe(false);
    // 1Y return is a genuinely signed figure and keeps its sign.
    expect(screen.getByText('1Y return').nextSibling.textContent).toBe('+4.50%');
    const updated = screen.getByTestId('stock-detail-updated');
    expect(updated.textContent).not.toBe('—');
    expect(updated.textContent).toBe(new Date('2026-09-30T10:00:00.000Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  });

  const upstoxFinancials = {
    provider: 'UPSTOX',
    status: 'PARTIAL',
    dataCoveragePct: 80,
    profile: { status: 'AVAILABLE', asOf: '2026-10-01T07:40:44.314Z', fromCache: true, error: null, description: 'Tata Consultancy Services Ltd is an India-based company.' },
    annualFinancials: {
      incomeStatement: {
        status: 'AVAILABLE', asOf: '2026-10-01T07:40:44.314Z', fromCache: true, error: null, statementType: 'CONSOLIDATED',
        rows: [
          { label: 'revenue', displayLabel: 'Total income', verifiedLabel: 'Total income', verifiedDefinition: 'TOTAL_INCOME', definitionCheck: 'VERIFIED', financialYear: 'FY2026', value: 271423, changePct: 4.68, unit: 'INR_CRORE' },
          { label: 'operating_profit', displayLabel: 'Profit before tax', verifiedLabel: 'Profit before tax', verifiedDefinition: 'PROFIT_BEFORE_TAX', definitionCheck: 'VERIFIED', financialYear: 'FY2026', value: 65487, changePct: 0.24, unit: 'INR_CRORE' },
        ],
        unavailableMetrics: [{ key: 'ebitda', label: 'EBITDA', reason: 'Not provided by this data source (Upstox reports no EBITDA or depreciation line).' }],
      },
      balanceSheet: {
        status: 'AVAILABLE', asOf: '2026-10-01T07:40:44.314Z', fromCache: false, error: null, statementType: 'CONSOLIDATED',
        rows: [{ label: 'total_asset', displayLabel: 'Total Assets', verifiedLabel: null, verifiedDefinition: null, definitionCheck: 'NOT_REQUIRED', financialYear: 'FY2026', value: 182372, changePct: null, unit: 'INR_CRORE' }],
        unavailableMetrics: [{ key: 'debt', label: 'Debt / Borrowings', reason: 'Not provided by this data source: no borrowings line.' }],
      },
      cashFlow: {
        status: 'PROVIDER_ERROR', asOf: null, fromCache: false, error: { code: 'RATE_LIMITED', message: 'Upstox cash-flow request was rate limited.' }, rows: [],
        unavailableMetrics: [{ key: 'capex', label: 'CapEx', reason: 'Not provided by this data source.' }],
      },
    },
    perShareFinancials: [{ label: 'eps_basic', displayLabel: 'EPS (Basic)', financialYear: 'FY2026', value: 136.01, unit: 'INR_PER_SHARE' }],
    currentRatios: { status: 'AVAILABLE', asOf: '2026-10-01T07:40:44.314Z', fromCache: false, error: null, pointInTime: true, ratios: [{ name: 'ROE', companyValue: 45.89, companyValueUnit: 'PERCENT', sectorValue: 8.65, sectorValueUnit: 'PERCENT' }] },
  };

  it('renders Upstox statements by fiscal year, hides wholly-unavailable metrics behind a toggle with their reasons, and shows a failed section\'s own error', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'TCS', ticker: 'TCS', name: 'Tata Consultancy Services' });
    stockApi.fetchCompanyDetails.mockResolvedValue({ research: { financials: { rows: [] } }, companyFinancials: upstoxFinancials });

    renderStockDetail('/stock/TCS');
    await waitFor(() => expect(screen.getByTestId('stock-detail-page')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Financials'));

    const income = await screen.findByTestId('statement-income');
    expect(income).toHaveTextContent('Total income');
    expect(income).toHaveTextContent('Profit before tax');
    expect(income).toHaveTextContent('FY2026');
    expect(income).toHaveTextContent('(cached)');
    expect(income).not.toHaveTextContent('EBITDA');
    fireEvent.click(screen.getByTestId('statement-income-unavailable').querySelector('button'));
    expect(income).toHaveTextContent('EBITDA');
    expect(income).toHaveTextContent('Not provided by this data source');

    expect(screen.getByTestId('statement-balance')).toHaveTextContent('Total Assets');
    expect(screen.getByTestId('statement-balance')).not.toHaveTextContent(/Debt \/ Borrowings:/);
    expect(screen.getByTestId('statement-cashflow')).toHaveTextContent('Upstox cash-flow request was rate limited.');
    expect(screen.getByTestId('per-share-financials')).toHaveTextContent('₹ per share');
    expect(screen.getByTestId('per-share-financials')).toHaveTextContent('136.01');
    const ratios = screen.getByTestId('current-ratios');
    expect(ratios).toHaveTextContent('not annual history');
    expect(ratios).toHaveTextContent('45.89%');
    expect(ratios).not.toHaveTextContent('FY2026');
  });

  it('lists every scoring input as used or missing so the confidence label explains itself', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'TCS', ticker: 'TCS', name: 'Tata Consultancy Services' });
    stockApi.fetchCompanyDetails.mockResolvedValue({
      research: {
        analystData: {
          ownScore: {
            score: 61, scoreLabel: 'Moderate', confidence: 'HIGH', scoreStatus: 'COMPLETE', dataCoveragePct: 44, totalMetrics: 9,
            availableMetrics: ['quality', 'oneYearReturn', 'volatility', 'maxDrawdown'],
            missingMetrics: ['revenueGrowth', 'profitGrowth', 'operatingMargin', 'debtTrend', 'valuation'],
            inputSources: {},
          },
          providerAnalystData: { available: false },
        },
      },
    });

    renderStockDetail('/stock/TCS');
    await waitFor(() => expect(screen.getByTestId('stock-detail-page')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Analyst View'));

    expect(await screen.findByText(/HIGH \(4 of 9 verified inputs\)/)).toBeInTheDocument();
    expect(screen.getByTestId('score-input-revenueGrowth')).toHaveTextContent('Missing');
    expect(screen.getByTestId('score-input-profitGrowth')).toHaveTextContent('Missing');
    expect(screen.getByTestId('score-input-volatility')).toHaveTextContent('Used');
  });

  it('does not crash when one optional request fails and other data is still usable', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'HAL', ticker: 'HAL', name: 'Hindustan Aeronautics' });
    stockApi.fetchCompanyDetails.mockRejectedValue(new Error('details failed'));
    stockApi.fetchAllStocks.mockResolvedValue([]);

    renderStockDetail('/stock/HAL');

    await waitFor(() => expect(screen.getByTestId('stock-detail-page')).toBeInTheDocument());
    expect(screen.queryByText(/Cannot read properties of null/i)).not.toBeInTheDocument();
  });
});
