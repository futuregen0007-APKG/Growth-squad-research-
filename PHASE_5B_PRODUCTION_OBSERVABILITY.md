# Phase 5B — Production Observability

Continues from `d8b48ed` (Phase 5A). Phase 5A made the RAG pipeline
observable *in one process*: 14 events, a bounded in-memory metrics store,
an error taxonomy, cost accounting, and one access-gated diagnostics
endpoint. Phase 5B makes that layer usable in production — it can ship to a
real backend, aggregate across instances, account for cost that Phase 5A
structurally lost, price models from validated configuration, and report
dependency state on `/ready`.

Every Phase 5A contract, export, and test is preserved. No answer the
system gives changes.

## 1. What was added

```
                        ┌─ console exporter            (Phase 5A, unchanged)
ragTelemetry.emitEvent ─┼─ metricsStore exporter       (Phase 5A, unchanged)
   (allow-list →        └─ otlpExporter  ◄── NEW, registered only when configured
    redactDeep)              │
                             ├─ bounded queue (drop-oldest, counted)
                             ├─ timer flush → batched OTLP/HTTP JSON POST
                             ├─ per-request timeout · bounded retry · backoff
                             └─ safe shutdown (bounded flush)

metricsStore (in-process, synchronous, always)
   │
   └─ sharedMetrics mirror ◄── NEW, timer-driven, never on the request path
        │  deltas → Redis HINCRBY (atomic, TTL'd, fixed keyspace)
        ▼
      GET /api/ops/rag-metrics → cluster view + aggregation mode/degraded status

LLM call completes ──► costLedger.recordLlmCall ◄── NEW (exactly-once, at the call site)
   │                        │
   │                        └─ modelPricing ◄── NEW (validated config, aliases, staleness)
   └─ logDiagnostics sweep ─┘  (safety net; the ledger refuses the duplicate)

/health  → liveness only, untouched
/ready   → + three-state verdict + dependency snapshot ◄── NEW
```

## 2. Files changed

**New (backend/services/telemetry/):** `otlpExporter.js`, `sharedMetrics.js`,
`costLedger.js`, `modelPricing.js`.

**New tests:** `telemetryOtlpExporter.test.js`, `telemetrySharedMetrics.test.js`,
`telemetryCostLedger.test.js`, `modelPricing.test.js`,
`healthReadinessOps.test.js` — all registered in `package.json`'s explicit list.

**Modified:** `costEstimation.js` (delegates pricing data to `modelPricing`,
same exports/values), `llmInvoke.js` / `composeAnswer.js` / `repairAnswer.js`
(calls recorded at completion), `logDiagnostics.js` (sweep via the ledger),
`routes/ops.js` (aggregation/exporter/pricing/ledger reporting),
`utils/healthHandlers.js` (readiness verdict, dependency snapshot, production
error redaction), `server.js` (startup + shutdown wiring),
`frontend/src/__tests__/chatStreamTraceId.test.js` (act() fix).

## 3. Exporter choice: OTLP/HTTP JSON, hand-rolled

**Chosen:** emit the OTLP/HTTP **JSON** encoding directly, mapping events to
OTLP **logs**, registered through Phase 5A's existing `registerExporter`.

**Why not the OpenTelemetry SDK.** OTLP is the vendor-neutral target the goal
asks for, and every major backend ingests it — but `@opentelemetry/sdk-node`
would add a large transitive dependency tree and a *second* batching and
shutdown lifecycle competing with the one this layer already needs, in
exchange for an encoding that is a few dozen lines. This telemetry layer is
currently dependency-free; keeping it that way avoids a supply-chain surface
for a component that, by design, sees every request. The tradeoff accepted:
no auto-instrumentation and no W3C context propagation — neither of which
this layer wants, since its events are deliberately hand-built and
allow-listed rather than captured.

**Why logs, not spans.** These events are discrete structured records, not a
parent/child timing tree. Where a `traceId` exists it is written into the
LogRecord's own `trace_id` (a UUID is exactly the 16 bytes OTLP wants), so a
collector can still correlate them with real traces.

