/**
 * claimPlan.js
 * ==============
 * Phase 6A reliability: build a STRUCTURED claim plan from evidence, before
 * any prose exists, and render the factual core of the answer from it
 * deterministically.
 *
 * WHY, measured. A 5x5 stability trace (25 runs of the five mandatory
 * queries) found 25/25 retrieving evidence but only 4/25 passing
 * verification. The failures were not retrieval and not citation parsing:
 *
 *     UNSUPPORTED_INFERENCE  20
 *     MISSING_CITATION        5
 *     WRONG_CITATION          2
 *     PERIOD_MISMATCH         2
 *
 * Every one originates in FREE-TEXT GENERATION: the model restates a real
 * figure without its citation, or writes an interpretation ("this means X
 * earns more from its assets") that no single evidence item supports, and
 * the deterministic verifier correctly rejects it. Two rounds of prompt
 * instruction did not make it reliable, because it is a sampling property,
 * not a comprehension failure.
 *
 * So the numbers stop being generated. This module extracts every material
 * claim into a typed record — company, metric, value, unit, reporting
 * period, and the exact evidence index that backs it — and the renderer
 * emits the table, the provenance, the limitations and a rule-derived
 * conditional verdict directly from those records. The model cannot invent,
 * round, re-period, or mis-cite a number it never writes.
 *
 * WHAT IS NOT BYPASSED: the claim verifier still runs on the rendered
 * answer, unchanged. Deterministic rendering earns its verification rather
 * than skipping it.
 */
import { SECTOR_METRICS, SECTOR_KINDS } from './storedFundamentals.js';

/**
 * The excerpt format this project's stored-evidence records use, which this
 * module also parses back:  `METRIC: value UNIT (PERIOD) - title`
 * We generate it (toolRegistry.storedFundamentalsEvidence) and we read it,
 * so the round-trip is exact rather than heuristic.
 */
const METRIC_EXCERPT = /^([A-Z_]+):\s*(-?[\d.]+)\s*([A-Z_%]+)?\s*(?:\(([^)]+)\))?\s*(?:-\s*(.*))?$/;

/** Market-history excerpt: `close INR 404.35, 1-year return 1.48%, ...` */
const MARKET_EXCERPT = /close INR\s+(-?[\d.]+)/i;

/**
 * Live-quote excerpt: `Price ₹2105.5, change -1.23% as of 2026-09-11T...`
 * (graph/tools/toolRegistry.js's getLiveQuote). UI Phase 1C.1: parsed so
 * company_header can show a real, cited live price — the SAME
 * code-controlled-format parsing technique METRIC_EXCERPT/MARKET_EXCERPT
 * already use, applied to a claim type (LIVE_PRICE) neither of them
 * recognizes. Deliberately kept a SEPARATE claim kind from MARKET (never
 * blurred together) — the whole reason evidence.js keeps LIVE_PRICE and
 * MARKET_HISTORY as distinct claim types is so a stale historical close is
 * never labelled as a live quote.
 */
const LIVE_PRICE_EXCERPT = /^Price\s*₹(-?[\d.]+),\s*change\s*(-?[\d.]+)%\s*as of\s*(.+)$/i;

/**
 * Price-history excerpt: `PRICE_HISTORY: 90 points, INR, NSE_BHAVCOPY,
 * NOT_REQUIRED (2026-03-01 to 2026-09-01)` (graph/tools/toolRegistry.js's
 * getPriceHistory). UI Phase 1C.3: a THIRD, distinct claim kind — never
 * matched by MARKET_EXCERPT (no "close INR" substring) so a bounded
 * per-day series never collides with or overwrites the single aggregate
 * MARKET claim renderMarket already prints. The actual {date, close}[]
 * values are read directly from the evidence item's own `chartSeries`
 * field below (structured data, never re-derived from this string) — the
 * regex only confirms the excerpt is well-formed and extracts the human-
 * readable currency/provider/basis/range for the rendered prose line.
 */
const PRICE_HISTORY_EXCERPT = /^PRICE_HISTORY:\s*(\d+)\s*points?,\s*([A-Z]+),\s*([A-Z_]+),\s*([A-Z_]+)\s*\(([\d-]+)\s*to\s*([\d-]+)\)$/;

