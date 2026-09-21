import { formatBlockValue, firstEvidenceRef } from "./blockHelpers";
import CitationMarker from "./CitationMarker";

/**
 * CompanyHeaderBlock - symbol, verified company name/sector/exchange, and
 * a cited price only where the backend actually resolved one (see
 * backend's services/responseBlocks.js's buildCompanyHeaderBlock — price
 * is omitted, never guessed, when nothing resolves). No logo: this system
 * holds no real, sourced logo data for any company, so none is rendered —
 * not a placeholder icon, not an inferred one.
 */
export const isValidCompanyHeaderBlock = (block) => Boolean(
  block && block.type === 'company_header' && typeof block.symbol === 'string' && typeof block.companyName === 'string' && block.companyName.length > 0,
);

export default function CompanyHeaderBlock({ block, onOpenEvidence }) {
  if (!isValidCompanyHeaderBlock(block)) return null;
  const priceRef = block.price ? firstEvidenceRef(block.price.evidence) : null;
  const priceAsOf = block.price?.asOf ? new Date(block.price.asOf) : null;
  const priceAsOfLabel = priceAsOf && !Number.isNaN(priceAsOf.getTime())
    ? priceAsOf.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: priceAsOf.getHours() || priceAsOf.getMinutes() ? 'short' : undefined })
    : null;

  return (
    <div className="gs-card p-3 mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1" data-testid="block-company-header">
      <div className="min-w-0">
        <div className="font-display font-bold text-gs-text text-[14px] truncate">{block.companyName}</div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] font-mono uppercase tracking-wider text-gs-textDim">
          <span>{block.symbol}</span>
          {block.exchange && <span className="gs-pill">{block.exchange}</span>}
          {block.sector && <span>{block.sector}</span>}
        </div>
      </div>
      {block.price && (
        <div className="text-right shrink-0">
          <div className="font-mono text-[16px] text-gs-text">
            {formatBlockValue(block.price.value, block.price.currency === 'INR' ? 'INR' : null)}
            <CitationMarker citationIndex={priceRef?.citationIndex} evidenceId={priceRef?.evidenceId} onOpenEvidence={onOpenEvidence} />
          </div>
          {priceAsOfLabel && <div className="text-[10px] text-gs-textDim">as of {priceAsOfLabel}</div>}
        </div>
      )}
    </div>
  );
}
