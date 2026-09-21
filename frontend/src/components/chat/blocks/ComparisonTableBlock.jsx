import { formatBlockValue, firstEvidenceRef } from "./blockHelpers";
import CitationMarker from "./CitationMarker";

/**
 * ComparisonTableBlock - a real `<table>`, styled identically to
 * ChatMessageBubble's own MARKDOWN_COMPONENTS table/thead/th/td (same
 * classes) so a comparison rendered as a block looks indistinguishable
 * from one the model rendered as Markdown — this is the "Table pattern"
 * reuse the brief asks for, applied to the actual visual language this
 * surface already uses rather than the generic shadcn table primitive.
 *
 * `row.comparable`/`row.commonPeriod` are read verbatim from the backend
 * (services/claimPlan.js's own comparability decision) — never
 * re-derived here. A missing cell renders an em dash, never a guess.
 */
export const isValidComparisonTableBlock = (block) => Boolean(
  block && block.type === 'comparison_table' && Array.isArray(block.symbols) && block.symbols.length >= 2
  && Array.isArray(block.rows) && block.rows.length > 0,
);

export default function ComparisonTableBlock({ block, onOpenEvidence }) {
  if (!isValidComparisonTableBlock(block)) return null;
  const anyMismatched = block.rows.some((row) => !row.comparable);

  return (
    <div className="my-2 overflow-x-auto" data-testid="block-comparison-table">
      <table className="w-full text-[12px] border-collapse">
        <thead className="border-b border-gs-border">
          <tr>
            <th className="text-left px-2 py-1.5 gs-label">Metric</th>
            {block.symbols.map((symbol) => <th key={symbol} className="text-left px-2 py-1.5 gs-label">{symbol}</th>)}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={`${row.metric}-${index}`}>
              <td className="px-2 py-1.5 text-gs-text border-b border-gs-border/50">
                {row.label}
                {row.commonPeriod && <span className="block text-[10px] text-gs-textDim">{row.commonPeriod}</span>}
              </td>
              {block.symbols.map((symbol) => {
                const cell = row.values?.[symbol];
                const ref = cell && firstEvidenceRef(cell.evidence);
                return (
                  <td key={symbol} className="px-2 py-1.5 text-gs-text border-b border-gs-border/50 font-mono">
                    {cell ? (
                      <>
                        {formatBlockValue(cell.value, cell.unit)}
                        <CitationMarker citationIndex={ref?.citationIndex} evidenceId={ref?.evidenceId} onOpenEvidence={onOpenEvidence} />
                      </>
                    ) : <span className="text-gs-textDim">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {anyMismatched && (
        <div className="text-[10.5px] text-gs-textDim mt-1">Rows without a shared reporting period are not directly comparable.</div>
      )}
    </div>
  );
}
