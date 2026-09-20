import { emitEvent } from '../services/telemetry/ragTelemetry.js';

/**
 * timing.js
 * ==========
 * Wraps a graph node function so its duration is recorded into
 * state.nodeTimings (see state.js) without every node file repeating the
 * same start/end timestamp boilerplate. Applied once per node at
 * registration time in graph.js.
 *
 * Phase 5A Part 4: duration is measured with `performance.now()` (a
 * monotonic, high-resolution timer — never affected by a system clock
 * adjustment mid-request, unlike `Date.now()` which this module used
 * before this phase) — this is the ONLY change to how duration itself is
 * computed; nodeTimings' own shape ({node, durationMs}) is unchanged, and
 * every node that reads it elsewhere (logDiagnostics.js) needs no change.
 *
 * Also emits one `rag.stage.completed` telemetry event per node
 * (services/telemetry/ragTelemetry.js), reusing this SAME wrapper rather
 * than instrumenting each of the 16 node files individually — "instrument
 * existing branches instead of duplicating them" (Part 4). A node that
 * never runs (a conditional edge skips it) simply never emits an event or
 * a nodeTimings entry for that turn — the honest "skipped, not 0ms"
 * distinction Part 4 requires, for free, from the graph's own routing.
 *
 * Never changes a node's return value or error behavior — a node that
 * throws still throws (LangGraph's own error handling is unaffected);
 * this only measures and appends one safe {node, durationMs} entry plus
 * one telemetry event, and a telemetry failure can never surface here
 * (emitEvent never throws — see its own module note).
 */
export const withNodeTiming = (name, nodeFn) => async (state) => {
  const startedAt = performance.now();
  const update = await nodeFn(state);
  const durationMs = Math.round(performance.now() - startedAt);
  emitEvent('rag.stage.completed', {
    traceId: state?.traceId, requestId: state?.requestId, stage: name, durationMs,
  });
  return { ...(update || {}), nodeTimings: [{ node: name, durationMs }] };
};

export default withNodeTiming;
