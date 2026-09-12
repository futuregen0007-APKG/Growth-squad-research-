import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '@/pages/Dashboard';
import { AuthProvider } from '@/hooks/useAuth';
import * as stockApi from '@/services/stockApi';
import * as newsApi from '@/services/newsApi';
import { useBackendReadiness } from '@/hooks/useBackendReadiness';

jest.mock('@/services/stockApi', () => ({
  fetchAllStocks: jest.fn(),
  fetchIndexQuotes: jest.fn(),
  fetchHistoricalData: jest.fn(),
  fetchSectorRotation: jest.fn(),
}));
jest.mock('@/services/newsApi', () => ({
  fetchNewsWithStatus: jest.fn(),
}));
jest.mock('@/hooks/useBackendReadiness');

const renderDashboard = () => render(
  <MemoryRouter>
    <AuthProvider>
      <Dashboard />
    </AuthProvider>
  </MemoryRouter>,
);

describe('Dashboard cold-start gating and partial-failure resilience', () => {
  beforeEach(() => {
    stockApi.fetchAllStocks.mockReset().mockResolvedValue([]);
    stockApi.fetchIndexQuotes.mockReset().mockResolvedValue([]);
    stockApi.fetchHistoricalData.mockReset().mockResolvedValue({ candles: [] });
    stockApi.fetchSectorRotation.mockReset().mockResolvedValue([]);
    newsApi.fetchNewsWithStatus.mockReset().mockResolvedValue({ articles: [], failedSymbols: [], providerStatus: 'OK' });
  });

  it('shows "Starting backend service..." and fires no dashboard requests while the backend is waking', () => {
    useBackendReadiness.mockReturnValue({ status: 'waking', attempt: 1, elapsedMs: 3000 });

    renderDashboard();

    expect(screen.getByTestId('backend-waking-banner')).toBeInTheDocument();
    expect(screen.getByText(/Starting backend service/i)).toBeInTheDocument();
    expect(stockApi.fetchAllStocks).not.toHaveBeenCalled();
    expect(stockApi.fetchIndexQuotes).not.toHaveBeenCalled();
    expect(stockApi.fetchSectorRotation).not.toHaveBeenCalled();
  });

  it('fires the dashboard requests once readiness reports ready, and hides the waking banner', async () => {
    useBackendReadiness.mockReturnValue({ status: 'ready', attempt: 1, elapsedMs: 500 });

    renderDashboard();

    expect(screen.queryByTestId('backend-waking-banner')).not.toBeInTheDocument();
    await waitFor(() => expect(stockApi.fetchAllStocks).toHaveBeenCalledTimes(1));
    expect(stockApi.fetchIndexQuotes).toHaveBeenCalledTimes(1);
    expect(stockApi.fetchSectorRotation).toHaveBeenCalledTimes(1);
  });

  it('still proceeds with requests after a wake-up timeout (never blocks the app forever)', async () => {
    useBackendReadiness.mockReturnValue({ status: 'timed-out', attempt: 30, elapsedMs: 75000 });

    renderDashboard();

    await waitFor(() => expect(stockApi.fetchAllStocks).toHaveBeenCalledTimes(1));
  });

  it('one section failing (sector rotation) never blocks the other sections from rendering their own data', async () => {
    useBackendReadiness.mockReturnValue({ status: 'ready', attempt: 1, elapsedMs: 500 });
    stockApi.fetchSectorRotation.mockRejectedValue(new Error('sector service down'));
    stockApi.fetchAllStocks.mockResolvedValue([
      { symbol: 'RELIANCE', ticker: 'RELIANCE', name: 'Reliance Industries', price: 2900, changePct: 1.2 },
    ]);

    renderDashboard();

    await waitFor(() => expect(screen.getByTestId('sector-error')).toBeInTheDocument());
    // Stocks (a different section) still rendered its real data despite the sector failure.
    await waitFor(() => expect(screen.getAllByText('RELIANCE').length).toBeGreaterThan(0));
  });
});
