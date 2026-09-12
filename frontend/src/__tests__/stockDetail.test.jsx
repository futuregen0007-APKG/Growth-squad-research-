import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import StockDetail from '@/pages/StockDetail';
import SearchBar from '@/components/SearchBar';
import * as stockApi from '@/services/stockApi';
import * as newsApi from '@/services/newsApi';

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
}));

jest.mock('@/services/newsApi', () => ({
  fetchStockNews: jest.fn(),
}));

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
    newsApi.fetchStockNews.mockReset();

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
    await waitFor(() => expect(screen.getByText('HAL')).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText('HAL')).toBeInTheDocument());
    expect(screen.getByText('NSE · HAL · Defence')).toBeInTheDocument();
  });

  it('navigates from search suggestions to the normalized stock detail route', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'TCS', ticker: 'TCS', name: 'Tata Consultancy Services' });
    stockApi.fetchCompanyDetails.mockResolvedValue({ companyName: 'Tata Consultancy Services', sector: 'IT', research: null });

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="*" element={<SearchHarness />} />
        </Routes>
      </MemoryRouter>
    );

    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);
    input.focus();
    input.setSelectionRange(0, input.value.length);
    input.value = 'TCS';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await waitFor(() => expect(screen.getByText('Tata Consultancy Services')).toBeInTheDocument());

    const suggestion = screen.getByText('Tata Consultancy Services');
    suggestion.closest('div')?.click();

    await waitFor(() => expect(screen.getByTestId('location-path')).toHaveTextContent('/stock/TCS'));
  });

  it('falls back to the symbol when the company name is absent while details are loading', async () => {
    stockApi.fetchStockBySymbol.mockResolvedValue({ symbol: 'HAL', ticker: 'HAL', name: null });
    stockApi.fetchCompanyDetails.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ sector: 'Defence', research: null }), 120)));

    renderStockDetail('/stock/HAL');

    await waitFor(() => expect(screen.getByText('HAL')).toBeInTheDocument());
  });

  it('renders a controlled unsupported state for an invalid symbol', async () => {
    render(
      <MemoryRouter initialEntries={['/stock/']}> 
        <Routes>
          <Route path="/stock/:ticker" element={<StockDetail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('stock-detail-invalid')).toBeInTheDocument();
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
