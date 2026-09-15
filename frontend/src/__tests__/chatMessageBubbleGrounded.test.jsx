import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatMessageBubble from '@/components/chat/ChatMessageBubble';

/**
 * chatMessageBubbleGrounded.test.jsx
 * =====================================
 * Phase 4B Part 10/11: the grounded-answer additions to
 * ChatMessageBubble.jsx (grounding-status badge, richer citation cards,
 * safe-link gating) — and a confirmation that ordinary (non-research)
 * assistant messages render exactly as before, with none of this new UI.
 */

// The sources-toggle button's label is split across multiple JSX
// expressions ({citations.length} source{...}) which this project's
// dev-time JSX instrumentation renders as several sibling DOM nodes —
// clicking via the stable data-testid container is robust to that,
// whereas getByText(/N sources/i) is not.
const openSources = () => fireEvent.click(screen.getByTestId('sources-section').querySelector('button'));

const baseAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: 'TCS guided FY2023 revenue growth of 15%.',
  createdAt: new Date().toISOString(),
  ...overrides,
});

test('a grounded research answer shows the "Verified from documents" badge', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({ groundingStatus: 'grounded' })} />);
  expect(screen.getByTestId('grounding-status')).toHaveTextContent(/verified from documents/i);
});

test('a partially-grounded answer shows the partial badge plus its coverage limitations', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    groundingStatus: 'partially_grounded',
    coverage: { limitations: ['FY2024 outcome data was not available'] },
  })}
  />);
  expect(screen.getByTestId('grounding-status')).toHaveTextContent(/partially verified/i);
  expect(screen.getByTestId('grounding-status')).toHaveTextContent(/FY2024 outcome data was not available/i);
});

test('an insufficient-evidence answer shows the insufficient-evidence badge, never a fabricated grounded claim', () => {
  render(<ChatMessageBubble message={baseAssistantMessage({
    content: "I couldn't find any indexed research documents covering TCS FY2099.",
    groundingStatus: 'insufficient_evidence',
  })}
  />);
  expect(screen.getByTestId('grounding-status')).toHaveTextContent(/insufficient evidence/i);
});

test('an ordinary chat message (no groundingStatus) renders with no grounding badge at all', () => {
  render(<ChatMessageBubble message={baseAssistantMessage()} />);
  expect(screen.queryByTestId('grounding-status')).toBeNull();
});

