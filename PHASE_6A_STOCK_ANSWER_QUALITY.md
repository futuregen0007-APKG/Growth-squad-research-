# Phase 6A — Stock-Answer Quality Recovery

Continues from `0a3022b` (Phase 5B). Phases 5A/5B built the observability
layer; this phase **uses** it to diagnose and fix the path from a user's
question to a verified answer. No infrastructure refactor — every change
here traces to a failure measured on a real run.

## 1. Baseline — measured, not assumed

`backend/scripts/captureAnswerBaseline.js` ran the five mandatory queries
through the real graph with the real configured providers (MongoDB up,
OpenAI up, IndianAPI **rate-limited with HTTP 429**), capturing intent,
entities, tool plan, tool outcomes, evidence, verification, per-stage
latency, and the final answer.

**All five queries abstained.** Every one produced a variant of:

> "I don't have verified data for: … temporarily unavailable. I'd rather say
> that plainly than guess."

| # | Query | Intent | Symbols resolved | Tool outcome | Evidence | Answer |
|---|---|---|---|---|---|---|
| 1 | HDFCBANK vs ICICIBANK margin trends | STOCK_COMPARISON | ✅ both | `compareStocks: EMPTY` | 0 | abstain |
| 2 | BEL vs HAL on margins and valuation | STOCK_COMPARISON | ✅ both | `compareStocks: EMPTY` | 0 | abstain |
| 3 | Which is better long term: ICICI or HDFC? | STOCK_COMPARISON | ✅ both | `compareStocks: SUCCESS` | 2 (prices) | partial |
| 4 | Compare TCS and INFY growth/margins/valuation | STOCK_COMPARISON | ✅ both | `compareStocks: EMPTY` | 0 | abstain |
| 5 | Analyse RELIANCE for a five-year investor | COMPANY_RESEARCH | ✅ | `getCompanyResearch: UNAVAILABLE (RATE_LIMITED)` | 0 | abstain |

**Symbol resolution and aliasing were never the problem** — "ICICI Bank",
"HDFC Bank", "Infosys", "Bharat Electronics" all resolved correctly
(baseline symbol accuracy 0.947). The failure was entirely downstream.

### What the database actually held, unused

| Symbol | Verified filing facts (`REAL_RESEARCH`) | NSE market metrics | Research chunks |
|---|---|---|---|
| INFY | 4,364 | ✅ | 1,145 |
| TCS | 792 | ✅ | 1,225 |
| ICICIBANK | 516 | ✅ | 0 |
| HDFCBANK | 175 | ✅ | 0 |
| RELIANCE | 143 | ✅ | 0 |
| **BEL** | **0** | ✅ | 0 |
| **HAL** | **0** | ✅ | 0 |

Thousands of verified, source-linked facts existed for the exact companies
being asked about. **Nothing in the chat path ever looked at them.**

## 2. Root cause per mandatory query

**Q1, Q2, Q4 — dimension narrowing discarded data we held.**
`dimensions.js` matches "margin"/"growth"/"valuation" to the `FINANCIALS`
dimension, so `compareStocks` fetched *only* financials and never price.
`getCompanyFinancials` reaches **only** the live provider, which was
rate-limited, so `anySuccess` was false, the whole comparison returned
`EMPTY`, and its zero evidence forced an abstain. Q3, which asked a *vaguer*
question, kept the default `PRICE` dimension and therefore produced a better
answer than the more specific questions — asking precisely made the answer
worse.

**Q3 — partial data, no sector framing.** It surfaced two live prices and
nothing else. No NIM, ROA, GNPA or NNPA, because nothing consulted the 691
stored bank facts.

**Q5 — provider failure became the final answer with no fallback.**
`getCompanyResearch` returned `UNAVAILABLE/RATE_LIMITED` and the turn ended,
despite 143 verified RELIANCE facts and real NSE market history sitting in
MongoDB.

**Cross-cutting — no sector awareness.** `StockFundamentalsSnapshot` models
`operatingMargin` for every company; it is `null` for every bank and listed
in `missingMetrics`. There was no NIM/ROA/GNPA/NNPA concept anywhere in the
chat path.

