import { Annotation } from '@langchain/langgraph';

/**
 * state.js
 * =========
 * GS Copilot's typed LangGraph state (Annotation.Root — the installed
 * @langchain/langgraph@1.4.8's official state API). Deliberately excludes:
 *   - API keys / auth tokens (read from env/req at the controller boundary,
 *     never placed in state or persisted checkpoints)
 *   - Full raw provider payloads (tools compact these into evidence records)
 *   - Chain-of-thought (never generated, never stored)
 *
 * This graph does NOT use a LangGraph checkpointer (none of
 * @langchain/langgraph-checkpoint-mongodb or similar is installed — see
 * the Phase 1 audit). Thread memory is restored explicitly into `messages`
 * by services/ChatThreadService.js before graph.invoke/stream is called;
 * see controllers/ChatController.js.
 */

const replace = (_current, update) => update;

export const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),

  userId: Annotation({ reducer: replace, default: () => null }),
  threadId: Annotation({ reducer: replace, default: () => null }),
  requestId: Annotation({ reducer: replace, default: () => null }),
  currentMessageId: Annotation({ reducer: replace, default: () => null }),
  turnStartedAt: Annotation({ reducer: replace, default: () => null }),

  // Short-term memory restored from ChatThread/ChatMessage before this
  // turn's model calls. `recentHistory` holds the last N prior turns
  // VERBATIM (plain {role, content} objects — never summarized);
  // `conversationSummary` covers everything older than that window.
  conversationSummary: Annotation({ reducer: replace, default: () => null }),
  recentHistory: Annotation({ reducer: replace, default: () => [] }),
  activeEntities: Annotation({ reducer: replace, default: () => ({ symbols: [], companyNames: [] }) }),

  intent: Annotation({ reducer: replace, default: () => null }),
  intentConfidence: Annotation({ reducer: replace, default: () => null }),

  entities: Annotation({
    reducer: replace,
    default: () => ({ symbols: [], companyNames: [], periods: [], comparisonMode: false }),
  }),

  // Long-term memory (UserPreference) — read-only within a turn; writes go
  // through ChatThreadService.saveExplicitPreferences from saveMemory.
  userContext: Annotation({
    reducer: replace,
    default: () => ({ riskAppetite: null, investmentHorizon: null, goals: [], preferredSectors: [] }),
  }),

  toolPlan: Annotation({ reducer: replace, default: () => [] }),
  toolResults: Annotation({ reducer: replace, default: () => [] }),
  evidence: Annotation({ reducer: replace, default: () => [] }),

  answer: Annotation({ reducer: replace, default: () => null }),
  citations: Annotation({ reducer: replace, default: () => [] }),
  tokenUsage: Annotation({ reducer: replace, default: () => null }),

  warnings: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
  errors: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),

  // Streaming callback set by the controller — not persisted, not part of
  // any checkpoint (this graph has none), purely an in-memory hook the
  // composeAnswer node uses to emit token/status events as they happen.
  onEvent: Annotation({ reducer: replace, default: () => null }),

  // Abort check set by the controller (returns true once the client has
  // disconnected or called stop) — composeAnswer polls it between stream
  // chunks so generation halts promptly instead of running to completion
  // after nobody is listening.
  aborted: Annotation({ reducer: replace, default: () => null }),
});

export default GraphState;
