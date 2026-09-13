import { resolveTotalDeadlineMs } from '../requestBudget.js';

export const MAX_INPUT_LENGTH = 4000;

/**
 * validateInput - the first node. Rejects empty/oversized input before any
 * model or tool call happens (cost control + Phase 11's "maximum input
 * length"). Also the ONE place deadlineAt is computed for this turn (Phase
 * 1) — every later node only reads it, never resets it (see
 * requestBudget.js's module doc).
 */
export const validateInput = async (state) => {
  const turnStartedAt = Date.now();
  // Set exactly once, here, even if the controller didn't already supply
  // one — a node must never find deadlineAt still null partway through a
  // turn and have to invent its own local timeout.
  const deadlineAt = state.deadlineAt ?? (turnStartedAt + resolveTotalDeadlineMs());
  const lastMessage = state.messages[state.messages.length - 1];
  const content = typeof lastMessage?.content === 'string' ? lastMessage.content.trim() : '';

  if (!content) {
    return { errors: ['Message cannot be empty.'], intent: 'UNSUPPORTED', turnStartedAt, deadlineAt };
  }
  if (content.length > MAX_INPUT_LENGTH) {
    return { errors: [`Message exceeds the ${MAX_INPUT_LENGTH}-character limit.`], intent: 'UNSUPPORTED', turnStartedAt, deadlineAt };
  }
  return { turnStartedAt, deadlineAt };
};

export default validateInput;