**Cross-cutting — misleading wording.** "Temporarily unavailable" was shown
for BEL/HAL, whose data is not temporarily missing; it was never collected.

### Data-quality defects found while fixing (each would print a wrong number)

- `StockFundamentalsSnapshot` derived growth is unusable: HDFCBANK
  `revenueGrowth -81.94%`, INFY `-70.19%`, BHEL `+13782.9%` — CAGRs computed
  across sparse, mismatched periods. **Deliberately not used.**
- TCS `OPERATING_MARGIN = 65799 INR_CRORE` — an absolute figure labelled a margin.
- INFY `REVENUE = 4.4 PERCENTAGE` — a growth rate labelled revenue.
- TCS `EPS = 11.2 PERCENTAGE` — a growth rate labelled EPS.
- INFY `OPERATING_MARGIN = 0.7%` from *"Impact on Operating Margin from
  Acquisitions"* — a **delta**, not a level. Shown beside TCS's genuine
  24.5% it read as Infosys running a 0.7% margin.

## 3. Fixes implemented

All are scoped to demonstrated failures.

**`services/storedFundamentals.js` (new).** Reads verified
(`dataOrigin: REAL_RESEARCH`, `verified: true`) `CompanyHistoricalFact` rows
and real NSE-bhavcopy `StockHistoricalMetricsSnapshot` metrics. It computes
nothing: every figure is an extracted filing value with its own period, unit,
source URL and as-of date. It adds two guards:

- **Unit/range contract** — a margin must be a percentage in a plausible
  range; a revenue must be a currency magnitude. Facts failing are *dropped
  and counted*, never corrected.
- **Delta-vs-level guard** — a ratio fact whose title describes a movement
  ("impact on", "change in", "bps", "YoY") is not a level and is dropped.
  This is what replaced INFY's 0.7% with its real **20.9% FY2026** margin.

**Sector awareness.** `classifySector` uses the stored profile's own sector.
Banks get `NIM / ROA / ROE / GNPA / NNPA` and explicitly mark
`OPERATING_MARGIN`/`EBITDA` as *not meaningful*; other companies keep the
operating-margin frame.

**`graph/tools/toolRegistry.js`.** The live provider is still tried **first**
and still preferred. Only when it fails or returns nothing does
`getCompanyFinancials` / `getCompanyResearch` fall back to stored verified
evidence — so a provider failure becomes the final answer only after a real
fallback is exhausted. `compareStocks` now attaches the stored view **per
symbol** for any symbol whose requested dimensions all failed, so one
company succeeding never masks another failing, and a narrowed question can
no longer discard data we hold.

**`graph/evidenceCoverage.js`.** `KEY_METRIC` counts toward `FINANCIALS`
coverage (a company with only price history has real data, and reporting "no
data found" while holding it is untrue), and the `UNAVAILABLE` phrase no
longer promises the gap is temporary.

**`graph/prompts/index.js`.** The composer prompt now exposes each evidence
item's **reporting period** (previously hidden, which is why FY2022 and
FY2024 figures were compared silently) and adds eight rules: provenance on
every figure, never compare across periods silently, sector-appropriate
metrics, the comparison structure (verdict → table → strengths → risks →
valuation → suitability → limitations), *conditional* answers for "which is
better" with no buy call, **cite every claim**, never invent, and name
exactly what is missing. The repair prompt was made strictly conservative:
delete a flagged sentence rather than attempt to rescue it.

**No safety or evidence gate was weakened.** The claim verifier, citation
validation, integrity gating and abstention paths are untouched. Two test
assertions changed: one brittle substring check I wrote in Phase 5A that
flaked under load (now asserts by field), and one wording assertion updated
to the corrected phrasing.

## 4. Provider / fallback flow

```
question → resolve symbols/dimensions
   │
   ├─ live provider (IndianAPI)         ← tried FIRST, always preferred
   │     ├─ SUCCESS → real-time evidence
   │     └─ 429 / error / empty
   │            ↓
   ├─ stored verified filings           ← CompanyHistoricalFact, REAL_RESEARCH + verified
   │     └─ unit/range + delta guards → sector-aware metric set
   │            ↓
   ├─ stored NSE market history         ← StockHistoricalMetricsSnapshot
   │            ↓
   └─ nothing held → say so precisely, naming company + metric + why
```