**Failure behaviour, all tested:** `export()` is synchronous and O(1) — it
enqueues and returns, never touching the network on the caller's tick. The
queue is hard-capped; past the cap the **oldest** events are dropped and
counted (during an incident the newest are the ones being looked at). Each
POST has an `AbortController` timeout. A failed batch retries a bounded
number of times with backoff, then is dropped — never re-queued into
unbounded growth. **Retry policy:** 5xx and transport failures retry; of the
4xx range only **408** (collector gave up waiting) and **429** (slow down)
retry, because every other 4xx is a rejection of this exact body that would
fail identically. A server-supplied **`Retry-After`** (delay-seconds or
HTTP-date) is honoured over local backoff, capped at 30s so a hostile or
mis-configured collector cannot stall the flush loop. `shutdown()` stops the timer and
flushes within a bounded time. **Unconfigured, nothing is registered and no
timer starts**, so local behaviour is exactly Phase 5A's.

## 4. Storage choice: Redis, with automatic in-process fallback

**Chosen:** the existing Redis connection (`utils/redisClient.js`).

**Why Redis over Mongo — both already exist, so neither is a new dependency:**

1. **`HINCRBY` is what counter aggregation is for**: atomic, O(1), no
   read-modify-write, so N instances incrementing concurrently cannot lose an
   update. The Mongo equivalent is either a write per event or a race.
2. **Blast radius.** Mongo is a *required* dependency here — it serves the
   research corpus every grounded answer depends on. Putting a write on it
   for every chat turn adds load to the one datastore whose failure takes the
   product down. Redis is already optional and degradable in this codebase,
   which is the correct blast radius for observability data.
3. **Durability is not needed.** Phase 5A already labels the snapshot
   `resetsOnRestart`; it is explicitly not a source of truth. Redis's TTLs
   additionally give bounded, self-cleaning keys for free.
4. **The fallback path already exists and is proven**: `redisClient.js`
   returns `null` when Redis is unavailable and every helper swallows errors.

**Caveat found, verified live, and FIXED.** That client was built with
`reconnectStrategy: false`, so once a connection dropped it never came back.
Confirmed against a real Redis container: stop it, start it again, and the
same client stayed `isOpen: false` and `degraded` forever — a momentary blip
became "no cache, metrics stuck degraded, until the next deploy."
`utils/redisClient.js` now uses a **bounded** reconnect (200ms→3s backoff,
10 attempts, then gives up exactly as before). Re-verified live: the same
client now self-heals.

**Second bug that fix exposed, also fixed.** While node-redis retries a
dropped connection it keeps `isOpen: true`, so the aggregation status
reported `shared` while every write was failing. Health is now judged by
whether operations actually *succeed* (`consecutiveFailures`), not by
`isOpen`. Verified live and pinned by unit tests.

### Delivery guarantees — precise

These counters are **best-effort**. They are not exact, and not strictly
at-least-once either. Do **not** treat a cluster total as a billing or audit
figure.

| Situation | Outcome |
|---|---|
| Healthy steady state | **Exact.** Each tick applies the delta since the last acknowledged tick, atomically. |
| Failed tick (refused/unreachable/timeout) | **Nothing applied** — `MULTI` is all-or-nothing — and the baseline does not advance, so counts fold into the next successful tick. Nothing lost, nothing doubled. *(Verified live.)* |
| **Ambiguous ack** (EXEC ran server-side, reply lost) | **Double-counted.** We cannot distinguish "never applied" from "applied, ack lost", and we choose to re-send rather than silently lose data. |
| **Process crash** | Counts since the last successful tick (≤ one interval, 15s default) are **lost.** The in-process store is not durable by design. |

So a crash window can **lose** counts and an ambiguous-ack window can
**duplicate** them. Use these numbers for rates, ratios, and order of
magnitude. Anything that must be accounted for precisely belongs in the
per-turn cost ledger or the OTLP event stream.

**Second risk found and closed:** node-redis has no per-command timeout, so a
*half-open* connection accepts commands that never settle. Unbounded, that
would hang the ops endpoint an operator is using during an incident, and
would wedge the mirror's in-flight guard permanently. Every Redis interaction
is now raced against a 1s deadline (`REDIS_OP_TIMEOUT_MS`), tested with a
client that never answers.

**Cardinality and content.** Fields written are the metrics store's own
bounded enum labels plus a fixed list of totals; a field not on that list is
never written. The keyspace is three TTL'd hashes under a version-pinned
namespace. Nothing derived from request content — no prompt, answer,
evidence, citation, identity, credential, trace id, symbol, or query — is
ever a key or a value. Cost accumulates as integer micro-dollars, because
`HINCRBY` is integer-only and float accumulation across instances drifts.

**Latency percentiles are deliberately *not* merged.** p50/p95/p99 from
separate ring buffers cannot be validly combined, and shipping raw samples
would be exactly the unbounded growth this design forbids. Latency stays
per-instance and the payload says so (`latencyScope`) rather than presenting
a plausible number that is not true.

