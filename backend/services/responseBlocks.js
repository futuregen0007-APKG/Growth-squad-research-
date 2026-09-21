/**
 * responseBlocks.js
 * ====================
 * UI Phase 1B: pure, deterministic builders for the `responseBlocks` array
 * that supplements the Markdown `answer`. Every builder here is a plain
 * function of already-computed graph state — NO MongoDB, NO provider call,
 * NO LLM call, ever. That is not a style preference: `buildResponseBlocks`
 * (the graph node that calls these — graph/nodes/buildResponseBlocks.js)
 * only ever runs AFTER validateFinalAnswer has already passed and
 * publishFinalAnswer has already published `answer`/`citations`. Reaching
 * back into the network at this point would just add latency and a new
 * failure mode to a turn that is, from the user's perspective, already
 * finished.
 *
 * THE CORE SAFETY RULE, enforced once here rather than trusted at each call
 * site: every block field that asserts a fact carries `evidence:
 * EvidenceRefSchema[]`, and every one of those refs is produced by
 * resolveEvidenceRef, which requires the evidenceId to be present in the
 * FINAL, already-validated `citations` array — not merely present
 * somewhere in the claim plan. This matters concretely: repairAnswer.js's
 * repairClaimPlan (graph/nodes/repairAnswer.js) prunes failing claims out
 * of the rendered TEXT but does not go back and rewrite state.claimPlan
 * itself, so after a repair, state.claimPlan.rows can still contain claims
 * that are no longer actually asserted anywhere in the published answer.
 * Validating every reference against `citations` (not `claimPlan` alone)
 * is what stops a block from citing a figure the user's answer no longer
 * makes.
 *
 * THAT ALONE IS NOT ENOUGH, on its own. Citations-array MEMBERSHIP is a
 * proxy for "was this claim approved," and a proxy can be satisfied for
 * the wrong reason: if a REMOVED claim's evidence record happens to share
 * its evidenceId with a DIFFERENT, SURVIVING claim elsewhere in the same
 * answer, membership alone would wrongly treat the removed claim as
 * resolvable too — resurrecting a figure the verifier specifically
 * rejected. resolveEvidenceRef therefore checks the verifier's own
 * per-citation verdict FIRST (state.claimValidation, the latest pass —
 * post-repair when a repair ran): a citation number any claim explicitly
 * marked non-SUPPORTED is rejected outright, independent of whether its
 * evidenceId also appears in `citations` for an unrelated reason. This is
 * strictly narrower than the plain membership check, never wider — it can
 * only reject more, never approve something membership alone would not
 * already have approved.
 *
 * Each builder returns either a block object that ALREADY passed its Zod
 * schema (graph/schemas.js), or `null` — never a partially-built or
 * unvalidated shape, and never a thrown error (the aggregator in
 * graph/nodes/buildResponseBlocks.js still wraps every call in try/catch
 * as a second layer, but a well-behaved builder should never need it).
 */
import {
  MetricGridBlockSchema, ComparisonTableBlockSchema, SourceListBlockSchema,
  DataQualityBlockSchema, SuggestedQuestionsBlockSchema, CompanyHeaderBlockSchema,
  EvidenceDrawerBlockSchema, NewsListBlockSchema, ChartBlockSchema, isSafeBlockUrl,
  CHART_PRICE_BASES, MAX_CHART_POINTS,
} from '../graph/schemas.js';
// UI Phase 1C.2: REUSE, not reimplementation — the same URL-canonicalizer
// services/NewsAPIService.js already uses to merge results across
// multiple symbol queries, applied here to dedupe news_list cards by
// normalized URL. A plain, exported, pure function; importing it adds no
// I/O and no new provider/DB dependency to this module.
import { canonicalizeArticleUrl } from './NewsAPIService.js';

