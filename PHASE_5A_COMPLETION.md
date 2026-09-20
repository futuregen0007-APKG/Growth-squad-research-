# Phase 5A Completion — RAG Observability, Cost Accounting, and Operational Diagnostics

Continues from commit `831f47b` (Phase 4 final closure). Phase 5A adds a
provider-neutral observability layer over the existing grounded-RAG chat
pipeline: trace identity, per-stage timing, bounded metrics, an operational
error taxonomy, LLM cost accounting, dependency state, and one access-gated
diagnostics endpoint — without changing a single answer the system gives.

The layer is strictly additive. No routing decision, no verification verdict,
no citation, and no user-visible answer depends on anything added here.

## 1. Architecture

```
HTTP request (optional X-Trace-Id from a caller/proxy)
        │
        ├─ traceContext.js ── strict UUID validation, else mint fresh (never trusts caller text)
        │
        ▼
ChatController.js ── rag.request.started · echoes X-Trace-Id on the response
        │
        ▼
LangGraph turn ── timing.js wraps EVERY node once (monotonic performance.now)
        │              └─ rag.stage.completed per node that actually ran
        │
        ├─ planTools.js ─────── rag.tools.planned
        ├─ executeTools.js ──── rag.retrieval.completed (per round)
        │                       dependency.timeout / dependency.failure (per real failing step)
        ├─ validateEvidence.js  rag.evidence.built
        ├─ composeAnswer.js ─── rag.scope.resolved · rag.generation.completed (only if a call ran)
        │                       + persists its OWN resolveResearchScope verdict as state.scopeSignal
        ├─ validateFinalAnswer  rag.verification.completed (per pass)
        ├─ repairAnswer.js ──── rag.repair.started · rag.repair.completed
        │
        ▼
logDiagnostics.js ── the ONE place a completed turn feeds observability
        │
        ├─ turnClassification.js ── bounded completion/repair/count labels
        ├─ errorTaxonomy.js ────── exactly one operational category per turn
        ├─ costEstimation.js ───── $ estimate from ALREADY-captured provider token usage
        │
        ▼
ragTelemetry.js ── allow-list → redactDeep → pluggable exporters (console, metricsStore)
        │
        ▼
metricsStore.js ── bounded in-memory aggregates (fixed labels, ring-buffered samples)
        │
        ▼
GET /api/ops/rag-metrics ── requireOpsAccess (admin + explicit opt-in in production)
```

## 2. Safety model

Two layers, in this order, and the first is the one that does the real work:

1. **Allow-listing (primary).** `ragTelemetry.js` forwards only keys named in
   `ALLOWED_DIMENSION_KEYS`/`ALLOWED_MEASUREMENT_KEYS`. Anything else a caller
   passes is silently dropped before any exporter sees it.
2. **Deterministic redaction (secondary).** `safeSerialization.js`'s
   `redactDeep` walks whatever object is passed and replaces any
   sensitive-named key at any depth with `'[REDACTED]'`, truncates over-long
   strings, caps arrays at 50 entries, and bounds recursion at depth 6 (so a
   circular structure can never hang telemetry). It never string-replaces
   known secret *values* — that only catches secrets you already know.

A trace id is accepted from a caller only if it is a syntactically valid
RFC 4122 UUID, so a client can never inject unbounded-cardinality or
adversarial content into every downstream log and metric.

Structurally, the metrics store **cannot** hold a prompt, an evidence chunk,
a citation URL, a user identity, or a trace id: counters are keyed only by
values from enums the module itself defines, and latency samples are plain
numbers in a fixed-capacity ring buffer.

## 3. Telemetry never breaks an answer

`emitEvent` never throws. Every exporter call is wrapped, a returned promise
has `.catch` attached, and a failing exporter is logged at `warn` while its
siblings still receive the event. Verified by test, for both a synchronous
throw and an async rejection.

## 4. Error taxonomy

`classifyOperationalError` makes one deterministic pass over signals the graph
already produced, in priority order, and returns exactly one of 18 categories.
The distinctions it protects:

- a client hanging up (`CLIENT_ABORTED`) is never an application failure, no
  matter what it interrupted;
- the server exhausting its own deadline (`REQUEST_DEADLINE_EXCEEDED`) is
  distinct from the client hanging up — and is *not* reported at all when the
  turn still produced a `PASSED` answer within budget;
- a provider outage (`LLM_TIMEOUT`/`LLM_PROVIDER_FAILURE`) is never reported
  as `EVIDENCE_INSUFFICIENT`;
