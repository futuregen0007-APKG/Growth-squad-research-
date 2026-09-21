import { BLOCK_REGISTRY, getValidBlocks } from "./blockRegistry";

/**
 * ResponseBlocksRenderer - renders every valid, recognized block from
 * `blocks`, in a FIXED canonical order (never the array's own order,
 * which is deterministic server-side but is not a layout instruction) and
 * excluding any type listed in `exclude` (ChatMessageBubble uses this to
 * skip `source_list`/`data_quality`, which it renders itself via its
 * existing SourcesSection/GroundingStatusBadge slots when no block
 * exists — see blockRegistry.js's and DataQualityBlock's own notes on
 * why those two specifically are handled outside this generic renderer).
 *
 * Renders nothing (null) if there is nothing left to show — the caller's
 * Markdown answer is never affected by this component either way.
 */
const CANONICAL_ORDER = [
  'company_header', 'data_quality', 'metric_grid', 'comparison_table', 'chart', 'news_list', 'source_list', 'evidence_drawer', 'suggested_questions',
];

// Block types whose Component reads a citation figure and needs
// onOpenEvidence to make its [N] marker clickable.
const OPEN_EVIDENCE_TYPES = ['metric_grid', 'comparison_table', 'company_header', 'news_list', 'chart'];

export default function ResponseBlocksRenderer({ blocks, exclude = [], onAskSuggestedQuestion, onOpenEvidence }) {
  const valid = getValidBlocks(blocks).filter((block) => !exclude.includes(block.type));
  if (!valid.length) return null;

  const ordered = [...valid].sort((a, b) => CANONICAL_ORDER.indexOf(a.type) - CANONICAL_ORDER.indexOf(b.type));

  return (
    <>
      {ordered.map((block, index) => {
        const { Component } = BLOCK_REGISTRY[block.type];
        const extraProps = block.type === 'suggested_questions'
          ? { onAsk: onAskSuggestedQuestion }
          : OPEN_EVIDENCE_TYPES.includes(block.type) ? { onOpenEvidence } : {};
        return <Component key={`${block.type}-${index}`} block={block} {...extraProps} />;
      })}
    </>
  );
}
