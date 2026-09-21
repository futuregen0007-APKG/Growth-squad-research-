import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { buildMarkerToEvidenceId } from '@/components/chat/blocks/citationLinkify';
import { CitationLinkContext, useLinkifiedChildren } from '@/components/chat/blocks/CitationLinkContext';

/**
 * citationLinkify.test.jsx
 * ===========================
 * UI Phase 1C.2. react-markdown itself is mocked in this test environment
 * (src/__mocks__/react-markdown.js renders the raw string and never
 * invokes `components` at all — see that file's own comment), so the
 * actual MARKDOWN_COMPONENTS wiring inside ChatMessageBubble cannot be
 * exercised end-to-end through a real markdown parse here. What IS tested
 * directly, with no mocking: the marker->evidenceId resolution logic
 * (buildMarkerToEvidenceId) and the linkify hook itself, rendered through
 * a real React tree exactly as a markdown component override would call
 * it. This is real coverage of the actual logic; it is not a substitute
 * for a real-browser check that react-markdown's OWN parsing feeds these
 * overrides the shapes assumed here (see the phase report).
 */

// -----------------------------------------------------------------------
// buildMarkerToEvidenceId — the numbering-compaction logic
// -----------------------------------------------------------------------

test('buildMarkerToEvidenceId maps CONTIGUOUS markers 1:1 to entries in order', () => {
  const entries = [{ evidenceId: 'e1' }, { evidenceId: 'e2' }, { evidenceId: 'e3' }];
  const map = buildMarkerToEvidenceId('TCS grew [1]. PAT was [2]. Margin was [3].', entries);
  expect(map.get(1)).toBe('e1');
  expect(map.get(2)).toBe('e2');
  expect(map.get(3)).toBe('e3');
});

test('buildMarkerToEvidenceId correctly compacts NON-CONTIGUOUS markers -- the exact case extractCitations produces server-side', () => {
  // Only [3] and [7] appear anywhere in the answer -- entries has 2 items,
  // built server-side in ascending-marker order: entries[0] came from
  // marker 3, entries[1] from marker 7. This is the subtlety this file's
  // own module note describes.
  const entries = [{ evidenceId: 'e-from-marker-3' }, { evidenceId: 'e-from-marker-7' }];
  const map = buildMarkerToEvidenceId('Revenue was ₹1 Cr [3]. Margin was 20% [7].', entries);
  expect(map.get(3)).toBe('e-from-marker-3');
  expect(map.get(7)).toBe('e-from-marker-7');
  expect(map.has(1)).toBe(false);
});

test('buildMarkerToEvidenceId scans the FULL text, not a fragment -- a marker appearing once still resolves regardless of where in the text it is', () => {
  const entries = [{ evidenceId: 'e1' }, { evidenceId: 'e2' }];
  const map = buildMarkerToEvidenceId('Intro sentence. [1] then later [2] and again [1].', entries);
  expect(map.get(1)).toBe('e1');
  expect(map.get(2)).toBe('e2');
});

test('buildMarkerToEvidenceId returns an empty map for no entries or no text', () => {
  expect(buildMarkerToEvidenceId('TCS grew [1].', []).size).toBe(0);
  expect(buildMarkerToEvidenceId('TCS grew [1].', undefined).size).toBe(0);
  expect(buildMarkerToEvidenceId('', [{ evidenceId: 'e1' }]).size).toBe(0);
});

test('buildMarkerToEvidenceId ignores a marker number with no corresponding entry (more markers than entries)', () => {
  const map = buildMarkerToEvidenceId('[1] [2] [3]', [{ evidenceId: 'e1' }]);
  expect(map.get(1)).toBe('e1');
  expect(map.has(2)).toBe(false);
  expect(map.has(3)).toBe(false);
});

// -----------------------------------------------------------------------
// useLinkifiedChildren — rendered through a real React tree, exactly as a
// markdown component override (p/li/strong/em/td/h1-h4) would call it.
// -----------------------------------------------------------------------

const TestParagraph = ({ children }) => {
  const linkified = useLinkifiedChildren(children, 'test-p');
  return <p data-testid="test-p">{linkified}</p>;
};

const renderWithContext = (children, { markerToEvidenceId, onOpenEvidence } = {}) => render(
  <CitationLinkContext.Provider value={{ markerToEvidenceId: markerToEvidenceId || new Map(), onOpenEvidence }}>
    <TestParagraph>{children}</TestParagraph>
  </CitationLinkContext.Provider>,
);