- an honest no-evidence answer is `EVIDENCE_INSUFFICIENT`, never
  `INTERNAL_ERROR`, which is the deliberate last resort.

## 5. Cost accounting

`costEstimation.js` prices a call only from token usage the provider actually
returned (`llmInvoke.js` and `composeAnswer.js` now additionally capture
`prompt_tokens_details.cached_tokens` and
`completion_tokens_details.reasoning_tokens` when present — never estimated,
never defaulted to `0`). Cached input is priced at its own lower rate and
never double-billed as fresh input.

An unknown model or unknown usage prices as `null`, **never `0`** — so a
caller can never mistake "we don't know" for "this was free." A turn with a
mix of priced and unpriced calls sums only the priced ones and reports
`unknownCallCount`. A call that was skipped for lack of budget is genuinely
zero calls, not an unknown cost. The price table is frozen, versioned, and
dated (`PRICE_TABLE_ASOF`), never presented as permanently current.

## 6. Diagnostics endpoint

`GET /api/ops/rag-metrics` returns the metrics snapshot plus the cost-table
version, the dependency snapshot, and non-secret configuration flags
(`openAiConfigured` reports *whether* a key exists, never its value). The
payload is labelled `resetsOnRestart: true` — it is explicitly not a source
of truth and not durable.

Access (`requireOpsAccess`): in production the route is disabled entirely
unless `RAG_METRICS_ENDPOINT_ENABLED=true` **and** the caller is an
authenticated admin. Disabled, unauthenticated, forged-token, non-admin, and
deactivated-account callers all receive an identical `404` that never names
what it is hiding. Development is reachable directly unless
`RAG_METRICS_REQUIRE_AUTH=true` opts into the production-like gate locally.

## 7. Event coverage — all 14 declared events

Every name in `RAG_EVENT_NAMES` is emitted by a real lifecycle point; none
was removed as unsupported. `RAG_EVENT_SCHEMA` (exported from
`ragTelemetry.js`) documents each event's minimal contract — the fields it
always carries and the fields it may carry — built only from the
already-allow-listed dimension/measurement vocabulary.

| Event | Emitted from | When | Required fields |
|---|---|---|---|
| `rag.request.started` | `ChatController.js` (both routes) | request accepted | `traceId`, `requestId`, `route` |
| `rag.scope.resolved` | `composeAnswer.js` | once per turn, on the one node every path reaches | `traceId`, `requestId`, `researchQuestionType` |
| `rag.tools.planned` | `planTools.js` | once per turn | `traceId`, `requestId`, `toolCount` |
| `rag.retrieval.completed` | `executeTools.js` | once per retrieval round | `traceId`, `requestId`, `toolCount`, `durationMs` |
| `rag.evidence.built` | `validateEvidence.js` | once per evidence round | `traceId`, `requestId`, `evidenceCount` |
| `rag.generation.completed` | `composeAnswer.js` | only when a generation call genuinely ran | `traceId`, `requestId`, `durationMs` |
| `rag.verification.completed` | `validateFinalAnswer.js` | once per verification pass | `traceId`, `requestId`, `verificationVerdict`, `durationMs` |
| `rag.repair.started` | `repairAnswer.js` | on entry to the one allowed repair pass | `traceId`, `requestId` |
| `rag.repair.completed` | `repairAnswer.js` | on exit, success or not | `traceId`, `requestId`, `durationMs`, `repairSucceeded` |
| `rag.request.completed` | `logDiagnostics.js` | turn finished inside the graph | `traceId`, `requestId`, `completionStatus`, `errorCategory`, `durationMs` |
| `rag.request.failed` | `ChatController.js` (both routes) | **only** when the failure was outside the graph's safety net | `traceId`, `requestId`, `errorCategory`, `durationMs` |
| `rag.stage.completed` | `graph/timing.js` | per node that actually ran | `traceId`, `requestId`, `stage`, `durationMs` |
| `dependency.timeout` | `executeTools.js` | a tool hit `TIMEOUT`/`CANCELLED`/`DEADLINE_EXCEEDED` | `traceId`, `requestId`, `tool` |
| `dependency.failure` | `executeTools.js` | any other tool-level error code | `traceId`, `requestId`, `tool` |

**Counted once, by construction.** The three places a turn could plausibly be
counted twice are each closed deliberately:

- *A turn that answered, then broke while responding.* Both controllers now
  set `graphCompleted` immediately after `graph.invoke` resolves. Past that
  point `logDiagnostics` has already recorded the turn and emitted
  `rag.request.completed`, so the catch block emits **no**
  `rag.request.failed` and does **not** call `recordRequest` again. Previously
  a late socket error counted one turn as both completed and failed.