export const METRIC_LABELS = Object.freeze({
  NIM: 'Net interest margin (NIM)',
  ROA: 'Return on assets (ROA)',
  ROE: 'Return on equity (ROE)',
  GNPA: 'Gross NPA',
  NNPA: 'Net NPA',
  CASA: 'CASA ratio',
  OPERATING_MARGIN: 'Operating margin',
  EBITDA_MARGIN: 'EBITDA margin',
  REVENUE: 'Revenue',
  PAT: 'Profit after tax (PAT)',
  EBITDA: 'EBITDA',
  EPS: 'Earnings per share (EPS)',
  ORDER_BOOK: 'Order book',
  DEPOSITS: 'Deposits',
  LOAN_PORTFOLIO: 'Loan portfolio',
  DEBT: 'Debt',
  CAPEX: 'Capex',
});

/**
 * RATIO_METRICS are size-independent and therefore the ONLY metrics a
 * verdict may rest on. An absolute figure (PAT, revenue, deposits) says how
 * BIG a company is, not how well it performs: "HDFC Bank earns more profit
 * than ICICI" is a statement about scale, and using it as evidence of
 * better profitability between differently sized banks is a category error
 * the earlier answers made.
 */
export const RATIO_METRICS = new Set(['NIM', 'ROA', 'ROE', 'GNPA', 'NNPA', 'CASA', 'OPERATING_MARGIN', 'EBITDA_MARGIN']);

/** For these, LOWER is better (asset quality). */
export const LOWER_IS_BETTER = new Set(['GNPA', 'NNPA']);

/** Formats a value with its unit exactly as stored — never rescaled. */
export const formatValue = (value, unit) => {
  if (!Number.isFinite(value)) return null;
  const u = String(unit || '').toUpperCase();
  if (u === 'PERCENTAGE' || u === 'PERCENT' || u === '%') return `${value}%`;
  if (u === 'INR_CRORE') return `₹${value.toLocaleString('en-IN')} Cr`;
  if (u === 'USD_MILLION') return `$${value.toLocaleString('en-US')}M`;
  if (u === 'INR') return `₹${value}`;
  return `${value}${u ? ` ${u}` : ''}`;
};

/**
 * extractClaims - turns the numbered evidence array into typed claim
 * records. The evidence INDEX is captured here, which is what makes every
 * rendered citation correct by construction.
 */
export const extractClaims = (evidence = []) => {
  const claims = [];
  evidence.forEach((item, index) => {
    const citation = index + 1; // citations are 1-based over this same array
    const excerpt = String(item?.excerpt || '');

    const metricMatch = excerpt.match(METRIC_EXCERPT);
    if (metricMatch) {
      const [, metric, rawValue, unit, period, title] = metricMatch;
      const value = Number(rawValue);
      if (Number.isFinite(value)) {
        claims.push({
          kind: 'METRIC',
          symbol: item.symbol || null,
          metric,
          value,
          unit: unit || null,
          period: period || item.reportingPeriod || null,
          title: title || item.title || null,
          citation,
          sourceUrl: item.sourceUrl || null,
          asOf: item.publishedAt || null,
        });
      }
      return;
    }

    const marketMatch = excerpt.match(MARKET_EXCERPT);
    if (marketMatch) {
      const closeValue = Number(marketMatch[1]);
      claims.push({
        kind: 'MARKET',
        symbol: item.symbol || null,
        excerpt,
        // Additive: the parsed close, alongside the excerpt every existing
        // consumer (answerRenderer.js's renderMarket) already reads —
        // never removes or reformats the excerpt itself.
        value: Number.isFinite(closeValue) ? closeValue : null,
        citation,
        asOf: item.publishedAt || null,
        sourceUrl: item.sourceUrl || null,
      });
      return;
    }

    const priceHistoryMatch = excerpt.match(PRICE_HISTORY_EXCERPT);
    if (priceHistoryMatch) {
      const [, , currency, provider, adjustmentStatus, rangeStart, rangeEnd] = priceHistoryMatch;
      const series = Array.isArray(item.chartSeries) ? item.chartSeries : [];
      if (series.length) {
        claims.push({
          kind: 'PRICE_HISTORY',
          symbol: item.symbol || null,
          excerpt,
          series,
          currency: currency || 'INR',
          provider: provider || null,
          adjustmentStatus: adjustmentStatus || null,
          rangeStart: rangeStart || null,
          rangeEnd: rangeEnd || null,
          requestedRangeDays: Number.isInteger(item.requestedRangeDays) ? item.requestedRangeDays : null,
          citation,
          asOf: item.publishedAt || null,
          sourceUrl: item.sourceUrl || null,
        });
      }
      return;
    }

    const liveMatch = excerpt.match(LIVE_PRICE_EXCERPT);
    if (liveMatch) {
      const [, rawValue, rawChange, timestamp] = liveMatch;
      const value = Number(rawValue);
      const changePercent = Number(rawChange);
      if (Number.isFinite(value)) {
        claims.push({
          kind: 'LIVE_PRICE',
          symbol: item.symbol || null,
          value,
          changePercent: Number.isFinite(changePercent) ? changePercent : null,
          timestamp: timestamp.trim(),
          citation,
          sourceUrl: item.sourceUrl || null,
          asOf: item.publishedAt || null,
        });
      }
    }
  });
  return claims;
};

