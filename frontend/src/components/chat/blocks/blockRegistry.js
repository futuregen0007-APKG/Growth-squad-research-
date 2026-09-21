import MetricGridBlock, { isValidMetricGridBlock } from "./MetricGridBlock";
import ComparisonTableBlock, { isValidComparisonTableBlock } from "./ComparisonTableBlock";
import SourceListBlock, { isValidSourceListBlock } from "./SourceListBlock";
import DataQualityBlock, { isValidDataQualityBlock } from "./DataQualityBlock";
import SuggestedQuestionsBlock, { isValidSuggestedQuestionsBlock } from "./SuggestedQuestionsBlock";
import CompanyHeaderBlock, { isValidCompanyHeaderBlock } from "./CompanyHeaderBlock";
import EvidenceDrawerBlock, { isValidEvidenceDrawerBlock } from "./EvidenceDrawerBlock";
import NewsListBlock, { isValidNewsListBlock } from "./NewsListBlock";
import ChartBlock, { isValidChartBlock } from "./ChartBlock";

/**
 * blockRegistry.js
 * ==================
 * UI Phase 1B: the CLOSED registry of approved responseBlock types. A
 * block's `type` string never becomes a component name, a class name, or
 * anything else dynamically resolved from server data — it is looked up
 * against this fixed, frozen object, and a `type` that is not a key here
 * (a Phase 1C type the frontend doesn't know yet, or anything malformed)
 * is silently ignored. This is what "the LLM/server can never make the
 * frontend render arbitrary content" means in practice: the set of
 * possible UI shapes is fixed at build time, not sent at request time.
 *
 * Each entry pairs the render component with a lightweight, defensive
 * shape guard (isValid*). The backend already validates every block with
 * Zod before it is ever sent (graph/nodes/buildResponseBlocks.js) or
 * re-read from storage (services/ChatThreadService.js's
 * fromPersistedResponseBlocks) — these guards are a SECOND, independent
 * layer here on the client, cheap and dependency-free, so a malformed or
 * unexpected payload degrades to "this one block is skipped" rather than
 * a render crash.
 */
export const BLOCK_REGISTRY = Object.freeze({
  metric_grid: { Component: MetricGridBlock, isValid: isValidMetricGridBlock },
  comparison_table: { Component: ComparisonTableBlock, isValid: isValidComparisonTableBlock },
  source_list: { Component: SourceListBlock, isValid: isValidSourceListBlock },
  data_quality: { Component: DataQualityBlock, isValid: isValidDataQualityBlock },
  suggested_questions: { Component: SuggestedQuestionsBlock, isValid: isValidSuggestedQuestionsBlock },
  company_header: { Component: CompanyHeaderBlock, isValid: isValidCompanyHeaderBlock },
  // evidence_drawer's Component is a deliberate no-op -- see EvidenceDrawerBlock.jsx's own note.
  evidence_drawer: { Component: EvidenceDrawerBlock, isValid: isValidEvidenceDrawerBlock },
  news_list: { Component: NewsListBlock, isValid: isValidNewsListBlock },
  chart: { Component: ChartBlock, isValid: isValidChartBlock },
});

export const isKnownBlockType = (type) => Object.prototype.hasOwnProperty.call(BLOCK_REGISTRY, type);

/**
 * getValidBlocks - filters an arbitrary responseBlocks array down to only
 * the blocks this build of the frontend recognizes AND that pass their
 * own shape guard. An unknown type (dev warning only, never a crash and
 * never shown to the user) or a malformed block of a known type is simply
 * absent from the result — this is the single choke point that makes
 * "ignore unknown block types safely" and "fall back to Markdown-only
 * when blocks are absent or invalid" the SAME code path, not two.
 */
export const getValidBlocks = (blocks) => {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((block) => {
    if (!block || typeof block !== 'object') return false;
    const entry = BLOCK_REGISTRY[block.type];
    if (!entry) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(`[responseBlocks] ignoring unrecognized block type: ${String(block.type)}`);
      }
      return false;
    }
    return entry.isValid(block);
  });
};

export default BLOCK_REGISTRY;
