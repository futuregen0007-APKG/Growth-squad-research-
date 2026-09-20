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

    if (MARKET_EXCERPT.test(excerpt)) {
      claims.push({
        kind: 'MARKET',
        symbol: item.symbol || null,
        excerpt,
        citation,
        asOf: item.publishedAt || null,
        sourceUrl: item.sourceUrl || null,
      });
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
export const buildClaimPlan = ({ evidence = [], symbols = [], sectorKindBySymbol = {}, missingEvidence = [] } = {}) => {
  const claims = extractClaims(evidence);
  const metricClaims = claims.filter((c) => c.kind === 'METRIC');
  const marketClaims = claims.filter((c) => c.kind === 'MARKET');

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

  return {
    symbols: resolvedSymbols,
    isComparison: resolvedSymbols.length > 1,
    primarySector,
    rows,
    market,
    missing: missingEvidence || [],
    notMeaningful: primarySector === SECTOR_KINDS.BANKING ? SECTOR_METRICS.BANKING.notMeaningful : [],
    hasAnything: rows.length > 0 || Object.keys(market).length > 0,
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