## 5. Evaluation results

`backend/scripts/evaluateAnswerQuality.js` — 20 prompts across aliases,
comparisons, sector metrics, unavailable data, partial failure and prompt
injection. Scoring is mechanical (no model judging itself). Baseline and
final were measured with the **same scorer on the same prompts**, using the
`STORED_FALLBACK_DISABLED=true` seam to reproduce pre-phase behaviour.

| Dimension | Baseline | Final | Δ |
|---|---|---|---|
| Symbol accuracy | 0.947 | 0.947 | — (already correct) |
| **Evidence coverage** | **0.150** | **0.900** | **+0.750** |
| Citation correctness | 1.000 | 1.000 | — |
| **Sector-metric correctness** | **0.000** | **0.875** | **+0.875** |
| Graceful degradation | 0.975 | 0.825 | −0.150 |
| Safety (no fabricated forecast/target) | 1.000 | 1.000 | — |
| **Usefulness** | **0.520** | **0.770** | **+0.250** |
| **Overall** | **0.740** | **0.901** | **+0.161** |
| Median latency | 1,057 ms | 11,733 ms | +10,676 ms |

**Latency rose because the system now does the work it previously skipped**:
the baseline abstained in ~1s without composing an answer. Graceful
degradation dipped slightly because more turns now attempt a real answer,
where the baseline trivially "passed" by admitting failure everywhere.

Safety held at 1.000, including all three prompt-injection attempts — none
produced a recommendation, price target, or guarantee.

## 6. Before / after — the five mandatory queries

### Q1 — HDFCBANK vs ICICIBANK margin trends
**Before:** `I don't have verified data for: HDFCBANK financials: temporarily unavailable; ICICIBANK financials: temporarily unavailable. I'd rather say that plainly than guess.`

**After (best observed run, verification PASSED):**
> On these figures, ICICI Bank appears to have a stronger net interest margin (NIM) compared to HDFC Bank…
>
> | Metric | HDFC Bank | ICICI Bank |
> |---|---|---|
> | NIM | 4.0% (FY2022) [1] | 4.78% (FY2024) [10] |
>
> **Strengths** — ICICI Bank: higher NIM of 4.78% (FY2024) [1][10]. HDFC Bank: ROA 0.53% (FY2023) [2], ROE 17% (FY2022) [3].
> **Risks** — HDFC Bank: GNPA 1.23% (FY2023) [4], NNPA 0.33% (FY2023) [5]. ICICI Bank: GNPA 1.58% (FY2026) [12].
> **Data Limitations** — HDFC Bank's NIM is FY2022 while ICICI's is FY2024, which limits direct comparison…
> This analysis does not constitute investment advice.

**After (lower-variance run, verification ABSTAINED):** falls back to a
cited list — `HDFCBANK NIM: 4% (FY2022) [1]`, `ICICIBANK NIM: 4.78% (FY2024) [10]` — still real, sourced, sector-correct data rather than "unavailable".

### Q2 — BEL vs HAL on margins and valuation
**Before:** `I don't have verified data for: BEL financials: temporarily unavailable; HAL financials: temporarily unavailable.`

**After:**
> Here's what I could verify:
> - BEL: close INR 404.35, 1-year return 1.48%, 52-week range INR 380.45–473.45, annualised volatility 24.68%, max drawdown −17.84% [1]
> - HAL: close INR 4905, 1-year return 2.29%, 52-week range INR 3479.1–5149.9, annualised volatility 27.37%, max drawdown −29.07% [2]

Margins and valuation remain genuinely unavailable — **zero verified filings
are held for BEL or HAL** — but the answer is now real market data instead of
a blanket refusal.

### Q3 — Which is better for the long term: ICICI Bank or HDFC Bank?
**Before:** two live prices, then `I don't have verified data for: ICICIBANK financials … HDFCBANK company research: temporarily unavailable.`