test('a resolvable [N] marker becomes a real clickable button that opens the matching evidence', () => {
  const onOpenEvidence = jest.fn();
  const map = new Map([[1, 'e1']]);
  renderWithContext('TCS revenue was ₹240,893 Cr [1].', { markerToEvidenceId: map, onOpenEvidence });

  const marker = screen.getByTestId('citation-marker');
  expect(marker.tagName).toBe('BUTTON');
  expect(marker).toHaveTextContent('[1]');
  fireEvent.click(marker);
  expect(onOpenEvidence).toHaveBeenCalledWith('e1');
});

test('the surrounding plain text is preserved exactly, on both sides of the marker', () => {
  const map = new Map([[1, 'e1']]);
  renderWithContext('TCS revenue was ₹240,893 Cr [1] this quarter.', { markerToEvidenceId: map, onOpenEvidence: jest.fn() });
  const p = screen.getByTestId('test-p');
  expect(p).toHaveTextContent('TCS revenue was ₹240,893 Cr [1] this quarter.');
});

test('multiple markers in the same text each become their own independent clickable button', () => {
  const onOpenEvidence = jest.fn();
  const map = new Map([[1, 'e1'], [2, 'e2']]);
  renderWithContext('Revenue [1] grew while margin [2] held steady.', { markerToEvidenceId: map, onOpenEvidence });
  const markers = screen.getAllByTestId('citation-marker');
  expect(markers).toHaveLength(2);
  fireEvent.click(markers[1]);
  expect(onOpenEvidence).toHaveBeenCalledWith('e2');
});

test('a marker with NO entry in the map renders as plain, inert "[N]" text -- never a dead-looking button', () => {
  renderWithContext('Some unresolvable figure [9].', { markerToEvidenceId: new Map(), onOpenEvidence: jest.fn() });
  expect(screen.queryByTestId('citation-marker')).toBeNull();
  expect(screen.getByTestId('test-p')).toHaveTextContent('Some unresolvable figure [9].');
});

test('with an EMPTY map (no evidence_drawer for this message), children pass through completely unchanged -- true no-op', () => {
  renderWithContext('TCS revenue was ₹1 Cr [1].', { markerToEvidenceId: new Map(), onOpenEvidence: jest.fn() });
  expect(screen.queryByTestId('citation-marker')).toBeNull();
  expect(screen.getByTestId('test-p')).toHaveTextContent('TCS revenue was ₹1 Cr [1].');
});

test('an already-rendered React element child (simulating a nested <a> or <code> from those overrides) is passed through completely untouched -- ordinary links and code are preserved by construction', () => {
  const map = new Map([[1, 'e1']]);
  const CodeStandin = () => <code data-testid="code-child">[1] literal, not a citation</code>;
  render(
    <CitationLinkContext.Provider value={{ markerToEvidenceId: map, onOpenEvidence: jest.fn() }}>
      <TestParagraph>{['Real text [1] here. ', <CodeStandin key="code" />]}</TestParagraph>
    </CitationLinkContext.Provider>,
  );
  // The real text citation IS linkified...
  expect(screen.getByTestId('citation-marker')).toBeInTheDocument();
  // ...but the code element's own children were never touched by linkify at all (no second marker button was manufactured from its text).
  expect(screen.getAllByTestId('citation-marker')).toHaveLength(1);
  expect(screen.getByTestId('code-child')).toHaveTextContent('[1] literal, not a citation');
});

test('without an onOpenEvidence handler, a resolvable marker still renders as plain text (never a clickable-looking-but-dead button)', () => {
  const map = new Map([[1, 'e1']]);
  renderWithContext('TCS revenue was ₹1 Cr [1].', { markerToEvidenceId: map, onOpenEvidence: undefined });
  expect(screen.queryByTestId('citation-marker')).toBeNull();
  expect(screen.getByTestId('test-p')).toHaveTextContent('TCS revenue was ₹1 Cr [1].');
});

test('rendered OUTSIDE any Provider, the default context value degrades safely to plain text -- no crash', () => {
  render(<TestParagraph>Some figure [1] with no provider at all.</TestParagraph>);
  expect(screen.queryByTestId('citation-marker')).toBeNull();
  expect(screen.getByTestId('test-p')).toHaveTextContent('Some figure [1] with no provider at all.');
});