- *A deduplicated tool step.* `executeTools` already collapses identical steps
  into one real call; only the genuinely-executed step reports a
  `dependency.*` event, so one outage is never counted per planned step.
- *Legitimate repeats.* A replan cycle really does run retrieval twice, and a
  repaired draft really is verified twice. These emit two events on purpose —
  `rag.verification.completed` carries `repairAttempted` so the second pass is
  distinguishable — and the schema documents this so a consumer never reads a
  real second round as a duplicate of the first.

**What no event carries.** No schema declares — and no emit site passes — a
prompt, a model response, streamed token text, evidence or document text, a
citation URL, a credential, a user identity, or a raw token count. Token
counts and their derived cost deliberately stay where Phase 5A already
captured them (`state.llmCalls`, summed once per turn by `logDiagnostics`),
so no per-stage event re-carries them. Both controllers cover the streaming
and legacy routes identically, and `traceId` + `requestId` are required on
every one of the 14 events, so a single request's events always link
together — including a trace id a caller supplied, once validated.

## 8. Defects found and fixed while completing this phase

Three real gaps between what the in-flight Phase 5A code *documented* and what
it *did*, all found by writing the tests the phase did not yet have (a fourth,
the late-failure double count, is covered in §7):

1. **`requireOpsAccess` leaked the endpoint's existence.** The module
   documented "unauthenticated/non-admin all respond 404 — never revealing
   whether the route exists," but `middleware/auth.js`'s `authenticate`
   answers a failed authentication with its own `401` written directly to the
   response, and never calls `next(err)` — so the `if (err)` branch was dead
   code and an unauthenticated production caller received a `401`, confirming
   the route exists. Fixed by handing `authenticate` a minimal response
   stand-in that captures its rejection and converts it to this module's own
   `404`, rather than duplicating (and risking drift from) its real
   token/user/account-status checks. The success path is untouched:
   `authenticate` still sets `req.user`/`req.userId` on the real request.

2. **A rate-limited retrieval tool was reported as an LLM failure.**
   `RETRIEVAL_FAILURE_CODES` included `'RATE_LIMITED'`, but an earlier generic
   check claimed *any* rate-limited tool as `LLM_RATE_LIMITED` — making that
   entry unreachable for the one kind of tool it existed to describe, and
   conflating two layers the module's own comments insist are "never
   conflated." Fixed by naming the retrieval tools once (`RETRIEVAL_TOOLS`)
   and excluding them from the generic rate-limit check, so the retrieval
   branch classifies them.

3. **`summarizeReadiness`'s `'degraded'` verdict was unreachable.**
   `localRetrieval` (a *required* dependency) collapsed anything short of
   `'ready'` to `'unavailable'`, so a merely *connecting* MongoDB — the only
   state that can ever produce `'degraded'` — always summarised as
   `'unavailable'`. Fixed by having every MongoDB-backed store mirror
   MongoDB's own status instead of flattening it.

Additionally, `isSensitiveKey` was exposed as a named export (it was already
on the module's default export) so the redaction vocabulary is directly
testable.

## 9. Part 14 — trace id in the UI

The server already returned `traceId` on `message.completed` and
`message.error` and echoed it on the `X-Trace-Id` response header.
`useChatStream.js` now carries it through both paths — on the resolved value,
and on the rejected `Error` itself — and `AIResearch.jsx` shows it as a quiet
`Reference: <id>` line **only** beneath a genuine send failure, cleared
whenever the error is. Nothing else about the run is exposed: no node names,
no timings, no diagnostics. A turn whose server sent no trace id yields
`null`, never an invented one.

## 10. Test coverage added

The phase's new backend code had **zero** tests. Six new backend files (112
tests) and one frontend file (6 tests) now cover it, and all seven are
registered in `package.json`'s explicit test-file list (the same list a gap in
which silently excluded two files from every "full suite" run in Phase 4F.2):

| File | Tests | Covers |
|---|---|---|
| `tests/telemetrySafety.test.js` | 14 | redaction, truncation, depth/array bounds, circular safety, trace-id validation, allow-listing, exporter isolation |
| `tests/telemetryMetrics.test.js` | 24 | store isolation, cardinality bounds, ring-buffer eviction, percentile thresholds, token/cost accounting, null-vs-zero |
| `tests/telemetryClassification.test.js` | 25 | full error-taxonomy priority order, completion buckets, turn metrics, no-free-text invariant |
| `tests/opsMetricsEndpoint.test.js` | 15 | every access-gate branch, endpoint payload shape, secret-leak check, dependency states |
| `tests/telemetryEventContract.test.js` | 22 | every event's name/schema/payload driven through the REAL nodes, timing, redaction, per-round vs duplicate |
| `tests/telemetryRequestLifecycle.test.js` | 12 | both controllers' lifecycle events, trace-id propagation and rejection, the late-failure double-count guard |
| `frontend/src/__tests__/chatStreamTraceId.test.js` | 6 | trace id on success and failure paths, null when absent, no internals alongside |

