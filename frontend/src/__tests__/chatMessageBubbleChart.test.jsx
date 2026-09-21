import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatMessageBubble from '@/components/chat/ChatMessageBubble';

/**
 * chatMessageBubbleChart.test.jsx
 * ===================================
 * UI Phase 1C.3: the `chart` responseBlock — a bounded historical daily-
 * close line chart for a single symbol. recharts is mocked (the same
 * technique src/__tests__/goalsLoadEligibleStocks.test.jsx already uses)
 * since jsdom gives ResponsiveContainer a zero-size box and recharts
 * renders nothing meaningful inside it — these tests verify OUR wiring
 * (what data reaches the chart, the citation/gap/range framing, the
 * accessible data-table alternative), not recharts' own SVG rendering.
 */
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  LineChart: ({ children, data }) => <div data-testid="line-chart" data-points={data?.length}>{children}</div>,
  Line: ({ data }) => <div data-testid="chart-line-segment" data-points={data?.length} />,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

const baseAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: "Here's TCS's price history chart [1].",
  createdAt: new Date().toISOString(),
  citations: [{ evidenceId: 'e1', title: 'TCS share-price history (NSE)', sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv', provider: 'NSE_BHAVCOPY', publishedAt: '2026-08-06' }],
  ...overrides,
});

const point = (date, close, gapBefore = false) => ({ date, close, gapBefore });

const CHART_BLOCK = {
  type: 'chart',
  version: 1,
  symbol: 'TCS',
  currency: 'INR',
  priceBasis: 'NOT_REQUIRED',
  points: [point('2026-08-01', 100), point('2026-08-02', 101), point('2026-08-03', 102)],
  rangeStart: '2026-08-01',
  rangeEnd: '2026-08-03',
  requestedRangeDays: null,
  provider: 'NSE_BHAVCOPY',
  sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv',
  dataAsOf: '2026-08-03',
  evidence: [{ evidenceId: 'e1', citationIndex: 1 }],
};

// -----------------------------------------------------------------------
// Valid rendering
// -----------------------------------------------------------------------

test('a valid chart block renders the symbol, range, price basis and a citation marker', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [CHART_BLOCK] })} />);
  const block = screen.getByTestId('block-chart');
  expect(block).toHaveTextContent('TCS');
  expect(block).toHaveTextContent('not adjusted for corporate actions');
  expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '3');
});

test('the trading-day point count is stated explicitly, separate from the calendar range -- a sparse trading calendar is not a data gap', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [CHART_BLOCK] })} />);
  expect(screen.getByTestId('block-chart')).toHaveTextContent('3 trading-day closes');
});

test('a chart with no gaps renders exactly one line segment carrying every point', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [CHART_BLOCK] })} />);
  const segments = screen.getAllByTestId('chart-line-segment');
  expect(segments).toHaveLength(1);
  expect(segments[0]).toHaveAttribute('data-points', '3');
});

test('a chart with a known gap renders it as a BREAK -- two separate line segments, never one connecting them', () => {
  const withGap = {
    ...CHART_BLOCK,
    points: [point('2026-08-01', 100), point('2026-08-02', 101), point('2026-08-06', 105, true)],
    rangeEnd: '2026-08-06',
  };
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [withGap] })} />);
  const segments = screen.getAllByTestId('chart-line-segment');
  expect(segments).toHaveLength(2);
  expect(screen.getByTestId('chart-gap-note')).toHaveTextContent('1 data gap');
});

test('a chart with no gaps shows no gap note', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [CHART_BLOCK] })} />);
  expect(screen.queryByTestId('chart-gap-note')).toBeNull();
});

// -----------------------------------------------------------------------
// Accessible data-table alternative
// -----------------------------------------------------------------------

test('the data table is hidden by default and shows real date/close rows once toggled', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [CHART_BLOCK] })} />);
  expect(screen.queryByTestId('chart-data-table')).toBeNull();
  fireEvent.click(screen.getByTestId('chart-table-toggle'));
  const table = screen.getByTestId('chart-data-table');
  expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
  expect(table).toHaveTextContent('100.00');
  fireEvent.click(screen.getByTestId('chart-table-toggle'));
  expect(screen.queryByTestId('chart-data-table')).toBeNull();
});

// -----------------------------------------------------------------------
// Requested vs. available range honesty
// -----------------------------------------------------------------------

test('when the real range is materially narrower than what was requested, an honest note says so', () => {
  const narrow = { ...CHART_BLOCK, requestedRangeDays: 365 }; // asked for a year, only 3 days of data exist
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [narrow] })} />);
  expect(screen.getByTestId('chart-range-note')).toHaveTextContent(/available history/i);
});

test('when no explicit range was requested, no range note is shown', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [CHART_BLOCK] })} />);
  expect(screen.queryByTestId('chart-range-note')).toBeNull();
});

// -----------------------------------------------------------------------
// Invalid / degenerate blocks degrade safely
// -----------------------------------------------------------------------