/** Newest period first. FY2026 > FY2024; a quarter sorts within its year. */
const periodRank = (period) => {
  const text = String(period || '');
  const year = Number((text.match(/FY(\d{4})/) || [])[1] || 0);
  const quarter = Number((text.match(/Q(\d)/) || [])[1] || 0);
  return year * 10 + quarter;
};

/**
 * buildClaimPlan - the structured plan the renderer works from.
 *
 * Comparability is decided HERE, not in prose: a metric row is
 * `comparable` only when every company in it reports the SAME period. The
 * plan prefers the latest period both companies share; where none exists it
 * still shows the figures but marks the row mismatched so the renderer can
 * label it explicitly rather than implying a like-for-like gap.
 */
export const buildClaimPlan = ({
  evidence = [], symbols = [], sectorKindBySymbol = {}, missingEvidence = [],
  requestedPeriods = [], valuationBySymbol = {},
} = {}) => {
  const claims = extractClaims(evidence);
  const metricClaims = claims.filter((c) => c.kind === 'METRIC');
  const marketClaims = claims.filter((c) => c.kind === 'MARKET');
  const livePriceClaims = claims.filter((c) => c.kind === 'LIVE_PRICE');
  const priceHistoryClaims = claims.filter((c) => c.kind === 'PRICE_HISTORY');

  const resolvedSymbols = symbols.length
    ? symbols.map((s) => String(s).toUpperCase())
    : [...new Set(metricClaims.map((c) => c.symbol).filter(Boolean))];

  // A bank if ANY resolved symbol is a bank: the metric vocabulary must
  // then include bank measures. Mixed comparisons keep both.
  const sectorKinds = new Set(resolvedSymbols.map((s) => sectorKindBySymbol[s] || SECTOR_KINDS.GENERAL));
  const primarySector = sectorKinds.has(SECTOR_KINDS.BANKING) && sectorKinds.size === 1
    ? SECTOR_KINDS.BANKING
    : (sectorKinds.size === 1 ? SECTOR_KINDS.GENERAL : 'MIXED');

  const metricOrder = primarySector === SECTOR_KINDS.BANKING
    ? [...SECTOR_METRICS.BANKING.primary, ...SECTOR_METRICS.BANKING.supporting]
    : [...SECTOR_METRICS.GENERAL.primary, ...SECTOR_METRICS.GENERAL.supporting];

  const rows = [];
  for (const metric of metricOrder) {
    const bySymbol = {};
    for (const symbol of resolvedSymbols) {
      const candidates = metricClaims
        .filter((c) => c.symbol === symbol && c.metric === metric)
        .sort((a, b) => periodRank(b.period) - periodRank(a.period));
      if (candidates.length) bySymbol[symbol] = candidates;
    }
    const present = Object.keys(bySymbol);
    if (!present.length) continue;

    // Prefer the latest period every present company shares.
    const periodSets = present.map((s) => new Set(bySymbol[s].map((c) => c.period)));
    const shared = [...periodSets[0]].filter((p) => periodSets.every((set) => set.has(p)));
    const commonPeriod = shared.sort((a, b) => periodRank(b) - periodRank(a))[0] || null;

    const chosen = {};
    for (const symbol of present) {
      chosen[symbol] = commonPeriod
        ? bySymbol[symbol].find((c) => c.period === commonPeriod)
        : bySymbol[symbol][0];
    }

    rows.push({
      metric,
      label: METRIC_LABELS[metric] || metric,
      isRatio: RATIO_METRICS.has(metric),
      lowerIsBetter: LOWER_IS_BETTER.has(metric),
      values: chosen,
      commonPeriod,
      // Comparable only when every company reports the same period AND more
      // than one company is present.
      comparable: Boolean(commonPeriod) && present.length > 1,
      periodsDiffer: !commonPeriod && present.length > 1,
    });
  }

  const market = {};
  for (const claim of marketClaims) if (claim.symbol) market[claim.symbol] = claim;

  // UI Phase 1C.1: one live quote per symbol, kept in its OWN field —
  // never merged into `market` (that would blur a live quote and a
  // historical close, exactly what evidence.js's LIVE_PRICE/MARKET_HISTORY
  // split exists to prevent). When more than one live-quote evidence item
  // exists for a symbol (should not normally happen — getLiveQuote is
  // cached per turn), the LAST one wins, matching `market`'s own
  // last-write-wins convention above.
  const livePrice = {};
  for (const claim of livePriceClaims) if (claim.symbol) livePrice[claim.symbol] = claim;

  // UI Phase 1C.3: one bounded price-history series per symbol, kept in
  // its own field for the exact same reason livePrice is kept separate
  // from market — a chart's full series is a materially different claim
  // from either a single live quote or a single aggregate close, and
  // blurring any of the three together would mislabel one as another.
  const priceHistory = {};
  for (const claim of priceHistoryClaims) if (claim.symbol) priceHistory[claim.symbol] = claim;

  return {
    symbols: resolvedSymbols,
    isComparison: resolvedSymbols.length > 1,
    primarySector,
    rows,
    market,
    livePrice,
    priceHistory,
    missing: missingEvidence || [],
    // Phase 6B: periods the QUESTION asked for, and whether the evidence
    // actually covers them. Answering "BEL revenue for FY2015" with a
    // Q4 FY2024 figure and no caveat is answering a different question.
    requestedPeriods: (requestedPeriods || []).map((p) => String(p).toUpperCase()),
    unmatchedRequestedPeriods: (requestedPeriods || [])
      .map((p) => String(p).toUpperCase())
      .filter((wanted) => !rows.some((row) => Object.values(row.values)
        .some((claim) => String(claim.period || '').toUpperCase().includes(wanted)))),
    // Phase 6B valuation, per company: the multiples actually held, and the
    // named reason for each one that is not. Carried on the plan so the
    // renderer states the real gap rather than a blanket "no multiples".
    valuation: valuationBySymbol || {},
    notMeaningful: primarySector === SECTOR_KINDS.BANKING ? SECTOR_METRICS.BANKING.notMeaningful : [],
    hasAnything: rows.length > 0 || Object.keys(market).length > 0 || Object.keys(priceHistory).length > 0,
  };
};

