import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Goals from '@/pages/Goals';

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));
// The installed @radix-ui/react-dialog / react-select in this environment
// reference a subpath ("@radix-ui/primitive/is-development") the installed
// @radix-ui/primitive version doesn't export -- a pre-existing node_modules
// version-skew issue unrelated to this fix. Stubbed with plain passthrough
// components so Goals.jsx's actual state/fetch/render logic (what this test
// suite verifies) can still be exercised without needing that dependency
// resolved.
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <div>{children}</div>,
  DialogTrigger: ({ children }) => <div>{children}</div>,
}));
jest.mock('@/components/ui/select', () => ({
  Select: ({ children }) => <div>{children}</div>,
  SelectContent: ({ children }) => <div>{children}</div>,
  SelectItem: ({ children }) => <div>{children}</div>,
  SelectTrigger: ({ children }) => <div>{children}</div>,
  SelectValue: () => null,
}));
jest.mock('@/services/watchlistApi', () => ({
  getWatchlists: jest.fn(async () => ({ data: [{ id: 'wl-1', symbols: [] }] })),
  addWatchlistSymbol: jest.fn(async () => ({})),
}));
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  LineChart: ({ children }) => <div>{children}</div>,
  Line: () => null,
  Tooltip: () => null,
}));

const GOAL = {
  id: 'goal-1', type: 'wealth_creation', name: 'Test Wealth Goal', targetAmount: 5000000, currentAmount: 100000,
  targetYear: new Date().getFullYear() + 10, monthlyContribution: 15000, isPrimary: true,
};

const ALLOCATION_PLAN = {
  feasibility: { status: 'ON_TRACK' },
  allocation: { equityMutualFundsPct: 40, directEquityPct: 20, debtPct: 20, goldPct: 10, liquidPct: 10 },
  monthlySplit: { total: 15000, equityMutualFundsAmount: 6000, directEquityAmount: 3000, debtAmount: 3000, goldAmount: 1500, liquidAmount: 1500 },
  assumptions: { expectedAnnualReturnPct: 10 },
  methodologyVersion: 'goal-allocation-v1',
  glidepath: [],
  productBuckets: {
    mutualFunds: { items: [{ productId: 'mf-1', name: 'Verified Index Fund', symbol: 'IDX', returns1Y: 14 }], status: 'VERIFIED_CURRENT_PRODUCTS' },
    gold: { items: [{ productId: 'gold-1', name: 'Verified Gold ETF', symbol: 'GOLDETF', returns1Y: 8 }], status: 'VERIFIED_CURRENT_PRODUCTS' },
    debt: { items: [{ productId: 'debt-1', name: 'Verified Debt Fund', symbol: 'DEBTF', returns1Y: 7 }], status: 'VERIFIED_CURRENT_PRODUCTS' },
    liquid: { items: [{ productId: 'liquid-1', name: 'Verified Liquid Fund', symbol: 'LIQF', returns1Y: 6 }], status: 'VERIFIED_CURRENT_PRODUCTS' },
    stocks: { items: [], status: 'AWAITING_FUNDAMENTALS' },
  },
  datasetAsOf: '2026-01-01T00:00:00.000Z',
  confidence: 'HIGH',
};

const STOCK_RECOMMENDATIONS = [
  { symbol: 'TCS', companyName: 'Tata Consultancy Services', goalFitScore: 82, risk: 'MODERATE', price: 3100, sector: 'IT' },
  { symbol: 'INFY', companyName: 'Infosys', goalFitScore: 75, risk: 'MODERATE', price: 1500, sector: 'IT' },
];

const jsonResponse = (data) => Promise.resolve({ ok: true, status: 200, json: async () => data });

function renderGoalsWithSeededGoal() {
  localStorage.setItem('financialGoals', JSON.stringify([GOAL]));
  localStorage.setItem('financialProfile', JSON.stringify({ riskProfile: 'moderate' }));
  return render(<MemoryRouter><Goals /></MemoryRouter>);
}

async function openGoalRecommendationsDialog() {
  renderGoalsWithSeededGoal();
  const planButton = await screen.findByRole('button', { name: /Plan for Test Wealth Goal/i });
  fireEvent.click(planButton);
  // "Load Eligible Stocks" only renders once the allocation plan has loaded.
  await screen.findByRole('button', { name: /Load Eligible Stocks/i });
}

