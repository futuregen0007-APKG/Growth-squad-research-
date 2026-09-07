export const MAX_INPUT_LENGTH = 4000;

/**
 * validateInput - the first node. Rejects empty/oversized input before any
 * model or tool call happens (cost control + Phase 11's "maximum input
 * length").
 */
export const validateInput = async (state) => {
  const turnStartedAt = Date.now();
  const lastMessage = state.messages[state.messages.length - 1];
  const content = typeof lastMessage?.content === 'string' ? lastMessage.content.trim() : '';

  if (!content) {
    return { errors: ['Message cannot be empty.'], intent: 'UNSUPPORTED', turnStartedAt };
  }
  if (content.length > MAX_INPUT_LENGTH) {
    return { errors: [`Message exceeds the ${MAX_INPUT_LENGTH}-character limit.`], intent: 'UNSUPPORTED', turnStartedAt };
  }
  return { turnStartedAt };
};

export default validateInput;