const MAX_METRICS_PER_GRID = 20;
const MAX_COMPARISON_ROWS = 20;
const MAX_COMPARISON_SYMBOLS = 6;
const MAX_SOURCES = 20;
const MAX_NEWS_ARTICLES = 5;
const MAX_GAPS = 10;
const MIN_CHART_POINTS = 2;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * resolveEvidenceRef - the ONE place a claim-plan citation number becomes
 * an EvidenceRefSchema. `citationNumber` is a claim's `citation` field
 * (services/claimPlan.js) — the 1-based index into the evidence array the
 * plan was built from (graph/state.js's `state.evidence`), which is also
 * exactly the number rendered as the answer's [N] marker.
 *
 * TWO INDEPENDENT CHECKS, both against the LATEST validation pass, either
 * of which can reject the reference — never a best-effort guess:
 *
 *   1. `claimValidation` (the verifier's own per-citation verdict, when it
 *      ran this pass): a citation number ANY claim explicitly marked
 *      non-SUPPORTED is rejected immediately, before membership is even
 *      checked. This is the authoritative "was this SPECIFIC claim
 *      approved" signal — see the module note above for why membership
 *      alone is not sufficient. Empty/absent claimValidation (the
 *      verifier legitimately did not run this turn — see
 *      claimValidation.js's needsClaimVerifier) rejects nothing here; it
 *      falls through to check 2 alone, exactly as before that check
 *      existed.
 *   2. The evidence record is present in `citations` — the final,
 *      published, already-verified array (state.citations). This is what
 *      makes a stale/pruned claim-plan entry (repairAnswer.js's
 *      repairClaimPlan prunes the rendered TEXT but never rewrites
 *      state.claimPlan itself) impossible to surface as if it were still
 *      backing the answer.
 */
export const resolveEvidenceRef = (citationNumber, evidence, citations, claimValidation = []) => {
  if (!Number.isInteger(citationNumber) || citationNumber < 1) return null;
  const record = Array.isArray(evidence) ? evidence[citationNumber - 1] : null;
  if (!record?.evidenceId) return null;

  // Check 1: an explicit rejection for THIS citation number always wins,
  // regardless of what citations-array membership would otherwise say.
  const explicitlyRejected = (claimValidation || []).some(
    (claim) => claim?.verdict !== 'SUPPORTED' && Array.isArray(claim?.evidenceIndexes) && claim.evidenceIndexes.includes(citationNumber),
  );
  if (explicitlyRejected) return null;

  // Check 2: membership in the final, published citations array.
  const citationIndex = (citations || []).findIndex((c) => c?.evidenceId === record.evidenceId);
  if (citationIndex === -1) return null; // not part of the FINAL published/verified answer
  return { evidenceId: record.evidenceId, citationIndex: citationIndex + 1 };
};

/**
 * buildMetricGridBlock - single-company figures from the claim plan. Only
 * produced for a NON-comparison plan; a comparison's figures go through
 * buildComparisonTableBlock instead so a figure is never rendered twice
 * across two different blocks.
 */
export const buildMetricGridBlock = (state) => {
  const plan = state.claimPlan;
  if (!plan || plan.isComparison || !Array.isArray(plan.rows) || !plan.rows.length) return null;
  const symbol = plan.symbols?.[0];
  if (!symbol) return null;

  const metrics = [];
  for (const row of plan.rows) {
    const claim = row?.values?.[symbol];
    if (!claim) continue;
    const ref = resolveEvidenceRef(claim.citation, state.evidence, state.citations, state.claimValidation);
    if (!ref) continue; // unresolved reference -- this metric is dropped, not guessed at
    metrics.push({
      metric: row.metric,
      label: row.label || row.metric,
      value: claim.value,
      unit: claim.unit || null,
      period: claim.period || null,
      evidence: [ref],
    });
    if (metrics.length >= MAX_METRICS_PER_GRID) break;
  }
  if (!metrics.length) return null;

  const parsed = MetricGridBlockSchema.safeParse({ type: 'metric_grid', symbol, metrics });
  return parsed.success ? parsed.data : null;
};

/**
 * buildComparisonTableBlock - the multi-company claim-plan rows, mirroring
 * exactly what answerRenderer.js's comparableRows/nonComparableRows
 * already decided about period-comparability (row.comparable/commonPeriod
 * are read verbatim, never re-derived here) — this block is a structured
 * VIEW of the same decision the prose already made, not a second opinion.
 */
export const buildComparisonTableBlock = (state) => {
  const plan = state.claimPlan;
  if (!plan || !plan.isComparison || !Array.isArray(plan.rows) || !plan.rows.length) return null;
  const symbols = (plan.symbols || []).slice(0, MAX_COMPARISON_SYMBOLS);
  if (symbols.length < 2) return null;

  const rows = [];
  for (const row of plan.rows) {
    const values = {};
    for (const symbol of Object.keys(row?.values || {})) {
      if (!symbols.includes(symbol)) continue;
      const claim = row.values[symbol];
      const ref = resolveEvidenceRef(claim.citation, state.evidence, state.citations, state.claimValidation);
      if (!ref) continue; // this cell is dropped, not the whole row
      values[symbol] = { value: claim.value, unit: claim.unit || null, evidence: [ref] };
    }
    if (!Object.keys(values).length) continue; // nothing in this row survived reference validation
    rows.push({
      metric: row.metric,
      label: row.label || row.metric,
      values,
      commonPeriod: row.commonPeriod || null,
      comparable: Boolean(row.comparable),
    });
    if (rows.length >= MAX_COMPARISON_ROWS) break;
  }
  if (!rows.length) return null;

  const parsed = ComparisonTableBlockSchema.safeParse({ type: 'comparison_table', symbols, rows });
  return parsed.success ? parsed.data : null;
};

/**
 * buildCompanyHeaderBlock - UI Phase 1C.1. Single-company only (mirrors
 * buildMetricGridBlock's own scope boundary — a comparison turn's per-
 * company headers are a Phase 1C.2+ extension, not added here).
 *
 * TWO DIFFERENT TRUST MODELS, deliberately:
 *   - companyName/sector/exchange are REFERENCE METADATA from
 *     state.companyProfiles (composeAnswer.js's capture of
 *     CompanyResearchProfile — generated from the real BSE/NSE scrip
 *     master, not a factual claim requiring a citation, same trust level
 *     answerRenderer.js already gives sectorKindBySymbol/notMeaningfulMetrics).
 *   - price is a genuine time-sensitive FACTUAL CLAIM and goes through the
 *     exact same resolveEvidenceRef discipline (including the
 *     claimValidation resurrection check) as every other numeric figure in
 *     this system. Preferred source: a live quote (claimPlan.livePrice) if
 *     present and resolvable, else the stored historical close
 *     (claimPlan.market) — never blurred into each other (see
 *     claimPlan.js's LIVE_PRICE/MARKET_HISTORY note). No price at all
 *     (rather than a guess) when neither resolves.
 */
export const buildCompanyHeaderBlock = (state) => {
  const plan = state.claimPlan;
  if (!plan || plan.isComparison) return null;
  const symbol = plan.symbols?.[0];
  if (!symbol) return null;

  const profile = state.companyProfiles?.[symbol];
  if (!profile?.companyName) return null; // nothing verified worth a header without at least a real name

  let price = null;
  const priceClaim = plan.livePrice?.[symbol] || plan.market?.[symbol];
  if (priceClaim && Number.isFinite(priceClaim.value)) {
    const ref = resolveEvidenceRef(priceClaim.citation, state.evidence, state.citations, state.claimValidation);
    if (ref) {
      price = {
        value: priceClaim.value,
        currency: 'INR',
        asOf: priceClaim.timestamp || priceClaim.asOf || null,
        evidence: [ref],
      };
    }
  }

  const candidate = {
    type: 'company_header',
    symbol,
    companyName: profile.companyName,
    sector: profile.sector || null,
    exchange: profile.exchange || null,
    price,
  };
  const parsed = CompanyHeaderBlockSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

/**
 * buildSourceListBlock - a structured mirror of the FINAL citations array,
 * independent of which answer path (legacy claim-plan or Phase 4B
 * grounded) produced it. Normalizes the two different citation shapes
 * (graph/evidence.js's buildEvidenceRecord vs graph/groundedAnswer.js's
 * citationFromEvidence — see the Phase 1A audit) at THIS boundary only,
 * per the approved decision: neither underlying shape is touched.
 */
export const buildSourceListBlock = (state) => {
  const citations = state.citations || [];
  if (!citations.length) return null;

  const sources = [];
  citations.slice(0, MAX_SOURCES).forEach((c, index) => {
    if (!c?.evidenceId) return; // no durable reference -- never included
    const rawUrl = c.sourceUrl || null;
    sources.push({
      evidenceId: c.evidenceId,
      citationIndex: index + 1,
      title: c.title || c.documentTitle || null,
      sourceUrl: rawUrl && isSafeBlockUrl(rawUrl) ? rawUrl : null,
      provider: c.provider || c.sourceAuthority || null,
      publishedAt: c.publishedAt || null,
      reportingPeriod: c.reportingPeriod || null,
    });
  });
  if (!sources.length) return null;

  const parsed = SourceListBlockSchema.safeParse({ type: 'source_list', sources });
  return parsed.success ? parsed.data : null;
};

/**
 * resolvePageRange - the two citation shapes (see the Phase 1A audit)
 * used to disagree on this specifically: legacy evidence records carried a
 * single `pageNumber`, grounded citations carried `pageStart`/`pageEnd`.
 * UI Phase 1D: graph/citations.js's citationFromLegacyEvidence now
 * normalizes pageNumber into pageStart/pageEnd at the citation boundary
 * itself, so every citation reaching this function already uses one
 * shape — the `pageNumber` branch below is kept only as a defensive
 * fallback for any caller that hands this function a raw evidence-shaped
 * object directly rather than a citation. A single real page becomes a
 * one-page range, never invented as a spread.
 */
const resolvePageRange = (citation) => {
  if (Number.isInteger(citation?.pageStart)) return { pageStart: citation.pageStart, pageEnd: Number.isInteger(citation.pageEnd) ? citation.pageEnd : citation.pageStart };
  if (Number.isInteger(citation?.pageNumber)) return { pageStart: citation.pageNumber, pageEnd: citation.pageNumber };
  return { pageStart: null, pageEnd: null };
};

/**
 * buildEvidenceDrawerBlock - UI Phase 1C.1. The RICH per-citation view
 * (excerpt, document type, page range, temporal status, canonical
 * guidance) that source_list (Phase 1B) deliberately does not carry — see
 * source_list's own schema note. Built from the exact same `state.citations`
 * array as source_list, normalizing both citation shapes at this one
 * boundary (the underlying shapes themselves are never touched, per the
 * approved Phase 1B decision this phase continues).
 */
export const buildEvidenceDrawerBlock = (state) => {
  const citations = state.citations || [];
  if (!citations.length) return null;

  const entries = [];
  citations.slice(0, MAX_SOURCES).forEach((c, index) => {
    if (!c?.evidenceId) return; // no durable reference -- never included
    const rawUrl = c.sourceUrl || null;
    const { pageStart, pageEnd } = resolvePageRange(c);
    entries.push({
      evidenceId: c.evidenceId,
      citationIndex: index + 1,
      title: c.title || c.documentTitle || null,
      // Truncated to the SAME 500-char convention evidence.js's
      // evidenceForPrompt and groundedAnswer.js's citationFromEvidence
      // already use elsewhere, proactively -- an unusually long raw
      // provider excerpt must degrade THIS ONE FIELD, not silently fail
      // EvidenceDrawerBlockSchema's validation for the whole block.
      excerpt: c.excerpt ? String(c.excerpt).slice(0, 500) : null,
      sourceUrl: rawUrl && isSafeBlockUrl(rawUrl) ? rawUrl : null,
      provider: c.provider || c.sourceAuthority || null,
      publishedAt: c.publishedAt || null,
      reportingPeriod: c.reportingPeriod || null,
      documentType: c.documentType || null,
      pageStart,
      pageEnd,
      temporalStatus: c.temporalStatus || null,
      canonicalGuidance: c.canonicalGuidance || null,
    });
  });
  if (!entries.length) return null;

  const parsed = EvidenceDrawerBlockSchema.safeParse({ type: 'evidence_drawer', entries });
  return parsed.success ? parsed.data : null;
};

/**
 * buildNewsListBlock - UI Phase 1C.2. Built ONLY from state.citations
 * (never state.evidence directly) — the exact same "relevance" reasoning
 * buildSourceListBlock/buildEvidenceDrawerBlock already rely on: an
 * article only reaches here if the PUBLISHED, VALIDATED answer actually
 * cited it. A news_list block therefore appears only when news genuinely
 * informed this turn's answer, never merely because getCompanyNews was
 * called and returned something the answer never used.
 *
 * No summary/excerpt field is carried at all (see NewsArticleSchema's own
 * note) — headline, publisher, date and link are the real article's own
 * fields, verbatim, never model-generated or paraphrased, so there is no
 * separate "claim" here needing its own claim-level check beyond the
 * evidence-reference validation every other block already applies.
 */
export const buildNewsListBlock = (state) => {
  const citations = state.citations || [];
  if (!citations.length) return null;

  // UI Phase 1D audit fix: imageUrl is sourced from state.evidence (matched
  // by evidenceId), never from the citation object itself -- citations use
  // an explicit, minimal, client/persistence-supported field whitelist
  // (graph/citations.js's citationFromLegacyEvidence) that deliberately
  // does not carry imageUrl, so it never leaks into the citations array
  // sent to the client. The real, provider-validated image still reaches
  // this block through its own proper field.
  const evidenceById = new Map((state.evidence || []).map((e) => [e.evidenceId, e]));

  const seenUrls = new Set();
  const articles = [];

  citations.forEach((c, index) => {
    if (c?.claimType !== 'COMPANY_NEWS') return;
    if (!c?.evidenceId || !c?.title) return; // no durable reference or no real headline -- never included
    const url = c.sourceUrl;
    if (!url || !isSafeBlockUrl(url)) return; // no invented/unsafe links -- a card with no real link is not built at all

    const canonicalUrl = canonicalizeArticleUrl(url);
    if (seenUrls.has(canonicalUrl)) return; // Phase 1C.2: dedupe by normalized URL
    seenUrls.add(canonicalUrl);

    const rawImage = evidenceById.get(c.evidenceId)?.imageUrl;
    articles.push({
      evidenceId: c.evidenceId,
      citationIndex: index + 1,
      symbol: c.symbol || null,
      title: c.title,
      url,
      publisher: c.provider || null,
      // Never substituted with "today" — an honestly-absent date stays null.
      publishedAt: c.publishedAt || null,
      imageUrl: rawImage && isSafeBlockUrl(rawImage) ? rawImage : null,
    });
  });

  if (!articles.length) return null;

  const parsed = NewsListBlockSchema.safeParse({ type: 'news_list', articles: articles.slice(0, MAX_NEWS_ARTICLES) });
  return parsed.success ? parsed.data : null;
};

/**
 * buildChartBlock - UI Phase 1C.3. Single-company only (mirrors
 * buildMetricGridBlock/buildCompanyHeaderBlock's own scope boundary).
 * Anchored to ONE resolved evidence reference — the SAME resolveEvidenceRef
 * discipline (including the claimValidation resurrection check) every
 * other numeric block field in this system uses, applied to the whole
 * series as a single claim rather than per-point (a chart is one claim —
 * "here is TCS's price history" — not N independent ones; see
 * services/claimPlan.js's PRICE_HISTORY_EXCERPT note).
 *
 * CITATION PRESENCE ALONE IS NOT ENOUGH, deliberately, per the brief: a
 * resolved reference only proves the CLAIM (that a price-history series
 * exists and was actually published) survived verification. It says
 * nothing about whether the underlying SERIES DATA itself is well-formed.
 * Every point is therefore independently validated here — finite, positive
 * close; a real YYYY-MM-DD date; no duplicate date — before the block is
 * ever assembled, exactly like the brief's "validate source data before
 * publication" requirement. A malformed point is dropped, never guessed
 * at or silently kept; the whole chart is omitted (not guessed at either)
 * if fewer than two valid points survive.
 */
export const buildChartBlock = (state) => {
  const plan = state.claimPlan;
  if (!plan || plan.isComparison) return null;
  const symbol = plan.symbols?.[0];
  if (!symbol) return null;
  const claim = plan.priceHistory?.[symbol];
  if (!claim) return null;

  const ref = resolveEvidenceRef(claim.citation, state.evidence, state.citations, state.claimValidation);
  if (!ref) return null; // the verifier rejected this claim, or it was never actually published -- no chart either way

  const rawPoints = Array.isArray(claim.series) ? claim.series : [];
  const seenDates = new Set();
  const cleaned = [];
  for (const point of rawPoints) {
    const date = typeof point?.date === 'string' && DATE_ONLY_PATTERN.test(point.date) ? point.date : null;
    const close = Number(point?.close);
    // Never invent, never fill a missing/invalid price -- the point is
    // simply dropped, which is also how a genuine gap becomes visible.
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    if (seenDates.has(date)) continue; // a duplicate date is dropped, never silently overwritten
    seenDates.add(date);
    cleaned.push({ date, close, gapBefore: Boolean(point.gapBefore) });
  }
  // Defensively re-sorted chronologically even though the tool already
  // returns points in order -- this builder never trusts upstream ordering
  // as the ONLY guarantee (see ChartBlockSchema's own refine, which would
  // otherwise reject a block this builder itself assembled out of order).
  cleaned.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));

  // Bounded to the most recent MAX_CHART_POINTS -- "the last year" means
  // the MOST RECENT year, never an arbitrary earlier slice.
  const bounded = cleaned.length > MAX_CHART_POINTS ? cleaned.slice(cleaned.length - MAX_CHART_POINTS) : cleaned;
  if (bounded.length < MIN_CHART_POINTS) return null; // fewer than two valid points -- omit the chart, the rest of the answer is unaffected

  // The first rendered point can never honestly claim a gap before it --
  // there is nothing rendered before it to gap from (any earlier exclusion
  // is invisible to a reader who only ever sees this bounded window).
  bounded[0] = { ...bounded[0], gapBefore: false };

  const priceBasis = CHART_PRICE_BASES.includes(claim.adjustmentStatus) ? claim.adjustmentStatus : 'NOT_REQUIRED';

  const candidate = {
    type: 'chart',
    version: 1,
    symbol,
    currency: 'INR', // this project's only currency/exchange today -- never invented for a different one
    priceBasis,
    points: bounded,
    // The REAL range of what is actually being shown, computed from the
    // final bounded/cleaned points -- never the tool's original claim.
    // rangeStart/rangeEnd, which could differ after point-level cleaning.
    rangeStart: bounded[0].date,
    rangeEnd: bounded[bounded.length - 1].date,
    requestedRangeDays: claim.requestedRangeDays ?? null,
    provider: claim.provider || null,
    sourceUrl: isSafeBlockUrl(claim.sourceUrl) ? claim.sourceUrl : null,
    dataAsOf: claim.asOf || null,
    evidence: [ref],
  };
  const parsed = ChartBlockSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

/**
 * buildDataQualityBlock - names gaps that are ALREADY computed elsewhere
 * (never re-derived): Phase 4B's server-recomputed groundingStatus, Phase
 * 6B's requestedPeriods-vs-held mismatch (claimPlan.unmatchedRequestedPeriods)
 * and valuation gaps (state.valuationCoverage), and Phase 4B's own
 * model-self-reported coverage.limitations (already rendered directly in
 * production today by ChatMessageBubble's GroundingStatusBadge, so nothing
 * new is exposed by including it here).
 *
 * Omitted entirely when there is genuinely nothing to report -- a
 * "data_quality" block with every field empty would tell the user less
 * than no block at all.
 */
export const buildDataQualityBlock = (state) => {
  const groundingStatus = state.groundingStatus || null;
  const unmatchedRequestedPeriods = (state.claimPlan?.unmatchedRequestedPeriods || []).slice(0, MAX_GAPS);
  const valuationGaps = (state.valuationCoverage || [])
    .flatMap((entry) => (entry?.unavailable || []).map((gap) => ({
      symbol: entry.symbol, metric: gap.metric, reason: gap.reason,
    })))
    .filter((gap) => gap.symbol && gap.metric && gap.reason)
    .slice(0, MAX_GAPS);
  const limitations = (state.coverage?.limitations || []).slice(0, MAX_GAPS);

  if (!groundingStatus && !unmatchedRequestedPeriods.length && !valuationGaps.length && !limitations.length) return null;

  const parsed = DataQualityBlockSchema.safeParse({
    type: 'data_quality', groundingStatus, unmatchedRequestedPeriods, valuationGaps, limitations,
  });
  return parsed.success ? parsed.data : null;
};

/**
 * SUGGESTED_QUESTION_TEMPLATES - DETERMINISTIC templates only, per the
 * approved decision. No model call, no free text generation — every
 * question is a fixed string with, at most, a real resolved symbol
 * substituted in. Keyed by intent (graph/schemas.js's INTENTS), so an
 * intent with no template here (GENERAL_EDUCATION, UNSUPPORTED, DOCUMENT_
 * RESEARCH, NEWS_RESEARCH, FOLLOW_UP) simply produces no block rather than
 * a generic/irrelevant suggestion.
 */
const SUGGESTED_QUESTION_TEMPLATES = Object.freeze({
  STOCK_COMPARISON: (symbols) => (symbols.length >= 2 ? [
    `How do ${symbols[0]} and ${symbols[1]} compare on valuation?`,
    `Which of ${symbols[0]} or ${symbols[1]} has the stronger balance sheet?`,
  ] : []),
  COMPANY_RESEARCH: (symbols) => (symbols[0] ? [
    `What was ${symbols[0]}'s most recent quarterly revenue?`,
    `How has ${symbols[0]}'s margin trended over the last year?`,
    `What is ${symbols[0]}'s valuation compared to its sector peers?`,
  ] : []),
  EARNINGS_INTELLIGENCE: (symbols) => (symbols[0] ? [
    `Has ${symbols[0]} met its most recent guidance?`,
    `What did ${symbols[0]} say in its last earnings call?`,
  ] : []),
  LIVE_MARKET_DATA: (symbols) => (symbols[0] ? [
    `How has ${symbols[0]} performed over the past year?`,
  ] : []),
  WATCHLIST_ANALYSIS: () => [
    'Which of my watchlist stocks has the weakest fundamentals?',
  ],
  PORTFOLIO_ANALYSIS: () => [
    'How diversified is my portfolio by sector?',
  ],
});

/**
 * buildSuggestedQuestionsBlock - see SUGGESTED_QUESTION_TEMPLATES above.
 * Reads only state.intent and state.entities.symbols; never the answer
 * text, never an evidence lookup (these questions are not factual claims
 * about a company, so they carry no `evidence` field at all — see
 * graph/schemas.js's SuggestedQuestionsBlockSchema).
 */
export const buildSuggestedQuestionsBlock = (state) => {
  const template = SUGGESTED_QUESTION_TEMPLATES[state.intent];
  if (!template) return null;
  const symbols = (state.entities?.symbols || []).map((s) => String(s).toUpperCase());
  const questions = template(symbols).filter(Boolean);
  if (!questions.length) return null;

  const parsed = SuggestedQuestionsBlockSchema.safeParse({ type: 'suggested_questions', questions });
  return parsed.success ? parsed.data : null;
};

/**
 * BLOCK_BUILDERS - every builder attempted, in a fixed order, by
 * graph/nodes/buildResponseBlocks.js. Adding a Phase 1C block type means
 * adding one entry here (plus its schema in graph/schemas.js) — nothing
 * else in the graph changes.
 */
export const BLOCK_BUILDERS = Object.freeze([
  buildCompanyHeaderBlock,
  buildMetricGridBlock,
  buildComparisonTableBlock,
  buildSourceListBlock,
  buildEvidenceDrawerBlock,
  buildNewsListBlock,
  buildChartBlock,
  buildDataQualityBlock,
  buildSuggestedQuestionsBlock,
]);

export default {
  resolveEvidenceRef,
  buildCompanyHeaderBlock,
  buildMetricGridBlock,
  buildComparisonTableBlock,
  buildSourceListBlock,
  buildEvidenceDrawerBlock,
  buildNewsListBlock,
  buildChartBlock,
  buildDataQualityBlock,
  buildSuggestedQuestionsBlock,
  BLOCK_BUILDERS,
};