**After (verification PASSED):**
> On these figures, ICICI Bank looks stronger on net interest margin (NIM) and return on assets (ROA), while HDFC Bank shows better performance in terms of profit after tax (PAT) and revenue. For a long-horizon investor prioritizing asset quality, ICICI's profile fits better, while HDFC's higher PAT may appeal to those focused on profitability.
>
> | Metric | ICICI Bank | HDFC Bank |
> |---|---|---|
> | NIM | 4.78% (FY2024) | 4.00% (FY2022) |
> | ROA | 2.11% (FY2022) | 0.53% (FY2023) |
> | GNPA | 1.58% (FY2026) | 1.23% (FY2023) |
> | NNPA | 0.35% (FY2027) | 0.33% (FY2023) |
> | PAT | 14,805 Cr (FY2027) | 17,616.14 Cr (FY2026) |
> | Revenue | 312,118.36 Cr (FY2026) | 470,915.93 Cr (FY2026) |

Conditional on horizon and priority, with no buy recommendation.

### Q4 — Compare TCS and INFY growth, margins, and valuation
**Before:** `I don't have verified data for: TCS financials: temporarily unavailable; INFY financials: temporarily unavailable.`

**After (verification PASSED):**
> | Metric | TCS (Q1 FY2026) | INFY (FY2026) |
> |---|---|---|
> | Operating Margin | 24.5% [1] | 20.9% [9] |
> | EBITDA Margin | 24.5% [2] | 21% [10] |
> | Revenue | 240,893 INR Crore [3] | 45,479 INR Crore [11] |
> | PAT | 9,800 INR Crore [4] | 3,030 USD Million [12] |
> | EPS | 29.64 INR [5] | 17.83 INR [13] |
> | Order Book | 9,440 USD Million [6] | 3.2 USD Million [14] |
>
> **Strengths** — TCS: higher operating and EBITDA margins… **Risks** — TCS one-year return −29.28% [8]; INFY −31.21% [16].
> **Data Limitations** — TCS figures are Q1 FY2026 while INFY's are FY2026… there is no valuation evidence available for either company.

The 20.9% INFY margin is the delta-guard fix; without it this table read 0.7%.

### Q5 — Analyse RELIANCE for a five-year investor
**Before:** `I don't have verified data for: RELIANCE company research: temporarily unavailable.` (tool: `UNAVAILABLE / RATE_LIMITED`)

**After:** tool now returns `SUCCESS` from stored evidence —
> Here's what I could verify:
> - RELIANCE: close INR 1257.5, 1-year return −10.13%, 52-week range INR 1249.8–1611.8, annualised volatility 20.53%, max drawdown −21.03% [6]

with verified FY2024 filing facts (operating margin 53%, EBITDA margin 8.1%,
revenue ₹1,000,000 Cr, PAT ₹21,423 Cr) available in the evidence set.

## 7. Files changed

**New:** `backend/services/storedFundamentals.js`,
`backend/scripts/captureAnswerBaseline.js`,
`backend/scripts/evaluateAnswerQuality.js`,
`backend/tests/storedFundamentals.test.js`, this document.

**Modified:** `backend/graph/tools/toolRegistry.js` (stored fallback in
`getCompanyFinancials`/`getCompanyResearch`, per-symbol preservation in
`compareStocks`), `backend/graph/prompts/index.js` (period-aware,
sector-aware, citation-disciplined composer + conservative repair),
`backend/graph/evidenceCoverage.js` (KEY_METRIC coverage + honest wording),
`backend/package.json`, `backend/tests/chatEvidenceCoverage.test.js`,
`backend/tests/telemetryEventContract.test.js`.

## 8. Test and build totals

- Backend: **1366/1366** passing (`npm test`, 118 registered files), 0 failures, 0 skipped.
- Frontend: **92/92** across 11 suites.
- Production build: succeeds from a clean `build/`.
- Real-provider acceptance: 20-prompt evaluation, overall **0.901** (from 0.740).

## 9. Remaining unavailable data, and why

- **BEL and HAL fundamentals** — zero verified filings are stored for either
  company. Margins and valuation for them are genuinely unanswerable from
  held data; only NSE price history exists. Fixing this is a data-collection
  job, not a code change.
- **Valuation multiples (P/E, P/B) for every symbol** — `peRatio` is `null`
  in every `StockFundamentalsSnapshot` row and no valuation facts are
  stored. Any valuation question is answered as unavailable.
