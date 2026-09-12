import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Layout from '@/components/layout/Layout';
import { AuthProvider } from '@/hooks/useAuth';
import { useBackendReadiness } from '@/hooks/useBackendReadiness';

jest.mock('@/hooks/useBackendReadiness');
jest.mock('@/services/stockApi', () => ({
  fetchAllStocks: jest.fn().mockResolvedValue([]),
  searchStocks: jest.fn(),
}));
// CommandPalette (via cmdk) and the mobile-nav Sheet (via
// @/components/ui/sheet) both ultimately import @radix-ui/react-dialog,
// whose installed version has a package "exports" map Jest's resolver
// can't follow in this environment -- a pre-existing dependency/tooling
// issue unrelated to the readiness gate under test here. Mocked out
// exactly like stockDetail.test.jsx already mocks other unrelated child
// components.
jest.mock('@/components/layout/CommandPalette', () => () => null);
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }) => <>{children}</>,
  SheetContent: ({ children }) => <>{children}</>,
  SheetTitle: ({ children }) => <>{children}</>,
  SheetDescription: ({ children }) => <>{children}</>,
}));

const DummyPage = () => <div data-testid="dummy-page">Dummy terminal route content</div>;

const renderAtRoute = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <AuthProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<DummyPage />} />
          <Route path="/goals" element={<DummyPage />} />
          <Route path="/stock/:ticker" element={<DummyPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  </MemoryRouter>,
);

/**
 * Layout wraps every terminal route (Dashboard, Goals, Earnings, Stock
 * Detail, Search, ...) -- this is the ONE shared place the readiness gate
 * needs to live so no individual page has to re-implement it. These tests
 * render three different routes through the same Layout to confirm the
 * gate is genuinely route-independent, not something that only happens to
 * work for Dashboard.
 */
describe('Layout readiness gate (shared across every terminal route)', () => {
  it('shows the shared "Starting backend service..." screen and never renders the routed page while waking, on /dashboard', () => {
    useBackendReadiness.mockReturnValue({ status: 'waking', attempt: 1, elapsedMs: 4000 });
    renderAtRoute('/dashboard');
    expect(screen.getByTestId('backend-waking-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('dummy-page')).not.toBeInTheDocument();
  });

  it('shows the same shared screen on /goals (a different terminal route, same Layout)', () => {
    useBackendReadiness.mockReturnValue({ status: 'waking', attempt: 1, elapsedMs: 4000 });
    renderAtRoute('/goals');
    expect(screen.getByTestId('backend-waking-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('dummy-page')).not.toBeInTheDocument();
  });

  it('shows the same shared screen on /stock/:ticker as well', () => {
    useBackendReadiness.mockReturnValue({ status: 'waking', attempt: 1, elapsedMs: 4000 });
    renderAtRoute('/stock/INFY');
    expect(screen.getByTestId('backend-waking-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('dummy-page')).not.toBeInTheDocument();
  });

  it('renders the routed page (and the market ticker) once readiness reports ready', () => {
    useBackendReadiness.mockReturnValue({ status: 'ready', attempt: 1, elapsedMs: 500 });
    renderAtRoute('/dashboard');
    expect(screen.queryByTestId('backend-waking-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('dummy-page')).toBeInTheDocument();
    expect(screen.getByTestId('market-ticker')).toBeInTheDocument();
  });

  it('also renders the routed page after a wake-up timeout (never blocks the app forever)', () => {
    useBackendReadiness.mockReturnValue({ status: 'timed-out', attempt: 30, elapsedMs: 75000 });
    renderAtRoute('/dashboard');
    expect(screen.queryByTestId('backend-waking-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('dummy-page')).toBeInTheDocument();
  });
});
