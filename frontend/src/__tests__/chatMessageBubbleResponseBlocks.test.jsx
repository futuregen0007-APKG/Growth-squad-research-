import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatMessageBubble from '@/components/chat/ChatMessageBubble';

/**
 * chatMessageBubbleResponseBlocks.test.jsx
 * ============================================
 * UI Phase 1B: the frontend half of the responseBlocks contract —
 * Markdown-only fallback, safe handling of unknown/invalid block types,
 * no duplicate rendering of the same content, and the five approved block
 * renderers themselves.
 */

const baseAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: 'TCS revenue was ₹240,893 Cr [1].',
  createdAt: new Date().toISOString(),
  citations: [{ evidenceId: 'e1', title: 'TCS filing', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'NSE', publishedAt: '2026-05-01' }],
  ...overrides,
});

const openSources = () => fireEvent.click(screen.getByTestId('sources-section').querySelector('button'));

// -----------------------------------------------------------------------
// Markdown-only fallback
// -----------------------------------------------------------------------

test('with no responseBlocks at all, the message renders Markdown-only -- identical to a pre-Phase-1B message', () => {
  render(<ChatMessageBubble message={baseAssistantMessage()} />);
  expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-metric-grid')).toBeNull();
  expect(screen.queryByTestId('block-comparison-table')).toBeNull();
  expect(screen.queryByTestId('block-data-quality')).toBeNull();
  expect(screen.queryByTestId('block-suggested-questions')).toBeNull();
});

test('with an EMPTY responseBlocks array, the message renders Markdown-only', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [] })} />);
  expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-metric-grid')).toBeNull();
});

test('a MALFORMED block (missing required fields) is silently ignored -- falls back to Markdown-only for that block', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'metric_grid', symbol: 'TCS', metrics: [] }], // empty metrics -- invalid per isValidMetricGridBlock
  })}
  />);
  expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-metric-grid')).toBeNull();
});

test('an UNKNOWN block type is ignored safely -- no crash, nothing rendered for it, Markdown still shows', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'chart', symbol: 'TCS', series: [1, 2, 3] }], // not an approved Phase 1B type
  })}
  />);
  expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument();
  // No element in the closed registry renders for an unrecognized type.
  expect(screen.queryByTestId(/^block-/)).toBeNull();
});

test('a non-array responseBlocks value (defensive: a malformed payload) never crashes the component', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: 'not-an-array' })} />);
  expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument();
});

// -----------------------------------------------------------------------
// No duplicate Markdown rendering
// -----------------------------------------------------------------------

test('the Markdown answer text appears EXACTLY ONCE even when every block type is present', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [
      { type: 'metric_grid', symbol: 'TCS', metrics: [{ metric: 'REVENUE', label: 'Revenue', value: 240893, unit: 'INR_CRORE', period: 'FY2024', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] }] },
      { type: 'source_list', sources: [{ evidenceId: 'e1', citationIndex: 1, title: 'TCS filing', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'NSE', publishedAt: null, reportingPeriod: null }] },
      { type: 'data_quality', groundingStatus: 'grounded', unmatchedRequestedPeriods: [], valuationGaps: [], limitations: [] },
      { type: 'suggested_questions', questions: ['What is TCS margin?'] },
    ],
  })}
  />);
  expect(screen.getAllByText(/TCS revenue was ₹240,893 Cr/)).toHaveLength(1);
});

test('source_list does not duplicate the existing SourcesSection -- exactly one sources list is shown', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'source_list', sources: [{ evidenceId: 'e1', citationIndex: 1, title: 'TCS filing', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'NSE', publishedAt: null, reportingPeriod: null }] }],
  })}
  />);
  expect(screen.getByTestId('sources-section')).toBeInTheDocument();
  expect(screen.queryByTestId('block-source-list')).toBeNull(); // registered, but not mounted here -- see SourceListBlock's own note
  openSources();
  expect(screen.getAllByText('TCS filing')).toHaveLength(1);
});

// -----------------------------------------------------------------------
// metric_grid
// -----------------------------------------------------------------------

test('a valid metric_grid block renders each metric with its formatted value and citation number', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{
      type: 'metric_grid', symbol: 'TCS',
      metrics: [{ metric: 'REVENUE', label: 'Revenue', value: 240893, unit: 'INR_CRORE', period: 'FY2024', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] }],
    }],
  })}
  />);
  const grid = screen.getByTestId('block-metric-grid');
  expect(grid).toHaveTextContent('₹2,40,893 Cr');
  expect(grid).toHaveTextContent('[1]');
  expect(grid).toHaveTextContent('Revenue');
  expect(grid).toHaveTextContent('FY2024');
});

// -----------------------------------------------------------------------
// comparison_table
// -----------------------------------------------------------------------

