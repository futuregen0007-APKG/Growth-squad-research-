import { BLOCK_BUILDERS } from '../../services/responseBlocks.js';
import { MAX_RESPONSE_BLOCKS } from '../schemas.js';
import { logger } from '../../utils/logger.js';

/**
 * buildResponseBlocks - UI Phase 1B. Runs ONLY on the publish path
 * (graph.js wires it publishFinalAnswer -> buildResponseBlocks ->
 * logDiagnostics; buildSafeFallback goes straight to logDiagnostics,
 * unchanged), so every call here already has a validated `answer` and
 * `citations` in hand — this node builds structured supplements to that
 * answer, never a replacement or a re-check of it.
 *
 * NEVER modifies answer/citations/claims. Every builder in
 * services/responseBlocks.js is pure (no I/O), but graph/timing.js's
 * withNodeTiming wrapper does NOT catch a node that throws — a broken
 * builder must not be able to fail the whole turn after the user's answer
 * is already correct and ready to publish. Both layers of defense are
 * applied: each builder call is individually wrapped so one bad builder
 * doesn't take the others down, AND the whole function is wrapped so even
 * an unexpected failure in the loop itself still returns the safe default
 * (`responseBlocks: []`) rather than throwing.
 */
const buildResponseBlocksInner = (state) => {
  const blocks = [];
  for (const builder of BLOCK_BUILDERS) {
    try {
      const block = builder(state);
      if (block) blocks.push(block);
    } catch (error) {
      // A single builder failing is an omission, never a turn failure —
      // the answer the user already has is untouched either way.
      logger.warn(`[responseBlocks] ${builder.name || 'builder'} failed: ${error.message}`);
    }
  }
  return { responseBlocks: blocks.slice(0, MAX_RESPONSE_BLOCKS) };
};

export const buildResponseBlocks = (state) => {
  try {
    return buildResponseBlocksInner(state);
  } catch (error) {
    logger.warn(`[responseBlocks] buildResponseBlocks failed entirely: ${error.message}`);
    return { responseBlocks: [] };
  }
};

export default buildResponseBlocks;
