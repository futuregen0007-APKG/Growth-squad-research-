import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AnnualFinancialHistory from '@/components/financials/AnnualFinancialHistory';

test('separates basic and diluted EPS, hides unsupported history, and shows bank ratio units and cached fetch time', () => {
  render(<AnnualFinancialHistory snapshot={{ annualSeries: [{ year: 2026, period: 'FY2026', basicEps: 10.2, dilutedEps: 10.1, revenue: 120 }] }} metadata={{
    sections: { incomeStatement: { available: true, fromCache: true, fetchedAt: '2026-10-01T00:00:00Z' } },
    currentRatios: [{ name: 'NIM', companyValue: 3.28, companyValueUnit: 'PERCENT' }, { name: 'CASA', companyValue: 34, companyValueUnit: 'NUMBER' }],
  }} />);
  const table = screen.getByRole('table');
  expect(table).toHaveTextContent('Basic EPS (₹ / share)');
  expect(table).toHaveTextContent('Diluted EPS (₹ / share)');
  expect(table).toHaveTextContent('10.2');
  expect(table).toHaveTextContent('10.1');
  expect(table).toHaveTextContent('cached');
  expect(table).not.toHaveTextContent('EBITDA');
  const ratios = screen.getByTestId('earnings-current-ratios');
  expect(within(ratios).getByText('3.28%')).toBeInTheDocument();
  expect(within(ratios).getByText('34')).toBeInTheDocument();
  expect(ratios).not.toHaveTextContent('34%');
  fireEvent.click(screen.getByRole('button', { name: /Show unavailable metrics/ }));
  expect(table).toHaveTextContent('profit before tax is not EBITDA');
  expect(table).toHaveTextContent('Provider ratios are current observations');
});

test('provider failure displays no annual values and cannot restore historical fallback data', () => {
  render(<AnnualFinancialHistory metadata={{ reason: 'UPSTREAM_UNAVAILABLE' }} />);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByText(/No verified consolidated annual statements/)).toHaveTextContent('UPSTREAM_UNAVAILABLE');
  expect(screen.getByTestId('earnings-current-ratios')).toHaveTextContent('not fetched');
});