## 5. Exactly-once cost capture

**The Phase 5A gap:** cost was summed in `logDiagnostics`, at the end of a
turn. Correct for a turn that finishes; **everything is lost for a turn that
does not** — a node throwing, a client aborting mid-graph, any failure before
that node runs. Calls that were really made, and really billed, were never
counted. Under-reporting cost is silent, compounding, and discovered on an
invoice.

**The fix:** `costLedger` records a call the moment it *completes*, at its own
call site (`llmInvoke.js`, `composeAnswer.js`, `repairAnswer.js` — which
covers every node, since the rest route through `invokeRoutingModel`), before
anything downstream can fail. `logDiagnostics` still sweeps `state.llmCalls`
as a safety net for any call site not wired up.

**Exactly-once** is by object identity in a `WeakSet`: the diagnostic object
created at the call site is the same one that reaches `state.llmCalls`
(`graph/state.js`'s reducer is `x.concat(y)`, which copies references, and
nothing clones these objects — verified). That costs no field on the
diagnostic, so Phase 5A's exact-key-set contract for `invokeRoutingModel`'s
diagnostic is preserved verbatim, and a `WeakSet` cannot leak. An explicit
`callId` is honoured too, for a path where an object might be copied.

`costUnknownCount` is preserved exactly: an unknown model or unknown usage
records `null` cost (incrementing `costUnknownCount`), never `0`. A call
skipped for lack of budget is genuinely zero calls — not an unknown cost.

## 6. Pricing configuration

`modelPricing.js` holds the data; `costEstimation.js` keeps only the
arithmetic and re-exports `PRICE_TABLE` / `PRICE_TABLE_VERSION` /
`PRICE_TABLE_ASOF` unchanged in name, shape, and value.

- **Provenance recorded:** `PRICING_SOURCE`, `PRICING_VERSION`,
  `PRICING_LAST_UPDATED`, `PRICING_CURRENCY`.
- **Validated at load.** A malformed entry (missing/zero/negative rate,
  cached input dearer than fresh input, unknown field) is **dropped**, not
  trusted — so it prices as *unknown*, the safe direction — and the rejection
  is logged. Validation never throws: a price typo must not stop the server
  answering questions.
- **Aliases are an explicit map**, never a pattern. Stripping a `-YYYY-MM-DD`
  suffix automatically would silently price a genuinely new model at an old
  model's rate. An unlisted pinned id resolves to `null` and prices as
  unknown, which is correct: nobody has confirmed what it costs.
- **Staleness is reported, not enforced.** `getPricingMetadata()` exposes
  `ageDays` / `stale`; a stale table still prices. Drift surfaces as a
  visible flag rather than a silently wrong number.

## 7. Health and readiness

`/health` is untouched — pure liveness, 200 while the process runs, with no
dependency opinion to leak. It must never gain a dependency check, or a
dependency blip would get healthy pods **killed** rather than drained.

`/ready` keeps its existing gate exactly (Mongo connected → 200/`ready`,
otherwise 503/`starting`) and adds:

- `readiness`: `'ready' | 'degraded' | 'unavailable'` — "still connecting" is
  now distinguishable from "gone", which the single `starting` label could
  not express.
- `dependencies`: the per-dependency snapshot, **reporting only**. It
  deliberately does not drive the HTTP code: a missing `OPENAI_API_KEY` must
  not pull an instance out of rotation, since every non-chat route keeps
  working without it. Letting it would turn one missing env var into a total
  outage. It is reported, not hidden.
- **Production error redaction.** `mongoLastError` is a driver message that
  can carry host, port, and replica-set topology. In production it is
  replaced with a bounded reason code; locally it stays verbatim, where it is
  the fastest way to debug. Tested with a realistic leaky string.

## 8. Environment variables

