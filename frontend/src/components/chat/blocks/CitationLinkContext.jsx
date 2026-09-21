import { createContext, useContext } from "react";

/**
 * CitationLinkContext.jsx
 * ==========================
 * UI Phase 1C.2: threads the answer's marker->evidenceId map (see
 * citationLinkify.js) and the evidence-drawer open handler down into
 * ReactMarkdown's component overrides (p/li/strong/em/td/h1-h4) — those
 * are invoked BY react-markdown's own dispatch, so ordinary prop-drilling
 * from ChatMessageBubble isn't possible; Context is the mechanism.
 *
 * The default value (empty map, no handler) is exactly the "no
 * evidence_drawer for this message" state — every consumer below already
 * treats an empty map as a no-op, so a component rendered outside the
 * Provider (e.g. in isolation in a test) degrades safely to plain text,
 * never a crash.
 */
export const CitationLinkContext = createContext({ markerToEvidenceId: new Map(), onOpenEvidence: undefined });

const CITATION_MARKER_PATTERN = /\[(\d+)\]/g;

/**
 * linkifyNode - splits ONE child (a string, or an already-rendered React
 * element) into an array of nodes with every RESOLVABLE [N] marker
 * replaced by a real, clickable button. A marker with no entry in the map
 * (evidence_drawer absent, or the number is genuinely not a citation the
 * drawer covers) is left as plain "[N]" text — never a dead-looking
 * button, matching CitationMarker's own rule elsewhere.
 *
 * An already-rendered element (e.g. the <a>/<code> output of THEIR OWN
 * overrides, appearing as a sibling child of `p`) is passed through
 * completely untouched: ordinary links and code blocks are preserved by
 * construction, not merely by convention — this function never inspects
 * or recurses into a non-string child at all.
 */
const linkifyNode = (node, markerToEvidenceId, onOpenEvidence, keyPrefix) => {
  if (typeof node !== 'string') return [node];
  const parts = [];
  let lastIndex = 0;
  let count = 0;
  for (const match of node.matchAll(CITATION_MARKER_PATTERN)) {
    const marker = Number(match[1]);
    const evidenceId = markerToEvidenceId.get(marker);
    if (match.index > lastIndex) parts.push(node.slice(lastIndex, match.index));
    if (evidenceId && onOpenEvidence) {
      parts.push(
        <button
          key={`${keyPrefix}-${count++}`}
          type="button"
          onClick={() => onOpenEvidence(evidenceId)}
          className="text-gs-gold hover:underline font-mono"
          data-testid="citation-marker"
          aria-label={`Open source ${marker}`}
        >
          [{marker}]
        </button>,
      );
    } else {
      parts.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < node.length) parts.push(node.slice(lastIndex));
  return parts.length ? parts : [node];
};

/**
 * useLinkifiedChildren - call from a markdown component override with its
 * own `children` prop; returns the same children with every resolvable
 * [N] replaced by a clickable marker. Safe for any children shape
 * (string, array of strings/elements, a single element, undefined/null).
 * Returns `children` completely unchanged (same reference) whenever the
 * map is empty — the common case for a message with no evidence_drawer,
 * kept a true no-op rather than an unnecessary re-wrap.
 */
export const useLinkifiedChildren = (children, keyPrefix) => {
  const { markerToEvidenceId, onOpenEvidence } = useContext(CitationLinkContext);
  if (!markerToEvidenceId.size) return children;
  const items = Array.isArray(children) ? children : [children];
  return items.flatMap((child, i) => linkifyNode(child, markerToEvidenceId, onOpenEvidence, `${keyPrefix}-${i}`));
};

export default { CitationLinkContext, useLinkifiedChildren };