- **IndianAPI was rate-limited (HTTP 429) throughout** this phase, so live
  provider data never exercised the primary path. The fallback is therefore
  well tested and the live path is not re-verified here.
- **Period alignment** — stored facts land on whatever period the filing
  reported, so cross-company comparisons often mix periods. The answer now
  states this explicitly rather than hiding it, but it cannot be resolved
  without denser per-period collection.
- **Residual corpus mislabels** — the unit and delta guards catch the
  systematic cases, but some facts are still imprecise (e.g. INFY
  `ORDER_BOOK = 3.2 USD_MILLION`, likely billions). Tightening further risks
  dropping good data; the honest fix is corpus re-extraction.

## 10. Reliability completion — deterministic composition

The Phase 6A draft closed with 1–2 of 5 mandatory queries passing
verification. That is fixed at the root, without touching the verifier's
strictness.

### Diagnosis: 5 queries × 5 runs, per claim

`backend/scripts/traceAnswerStability.js` classified every failing claim
across 25 runs:

| Failure kind | Count | Meaning |
|---|---|---|
| `UNSUPPORTED_INFERENCE` | 20 | model reasoned past what any evidence item supports |
| `MISSING_CITATION` | 5 | real figure restated without its `[N]` |
| `WRONG_CITATION` | 2 | cited index did not apply |
| `PERIOD_MISMATCH` | 2 | right metric, wrong period |

25/25 retrieved evidence; only 4/25 verified. **The randomness came from
free-text composition** — not retrieval, evidence identity, or citation
parsing. It is a sampling property, which is why two rounds of prompt
instruction never made it reliable.

### Fix: the numbers stop being generated

`services/claimPlan.js` extracts every material claim into a typed record —
company, metric, value, unit, reporting period, and the exact evidence index
backing it — and `services/answerRenderer.js` emits the verdict, table,
per-company figures and limitations directly from those records. The model
writes no number, period, unit, or citation id, so it cannot invent or
mis-cite one. The synthesis LLM call is gone from these turns entirely.

**Verification is not bypassed.** `validateFinalAnswer` runs on the rendered
text unchanged, and passes it because each sentence genuinely restates a
cited excerpt.

### Five defects found and fixed while stabilising

1. **Absence asserted as fact.** A table cell reading "not reported" is an
   unbacked company claim — it was the single failing claim in an otherwise
   15/16 SUPPORTED answer. A metric now appears only when every compared
   company has a real figure.
2. **Price language with no price evidence.** Stored NSE history was typed
   `KEY_METRIC`, so `PRICE_WITHOUT_EVIDENCE` fired on every answer quoting a
   close. Added a `MARKET_HISTORY` claim type — real price evidence,
   explicitly not a live quote. The check still rejects price language when
   no price evidence of either kind exists.
3. **Verifier output budget too small.** At ~17 claims the verifier ran out
   of `maxTokens: 900` mid-list and returned `INVALID_CITATION` for claims it
   never examined — **63 false positives across 25 runs**, on citations that
   were correct. Raised to 2500: this lets the gate finish its job, it does
   not relax it.
4. **Mismatched periods shown side by side.** Even labelled "differs", two
   periods in one row read as like-for-like and were flagged `WRONG_PERIOD`.
   Non-comparable metrics moved out of the table into per-company lines.
5. **Ambiguous claim splitting.** A bullet listing five cited figures split
   into 11 claims on one run and 12 (with a spurious `INVALID_CITATION`) on
   the next. One line per figure removed the ambiguity.

### Comparison correctness

- A metric is comparable only when every company reports the **same period**;
  the **latest shared period** is preferred.
- A verdict rests **only on ratios** (NIM, ROA, ROE, GNPA, NNPA, margins).
  Absolute PAT and revenue are excluded by construction, so a larger bank can
  never be called the better one on size alone.
- Asset quality is scored lower-is-better.
- The verdict is conditional, cites the metrics supporting it, and issues no
  buy/sell/hold call.

### Acceptance gates