All optional. With none set, behaviour is exactly Phase 5A's.

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | **Setting this enables export.** Unset = no exporter registered, no timer. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `<endpoint>/v1/logs` | Full signal-specific URL override. |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | `k=v,k=v`. **Secret** (collector credentials); never logged or reported. |
| `OTEL_SERVICE_NAME` | `gs-copilot-backend` | OTLP `service.name`. |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `NODE_ENV` | OTLP `deployment.environment`. |
| `OTEL_SDK_DISABLED` | — | `true` disables export even with an endpoint set (kill switch). |
| `OTEL_BSP_MAX_QUEUE_SIZE` | `2048` | Hard cap; oldest dropped past it. |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | `256` | Max records per POST. |
| `OTEL_BSP_SCHEDULE_DELAY` | `5000` | Flush interval (ms). |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `10000` | Per-request timeout (ms). |
| `OTEL_EXPORTER_OTLP_MAX_RETRIES` | `2` | Bounded; batch dropped after. |
| `OTEL_EXPORTER_OTLP_RETRY_DELAY_MS` | `500` | Backoff base. |
| `OTEL_EXPORTER_OTLP_SHUTDOWN_TIMEOUT_MS` | `3000` | Max shutdown flush wait. |
| `RAG_METRICS_SHARED_AGGREGATION` | — | `true` enables Redis aggregation (uses existing `REDIS_*`). |
| `RAG_METRICS_ENDPOINT_ENABLED` | — | Phase 5A: required in production, with an admin caller. |
| `RAG_METRICS_REQUIRE_AUTH` | — | Phase 5A: opt into the production-like gate locally. |

Invalid numeric values fall back to the default rather than disabling export.

> **Note:** `.env.example` is matched by `.gitignore`'s `.env.*` rule, so it
> is **not tracked** in this repository. It was updated locally for the
> working copy, but this table is the version-controlled reference.

## 9. Live integration evidence

Verified against **real disposable containers**, not test doubles:

```
docker run -d --name gsr-redis -p 63790:6379 redis:7-alpine
docker run -d --name gsr-otel-collector -p 43180:4318   -v "$PWD/otel-collector-config.yaml:/etc/otelcol/config.yaml:ro"   -v "$PWD/otel-output:/output"   otel/opentelemetry-collector:latest --config=/etc/otelcol/config.yaml

OTLP_TEST_ENDPOINT=http://localhost:43180 REDIS_TEST_URL=redis://localhost:63790 npm run observability:verify
```

`backend/scripts/verifyObservabilityIntegration.js` is **opt-in** and is not
part of `npm test` — with its endpoints unset it prints SKIPPED and exits 0,
so the registered suite still runs with no network and no containers.

**Result: 59 passed, 0 failed** (otelcol 0.160.0, redis 7-alpine).

**OTLP — against a real OpenTelemetry Collector**

- Endpoint resolution → `http://localhost:43180/v1/logs`; requests observed
  arriving at path `/v1/logs`.
- The collector **accepted** the payload: `HTTP 200 {"partialSuccess":{}}` —
  i.e. zero rejected records, proving `resourceLogs` / `scopeLogs` /
  `logRecords` / AnyValue encodings are genuinely valid, not merely
  self-consistent.
- **13 logRecords were ingested and persisted** by the collector's file
  exporter, carrying `service.name=gs-copilot-backend`, body
  `rag.request.completed`, and `traceId=123e4567e89b42d3a456426614174000` —
  the UUID correctly encoded as 32 lowercase hex chars (16 bytes).
- `timeUnixNano` is a 19-digit nanosecond epoch; integers encode as
  `intValue` (string), fractions as `doubleValue`, labels as `stringValue`.
- Configured headers reach the wire (`api-key` observed server-side).
- Retry policy, measured attempt counts: 400/404/422 → **1 attempt**;
  408/429/503 → **2 attempts** with `maxRetries: 1`.
- `Retry-After: 1` on a 429 → measured **1009ms** wait before the retry,
  overriding a 5ms local backoff.
- Non-answering collector → aborted at **304ms** (`timeoutMs: 300`), batch
  dropped, queue not re-grown.
- Queue overflow: 20 events into a cap of 4 → depth **4**, dropped **16**.
- Shutdown against a black hole returned in **3001ms** (its bound); against
  a healthy collector it flushed 2 pending events with **0 abandoned**.
- Completely unreachable collector → never threw to the caller.

**Redis — two simulated instances against a real server**

- Instance A (7 requests) + Instance B (5) → shared `requestTotal = 12`,
  `completionStatus:grounded = 12`, `inputTokens = 3000`.
- Fractional cost summed exactly through integer micro-dollars:
  `0.000123 + 0.000456 = 0.000579`.
- Both instances counted live (`instanceCount = 2`).
- Re-mirroring an unchanged snapshot added **nothing** (no duplicate
  increments); new activity applied **only** the delta (12 → 13).
- A write against a downed client failed cleanly and applied **nothing** —
  shared state stayed at 13, confirming `MULTI` all-or-nothing.
