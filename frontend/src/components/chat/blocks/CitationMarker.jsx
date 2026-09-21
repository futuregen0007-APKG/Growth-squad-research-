/**
 * CitationMarker - the small [N] superscript MetricGridBlock/
 * ComparisonTableBlock/CompanyHeaderBlock attach to a figure. A real
 * `<button>` (native keyboard focus/activation, no manual key handling
 * needed) when `onOpenEvidence` is given, opening the evidence drawer at
 * this figure's evidenceId; otherwise a plain, inert `<sup>` — exactly
 * like before evidence_drawer existed, so a message with no evidence_drawer
 * block looks and behaves unchanged.
 */
export default function CitationMarker({ citationIndex, evidenceId, onOpenEvidence }) {
  if (!citationIndex) return null;
  if (!onOpenEvidence) return <sup className="ml-0.5 text-gs-gold text-[9px]">[{citationIndex}]</sup>;
  return (
    <sup>
      <button
        type="button"
        onClick={() => onOpenEvidence(evidenceId)}
        className="ml-0.5 text-gs-gold text-[9px] hover:underline"
        data-testid="citation-marker"
        aria-label={`Open source ${citationIndex}`}
      >
        [{citationIndex}]
      </button>
    </sup>
  );
}
