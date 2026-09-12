import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PopularStocksRail from '@/components/widgets/PopularStocksRail';

describe('Dashboard market pulse', () => {
  const stocks = [
    { symbol: 'RELIANCE', name: 'Reliance Industries', price: 2900, change: 35, changePct: 1.2, dayLow: 2860, dayHigh: 2940, marketCap: '₹18.5T', pe: 24.3, sector: 'Energy', volume: 4125000 },
    { symbol: 'TCS', name: 'Tata Consultancy Services', price: 3650, change: -20, changePct: -0.5, dayLow: 3625, dayHigh: 3695, marketCap: '₹12.3T', pe: 26.1, sector: 'IT', volume: 2240000 },
  ];

  it('renders a popular stocks rail after the sensex section', async () => {
    render(
      <MemoryRouter>
        <PopularStocksRail stocks={stocks} watchlistSymbols={[]} onSelectSymbol={() => {}} onToggleWatchlist={() => {}} />
      </MemoryRouter>
    );

    expect(screen.getByText(/MARKET INDICES \| POPULAR STOCKS/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /toggle details for reliance/i })).toBeInTheDocument();
  });

  it('flips a stock card on click', async () => {
    render(
      <MemoryRouter>
        <PopularStocksRail stocks={stocks} watchlistSymbols={[]} onSelectSymbol={() => {}} onToggleWatchlist={() => {}} />
      </MemoryRouter>
    );

    const card = screen.getByRole('button', { name: /toggle details for reliance/i });
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');
  });
});
