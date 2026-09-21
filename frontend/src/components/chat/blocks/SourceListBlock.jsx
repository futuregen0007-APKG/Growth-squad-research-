import { isSafeBlockUrl } from "./blockHelpers";

/**
 * SourceListBlock - a structured mirror of the turn's citations, following
 * the exact same collapsible-list pattern as ChatMessageBubble's existing
 * SourcesSection (chevron toggle, numbered [N] entries, safe-href guard).
 *
 * NOT MOUNTED BY ChatMessageBubble TODAY, DELIBERATELY. SourcesSection
 * already renders this exact data (message.citations) with MORE fidelity
 * than source_list's Phase 1B schema carries on purpose (no
 * documentTitle/pageStart/temporalStatus/canonicalGuidance — those are
 * evidence_drawer's job, Phase 1C, per the approved scope). Mounting both
 * would either duplicate the same list twice or, if used to REPLACE
 * SourcesSection, would regress today's grounded-citation UX (temporal
 * badges, "Revised from X to Y", qualitative-guidance labels all
 * disappear). The component still exists, is registered in the closed
 * block registry, and is fully tested here, because: (a) the registry
 * must have a real renderer for every approved block type to be
 * genuinely "closed" rather than partially implemented, and (b) Phase 1C's
 * evidence_drawer is expected to reuse this exact list pattern once it
 * carries the richer fields.
 */
export const isValidSourceListBlock = (block) => Boolean(
  block && block.type === 'source_list' && Array.isArray(block.sources) && block.sources.length > 0,
);

export default function SourceListBlock({ block }) {
  if (!isValidSourceListBlock(block)) return null;

  return (
    <div className="mt-2.5 pt-2.5 border-t border-gs-border" data-testid="block-source-list">
      <div className="gs-label mb-1.5">{block.sources.length} source{block.sources.length !== 1 ? 's' : ''}</div>
      <div className="space-y-1.5">
        {block.sources.map((source, index) => (
          <div key={source.evidenceId || index} className="text-[11px] text-gs-textMuted flex items-start gap-1.5">
            <span className="text-gs-textDim shrink-0">[{source.citationIndex ?? index + 1}]</span>
            <div className="min-w-0">
              {source.sourceUrl && isSafeBlockUrl(source.sourceUrl) ? (
                <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-gs-gold hover:underline break-words">
                  {source.title || source.sourceUrl}
                </a>
              ) : (
                <span className="break-words">{source.title || 'Source unavailable'}</span>
              )}
              {(source.provider || source.reportingPeriod || source.publishedAt) && (
                <div className="text-gs-textDim">
                  {[source.provider, source.reportingPeriod].filter(Boolean).join(' · ')}
                  {source.publishedAt && ` ${(source.provider || source.reportingPeriod) ? '· ' : ''}${new Date(source.publishedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
