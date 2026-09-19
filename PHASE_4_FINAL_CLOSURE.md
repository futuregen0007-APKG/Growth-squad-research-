# Phase 4 Final Closure — Qualitative Guidance and Complete Cross-Layer Integration

Closes Phase 4F.2, continuing from commit `1a55993` (Phase 4F.1). Covers the
final gap identified at the end of Phase 4F.1: TCS-FY2026-002, a real,
verified cross-source Earnings-Intelligence record whose promise is
qualitative management guidance and whose outcome is numeric, could not
previously participate naturally in the Phase 4E annotation, Phase 4D
temporal-relationship, or grounded-verification layers.

## 1. Final architecture

Qualitative guidance is now a first-class, additive value type threaded
through every layer that already understood numeric (`range`/`exact`)
guidance, without changing any existing numeric behavior:

```
Official document (real, chunked)
        │
        ├─ Phase 4E corpus-wide scan (guidanceExtraction.js) ── numeric OR qualitative sentence-level VERIFIED annotation
        │
        └─ Phase 4F.2 EI-to-chunk bridge (evidenceLinkage.js) ── links an ALREADY public-safe, human-reviewed
             EI record's own excerpt to its real backing chunk, and derives a genuine qualitative annotation
             from that record's OWN trusted fields when the corpus-wide scan's generic gates would (correctly)
             reject the raw sentence in isolation (e.g. a courtesy "as you know" address)
        │
        ▼
guidanceNormalization.js (canonical record: valueType 'qualitative' | 'range' | 'exact' | null)
        │
        ▼
temporalRelationships.js (SUPPORTS / REPEATS / SUPERSEDES / CONFLICTS / OUTCOME_FOR — qualitative-aware)
        │
        ▼
EvidenceEnvelope.js (reconcileEvidenceEnvelope — canonicalGuidance + fulfillmentEvaluable)
        │
        ▼
groundedVerification.js (direction/overreach/fulfillment-aware claim verifier)
        │
        ▼
Public API citations / frontend citation card (plain-language direction, never a fake number)
```

## 2. Qualitative-guidance schema

