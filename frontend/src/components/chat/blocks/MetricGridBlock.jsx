import { formatBlockValue, firstEvidenceRef } from "./blockHelpers";
import CitationMarker from "./CitationMarker";

/**
 * MetricGridBlock - a single company's figures as a small tile grid,
 * supplementing (never replacing) the Markdown table the answer already
 * renders. Uses the project's own `.gs-card` pattern (src/index.css),
 * matching how every other chat/dashboard card is already built —
 * ChatMessageBubble does not import the generic shadcn Card component
 * anywhere today, so introducing it here would visually clash with the
 * surface it sits in.
 *
 * Every figure that has a resolved citationIndex shows a [N] superscript
 * matching the same numbering the existing SourcesSection uses — a figure
 * with no citation (should not happen; buildMetricGridBlock requires at
 * least one evidence ref per metric) simply shows no superscript rather
 * than a fabricated one.
 */
export const isValidMetricGridBlock = (block) => Boolean(
  block && block.type === 'metric_grid' && typeof block.symbol === 'string' && Array.isArray(block.metrics) && block.metrics.length > 0,
);

export default function MetricGridBlock({ block, onOpenEvidence }) {
  if (!isValidMetricGridBlock(block)) return null;

  return (
    <div className="gs-card p-3 my-2" data-testid="block-metric-grid">
      <div className="gs-label mb-2">{block.symbol} — key metrics</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {block.metrics.map((metric, index) => {
          const ref = firstEvidenceRef(metric.evidence);
          return (
            <div key={`${metric.metric}-${index}`} className="rounded-sm border border-gs-border bg-gs-panel/60 px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wider text-gs-textDim truncate" title={metric.label}>{metric.label}</div>
              <div className="font-mono text-[14px] text-gs-text mt-0.5">
                {formatBlockValue(metric.value, metric.unit)}
                <CitationMarker citationIndex={ref?.citationIndex} evidenceId={ref?.evidenceId} onOpenEvidence={onOpenEvidence} />
              </div>
              {metric.period && <div className="text-[10px] text-gs-textDim mt-0.5">{metric.period}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
