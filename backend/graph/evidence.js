import { v4 as uuidv4 } from 'uuid';

/**
 * evidence.js
 * ============
 * The normalized evidence record every GS Copilot factual claim must trace
 * back to. Built exclusively from real tool results — nothing here is ever
 * invented. `buildEvidenceRecord` is the ONLY way an evidence record is
 * created, so every field's provenance is enforced in one place.
 */

export const CLAIM_TYPES = Object.freeze([
  'LIVE_PRICE',
  // Phase 6A: NSE-derived historical price/market metrics (close, 52-week
  // range, one-year return, volatility, drawdown). Real price evidence, but
  // explicitly NOT a live quote - kept separate so an answer can never pass
  // historical data off as the current price.
  'MARKET_HISTORY',
  'COMPANY_PROFILE',
  'FINANCIAL_DATA',
  'KEY_METRIC',
  'SHAREHOLDING',
  'CORPORATE_ACTION',
  'ANALYST_FORECAST', // never presented as an actual outcome
  'COMPANY_NEWS',
  'MANAGEMENT_PROMISE',
  'PROMISE_OUTCOME',
  'DOCUMENT_EXCERPT',
  'WATCHLIST_DATA',
  'PORTFOLIO_DATA',
]);

const isUsableUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return null;
  }
};

/**
 * normalizePublishedAt - UI Phase 1D fix: a confirmed live bug, found via
 * real browser verification. Several stored-fallback evidence records
 * (services/storedFundamentals.js's fact.date, read via a `.lean()` Mongo
 * query) pass a raw JS Date object as `publishedAt`, not a string.
 * graph/schemas.js's SourceEntrySchema/EvidenceDrawerEntrySchema both
 * require `publishedAt: z.string()` — a Date object fails that check
 * SILENTLY (Zod's safeParse never throws), which dropped BOTH
 * source_list AND evidence_drawer ENTIRELY for any turn using this
 * fallback path, making every [N] citation marker on that turn a plain,
 * inert `<sup>` instead of a clickable evidence-drawer trigger. The same
 * raw Date, read as a claim's `asOf` field (services/claimPlan.js) and
 * printed via `String(date).slice(0, 10)` in answerRenderer.js's
 * renderMarket, is also why a live check showed "(as of Fri Sep 11)"
 * instead of "(as of 2026-09-11)" — JS Date's own default toString, not a
 * real ISO date.
 *
 * This is the ONE place every evidence record is built, so normalizing
 * here (rather than chasing every caller) closes the bug for every
 * current AND future caller at once. A real Date becomes its ISO string;
 * an already-correct string (or null) passes through unchanged; anything
 * else that cannot honestly be dated becomes null rather than a guess.
 */
const normalizePublishedAt = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') return value;
  return null;
};

/**
 * buildEvidenceRecord - constructs one evidence record from a real,
 * already-fetched piece of tool data. Returns null (never a fabricated
 * record) when the minimum required fields (claimType, symbol) are
 * missing.
 */
export const buildEvidenceRecord = ({
  claimType,
  symbol = null,
  title = null,
  sourceUrl = null,
  provider = null,
  publishedAt = null,
  reportingPeriod = null,
  excerpt = null,
  pageNumber = null,
  evidenceQuality = null,
  // UI Phase 1C.2: preserved for news_list — a COMPANY_NEWS article's real,
  // provider-validated image (services/NewsAPIService.js's own validUrl
  // check already ran before this reaches here; re-validated with the
  // SAME rule sourceUrl uses, never trusted at face value). Null/absent
  // for every other claim type, which is the correct, honest "no image"
  // state, never a placeholder.
  imageUrl = null,
  // UI Phase 1C.3: the real, bounded {date, close}[] series backing a
  // chart — populated ONLY for the price-history evidence
  // graph/tools/toolRegistry.js's getPriceHistory builds. Deliberately NOT
  // forwarded by evidenceForPrompt below (the LLM composer needs to know a
  // chart exists, never needs — and should never be tempted to restate —
  // dozens of raw numbers itself); null for every other claim type.
  chartSeries = null,
  // UI Phase 1C.3: the calendar-day window the QUESTION actually asked for
  // (planTools.js's parseRequestedRangeDays), carried alongside the series
  // so buildChartBlock can state honestly whether the chart's real range
  // matches what was requested — never invented when the question named no
  // range at all (stays null, exactly what the tool was given).
  requestedRangeDays = null,
} = {}) => {
  if (!claimType || !CLAIM_TYPES.includes(claimType)) return null;

  return {
    evidenceId: uuidv4(),
    claimType,
    symbol: symbol ? String(symbol).toUpperCase() : null,
    title: title || null,
    sourceUrl: isUsableUrl(sourceUrl) ? sourceUrl : null,
    provider: provider || null,
    publishedAt: normalizePublishedAt(publishedAt),
    reportingPeriod: reportingPeriod || null,
    excerpt: excerpt || null,
    pageNumber: Number.isInteger(pageNumber) ? pageNumber : null,
    retrievedAt: new Date().toISOString(),
    evidenceQuality: evidenceQuality || null,
    imageUrl: isUsableUrl(imageUrl) ? imageUrl : null,
    chartSeries: Array.isArray(chartSeries) ? chartSeries : null,
    requestedRangeDays: Number.isInteger(requestedRangeDays) && requestedRangeDays > 0 ? requestedRangeDays : null,
  };
};

/** Strips fields the model prompt doesn't need (raw payloads, internal ids) before sending evidence into the composer prompt. */
export const evidenceForPrompt = (evidence = []) => evidence.map((item) => ({
  evidenceId: item.evidenceId,
  claimType: item.claimType,
  symbol: item.symbol,
  title: item.title,
  sourceUrl: item.sourceUrl,
  provider: item.provider,
  publishedAt: item.publishedAt,
  reportingPeriod: item.reportingPeriod,
  excerpt: item.excerpt ? String(item.excerpt).slice(0, 500) : null,
}));

export default { CLAIM_TYPES, buildEvidenceRecord, evidenceForPrompt };