Canonical record (`guidanceNormalization.js`'s `normalizeGuidanceEvidence` output) gained two additive fields, non-null only for a genuine qualitative record:

```js
{
  valueType: 'qualitative',
  qualitativeDirection: 'INCREASE' | 'DECREASE' | 'MAINTAIN' | 'IMPROVE' | 'EXPAND' | 'REDUCE' | 'STABLE' | 'OTHER',
  qualitativeText: string,       // the verified excerpt/span itself, never regenerated
  lowerBound: null, upperBound: null, exactValue: null, unit: null,   // always null — never a fake number
}
```

Same shape mirrored in `models/ResearchGuidanceAnnotation.js` (`valueType` enum extended with `'qualitative'`; new `qualitativeDirection` field; `supportingSpan` doubles as the verified `qualitativeText` — no separate, driftable field). `EXTRACTION_METHODS` gained `'EI_LINKED_DETERMINISTIC'` (still zero-LLM) to record provenance distinctly from a blind corpus scan.

`classifyQualitativeDirection(text)` (`guidanceNormalization.js`) is the one canonical direction vocabulary, an explicit allow-list of phrase patterns — no fuzzy matching. Zero matches → `UNRESOLVED`/`NO_QUALITATIVE_DIRECTION_FOUND` (generic aspirations like "we aim to be the best" never get a direction). More than one distinct match → `UNRESOLVED`/`AMBIGUOUS_DIRECTION:...` (never guessed).

Existing numeric `EXACT`/`RANGE` behavior is untouched — verified by rerunning every pre-existing test file unmodified except one assertion (see §8).

## 3. Extraction rules

`guidanceExtraction.js`'s per-sentence pipeline (bumped to `EXTRACTION_VERSION = '3'`) no longer drops a number-free sentence outright. It instead runs the qualitative path through the **exact same** disqualifying gates the numeric path already used — analyst-question language, analyst framing, second-person address (same-sentence and proximity-gated neighbor), actual-result language — then requires a resolvable metric (`normalizeMetric`), a resolvable direction (`classifyQualitativeDirection`), and explicit forward-looking/guidance language (`FORWARD_LOOKING_MARKER` or non-`ORIGINAL` `guidanceKind`) before ever reaching `VERIFIED`. Nothing was loosened to gain coverage.

Real-corpus proof (rerun 3× each for idempotency — see §9): the deterministic scan run against the **entire live TCS (1225 chunks) and INFY (1145 chunks) corpus** found exactly **0 regressions** on the 23 pre-existing numeric `VERIFIED` annotations (1 TCS + 22 INFY) and **8 new genuine qualitative `VERIFIED`** annotations in INFY's real corpus (attrition/revenue-growth direction statements like "We expect attrition to reduce further in the coming quarters."). Adversarial cases from the real corpus were confirmed correctly rejected, not forced: an analyst "do you expect..." question, a courtesy "as you know" address, and historical/actual-result phrasing ("attrition declined...") all still resolve to `REJECTED`, never `VERIFIED`.

## 4. EI/document linkage algorithm

New module `services/evidenceLinkage.js`. `linkPublicSafeEIEvidence(eiRecord, side)`:
1. Refuses immediately — no chunk query at all — unless `isPubliclyVisibleRecord(eiRecord)` is true (rejects `QUARANTINED`, `UNSUPPORTED`, `UNREVIEWED_LEGACY`, `PENDING_REVIEW`, missing status, and any `SEEDED_DEMO`/non-`REAL_RESEARCH` record by construction, since those never carry a public-safe status).
2. Finds `ResearchDocumentChunk` rows by the record's own `sourceUrl` + page range.
3. Verifies the record's own excerpt is an **exact substring** of the real chunk text, after a narrow, generic Unicode-punctuation normalization (`normalizeForExactMatch`: curly↔straight quotes, en/em dash↔hyphen, NBSP↔space) — never fuzzy/semantic matching.
4. Returns `{linked:false, reason}` with an explicit machine-readable reason on any failure — never manufactures a link.

`buildQualitativeAnnotationFromLinkage` then derives metric + direction from the record's own trusted fields and, only if both resolve, upserts a real `ResearchGuidanceAnnotation` row (`extractionMethod: 'EI_LINKED_DETERMINISTIC'`, `extractionVersion: 'EI-LINKED-1'` — a deliberately separate, non-numeric version lane from the corpus-wide scan's own numeric versions, fixing a real collision this phase found: writing to the same version let the scan's own correct rejection silently overwrite the bridge's verified result). `guidanceAnnotationLookup.js` was updated so a chunk's EI-linked entry always wins over its numeric-lane sibling for the same chunk (a human-reviewed record is strictly more trusted than an unaudited blind scan) — every pre-existing version-selection test still passes unmodified.

## 5. Temporal relationship behavior