test('a chart block with fewer than 2 points is ignored -- Markdown-only fallback preserved', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ ...CHART_BLOCK, points: [point('2026-08-01', 100)] }],
  })}
  />);
  expect(screen.getByText(/Here's TCS's price history chart/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-chart')).toBeNull();
});

test('a chart block with a non-finite close is ignored entirely by the frontend guard (defense in depth)', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ ...CHART_BLOCK, points: [point('2026-08-01', NaN), point('2026-08-02', 101)] }],
  })}
  />);
  expect(screen.queryByTestId('block-chart')).toBeNull();
});

test('a chart block with a malformed date is ignored entirely by the frontend guard', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ ...CHART_BLOCK, points: [point('not-a-date', 100), point('2026-08-02', 101)] }],
  })}
  />);
  expect(screen.queryByTestId('block-chart')).toBeNull();
});

test('an invalid chart block does not prevent other valid blocks from rendering', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [
      { ...CHART_BLOCK, points: [] },
      { type: 'suggested_questions', questions: ['What is TCS margin?'] },
    ],
  })}
  />);
  expect(screen.queryByTestId('block-chart')).toBeNull();
  expect(screen.getByTestId('block-suggested-questions')).toBeInTheDocument();
});

// -----------------------------------------------------------------------
// Exactly-once rendering
// -----------------------------------------------------------------------

test('chart renders exactly once even alongside company_header, data_quality and suggested_questions', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    groundingStatus: 'grounded',
    responseBlocks: [
      { type: 'company_header', symbol: 'TCS', companyName: 'Tata Consultancy Services', sector: null, exchange: null, price: null },
      { type: 'data_quality', groundingStatus: 'grounded', unmatchedRequestedPeriods: [], valuationGaps: [], limitations: [] },
      CHART_BLOCK,
      { type: 'suggested_questions', questions: ['What is TCS margin?'] },
    ],
  })}
  />);
  expect(screen.getAllByTestId('block-chart')).toHaveLength(1);
});

// -----------------------------------------------------------------------
// Evidence-drawer citation-click integration.
// -----------------------------------------------------------------------

test('clicking the chart\'s citation marker opens the evidence drawer at the matching entry', async () => {
  const evidenceDrawerBlock = {
    type: 'evidence_drawer',
    entries: [{
      evidenceId: 'e1', citationIndex: 1, title: 'TCS share-price history (NSE)', excerpt: 'PRICE_HISTORY: 3 points, INR, NSE_BHAVCOPY, NOT_REQUIRED (2026-08-01 to 2026-08-03)',
      sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv', provider: 'NSE_BHAVCOPY', publishedAt: '2026-08-03', reportingPeriod: null,
      documentType: null, pageStart: null, pageEnd: null, temporalStatus: null, canonicalGuidance: null,
    }],
  };
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [evidenceDrawerBlock, CHART_BLOCK],
  })}
  />);
  const marker = screen.getByTestId('block-chart').querySelector('[data-testid="citation-marker"]');
  expect(marker).toBeTruthy();
  fireEvent.click(marker);
  await waitFor(() => expect(screen.getByTestId('evidence-drawer')).toBeInTheDocument());
  expect(screen.getByTestId('evidence-drawer-highlighted-entry')).toHaveTextContent('TCS share-price history');
});

test('a chart with no matching evidence_drawer block still renders a plain, inert [N] (no drawer to open)', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [CHART_BLOCK] })} />);
  expect(screen.getByTestId('block-chart').querySelector('[data-testid="citation-marker"]')).toBeNull();
  expect(screen.getByTestId('block-chart').querySelector('sup')).toBeTruthy();
});

// -----------------------------------------------------------------------
// Legacy-message fallback and post-reload parity.
// -----------------------------------------------------------------------

test('a legacy message (no responseBlocks field at all) renders Markdown-only, no chart, no crash', () => {
  const legacyMessage = baseAssistantMessage();
  delete legacyMessage.responseBlocks;
  render(<ChatMessageBubble message={legacyMessage} />);
  expect(screen.getByText(/Here's TCS's price history chart/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-chart')).toBeNull();
});

test('after reload: a chart block renders identically from the persisted/reloaded shape', () => {
  const reloadedMessage = {
    _id: 'msg-1', role: 'assistant', content: "Here's TCS's price history chart [1].", status: 'COMPLETE',
    citations: [{ evidenceId: 'e1', title: 'TCS share-price history (NSE)', sourceUrl: 'https://nsearchives.nseindia.com/bhavcopy.csv', provider: 'NSE_BHAVCOPY', publishedAt: '2026-08-06' }],
    createdAt: '2026-08-06T00:00:00.000Z',
    responseBlocks: [CHART_BLOCK],
  };
  render(<ChatMessageBubble message={reloadedMessage} />);
  const block = screen.getByTestId('block-chart');
  expect(block).toHaveTextContent('TCS');
  expect(screen.getByTestId('line-chart')).toHaveAttribute('data-points', '3');
});
