/**
 * blockHelpers.js
 * =================
 * UI Phase 1B: small, shared, presentation-only helpers for the
 * responseBlocks renderers. No fetching, no state — every block already
 * arrives fully formed and already validated server-side (see backend's
 * graph/nodes/buildResponseBlocks.js); these only format and defensively
 * re-check shape before render.
 */

/**
 * isSafeBlockUrl - mirrors ChatMessageBubble's own isSafeHref and the
 * backend's graph/evidence.js isUsableUrl / graph/schemas.js
 * isSafeBlockUrl: http(s) only. The backend already enforces this before
 * a block is ever sent, but a link is rendered as a real anchor tag, so
 * it is re-checked here too rather than trusted at face value.
 */
export const isSafeBlockUrl = (href) => /^https?:\/\//.test(href || '');

/**
 * formatBlockValue - the SAME unit vocabulary backend/services/claimPlan.js's
 * formatValue uses (₹ Cr for INR_CRORE, % for PERCENTAGE, $ M for
 * USD_MILLION, plain ₹ for INR), applied here because responseBlocks
 * deliberately carry a raw {value, unit} pair rather than a pre-formatted
 * string — kept structured for whatever renders it, including a future
 * chart. Never rescales or reinterprets the number, only formats it.
 */
export const formatBlockValue = (value, unit) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const u = String(unit || '').toUpperCase();
  if (u === 'PERCENTAGE' || u === 'PERCENT' || u === '%') return `${value}%`;
  if (u === 'INR_CRORE') return `₹${value.toLocaleString('en-IN')} Cr`;
  if (u === 'USD_MILLION') return `$${value.toLocaleString('en-US')}M`;
  if (u === 'INR') return `₹${value}`;
  return `${value}${u ? ` ${u}` : ''}`;
};

/** firstEvidenceRef - the first {evidenceId, citationIndex} a figure's evidence array carries, or null. */
export const firstEvidenceRef = (evidence) => (Array.isArray(evidence) && evidence[0]) || null;

/** citationBadge - the small [N] superscript every block figure carries when it resolved a citationIndex. */
export const firstCitationIndex = (evidence) => firstEvidenceRef(evidence)?.citationIndex || null;