Real audit finding, fixed in `temporalRelationships.js`: `OUTCOME_FOR` detection was gated behind a unit-comparability check that a qualitative record (which has no unit at all, by design) could never pass — meaning a qualitative promise could never link to its own later numeric outcome. Fixed by checking `OUTCOME_FOR` (symbol/metricKey/period only, exactly Part 5's own rule) **before** the unit/value-type equality gate, which still governs only `SUPPORTS`/`REPEATS`/`SUPERSEDES`/`CONFLICTS`.

Every `OUTCOME_FOR` relationship now carries `fulfillmentEvaluable`: `true` only when the guidance side is genuinely numeric; `false` (with `fulfillmentReason: 'QUALITATIVE_GUIDANCE_NO_DETERMINISTIC_FULFILLMENT_RULE'`) when it's qualitative — the relationship (the link) is always preserved; only the fulfillment *verdict* is withheld. Surfaced onto the OUTCOME envelope item itself (`EvidenceEnvelope.js`) so the verifier never needs the raw relationships array.

Qualitative-vs-qualitative comparison (`valuesEqual`/`isComparable`) is now direction-based, with no unit involved, correctly producing `SUPPORTS`/`REPEATS` for matching directions and `CONFLICTS` for genuinely different ones with no revision language — `SUPERSEDES` still requires explicit revision language exactly as before. A qualitative record is never compared to a numeric one for equality (`VALUE_TYPE_MISMATCH`, never guessed).

**TCS-FY2026-002, reported per Part 5's own required breakdown:**
1. Canonical promise: `{valueType:'qualitative', qualitativeDirection:'IMPROVE', metricKey:'revenue_growth', targetFiscalYear:'FY2026', targetQuarter:'Q2'}`.
2. Canonical outcome: `{valueType:'exact', exactValue:0.6, unit:'PERCENTAGE', metricKey:'revenue_growth', guidanceKind:'outcome'}`.
3. Relationship: `OUTCOME_FOR` (outcome → promise) — genuinely a promise followed by its actual result, never `SUPERSEDES` (no revision occurred).
4. Fulfillment: **not** deterministically evaluable.
5. Justification: the promise is qualitative/directional ("more optimistic"), with no numeric target; there is no deterministic rule for comparing a direction word to a specific reported percentage, so asserting "fulfilled" would be an invented judgment, not a computed one. The *link* is genuine and kept; the *verdict* is honestly withheld.

## 6. Verifier behavior

`groundedVerification.js` gained `checkQualitativeConsistency`, run for every claim citing qualitative evidence, before the numeric-fact check:
- **Direction mismatch**: claim's own classified direction disagrees with every cited qualitative item's verified direction → `QUALITATIVE_DIRECTION_MISMATCH`.
- **Overreach**: firm-commitment language (`guarantee(d)`, `formal guidance`, `commit(ted) to`, `promise(d)`, `confirmed formally`) citing only qualitative (aspirational) evidence → `QUALITATIVE_OVERREACH`.
- **Unsupported fulfillment**: fulfillment language (`fully delivered/achieved/met`, `successfully delivered`, etc.) citing an `OUTCOME_FOR` pairing whose `fulfillmentEvaluable` is `false` → `UNSUPPORTED_FULFILLMENT_CLAIM`. Plainly reporting the real outcome number is never blocked — only an explicit fulfillment *conclusion* is.

Every numeric-only claim/citation pair is completely unaffected (confirmed by full regression run). The model never sets its own verification status; the one-repair-maximum cap is untouched.

## 7. Real TCS-FY2026-002 evidence chain (genuine, not hand-constructed)

Run live, end-to-end, using the real production functions and real stored corpus/DB records (see also §9's exact commands, reproducible):

1. `getEarningsTimeline({symbol:'TCS'})` → 2 public-safe promises returned (the 3rd, `QUARANTINED` 26%-28% record, correctly excluded).
2. TCS-FY2026-002's `operator: null` (the only way `earningsImport.js` ever produces this — confirmed live) → genuinely qualitative.
3. `linkPublicSafeEIEvidence` → real chunk found (`sourceUrl` `.../9cee0fdb-...pdf`, page 26); excerpt verified verbatim against real stored text after apostrophe normalization (curly `'` vs straight `'` — the actual real-world discrepancy found).
4. `buildQualitativeAnnotationFromLinkage` → real `ResearchGuidanceAnnotation` row written, `VERIFIED`, `qualitativeDirection: 'IMPROVE'`, `extractionMethod: 'EI_LINKED_DETERMINISTIC'`.
5. `mergeEarningsIntelligenceEvidence` + `reconcileEvidenceEnvelope` (the real production merge/reconcile pipeline) → promise item `canonicalGuidance.qualitativeDirection = 'IMPROVE'`; outcome item `canonicalGuidance.exactValue = 0.6`; real `OUTCOME_FOR` relationship, `fulfillmentEvaluable: false`.
6. **Live** `generateGroundedAnswer` (a real OpenAI call — a configured key was available) on the question *"What did TCS management say about international revenue, and what actually happened?"* produced: *"TCS management expressed optimism regarding international revenue, stating they were 'more optimistic in the coming quarter' (E1). However, the actual outcome reported was a modest growth of only 0.6% quarter-over-quarter in constant currency (E2)."* — genuinely never overreached into a fulfillment claim on its own.
7. `verifyGroundedAnswer` (deterministic) → both claims `VERIFIED`, `groundingStatus: 'grounded'`.
8. Citations: real `sourceUrl`s (`bseindia.com` page 26; `nsearchives.nseindia.com`), nothing fabricated.

## 8. Safety regression results

Full backend suite rerun after every change (see §10 for totals). One pre-existing assertion was intentionally strengthened, not weakened: `evidenceIntegrityAudit.test.js`'s "qualitative promise never produces a fabricated numeric structuredGuidance" test previously asserted `structuredGuidance === null`; it now asserts the real, safe, non-numeric qualitative object and additionally checks `'targetValue' in structuredGuidance === false` — a stronger check of the same invariant (never the coerced `0`), reflecting the intentional design change from "passive null" to "real qualitative signal."

Confirmed zero leakage (rerun live and via the automated suite) for: `QUARANTINED`, `UNSUPPORTED`, `UNREVIEWED_LEGACY`, `PENDING_REVIEW`, `SEEDED_DEMO`, missing/null integrity status — across `getEarningsTimeline`, `getCompanyPromises`, `getManagementPromiseDetails`, and the warm-cache-then-quarantine regression test (all still pass). No `tcs.com` source URL was reintroduced (only the pre-existing, still-`QUARANTINED` `TCS-FY2026-001` retains one, unchanged, kept for audit history). The 9 inaccessible INFY candidates from Phase 4F.1 were not touched.

## 9. Corpus before/after measurements

| Symbol | Chunks scanned | Candidate chunks | VERIFIED (v2, numeric-only pipeline) | VERIFIED (v3, numeric+qualitative pipeline) | Regressions |
|---|---|---|---|---|---|
| TCS | 1225 | 309 | 1 | 1 | 0 |
| INFY | 1145 | 540 | 28 | 36 (+8 genuine qualitative) | 0 |

Idempotency: each symbol's v3 extraction was run 3 times consecutively; chunk/candidate/VERIFIED/REJECTED/UNRESOLVED counts were identical on every run.

## 10. Test and build totals

- Backend: **1127/1127** passing (`npm test`) — up from 1086; the increase reflects both 34 new qualitative-guidance tests and two pre-existing test files (`migrateEvidenceIntegrity.test.js` from Phase 4F.1, and the new `qualitativeGuidance.test.js`) that a genuine gap in `package.json`'s explicit test-file list had been silently excluding from every "full suite" run this session — fixed as part of this phase.
- Frontend: **86/86** passing (`npm test`, CI mode) — up from 84 with 2 new qualitative-citation-rendering tests.
- Production build: succeeds (`npm run build`).

## 11. Files changed

`backend/services/guidanceNormalization.js`, `backend/services/guidanceExtraction.js`, `backend/services/temporalRelationships.js`, `backend/services/EvidenceEnvelope.js`, `backend/services/guidanceAnnotationLookup.js`, `backend/services/evidenceLinkage.js` (new), `backend/models/ResearchGuidanceAnnotation.js`, `backend/graph/groundedVerification.js`, `backend/graph/schemas.js`, `backend/scripts/enrichGuidanceCorpus.js`, `backend/package.json`, `backend/tests/qualitativeGuidance.test.js` (new), `backend/tests/evidenceIntegrityAudit.test.js`, `frontend/src/components/chat/ChatMessageBubble.jsx`, `frontend/src/__tests__/chatMessageBubbleGrounded.test.jsx`.

## 12. Commit hash

`b4a5b21` — `fix: add first-class qualitative guidance and EI-document linkage` (see git log; exact hash confirmed after commit below).

## 13. Git-ahead count

18 commits ahead of `origin/main` after this phase's commit (17 before it, all preserved, none rewritten).

## 14. Confirmation nothing was pushed

`git status` shows only "ahead of origin/main"; no `git push` was run at any point. `.env` was never read for editing and was not modified.

## 15. Remaining production-only limitations

- The 9 INFY `PromiseCandidate` records blocked by HTTP 403 source access (Phase 4F.1) remain untouched and unresolved.
- Atlas Vector Search verification remains deferred (per this phase's own instruction).
- The EI-linked qualitative annotation was built for TCS-FY2026-002 specifically (the record this phase targeted); the bridge is general-purpose and would need to be run again (via a small script calling `linkPublicSafeEIEvidence`/`buildQualitativeAnnotationFromLinkage`) for any *other* qualitative EI record added in the future — it is not yet wired into an automated batch job the way `enrichGuidanceCorpus.js` is for the numeric/qualitative corpus-wide scan.
- Qualitative direction classification covers 8 explicit categories with a deliberately narrow phrase list; genuinely novel phrasing not in that list correctly resolves `UNRESOLVED` rather than being guessed, which trades recall for precision by design.

---

## Verdict

**PHASE 4 COMPLETE FOR LOCAL DEVELOPMENT — GENUINE EI + DOCUMENT CROSS-LAYER VALIDATED**