The event-contract and lifecycle tests drive the **real** node and controller
functions rather than imitating what they are assumed to emit, so a call site
that stops emitting, drifts from its schema, or starts carrying something
sensitive fails the suite.

Three assertions deliberately encode the fixes in §8 rather than the old
behavior: "an UNAUTHENTICATED caller gets 404, not 401", "a rate-limited
RETRIEVAL tool is a retrieval failure, not an LLM rate limit", and "a request
the graph answered is never ALSO counted as failed when something later
throws" — the last of which asserts the failure path genuinely ran (HTTP 500)
before asserting no event followed, so it cannot pass for the wrong reason."

## 11. Test and build totals

- Backend: **1239/1239** passing (`npm test`, the complete registered
  112-file suite) — up from 1127 at Phase 4 closure, +112 new tests, zero
  failures, zero skipped.
- Frontend: **92/92** passing across 11 suites (`npm test`, CI mode) — up
  from 86, +6 new tests.
- Production build: succeeds from a clean `build/` (`npm run build`).

The four pre-existing backend test files modified earlier in this phase
(`chatComposeAnswer`, `chatZeroEvidenceFastPath`, `groundedAnswerPipeline`,
`llmInvoke`) were adjusted only to accept additive fields (`scopeSignal`,
`cachedInputTokens`/`reasoningTokens`); none had an assertion weakened.

## 12. Files changed

New: `backend/services/telemetry/{traceContext,safeSerialization,ragTelemetry,metricsStore,costEstimation,errorTaxonomy,turnClassification,dependencyState}.js`,
`backend/routes/ops.js`, `backend/middleware/requireOpsAccess.js`,
`backend/tests/{telemetrySafety,telemetryMetrics,telemetryClassification,opsMetricsEndpoint,telemetryEventContract,telemetryRequestLifecycle}.test.js`,
`frontend/src/__tests__/chatStreamTraceId.test.js`, this document.

Modified: `backend/controllers/ChatController.js`, `backend/graph/{state,timing,llmInvoke}.js`,
`backend/graph/nodes/{planTools,executeTools,validateEvidence,composeAnswer,validateFinalAnswer,repairAnswer,logDiagnostics}.js`,
`backend/server.js`, `backend/package.json`,
`backend/tests/{chatComposeAnswer,chatZeroEvidenceFastPath,groundedAnswerPipeline,llmInvoke}.test.js`,
`frontend/src/hooks/useChatStream.js`, `frontend/src/pages/AIResearch.jsx`.

`validateFinalAnswer.js` and `repairAnswer.js` follow the same wrapper pattern
`composeAnswer.js` already used: the existing node function is renamed to an
untouched `*Inner`, and a thin exported wrapper emits around it — so every one
of their many early-return branches is covered identically and none can be
missed, with no change to control flow or return values.

## 13. Remaining limitations

- No exporter beyond `console` and the in-memory store exists yet. A
  CloudWatch/OpenTelemetry integration is a new `registerExporter` call, never
  a change to any call site — but it has not been written or verified.
- The metrics store is in-process and per-instance: under more than one server
  process or dyno, `/api/ops/rag-metrics` reports only the instance that served
  the request. It is labelled `resetsOnRestart` but not labelled per-instance.
- `estimateRequestCost` is called only from `logDiagnostics`, so a turn that
  fails *outside* the graph's own safety net records an error category and a
  request count but no cost.
- The price table was confirmed manually against published pricing on
  2026-09-19 and is not auto-fetched; it will silently drift as prices change.
  An unknown model prices as `null`, so drift shows up as `costUnknownCount`
  rather than as a wrong number.
- `/ready` deliberately still does not use `getDependencySnapshot` — it must
  stay cheap on the hot path.

---

## Verdict

**PHASE 5A COMPLETE FOR LOCAL DEVELOPMENT — EVERY DECLARED EVENT WIRED AND
UNDER TEST, OBSERVABILITY ACCESS-GATED, AND PROVEN NON-INTRUSIVE TO EVERY
EXISTING ANSWER PATH.**

No carry-over remains from this phase's own scope. The items in §13 are
production/integration concerns that were never in it.