| Gate | Required | Result |
|---|---|---|
| Runs | 5 queries × 5 | 25 |
| Retrieve expected evidence | 25/25 | **25/25** |
| Pass final verification | ≥ 24/25 | **25/25** |
| No unsupported numeric claims | 25/25 | **25/25** (0 failing claims) |
| Citations in range | — | **0 out of range** |
| Sector metrics + comparable periods | correct | correct |
| Injection safety | 100% | **100%** (3/3) |
| Graceful degradation vs corrected baseline | no regression | 0.875 → **1.000** |

### Latency (25 runs)

| | p50 | p95 |
|---|---|---|
| **End to end** | **3,006 ms** | **6,931 ms** |
| Tools | 36 ms | 272 ms |
| Composition | **3 ms** | 18 ms |
| Verification | 2,650 ms | 3,354 ms |
| Repair | 0 ms | 0 ms |

End-to-end p50 improved **~4×** (11,733 ms → 3,006 ms) because composition no
longer calls a model. Verification is now the dominant cost — one LLM call —
and repair fired in only **1 of 25** runs. No LLM call was added for
formatting; one was removed.

## 11. Evaluator audit

The first scorer flattered the baseline. Three defects, fixed in
`services/answerQualityScorer.js` and pinned by adversarial tests:

1. **Citation correctness gave 1.0 to an answer with nothing cited** — an
   abstention scored like a sourced comparison. It is now `null` (excluded
   from the mean) when there is nothing substantive to cite.
2. **Graceful degradation gave 1.0 to any non-empty answer.** It is now
   scored only where degradation is the expected behaviour.
3. **Abstention inflated the aggregate.** `substantiveAnswerRate` is now
   reported, so an all-abstention run cannot read as capable.

`tests/answerQualityScorer.test.js` proves the scorer rejects fluent but
unsupported answers: figures with no citation score 0, out-of-range citations
score 0, invented figures in a no-data scenario score 0 on degradation, and
fabricated forecasts or price targets score 0 on safety.

### Corrected evaluation — same scorer on both sides

| Dimension | Baseline | Final |
|---|---|---|
| Symbol accuracy | 0.947 | 0.947 |
| **Evidence coverage** | **0.200** | **0.900** |
| Citation correctness | 1.000 | 1.000 |
| **Sector-metric correctness** | **0.000** | **1.000** |
| **Graceful degradation** | **0.875** | **1.000** |
| Safety | 1.000 | 1.000 |
| **Usefulness** | **0.475** | **0.850** |
| **Substantive answer rate** | **0.200** | **0.850** |
| **Overall** | **0.652** | **0.921** |
| p50 latency | 1,001 ms | 3,014 ms |
| p95 latency | 15,375 ms | 10,854 ms |

Baseline p50 is lower only because it abstained in ~1 s without composing
anything; its p95 is *worse* than final.

## 12. Representative final answers

**Q1 — HDFCBANK vs ICICIBANK margin trends** (PASSED)

> **Verdict.** These companies do not share a reporting period on any comparable ratio in the data held, so no like-for-like verdict is possible. What each company did report is below.
>
> | Metric | Period | HDFCBANK | ICICIBANK |
> |---|---|---|---|
> | Revenue | FY2026 | ₹4,70,915.93 Cr [7] | ₹3,12,118.36 Cr [14] |
>
> **Reported in different periods — listed separately because they are not like-for-like.**
> - HDFCBANK Net interest margin (NIM): 4% (FY2022) [1]
> - HDFCBANK Return on assets (ROA): 0.53% (FY2023) [2]
> - HDFCBANK Gross NPA: 1.23% (FY2023) [4]
> - HDFCBANK Net NPA: 0.33% (FY2023) [5]
> - ICICIBANK Net interest margin (NIM): 4.78% (FY2024) [9]
> - ICICIBANK Return on assets (ROA): 2.11% (FY2022) [10]
> - ICICIBANK Gross NPA: 1.58% (FY2026) [11]
> - ICICIBANK Net NPA: 0.35% (FY2027) [12]
>
> **Share-price history (NSE) — historical, not a live quote.**
> - HDFCBANK: close INR 708.25, 1-year return −26.76%, 52-week range INR 681.9–1020.5 … (as of 2026-09-11) [8]
> - ICICIBANK: close INR 1379.3, 1-year return −2.83%, 52-week range INR 1187.6–1480 … (as of 2026-09-11) [17]
>
> **Data limitations.**
> - I hold Return on equity (ROE), Deposits, Loan portfolio for only one of these companies, so there is nothing to compare it against.
> - 5 metric(s) are held for both companies but in different reporting periods, so they are listed separately rather than compared.
> - Operating margin and EBITDA are not meaningful measures for a bank, so they are not shown; net interest margin, returns and asset quality are used instead.
> - I hold no valuation multiples (P/E, P/B) for these companies, so valuation is not assessed.
>
> _Figures are as reported in the cited filings and NSE price history; this is information, not investment advice._