describe('Goals page — Load Eligible Stocks', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('fund/ETF/gold/debt/liquid buckets render from the allocation-plan response and are never touched by stock screening', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/allocation-plan')) return jsonResponse({ success: true, data: ALLOCATION_PLAN });
      return jsonResponse({ success: true, data: { recommendations: [], stocks: [], status: 'UNAVAILABLE', universeCount: 0, evaluatedCount: 0, eligibleCount: 0, rejectionCounts: {}, missingDataReasons: [] } });
    });

    await openGoalRecommendationsDialog();
    expect(await screen.findByText(/Verified Index Fund/)).toBeInTheDocument();
    expect(screen.getByText(/Verified Gold ETF/)).toBeInTheDocument();
    expect(screen.getByText(/Verified Debt Fund/)).toBeInTheDocument();
    expect(screen.getByText(/Verified Liquid Fund/)).toBeInTheDocument();

    // Click "Load Eligible Stocks" (empty/unavailable result) and confirm the
    // fund buckets are still exactly as they were.
    fireEvent.click(screen.getByRole('button', { name: /Load Eligible Stocks/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Load Eligible Stocks/i })).not.toBeDisabled());
    expect(screen.getByText(/Verified Index Fund/)).toBeInTheDocument();
    expect(screen.getByText(/Verified Gold ETF/)).toBeInTheDocument();
  });

  test('button shows a loading state and is disabled while the request is in flight, then shows real stock cards mapped from the response', async () => {
    let resolveRecommendations;
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/allocation-plan')) return jsonResponse({ success: true, data: ALLOCATION_PLAN });
      return new Promise((resolve) => { resolveRecommendations = resolve; });
    });

    await openGoalRecommendationsDialog();
    const button = screen.getByRole('button', { name: /Load Eligible Stocks/i });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: /Screening stocks/i })).toBeDisabled());

    resolveRecommendations({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          recommendations: STOCK_RECOMMENDATIONS, stocks: STOCK_RECOMMENDATIONS, status: 'AVAILABLE',
          universeCount: 2, evaluatedCount: 2, eligibleCount: 2, rejectionCounts: {}, missingDataReasons: [],
        },
      }),
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /Load Eligible Stocks/i })).not.toBeDisabled());
    expect(screen.getByText('TCS')).toBeInTheDocument();
    expect(screen.getByText('INFY')).toBeInTheDocument();
    expect(screen.queryByText(/Awaiting verified product data/i)).not.toBeInTheDocument();
  });

  test('an empty (UNAVAILABLE) result shows the precise backend rejection reasons, not a generic placeholder', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/allocation-plan')) return jsonResponse({ success: true, data: ALLOCATION_PLAN });
      return jsonResponse({
        success: true,
        data: {
          recommendations: [], stocks: [], status: 'UNAVAILABLE', universeCount: 205, evaluatedCount: 200, eligibleCount: 0,
          rejectionCounts: { INSUFFICIENT_HISTORY: 150, AWAITING_FUNDAMENTALS: 40 },
          missingDataReasons: [{ reasonCode: 'INSUFFICIENT_HISTORY', count: 150 }, { reasonCode: 'AWAITING_FUNDAMENTALS', count: 40 }],
        },
      });
    });

    await openGoalRecommendationsDialog();
    fireEvent.click(screen.getByRole('button', { name: /Load Eligible Stocks/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Load Eligible Stocks/i })).not.toBeDisabled());

    expect(await screen.findByText(/lack sufficient verified historical price data/i)).toBeInTheDocument();
    expect(screen.getByText(/awaiting verified fundamentals data/i)).toBeInTheDocument();
  });

  test('a network/HTTP failure shows a precise error and clears only the stock bucket, never the fund buckets', async () => {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/allocation-plan')) return jsonResponse({ success: true, data: ALLOCATION_PLAN });
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    });

    await openGoalRecommendationsDialog();
    fireEvent.click(screen.getByRole('button', { name: /Load Eligible Stocks/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Load Eligible Stocks/i })).not.toBeDisabled());

    expect(await screen.findByText(/Stock screening failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Verified Index Fund/)).toBeInTheDocument(); // fund bucket untouched by the stock-screening failure
  });
});