test('citation numbering matches the order of the citations array, and page/period metadata is shown', () => {
  const message = baseAssistantMessage({
    citations: [
      {
        evidenceId: 'E1', symbol: 'TCS', reportingPeriod: 'FY2023', documentTitle: 'TCS FY2023 Annual Report', sourceAuthority: 'COMPANY_FILING', pageStart: 12, pageEnd: 12, sourceUrl: 'https://example.com/tcs.pdf',
      },
      {
        evidenceId: 'E2', symbol: 'TCS', reportingPeriod: 'Q4 FY2023', documentTitle: 'TCS Q4 FY2023 Earnings Call', sourceAuthority: 'EARNINGS_CALL', pageStart: 3, pageEnd: 4, sourceUrl: 'https://example.com/tcs-q4.pdf',
      },
    ],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  const links = screen.getAllByRole('link');
  expect(links[0]).toHaveTextContent('TCS FY2023 Annual Report');
  expect(links[1]).toHaveTextContent('TCS Q4 FY2023 Earnings Call');
  expect(screen.getByText(/p\.12/)).toBeInTheDocument();
  expect(screen.getByText(/p\.3-4/)).toBeInTheDocument();
});

test('a citation with an unsafe link scheme is never rendered as a clickable link', () => {
  const message = baseAssistantMessage({
    citations: [{
      evidenceId: 'E1', documentTitle: 'Suspicious source', sourceUrl: 'javascript:alert(1)',
    }],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Suspicious source')).toBeInTheDocument();
});

test('a citation missing page metadata renders gracefully with no crash and no stray "p." label', () => {
  const message = baseAssistantMessage({
    citations: [{ evidenceId: 'E1', symbol: 'TCS', documentTitle: 'TCS Filing', sourceUrl: 'https://example.com/tcs.pdf' }],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  expect(screen.getByText('TCS Filing')).toBeInTheDocument();
  expect(screen.queryByText(/p\./)).toBeNull();
});

test('a backend error message renders as an error, never crashing on missing grounded fields', () => {
  render(<ChatMessageBubble message={{
    role: 'assistant', content: 'GS Copilot ran into a problem answering that.', status: 'ERROR',
  }}
  />);
  expect(screen.getByText(/ran into a problem/i)).toBeInTheDocument();
  expect(screen.queryByTestId('grounding-status')).toBeNull();
});

test('an ordinary user message renders unchanged (right-aligned bubble, no markdown/citations)', () => {
  render(<ChatMessageBubble message={{ role: 'user', content: 'What is a P/E ratio?' }} />);
  expect(screen.getByTestId('msg-user')).toHaveTextContent('What is a P/E ratio?');
});

// ---------------------------------------------------------------------------
// Phase 4D Part 7: temporal citation labels (current/revised/superseded).
// ---------------------------------------------------------------------------

test('a SUPERSEDED citation is clearly labeled, and its historical citation is never removed', () => {
  const message = baseAssistantMessage({
    citations: [{
      evidenceId: 'E1', symbol: 'INFY', documentTitle: 'INFY Q1 FY2023 Earnings Call', sourceUrl: 'https://example.com/infy-q1.pdf',
      temporalStatus: 'SUPERSEDED', supersededBy: 'E2', canonicalGuidance: { valueType: 'range', lowerBound: 21, upperBound: 23, unit: 'PERCENTAGE' },
    }],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  expect(screen.getByText('Superseded')).toBeInTheDocument();
  expect(screen.getByText('INFY Q1 FY2023 Earnings Call')).toBeInTheDocument();
});

test('a CURRENT citation that supersedes a shown SUPERSEDED sibling renders "Revised from X to Y"', () => {
  const message = baseAssistantMessage({
    citations: [
      {
        evidenceId: 'E1', symbol: 'INFY', documentTitle: 'INFY Q1 FY2023 Earnings Call', sourceUrl: 'https://example.com/infy-q1.pdf',
        temporalStatus: 'SUPERSEDED', supersededBy: 'E2', canonicalGuidance: { valueType: 'range', lowerBound: 21, upperBound: 23, unit: 'PERCENTAGE' },
      },
      {
        evidenceId: 'E2', symbol: 'INFY', documentTitle: 'INFY Revised Guidance', sourceUrl: 'https://example.com/infy-revised.pdf',
        temporalStatus: 'CURRENT', supersedes: ['E1'], canonicalGuidance: { valueType: 'range', lowerBound: 21, upperBound: 22, unit: 'PERCENTAGE' },
      },
    ],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  expect(screen.getByText('Revised from 21%-23% to 21%-22%')).toBeInTheDocument();
  expect(screen.getByText('Current')).toBeInTheDocument();
});

test('a CONFLICTING citation is honestly labeled, never silently hidden', () => {
  const message = baseAssistantMessage({
    citations: [{
      evidenceId: 'E1', symbol: 'INFY', documentTitle: 'Conflicting Source', sourceUrl: 'https://example.com/c.pdf', temporalStatus: 'CONFLICTING',
    }],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  expect(screen.getByText('Conflicting source')).toBeInTheDocument();
});

test('an ordinary (non-guidance) citation with no temporalStatus shows no temporal label at all', () => {
  const message = baseAssistantMessage({
    citations: [{ evidenceId: 'E1', symbol: 'TCS', documentTitle: 'TCS News', sourceUrl: 'https://example.com/n.pdf' }],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  expect(screen.queryByText('Current')).toBeNull();
  expect(screen.queryByText('Superseded')).toBeNull();
});

test('internal verifier diagnostics (reasonCode, relationshipId, confidence) are never rendered in the citation card', () => {
  const message = baseAssistantMessage({
    citations: [{
      evidenceId: 'E1', symbol: 'INFY', documentTitle: 'INFY Guidance', sourceUrl: 'https://example.com/g.pdf',
      temporalStatus: 'CURRENT', reasonCode: 'SECRET_INTERNAL_REASON', relationshipId: 'R1', confidence: 'high',
    }],
  });
  render(<ChatMessageBubble message={message} />);
  openSources();
  expect(screen.queryByText(/SECRET_INTERNAL_REASON/)).toBeNull();
  expect(screen.queryByText(/R1/)).toBeNull();
});