/**
 * buildVerdict - a CONDITIONAL comparison derived by rule, never a
 * recommendation and never generated text.
 *
 * Only comparable RATIO rows count. Absolute figures are excluded by
 * construction, so the verdict can never argue that the bigger bank is the
 * better one.
 */
export const buildVerdict = (plan) => {
  if (!plan.isComparison) return null;
  const usable = plan.rows.filter((r) => r.comparable && r.isRatio && Object.keys(r.values).length > 1);
  if (!usable.length) {
    return {
      comparable: false,
      text: 'No metric is reported for these companies in a shared period, so no like-for-like comparison is possible from the data held.',
      supporting: [],
    };
  }

  const wins = {};
  const supporting = [];
  for (const row of usable) {
    const entries = Object.entries(row.values);
    const sorted = [...entries].sort((a, b) => (row.lowerIsBetter
      ? a[1].value - b[1].value
      : b[1].value - a[1].value));
    const [leaderSymbol, leaderClaim] = sorted[0];
    const [, runnerClaim] = sorted[1];
    if (leaderClaim.value === runnerClaim.value) continue; // a tie favours nobody
    wins[leaderSymbol] = (wins[leaderSymbol] || 0) + 1;
    supporting.push({
      metric: row.metric,
      label: row.label,
      leader: leaderSymbol,
      period: row.commonPeriod,
      values: entries.map(([symbol, claim]) => ({ symbol, value: claim.value, unit: claim.unit, citation: claim.citation })),
    });
  }

  return { comparable: true, wins, supporting, text: null };
};

export default { buildClaimPlan, buildVerdict, extractClaims, formatValue, METRIC_LABELS, RATIO_METRICS };