**Q2 — BEL vs HAL** (PASSED) — abstains *precisely* on what is missing, and
still answers what it can:

> **Share-price history (NSE) — historical, not a live quote.**
> - BEL: close INR 404.35, 1-year return 1.48%, 52-week range INR 380.45–473.45 … [1]
> - HAL: close INR 4905, 1-year return 2.29%, 52-week range INR 3479.1–5149.9 … [2]
>
> **Data limitations.**
> - Not held this turn: financials for BEL and HAL — neither stored filings nor the live provider returned it.
> - I hold no valuation multiples (P/E, P/B) for these companies, so valuation is not assessed.

**Q4 — TCS vs INFY** (PASSED) — INFY's operating margin is the real **20.9%**,
not the 0.7% delta fact the guard rejects:

> - TCS Operating margin: 24.5% (Q1 FY2026) [1]
> - TCS Revenue: ₹2,40,893 Cr (FY2024) [3]
> - INFY Operating margin: 20.9% (FY2026) [8]
> - INFY Revenue: ₹45,479 Cr (FY2026) [10]

## 13. Files changed (reliability pass)

**New:** `services/claimPlan.js`, `services/answerRenderer.js`,
`services/answerQualityScorer.js`, `scripts/traceAnswerStability.js`,
`tests/claimPlanRendering.test.js`, `tests/answerQualityScorer.test.js`.

**Modified:** `graph/nodes/composeAnswer.js` (deterministic path + precise
abstention), `graph/nodes/buildSafeFallback.js` (prefers the precise
abstention), `graph/nodes/validateFinalAnswer.js` (verifier output budget),
`graph/state.js` (`claimPlan`), `graph/evidence.js` (`MARKET_HISTORY`),
`graph/claimValidation.js` (price check accepts market history),
`graph/evidenceCoverage.js` (PRICE mapping), `graph/tools/toolRegistry.js`
(market evidence type), `services/storedFundamentals.js` (EPS per-share
contract), `scripts/evaluateAnswerQuality.js` (delegates to the tested
scorer), plus three scripts guarded against import side effects and three
pre-existing tests updated for the precise-abstention status.

## 14. Totals

- Backend: **1396/1396** passing (120 registered files).
- Frontend: **92/92**.
- Production build: succeeds from a clean `build/`.
- Stability: **25/25** verified, **25/25** evidence, **0** unsupported claims.
- Evaluation: overall **0.652 → 0.921** on the corrected scorer.

## 15. Remaining limitations

- **BEL/HAL fundamentals do not exist** in the corpus; margins and valuation
  for them remain unanswerable. The abstention is now precise about that.
- **No valuation multiples for any symbol** — `peRatio` is null everywhere.
- **Stored facts mix reporting periods**, so most cross-company comparisons
  land in the "reported separately" section rather than the comparable
  table. Honest, but a denser corpus would produce stronger answers.
- **IndianAPI was rate-limited (HTTP 429) throughout**, so the live-provider
  primary path is exercised only through its failure branch.
- **One test makes a live intent-classification call** and can vary under
  provider rate limiting; its status assertion accepts any non-fabricating
  terminal state while the no-synthesis and no-fabrication checks stay strict.
- **Verification is now the latency floor** (~2.6 s p50, one LLM call). It
  could be skipped for deterministically rendered answers, but that would
  weaken the gate, so it was not.

---

## 16. Commit gate — final verification

### Flaky test fixed at its real cause

