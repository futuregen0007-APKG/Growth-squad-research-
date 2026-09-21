import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatMessageBubble from '@/components/chat/ChatMessageBubble';

/**
 * chatMessageBubbleNewsList.test.jsx
 * ======================================
 * UI Phase 1C.2: news_list — up to 5 real, cited news cards rendered from
 * existing news-service/tool evidence only (no summary/description field
 * exists on the block at all; see NewsArticleSchema's own note). These
 * tests cover the frontend half: valid rendering, the same "Date
 * unavailable"/"Unknown source" honesty rules News.jsx already uses,
 * graceful degradation for invalid blocks, no duplicate rendering, and
 * the evidence-drawer citation-click integration on a news card.
 */

const baseAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: 'TCS won a major BFSI deal [1].',
  createdAt: new Date().toISOString(),
  citations: [{ evidenceId: 'e1', title: 'TCS wins major BFSI deal', sourceUrl: 'https://reuters.com/tcs-deal', provider: 'Reuters', publishedAt: '2026-09-01T00:00:00.000Z' }],
  ...overrides,
});

const ARTICLE = {
  evidenceId: 'e1', citationIndex: 1, symbol: 'TCS', title: 'TCS wins major BFSI deal',
  url: 'https://reuters.com/tcs-deal', publisher: 'Reuters', publishedAt: '2026-09-01T00:00:00.000Z',
  imageUrl: 'https://reuters.com/img.jpg',
};

// -----------------------------------------------------------------------
// Valid rendering
// -----------------------------------------------------------------------

test('a valid news_list block renders a card with headline, publisher, date and thumbnail', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [ARTICLE] }],
  })}
  />);
  const block = screen.getByTestId('block-news-list');
  expect(block).toHaveTextContent('TCS wins major BFSI deal');
  expect(block).toHaveTextContent('Reuters');
  const card = screen.getByTestId('news-card');
  const img = card.querySelector('img');
  expect(img).toHaveAttribute('src', 'https://reuters.com/img.jpg');
  expect(img).toHaveAttribute('loading', 'lazy');
  expect(img).toHaveAttribute('referrerPolicy', 'no-referrer');
});

test('clicking a news card opens the original article in a new tab, safely', () => {
  const openSpy = jest.spyOn(window, 'open').mockImplementation(() => {});
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [ARTICLE] }],
  })}
  />);
  fireEvent.click(screen.getByTestId('news-card'));
  expect(openSpy).toHaveBeenCalledWith('https://reuters.com/tcs-deal', '_blank', 'noopener,noreferrer');
  openSpy.mockRestore();
});

test('renders one card per article, in the order given, up to whatever the backend already capped/deduped', () => {
  const second = { ...ARTICLE, evidenceId: 'e2', citationIndex: 2, title: 'TCS opens new delivery center', url: 'https://reuters.com/tcs-center', imageUrl: null };
  render(<ChatMessageBubble message={baseAssistantMessage({
    citations: [
      { evidenceId: 'e1', title: 'TCS wins major BFSI deal', sourceUrl: 'https://reuters.com/tcs-deal', provider: 'Reuters', publishedAt: '2026-09-01T00:00:00.000Z' },
      { evidenceId: 'e2', title: 'TCS opens new delivery center', sourceUrl: 'https://reuters.com/tcs-center', provider: 'Reuters', publishedAt: '2026-09-02T00:00:00.000Z' },
    ],
    responseBlocks: [{ type: 'news_list', articles: [ARTICLE, second] }],
  })}
  />);
  expect(screen.getAllByTestId('news-card')).toHaveLength(2);
});

// -----------------------------------------------------------------------
// Honesty rules: missing image / date / publisher are shown as missing,
// never substituted (mirrors src/pages/News.jsx's own NewsCard rules).
// -----------------------------------------------------------------------

test('an article with no imageUrl shows the no-image fallback, never a broken/placeholder img', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [{ ...ARTICLE, imageUrl: null }] }],
  })}
  />);
  expect(screen.getByTestId('news-card').querySelector('img')).toBeNull();
  expect(screen.getByTestId('news-card-no-image')).toBeInTheDocument();
});

test('an image that fails to load falls back to the no-image state instead of showing a broken icon', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [ARTICLE] }],
  })}
  />);
  const img = screen.getByTestId('news-card').querySelector('img');
  fireEvent.error(img);
  expect(screen.getByTestId('news-card').querySelector('img')).toBeNull();
  expect(screen.getByTestId('news-card-no-image')).toBeInTheDocument();
});

test('an article with no publishedAt shows "Date unavailable" -- never substitutes today\'s date', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [{ ...ARTICLE, publishedAt: null }] }],
  })}
  />);
  expect(screen.getByTestId('news-card')).toHaveTextContent('Date unavailable');
});

test('an article with no publisher shows "Unknown source" rather than a blank field', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [{ ...ARTICLE, publisher: null }] }],
  })}
  />);
  expect(screen.getByTestId('news-card')).toHaveTextContent('Unknown source');
});

// -----------------------------------------------------------------------
// Invalid / empty blocks degrade safely -- the Markdown answer is
// unaffected either way.
// -----------------------------------------------------------------------

test('a news_list block with an empty articles array is ignored -- Markdown-only fallback preserved', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [] }],
  })}
  />);
  expect(screen.getByText(/TCS won a major BFSI deal/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-news-list')).toBeNull();
});

