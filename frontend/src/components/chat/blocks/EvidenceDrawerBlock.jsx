/**
 * EvidenceDrawerBlock.jsx
 * ==========================
 * Registry entry for `evidence_drawer` — see blockRegistry.js. The
 * validation guard here is real and used by ResponseBlocksRenderer's
 * filtering; the default-exported Component is a deliberate no-op.
 *
 * evidence_drawer is NEVER mounted through the generic ResponseBlocksRenderer
 * (ChatMessageBubble excludes it from every ResponseBlocksRenderer call,
 * exactly like source_list — see that block's own note). Its actual UI is
 * EvidenceDrawerSheet, mounted directly by ChatMessageBubble as a single
 * drawer instance per message, opened by clicking a [N] citation marker —
 * not as an inline block sitting in the answer's normal flow. The registry
 * still needs a real `isValid` guard (so a malformed evidence_drawer block
 * is excluded from being treated as "present" at all) and a Component
 * entry (so the registry is genuinely complete for every approved type),
 * hence this file.
 */
export const isValidEvidenceDrawerBlock = (block) => Boolean(
  block && block.type === 'evidence_drawer' && Array.isArray(block.entries) && block.entries.length > 0
  && block.entries.every((entry) => typeof entry?.evidenceId === 'string' && entry.evidenceId.length > 0),
);

export default function EvidenceDrawerBlock() {
  return null;
}
