import { getThread } from '../../services/ChatThreadService.js';
import { getUserPreferences } from '../../services/ChatThreadService.js';
import { RECENT_MESSAGE_COUNT } from '../../services/ConversationSummaryService.js';
import { logger } from '../../utils/logger.js';

/**
 * loadThreadMemory - restores short-term memory from ChatThread/
 * ChatMessage. This graph has no checkpointer (see state.js's note — none
 * is installed), so this is the explicit restore step in place of one.
 * `recentHistory` excludes the current turn's own message (already
 * persisted by the controller before graph invocation, with its id passed
 * in as state.currentMessageId) so it never appears twice in the prompt.
 */
export const loadThreadMemory = async (state) => {
  if (!state.threadId || !state.userId) return {};
  try {
    const { thread, messages } = await getThread(state.userId, state.threadId);
    const priorMessages = messages
      .filter((m) => String(m._id) !== String(state.currentMessageId))
      .slice(-RECENT_MESSAGE_COUNT)
      .map((m) => ({ role: m.role, content: m.content }));

    return {
      conversationSummary: thread.summary || null,
      activeEntities: thread.activeEntities || { symbols: [], companyNames: [] },
      recentHistory: priorMessages,
    };
  } catch (error) {
    logger.warn(`[Graph] loadThreadMemory failed for thread ${state.threadId}: ${error.message}`);
    return { warnings: ['Could not load prior conversation context for this thread.'] };
  }
};

/**
 * loadUserContext - long-term memory (UserPreference). Read-only within a
 * turn; explicit preference updates happen in saveMemory at the end.
 */
export const loadUserContext = async (state) => {
  if (!state.userId) return {};
  try {
    const prefs = await getUserPreferences(state.userId);
    return {
      userContext: {
        riskAppetite: prefs.riskAppetite,
        investmentHorizon: prefs.investmentHorizon,
        goals: prefs.goals || [],
        preferredSectors: prefs.preferredSectors || [],
      },
    };
  } catch (error) {
    logger.warn(`[Graph] loadUserContext failed for user ${state.userId}: ${error.message}`);
    return {};
  }
};

export default { loadThreadMemory, loadUserContext };