The intent-classification flake was **not** the classifier. My stored-evidence
fallback introduced a MongoDB read into a suite that runs with no database;
mongoose *buffers* such a query for its 10s default before rejecting, which
exhausted the turn's deadline and silently rerouted it. `storedFundamentals`
now checks `mongoose.connection.readyState` and treats an unreachable store as
an empty one — instantly, with no wait. That is the correct production
behaviour too: a down database must not add 10s to a request.

With that fixed, the strict assertions are restored:

- `chatZeroEvidenceFastPath` asserts `intent === 'STOCK_COMPARISON'` and
  `validationStatus === 'ABSTAINED_PRECISE'` **exactly** — the classifier is
  stubbed there, so routing is fully determined.
- `tests/liveIntentClassification.acceptance.js` is the opt-in counterpart
  (`LIVE_INTENT_ACCEPTANCE=true`). It is named `.acceptance.js` so the
  registered glob cannot pick it up, and a provider 429/outage **skips it
  loudly** rather than failing. Verified against the live provider: all three
  mandatory routings confirmed.

### Two more defects found by writing the regression tests

1. **Repair regenerated a valid answer.** A single deterministic-check
   failure sent a fully-sourced comparison to the model, which replaced it
   with free text. `repairAnswer` now repairs a claim-plan answer
   *deterministically*: drop the implicated claims, re-render the rest, make
   **no** model call, and let the unchanged verifier re-check it. Verified
   content is preserved byte-for-byte.
2. **A profit figure read as a price claim.** `PRICE_WITHOUT_EVIDENCE` fired
   on `₹17,616 Cr` because any rupee amount matched the price pattern. No
   stock trades at "₹17,616 Cr", so crore/lakh/million-denominated figures are
   now excluded — with the lookahead anchored past the full number, since
   backtracking otherwise let a partial match through. A bare `₹1,234` with no
   price evidence is still flagged.

### Regression assertions (`tests/deterministicComposition.test.js`, 8 tests)

Each drives the real graph with a stubbed model:

| Proven | How |
|---|---|
| Comparison bypasses free-text synthesis | `chat.completions.create` call count is **0**; no `synthesis` LLM call recorded |
| The verifier still executes | `claim_verification` call count > 0, status `PASSED` |
| Values/units/periods/citations come only from the plan | every figure compared against the plan's **own formatter**; every `[N]` indexes real evidence |
| Absence claims cannot be rendered | no `\| not reported \|` cell; a one-sided metric is dropped from the table |
| No absolute PAT/revenue drives a verdict | verdict drivers contain `NIM`, never `PAT`/`REVENUE`; the larger-PAT bank does not win |
| Byte-stable output | three identical runs produce byte-identical answers |

### Final gate results

| Check | Result |
|---|---|
| Backend suite (121 registered files) | **1404/1404**, 0 failures, 0 skipped |
| Frontend suite | **92/92** across 11 suites |
| Production build | succeeds from a clean `build/` |
| Stability: 5 queries × 5 runs | **25/25 verified**, **25/25 evidence**, **0** unsupported claims, **0** citations out of range |
| Repairs used | **0/25** |
| Injection safety | **100%** |
| Secret scan | clean |

### Latency (25-run gate)

| | p50 | p95 |
|---|---|---|
| **End to end** | **2,702 ms** | 13,419 ms |
| Tools | 58 ms | 9,424 ms |
| Composition | **5 ms** | 28 ms |
| Verification | 2,483 ms | 2,879 ms |
| Repair | 0 ms | 0 ms |

p95 is dominated by tool retrieval when the live provider is slow before
failing over; composition and repair are effectively free.

### Corrected evaluation (same scorer both sides)

| Dimension | Baseline | Final |
|---|---|---|
| Symbol accuracy | 0.947 | 0.947 |
| **Evidence coverage** | **0.100** | **0.900** |
| Citation correctness | 1.000 | 1.000 |
| **Sector-metric correctness** | *n/a* | **1.000** |
| **Graceful degradation** | 0.875 | **1.000** |
| Safety | 1.000 | 1.000 |
| **Usefulness** | **0.415** | **0.850** |
| **Substantive answer rate** | **0.100** | **0.850** |
| **Overall** | **0.620** | **0.921** |

Baseline `sectorMetricCorrectness` is `null` — it never produced a
substantive bank answer to score, which is exactly the inflation the
corrected scorer now refuses to hide.
