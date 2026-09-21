import { isSafeBlockUrl } from "./blockHelpers";

/**
 * CitationEntry.jsx
 * ====================
 * UI Phase 1C.1: extracted, unchanged, from ChatMessageBubble's own
 * SourcesSection — the exact same temporal-status badge / "Revised from X
 * to Y" / qualitative-direction rendering, now shared by BOTH
 * SourcesSection (compact inline list, unchanged appearance — see its own
 * test suite) and EvidenceDrawerSheet (the richer per-entry drawer view,
 * Phase 1C.1). This is the "reuse SourcesSection" the brief asks for: one
 * rendering implementation, not two.
 *
 * Works with either citation shape this project has (a raw
 * message.citations entry, or a normalized evidence_drawer entry from
 * services/responseBlocks.js) — both carry evidenceId/title|documentTitle/
 * sourceUrl/provider|sourceAuthority/publishedAt/reportingPeriod/
 * temporalStatus/supersedes/canonicalGuidance; evidence_drawer entries
 * additionally carry `excerpt`, shown only when `showExcerpt` is true.
 */

const TEMPORAL_LABEL_STYLE = {
  SUPERSEDED: { label: 'Superseded', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
  CURRENT: { label: 'Current', className: 'text-gs-pos border-gs-pos/30 bg-gs-posBg' },
  HISTORICAL: { label: 'Historical outcome', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
  CONFLICTING: { label: 'Conflicting source', className: 'text-gs-neg border-gs-neg/30 bg-gs-negBg' },
  UNRESOLVED: { label: 'Unverified figure', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
};

/** formatGuidanceRange - a short "21%-23%" / "22%" label from canonicalGuidance, or null when nothing was safely extracted -- never guessed here either. */
const formatGuidanceRange = (canonicalGuidance) => {
  if (!canonicalGuidance) return null;
  const unitSuffix = canonicalGuidance.unit === 'PERCENTAGE' ? '%' : '';
  if (canonicalGuidance.valueType === 'range' && canonicalGuidance.lowerBound != null && canonicalGuidance.upperBound != null) {
    return `${canonicalGuidance.lowerBound}${unitSuffix}-${canonicalGuidance.upperBound}${unitSuffix}`;
  }
  if (canonicalGuidance.valueType === 'exact' && canonicalGuidance.exactValue != null) {
    return `${canonicalGuidance.exactValue}${unitSuffix}`;
  }
  return null;
};

const QUALITATIVE_DIRECTION_LABEL = {
  INCREASE: 'Expected to increase', DECREASE: 'Expected to decrease', MAINTAIN: 'Maintained', IMPROVE: 'Expected to improve',
  EXPAND: 'Expected to expand', REDUCE: 'Expected to reduce', STABLE: 'Expected to stay stable', OTHER: 'Directional guidance',
};

/** formatQualitativeLabel - plain-language rendering for a qualitative canonicalGuidance, or null for a numeric/unresolved one. Never renders a fake number. */
const formatQualitativeLabel = (canonicalGuidance) => {
  if (!canonicalGuidance || canonicalGuidance.valueType !== 'qualitative') return null;
  return QUALITATIVE_DIRECTION_LABEL[canonicalGuidance.qualitativeDirection] || null;
};

/**
 * CitationEntry - one citation/evidence entry.
 *
 * @param citation - the citation/entry object.
 * @param index - its position (0-based) in `allCitations`, for the [N] label.
 * @param allCitations - the full array, needed only to resolve a
 *   revision's superseded sibling by evidenceId (matches SourcesSection's
 *   original lookup exactly).
 * @param showExcerpt - drawer view only; SourcesSection's compact list
 *   never shows it, keeping that existing surface visually unchanged.
 * @param onOpenIndex - optional; when given, the [N] label becomes a real
 *   button that opens the evidence drawer at this entry's evidenceId.
 * @param highlighted - drawer view only; true for the entry the drawer was
 *   opened to, given a highlight ring and used as the initial scroll/focus
 *   target.
 * @param entryRef - forwarded ref, used by EvidenceDrawerSheet to scroll/
 *   focus the highlighted entry on open.
 */
export default function CitationEntry({
  citation: c, index, allCitations = [], showExcerpt = false, onOpenIndex, highlighted = false, entryRef,
}) {
  const byId = new Map(allCitations.map((item) => [item.evidenceId, item]));
  const label = c.documentTitle || c.title || c.sourceUrl || 'Source unavailable';
  const metaParts = [
    c.symbol, c.reportingPeriod, c.sourceAuthority || c.provider,
    c.pageStart ? `p.${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ''}` : null,
  ].filter(Boolean);
  const temporalStyle = TEMPORAL_LABEL_STYLE[c.temporalStatus];
  const supersededSibling = c.supersedes?.length ? byId.get(c.supersedes[0]) : null;
  const revisionSummary = c.temporalStatus === 'CURRENT' && supersededSibling
    ? (() => {
      const from = formatGuidanceRange(supersededSibling.canonicalGuidance);
      const to = formatGuidanceRange(c.canonicalGuidance);
      return from && to ? `Revised from ${from} to ${to}` : null;
    })()
    : null;
  const qualitativeLabel = formatQualitativeLabel(c.canonicalGuidance);

  return (
    <div
      ref={entryRef}
      tabIndex={highlighted ? -1 : undefined}
      className={`text-[11px] text-gs-textMuted flex items-start gap-1.5 ${highlighted ? 'ring-1 ring-gs-gold/50 bg-gs-goldMuted/40 rounded-sm p-1.5 -m-1.5' : ''}`}
      data-testid={highlighted ? 'evidence-drawer-highlighted-entry' : undefined}
    >
      {onOpenIndex ? (
        <button
          type="button"
          onClick={() => onOpenIndex(c.evidenceId)}
          className="text-gs-textDim shrink-0 hover:text-gs-gold hover:underline font-mono"
          data-testid="citation-marker"
          aria-label={`Open source ${index + 1}: ${label}`}
        >
          [{index + 1}]
        </button>
      ) : (
        <span className="text-gs-textDim shrink-0">[{index + 1}]</span>
      )}
      <div className="min-w-0">
        {c.sourceUrl && isSafeBlockUrl(c.sourceUrl) ? (
          <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-gs-gold hover:underline break-words">
            {label}
          </a>
        ) : (
          <span className="break-words">{label}</span>
        )}
        {temporalStyle && (
          <span className={`ml-1.5 inline-flex items-center font-mono text-[9px] uppercase tracking-wider px-1 py-0.5 rounded-sm border ${temporalStyle.className}`}>
            {temporalStyle.label}
          </span>
        )}
        {(metaParts.length > 0 || c.publishedAt) && (
          <div className="text-gs-textDim">
            {metaParts.join(' · ')}
            {c.publishedAt && ` ${metaParts.length ? '· ' : ''}${new Date(c.publishedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`}
          </div>
        )}
        {revisionSummary && <div className="mt-0.5 text-gs-gold">{revisionSummary}</div>}
        {!revisionSummary && qualitativeLabel && <div className="mt-0.5 text-gs-textDim">{qualitativeLabel}</div>}
        {showExcerpt && c.excerpt && <div className="mt-1 text-gs-textMuted italic break-words">"{c.excerpt}"</div>}
      </div>
    </div>
  );
}