test('a valid comparison_table block renders a real table with one column per symbol', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{
      type: 'comparison_table',
      symbols: ['HDFCBANK', 'ICICIBANK'],
      rows: [{
        metric: 'NIM', label: 'Net interest margin (NIM)', commonPeriod: 'FY2024', comparable: true,
        values: {
          HDFCBANK: { value: 4, unit: 'PERCENTAGE', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] },
          ICICIBANK: { value: 4.78, unit: 'PERCENTAGE', evidence: [{ evidenceId: 'e2', citationIndex: 2 }] },
        },
      }],
    }],
  })}
  />);
  const table = screen.getByTestId('block-comparison-table');
  expect(table.querySelector('table')).toBeTruthy();
  expect(table).toHaveTextContent('HDFCBANK');
  expect(table).toHaveTextContent('ICICIBANK');
  expect(table).toHaveTextContent('4%');
  expect(table).toHaveTextContent('4.78%');
});

test('a comparison_table row missing a company\'s cell renders an em dash, never a guessed value', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{
      type: 'comparison_table', symbols: ['TCS', 'INFY'],
      rows: [{ metric: 'ROE', label: 'Return on equity', commonPeriod: null, comparable: false, values: { TCS: { value: 17, unit: 'PERCENTAGE', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] } } }],
    }],
  })}
  />);
  expect(screen.getByTestId('block-comparison-table')).toHaveTextContent('—');
});

// -----------------------------------------------------------------------
// data_quality replaces the old GroundingStatusBadge, additively
// -----------------------------------------------------------------------

test('a valid data_quality block REPLACES the old grounding-status badge element (grounding-status testid absent, block testid present)', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    groundingStatus: 'grounded',
    responseBlocks: [{ type: 'data_quality', groundingStatus: 'grounded', unmatchedRequestedPeriods: ['FY2015'], valuationGaps: [], limitations: [] }],
  })}
  />);
  expect(screen.queryByTestId('grounding-status')).toBeNull();
  const block = screen.getByTestId('block-data-quality');
  expect(block).toHaveTextContent(/verified from documents/i);
  expect(block).toHaveTextContent('FY2015');
});

test('without a data_quality block, the ORIGINAL grounding-status badge renders exactly as before Phase 1B', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ groundingStatus: 'partially_grounded', coverage: { limitations: ['x'] } })} />);
  expect(screen.getByTestId('grounding-status')).toHaveTextContent(/partially verified/i);
  expect(screen.queryByTestId('block-data-quality')).toBeNull();
});

test('data_quality surfaces valuation gaps, which the old badge never had access to', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'data_quality', groundingStatus: null, unmatchedRequestedPeriods: [], valuationGaps: [{ symbol: 'HAL', metric: 'PE', reason: 'no per-share earnings are held' }], limitations: [] }],
  })}
  />);
  const block = screen.getByTestId('block-data-quality');
  expect(block).toHaveTextContent('HAL');
  expect(block).toHaveTextContent('PE');
  expect(block).toHaveTextContent('no per-share earnings are held');
});

// -----------------------------------------------------------------------
// suggested_questions — placed below the response
// -----------------------------------------------------------------------

test('suggested_questions renders below sources and the copy/regenerate row -- literally last in the DOM', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'suggested_questions', questions: ['What is TCS margin?', 'How does TCS compare to INFY?'] }],
  })}
  />);
  const bubble = screen.getByTestId('msg-assistant');
  const suggested = screen.getByTestId('block-suggested-questions');
  const sources = screen.getByTestId('sources-section');
  const copyButton = screen.getByTestId('copy-response');

  const positionOf = (el) => Array.from(bubble.querySelectorAll('*')).indexOf(el);
  expect(positionOf(suggested)).toBeGreaterThan(positionOf(sources));
  expect(positionOf(suggested)).toBeGreaterThan(positionOf(copyButton));
});

test('clicking a suggested question calls onAskSuggestedQuestion with its exact text', () => {
  const onAsk = jest.fn();
  render(<ChatMessageBubble
    message={baseAssistantMessage({ responseBlocks: [{ type: 'suggested_questions', questions: ['What is TCS margin?'] }] })}
    onAskSuggestedQuestion={onAsk}
  />);
  fireEvent.click(screen.getByTestId('suggested-question'));
  expect(onAsk).toHaveBeenCalledWith('What is TCS margin?');
});

test('without an onAskSuggestedQuestion handler, the chips still render but are disabled rather than throwing on click', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ responseBlocks: [{ type: 'suggested_questions', questions: ['What is TCS margin?'] }] })} />);
  const chip = screen.getByTestId('suggested-question');
  expect(chip).toBeDisabled();
});

// -----------------------------------------------------------------------
// Never dangerouslySetInnerHTML / injected markup
// -----------------------------------------------------------------------

