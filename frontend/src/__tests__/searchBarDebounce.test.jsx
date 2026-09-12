import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SearchBar from '@/components/SearchBar';
import * as stockApi from '@/services/stockApi';
import { useBackendReadiness } from '@/hooks/useBackendReadiness';

jest.mock('@/services/stockApi', () => ({
  searchStocks: jest.fn(),
}));
jest.mock('@/hooks/useBackendReadiness');

const renderSearchBar = () => render(
  <MemoryRouter>
    <SearchBar />
  </MemoryRouter>,
);

const type = (input, value) => fireEvent.change(input, { target: { value } });

describe('SearchBar debounce, cancellation and stale-result protection', () => {
  beforeEach(() => {
    stockApi.searchStocks.mockReset();
    // Global search shares the same single-flight readiness signal as
    // every other terminal route -- default to 'ready' here so the
    // existing debounce/cancellation behavior below is exercised
    // unchanged; the dedicated 'waking' test further down overrides this.
    useBackendReadiness.mockReturnValue({ status: 'ready', attempt: 1, elapsedMs: 500 });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('never searches for fewer than 2 characters', () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);
    type(input, 'h');
    act(() => { jest.advanceTimersByTime(1000); });
    expect(stockApi.searchStocks).not.toHaveBeenCalled();
  });

  it('waits ~400-500ms after the last keystroke before searching (debounced, not per-keystroke)', () => {
    stockApi.searchStocks.mockResolvedValue([]);
    renderSearchBar();
    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);

    type(input, 'h');
    type(input, 'hd');
    type(input, 'hdf');
    type(input, 'hdfc');

    act(() => { jest.advanceTimersByTime(300); });
    expect(stockApi.searchStocks).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(200); });
    expect(stockApi.searchStocks).toHaveBeenCalledTimes(1);
    expect(stockApi.searchStocks).toHaveBeenCalledWith('hdfc', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('aborts the in-flight request when the query changes again before it resolves', () => {
    stockApi.searchStocks.mockImplementation(() => new Promise(() => {})); // never resolves
    renderSearchBar();
    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);

    type(input, 'ir');
    act(() => { jest.advanceTimersByTime(450); });
    expect(stockApi.searchStocks).toHaveBeenCalledTimes(1);
    const firstSignal = stockApi.searchStocks.mock.calls[0][1].signal;
    expect(firstSignal.aborted).toBe(false);

    type(input, 'irc');
    expect(firstSignal.aborted).toBe(true);
  });

  it('a stale (superseded) response never overwrites the newer query\'s results', async () => {
    let resolveFirst;
    stockApi.searchStocks.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    stockApi.searchStocks.mockImplementationOnce(() => Promise.resolve([{ ticker: 'TCS', name: 'Tata Consultancy Services', sector: 'IT', changePct: 1 }]));

    renderSearchBar();
    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);

    type(input, 'ta');
    act(() => { jest.advanceTimersByTime(450); });

    type(input, 'tcs');
    act(() => { jest.advanceTimersByTime(450); });

    // Second (newer) request resolves first
    await waitFor(() => expect(screen.getByText('TCS')).toBeInTheDocument());

    // The stale first request resolving late must not replace the newer result
    act(() => { resolveFirst([{ ticker: 'STALE', name: 'Should not appear', sector: 'X', changePct: 0 }]); });
    await Promise.resolve();
    expect(screen.queryByText('STALE')).not.toBeInTheDocument();
    expect(screen.getByText('TCS')).toBeInTheDocument();
  });

  it('aborts any in-flight request and clears the debounce timer on unmount', () => {
    stockApi.searchStocks.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderSearchBar();
    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);

    type(input, 'hd');
    act(() => { jest.advanceTimersByTime(450); });
    const signal = stockApi.searchStocks.mock.calls[0][1].signal;

    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('never fires a live search while the shared backend readiness is "waking", even for a valid query', () => {
    useBackendReadiness.mockReturnValue({ status: 'waking', attempt: 2, elapsedMs: 6000 });
    renderSearchBar();
    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);

    type(input, 'hdfc');
    act(() => { jest.advanceTimersByTime(2000); });

    expect(stockApi.searchStocks).not.toHaveBeenCalled();
    expect(screen.getByText(/Backend is starting/i)).toBeInTheDocument();
  });

  it('resumes normal debounced searching once the shared readiness flips from waking to ready', () => {
    useBackendReadiness.mockReturnValue({ status: 'waking', attempt: 2, elapsedMs: 6000 });
    stockApi.searchStocks.mockResolvedValue([]);
    const { rerender } = renderSearchBar();
    const input = screen.getByPlaceholderText(/Search stocks, companies, sectors/i);

    type(input, 'hdfc');
    act(() => { jest.advanceTimersByTime(2000); });
    expect(stockApi.searchStocks).not.toHaveBeenCalled();

    useBackendReadiness.mockReturnValue({ status: 'ready', attempt: 3, elapsedMs: 7000 });
    rerender(<MemoryRouter><SearchBar /></MemoryRouter>);
    act(() => { jest.advanceTimersByTime(450); });
    expect(stockApi.searchStocks).toHaveBeenCalledTimes(1);
  });
});
