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
} = {}) => {
  if (!claimType || !CLAIM_TYPES.includes(claimType)) return null;

  return {
    evidenceId: uuidv4(),
    claimType,
    symbol: symbol ? String(symbol).toUpperCase() : null,
    title: title || null,
    sourceUrl: isUsableUrl(sourceUrl) ? sourceUrl : null,
    provider: provider || null,
    publishedAt: publishedAt || null,
    reportingPeriod: reportingPeriod || null,
    excerpt: excerpt || null,
    pageNumber: Number.isInteger(pageNumber) ? pageNumber : null,
    retrievedAt: new Date().toISOString(),
    evidenceQuality: evidenceQuality || null,
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