- Instance B reported `degraded` while A stayed `shared` and unaffected.
- After reconnection, buffered counts landed exactly once: 13 → **14**, with
  `completionStatus:grounded = 14` (not double-counted).
- Real container stop/start proved the reconnect fix: before it, the same
  client stayed `isOpen=false`/`degraded` permanently; after it, the same
  client self-heals and returns to `shared`.

**Endpoints under real dependency states**

| State | `/health` | `/ready` | `readiness` |
|---|---|---|---|
| Mongo connected | 200 | 200 | `ready` |
| Mongo connecting | 200 | 503 | `degraded` |
| Mongo unavailable | 200 | 503 | `unavailable` |

- `/health` stayed 200 in every case — a dependency outage never gets a pod
  killed.
- `/ready` redacted the driver error (`connect ECONNREFUSED 10.0.0.5:27017`)
  in production and kept it in development.
- `/api/ops/rag-metrics` answered 200 with Redis unavailable, reported
  `aggregation.mode: 'degraded'`, still served local numbers, and carried no
  secret.

## 10. Test and build totals

- Backend: **1351/1351** passing (`npm test`, the complete registered 117-file
  suite) — up from 1239 at Phase 5A, **+112 new tests**, zero failures, zero
  skipped. Re-run with **both containers stopped**: still 1351/1351, proving
  the registered suite has no hidden infrastructure dependency.
- Frontend: **92/92** passing across 11 suites, now with **zero `act()`
  warnings**.
- Live integration: **59/59** against real containers (§9).
- Production build: succeeds from a clean `build/`.

New coverage: OTLP buffering/timeout/retry/redaction/shutdown/disabled (31),
shared aggregation and fallback (26), exactly-once cost (16), pricing config
(20), health/readiness/ops (19).

## 11. Risks and failure modes

- **Collector outage** → events buffer to the cap, then oldest-dropped and
  counted; `exporter.dropped` on the ops endpoint is the signal. No request
  is affected. Worst case is bounded memory (`maxQueueSize` events).
- **Redis outage** → `aggregation.mode: 'degraded'`, local numbers served.
  Because the shared client never reconnects (`reconnectStrategy: false`),
  recovery requires a process restart; the mode field makes that visible
  rather than silent.
- **Mirror lag.** The mirror ticks every 15s, so the cluster view trails
  real time by up to that. Counters are deltas, so a missed tick folds into
  the next one — nothing is lost or double-counted.
- **Instance registry** is capped and pruned on read, so restart churn cannot
  grow it.
- **Cost under/over-count.** The ledger's identity dedupe depends on nothing
  cloning `llmCalls` entries. That holds today (verified); a future node that
  spreads a diagnostic into a new object would double-count it. The explicit
  `callId` path exists for that case, and the ledger's
  `duplicateCallCount` on the ops endpoint would show the drift.
- **Pricing drift** surfaces as `pricing.stale` and `costUnknownCount`, never
  as a silently wrong figure.
- **Ops endpoint** does one bounded Redis read per call; it never writes, so
  reading metrics cannot perturb them.

## 12. Carry-over

Resolved since the first draft of this document: the exporter **is** now
verified against a live OpenTelemetry Collector, aggregation **is** verified
against a real Redis with two instances, and `redisClient.js` **does** now
reconnect (all in §9). What remains:

- **Cluster latency percentiles remain unavailable** by design (§4). A correct
  implementation needs a mergeable sketch (t-digest/HDR histogram), which is a
  larger change than this phase.
- **Cluster totals are best-effort, not exact** (§4). A crash window can lose
  up to one mirror interval of counts; an ambiguous ack can duplicate a tick.
  Never quote these as billing or audit figures.
- **Not soak-tested.** Verification was functional, against one collector and
  one Redis, for seconds at a time. Sustained throughput, memory under a long
  collector outage, and behaviour across many instances are unproven.
- **Reconnect is bounded to 10 attempts.** A Redis outage longer than roughly
  half a minute still ends with the client giving up until the process
  restarts — better than never recovering, but not unlimited. The ops endpoint
  reports `degraded` throughout.
- **Only the logs signal is exported.** Traces and metrics signals are not
  emitted; a collector receives these as OTLP log records with attributes.
- **No dashboards or alerts** are defined; this phase ships the data, not the
  monitoring on top of it.
- **TLS/mTLS to the collector is untested.** Only plain HTTP was exercised
  locally; `OTEL_EXPORTER_OTLP_HEADERS` carries bearer-style auth, but a
  certificate-based setup has not been tried.