test('a metric label containing HTML-looking text is rendered as plain text, never interpreted as markup', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{
      type: 'metric_grid', symbol: 'TCS',
      metrics: [{ metric: 'X', label: '<img src=x onerror=alert(1)>', value: 1, unit: null, period: null, evidence: [{ evidenceId: 'e1', citationIndex: 1 }] }],
    }],
  })}
  />);
  expect(screen.getByTestId('block-metric-grid').querySelector('img')).toBeNull();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
});

// -----------------------------------------------------------------------
// After thread reload — the message object below is shaped EXACTLY as
// chatApi.getThread()'s response is passed straight through (AIResearch.jsx's
// loadThreadMessages does `setMessages(data.messages)`, no transform;
// controllers/ChatController.js's getUserThread returns
// services/ChatThreadService.js's getThread() output unchanged), and
// getThread's own backend test
// (tests/chatMessageResponseBlocksPersistence.test.js) already proves this
// is BYTE-IDENTICAL to a live message.completed SSE payload — including a
// real round trip against the actual configured MongoDB. This suite proves
// the OTHER half: given that exact shape, the blocks genuinely render and
// remain functional, not just "parse without crashing."
// -----------------------------------------------------------------------

const reloadedMessage = (overrides = {}) => ({
  _id: 'msg-1',
  role: 'assistant',
  content: 'TCS revenue was ₹240,893 Cr [1].',
  status: 'COMPLETE',
  citations: [{ evidenceId: 'e1', title: 'TCS filing', sourceUrl: 'https://nsearchives.nseindia.com/x.xml', provider: 'NSE', publishedAt: '2026-05-01' }],
  createdAt: '2026-05-01T00:00:00.000Z',
  ...overrides,
});

test('after reload: a metric_grid block renders with the same value/citation as it would live', () => {
  render(<ChatMessageBubble message={reloadedMessage({
    responseBlocks: [{
      type: 'metric_grid', symbol: 'TCS',
      metrics: [{ metric: 'REVENUE', label: 'Revenue', value: 240893, unit: 'INR_CRORE', period: 'FY2024', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] }],
    }],
  })}
  />);
  const grid = screen.getByTestId('block-metric-grid');
  expect(grid).toHaveTextContent('₹2,40,893 Cr');
  expect(grid).toHaveTextContent('[1]');
});

test('after reload: a comparison_table block renders its object-keyed-by-symbol values correctly (the exact shape fromPersistedResponseBlocks produces)', () => {
  render(<ChatMessageBubble message={reloadedMessage({
    content: 'HDFCBANK and ICICIBANK NIM compared [1][2].',
    citations: [
      { evidenceId: 'e1', title: 'HDFC filing', sourceUrl: 'https://nsearchives.nseindia.com/a.xml', provider: 'NSE', publishedAt: null },
      { evidenceId: 'e2', title: 'ICICI filing', sourceUrl: 'https://nsearchives.nseindia.com/b.xml', provider: 'NSE', publishedAt: null },
    ],
    responseBlocks: [{
      type: 'comparison_table',
      symbols: ['HDFCBANK', 'ICICIBANK'],
      rows: [{
        metric: 'NIM', label: 'Net interest margin (NIM)', commonPeriod: 'FY2024', comparable: true,
        // This is the reconstructed shape fromPersistedResponseBlock produces
        // (Object.fromEntries over the persisted array-of-{symbol,...}) --
        // an object keyed by symbol, not the Mongoose array form.
        values: {
          HDFCBANK: { value: 4, unit: 'PERCENTAGE', evidence: [{ evidenceId: 'e1', citationIndex: 1 }] },
          ICICIBANK: { value: 4.78, unit: 'PERCENTAGE', evidence: [{ evidenceId: 'e2', citationIndex: 2 }] },
        },
      }],
    }],
  })}
  />);
  const table = screen.getByTestId('block-comparison-table');
  expect(table).toHaveTextContent('4%');
  expect(table).toHaveTextContent('4.78%');
});

test('after reload: suggested_questions still renders and is fully clickable (not a live-only feature)', () => {
  const onAsk = jest.fn();
  render(<ChatMessageBubble
    message={reloadedMessage({ responseBlocks: [{ type: 'suggested_questions', questions: ['What is TCS margin?', 'How does TCS compare to INFY?'] }] })}
    onAskSuggestedQuestion={onAsk}
  />);
  const chips = screen.getAllByTestId('suggested-question');
  expect(chips).toHaveLength(2);
  fireEvent.click(chips[1]);
  expect(onAsk).toHaveBeenCalledWith('How does TCS compare to INFY?');
});

test('after reload: a LEGACY message with no responseBlocks field at all (pre-Phase-1B history) still renders Markdown-only, no crash', () => {
  const legacyMessage = reloadedMessage();
  delete legacyMessage.responseBlocks; // pre-Phase-1B persisted messages genuinely lack this field
  render(<ChatMessageBubble message={legacyMessage} />);
  expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument();
  expect(screen.queryByTestId(/^block-/)).toBeNull();
});
