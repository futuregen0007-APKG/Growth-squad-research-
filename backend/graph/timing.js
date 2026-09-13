/**
 * timing.js
 * ==========
 * Wraps a graph node function so its wall-clock duration is recorded into
 * state.nodeTimings (see state.js) without every node file repeating the
 * same start/end timestamp boilerplate. Applied once per node at
 * registration time in graph.js.
 *
 * Never changes a node's return value or error behavior — a node that
 * throws still throws (LangGraph's own error handling is unaffected);
 * this only measures and appends one safe {node, durationMs} entry.
 */
export const withNodeTiming = (name, nodeFn) => async (state) => {
  const startedAt = Date.now();
  const update = await nodeFn(state);
  const durationMs = Date.now() - startedAt;
  return { ...(update || {}), nodeTimings: [{ node: name, durationMs }] };
};

export default withNodeTiming;