test('a news_list block whose article is missing a required field (url) is ignored entirely, not rendered with a broken link', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [{ ...ARTICLE, url: null }] }],
  })}
  />);
  expect(screen.getByText(/TCS won a major BFSI deal/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-news-list')).toBeNull();
});

test('a news_list block with an unsafe article URL (e.g. javascript:) is ignored entirely', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [{ ...ARTICLE, url: 'javascript:alert(1)' }] }],
  })}
  />);
  expect(screen.getByText(/TCS won a major BFSI deal/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-news-list')).toBeNull();
});

test('an invalid news_list block does not prevent other valid blocks from rendering', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [
      { type: 'news_list', articles: [] },
      { type: 'suggested_questions', questions: ['What is TCS margin?'] },
    ],
  })}
  />);
  expect(screen.queryByTestId('block-news-list')).toBeNull();
  expect(screen.getByTestId('block-suggested-questions')).toBeInTheDocument();
});

// -----------------------------------------------------------------------
// No duplicate rendering -- news_list must appear at exactly one of
// ChatMessageBubble's three ResponseBlocksRenderer call sites.
// -----------------------------------------------------------------------

test('news_list renders exactly once even though it is a valid block alongside company_header, data_quality and suggested_questions', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    groundingStatus: 'grounded',
    responseBlocks: [
      { type: 'company_header', symbol: 'TCS', companyName: 'Tata Consultancy Services', sector: null, exchange: null, price: null },
      { type: 'data_quality', groundingStatus: 'grounded', unmatchedRequestedPeriods: [], valuationGaps: [], limitations: [] },
      { type: 'news_list', articles: [ARTICLE] },
      { type: 'suggested_questions', questions: ['What is TCS margin?'] },
    ],
  })}
  />);
  expect(screen.getAllByTestId('block-news-list')).toHaveLength(1);
  expect(screen.getAllByTestId('news-card')).toHaveLength(1);
});

// -----------------------------------------------------------------------
// Evidence-drawer citation-click integration -- a news card's [N] opens
// the SAME drawer entry SourcesSection's own [N] does.
// -----------------------------------------------------------------------

test('clicking a news card\'s citation marker opens the evidence drawer WITHOUT also navigating to the article', async () => {
  const openSpy = jest.spyOn(window, 'open').mockImplementation(() => {});
  const evidenceDrawerBlock = {
    type: 'evidence_drawer',
    entries: [{
      evidenceId: 'e1', citationIndex: 1, title: 'TCS wins major BFSI deal', excerpt: 'TCS announced a multi-year BFSI deal.',
      sourceUrl: 'https://reuters.com/tcs-deal', provider: 'Reuters', publishedAt: '2026-09-01T00:00:00.000Z', reportingPeriod: null,
      documentType: 'NEWS_ARTICLE', pageStart: null, pageEnd: null, temporalStatus: null, canonicalGuidance: null,
    }],
  };
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [evidenceDrawerBlock, { type: 'news_list', articles: [ARTICLE] }],
  })}
  />);
  const marker = screen.getByTestId('block-news-list').querySelector('[data-testid="citation-marker"]');
  expect(marker).toBeTruthy();
  fireEvent.click(marker);

  await waitFor(() => expect(screen.getByTestId('evidence-drawer')).toBeInTheDocument());
  expect(screen.getByTestId('evidence-drawer-highlighted-entry')).toHaveTextContent('TCS wins major BFSI deal');
  expect(openSpy).not.toHaveBeenCalled();
  openSpy.mockRestore();
});

test('a news card with no matching evidence_drawer block still renders a plain, inert [N] (no drawer to open)', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    responseBlocks: [{ type: 'news_list', articles: [ARTICLE] }],
  })}
  />);
  const marker = screen.getByTestId('block-news-list').querySelector('sup');
  expect(marker).toBeTruthy();
  expect(screen.getByTestId('block-news-list').querySelector('[data-testid="citation-marker"]')).toBeNull();
});

// -----------------------------------------------------------------------
// Legacy-message fallback -- pre-Phase-1C.2 persisted messages lack
// responseBlocks entirely, or lack news_list specifically.
// -----------------------------------------------------------------------

test('a legacy message (no responseBlocks field at all) renders Markdown-only, no news card, no crash', () => {
  const legacyMessage = baseAssistantMessage();
  delete legacyMessage.responseBlocks;
  render(<ChatMessageBubble message={legacyMessage} />);
  expect(screen.getByText(/TCS won a major BFSI deal/)).toBeInTheDocument();
  expect(screen.queryByTestId('block-news-list')).toBeNull();
});

test('after reload: a news_list block renders identically from the persisted/reloaded shape', () => {
  const reloadedMessage = {
    _id: 'msg-1', role: 'assistant', content: 'TCS won a major BFSI deal [1].', status: 'COMPLETE',
    citations: [{ evidenceId: 'e1', title: 'TCS wins major BFSI deal', sourceUrl: 'https://reuters.com/tcs-deal', provider: 'Reuters', publishedAt: '2026-09-01T00:00:00.000Z' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    responseBlocks: [{ type: 'news_list', articles: [ARTICLE] }],
  };
  render(<ChatMessageBubble message={reloadedMessage} />);
  const block = screen.getByTestId('block-news-list');
  expect(block).toHaveTextContent('TCS wins major BFSI deal');
  expect(block).toHaveTextContent('Reuters');
});
