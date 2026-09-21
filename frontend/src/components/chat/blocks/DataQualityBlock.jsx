/**
 * DataQualityBlock - REPLACES ChatMessageBubble's old inline
 * GroundingStatusBadge rendering whenever a valid data_quality block is
 * present (the caller — ChatMessageBubble — decides which one to render;
 * this component only renders). This is safe specifically because
 * data_quality is a strict SUPERSET of what GroundingStatusBadge already
 * showed: buildDataQualityBlock (backend) never omits the block once
 * groundingStatus is non-null, so every turn the old badge would have
 * shown something for still produces a block here, PLUS the two fields
 * the old badge never had access to (unmatchedRequestedPeriods,
 * valuationGaps — both Phase 6B). When no block is present (an older
 * persisted message, or a turn where buildDataQualityBlock found
 * genuinely nothing to report), ChatMessageBubble falls back to the
 * original GroundingStatusBadge unchanged — see its own module note.
 */
const GROUNDING_STATUS_STYLE = {
  grounded: { label: 'Verified from documents', className: 'text-gs-pos border-gs-pos/30 bg-gs-posBg' },
  partially_grounded: { label: 'Partially verified', className: 'text-gs-gold border-gs-gold/30 bg-gs-goldMuted' },
  insufficient_evidence: { label: 'Insufficient evidence', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
};

export const isValidDataQualityBlock = (block) => Boolean(
  block && block.type === 'data_quality'
  && (block.groundingStatus === null || typeof block.groundingStatus === 'string')
  && Array.isArray(block.unmatchedRequestedPeriods) && Array.isArray(block.valuationGaps) && Array.isArray(block.limitations),
);

/** hasAnythingToShow - mirrors the backend's own omission rule (defense in depth; a block that reaches here should already satisfy this). */
const hasAnythingToShow = (block) => Boolean(
  block.groundingStatus || block.unmatchedRequestedPeriods.length || block.valuationGaps.length || block.limitations.length,
);

export default function DataQualityBlock({ block }) {
  if (!isValidDataQualityBlock(block) || !hasAnythingToShow(block)) return null;
  const style = block.groundingStatus ? GROUNDING_STATUS_STYLE[block.groundingStatus] : null;

  return (
    <div className="mb-1.5" data-testid="block-data-quality">
      <div className="flex flex-wrap items-center gap-1.5">
        {style && (
          <span className={`inline-flex items-center font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${style.className}`}>
            {style.label}
          </span>
        )}
        {block.limitations.length > 0 && (
          <span className="text-[10.5px] text-gs-textDim">{block.limitations.join('; ')}</span>
        )}
      </div>
      {block.unmatchedRequestedPeriods.length > 0 && (
        <div className="text-[10.5px] text-gs-textDim mt-1">No data held for: {block.unmatchedRequestedPeriods.join(', ')}.</div>
      )}
      {block.valuationGaps.length > 0 && (
        <div className="text-[10.5px] text-gs-textDim mt-1">
          {block.valuationGaps.map((gap, i) => (
            <div key={`${gap.symbol}-${gap.metric}-${i}`}>{gap.symbol} {gap.metric}: {gap.reason}.</div>
          ))}
        </div>
      )}
    </div>
  );
}
