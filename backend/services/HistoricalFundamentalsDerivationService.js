/**
 * HistoricalFundamentalsDerivationService.js
 * =============================================
 * Derives PERMITTED fundamental metrics from this project's own verified
 * CompanyHistoricalFact records (dataOrigin: 'REAL_RESEARCH') when IndianAPI
 * is unavailable/rate-limited -- tier 4 of StockFundamentalsService's lookup
 * priority. Never a live-provider call; pure Mongo reads + arithmetic on
 * already-verified, already-cited facts.
 *
 * Allowed: revenue growth/CAGR, PAT growth/CAGR, operating margin, debt
 * trend. Deliberately NOT allowed and never attempted here: P/E (needs a
 * verified EPS AND a current market price, which this fact set does not
 * reliably carry together) and ROE (never invented from unrelated facts).
 *
 * Every derived metric only uses facts that already satisfy, independently
 * of this service, CompanyHistoricalFact's own real-evidence requirements
 * (dataOrigin REAL_RESEARCH, a required source.url, a required period,
 * verified numeric metrics.actualValue+unit) -- this service adds ONE more
 * requirement of its own: growth/trend metrics require at least two
 * comparable (same metric family, same unit, same period-kind) annual
 * periods, so a single data point never gets asserted as a "trend".
 */
import mongoose from 'mongoose';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import { parseFiscalPeriod } from '../utils/financialNormalization.js';

const REVENUE_METRIC_ALIASES = ['REVENUE'];
const PAT_METRIC_ALIASES = ['PAT', 'ADJUSTED_PAT'];
const MARGIN_METRIC_ALIASES = ['OPERATING_MARGIN', 'EBITDA_MARGIN', 'MARGIN'];
const DEBT_METRIC_ALIASES = ['DEBT', 'NET_DEBT'];

// Only a plain annual fiscal-year label ("FY2024") is used for growth/trend
// derivation -- mixing a quarterly figure with an annual one (or two
// different quarters) would not be a genuine year-over-year comparison, and
// this service never invents a quarter-to-annual conversion.
const isAnnualPeriod = (period) => /^FY\d{4}$/i.test(String(period || '').trim());

const fetchAnnualFacts = async (symbol, metricAliases) => {
  if (mongoose.connection.readyState !== 1) return [];
  const facts = await CompanyHistoricalFact.find({
    symbol: String(symbol).toUpperCase(),
    dataOrigin: 'REAL_RESEARCH',
    'metrics.metric': { $in: metricAliases },
    'metrics.actualValue': { $ne: null },
    'source.url': { $ne: null },
  }).sort({ date: 1 }).lean();

  // One fact per fiscal year (keep the highest-confidence one if more than
  // one document reports the same year's figure) -- never averages two
  // different real numbers together.
  const byPeriod = new Map();
  for (const fact of facts) {
    if (!isAnnualPeriod(fact.period)) continue;
    if (!Number.isFinite(fact.metrics?.actualValue) || !fact.metrics?.unit) continue;
    const existing = byPeriod.get(fact.period);
    if (!existing || (fact.confidence || 0) > (existing.confidence || 0)) byPeriod.set(fact.period, fact);
  }
  return [...byPeriod.values()].sort((a, b) => parseFiscalPeriod(a.period).fiscalYear - parseFiscalPeriod(b.period).fiscalYear);
};

/**
 * deriveGrowthMetric - growth (or CAGR when the span exceeds one year)
 * between the EARLIEST and LATEST comparable annual fact for one metric
 * family. Requires >=2 periods with the same unit; returns null otherwise
 * (never mixes units, never asserts a trend from one data point).
 */
const deriveGrowthMetric = (facts) => {
  if (facts.length < 2) return null;
  const earliest = facts[0];
  const latest = facts[facts.length - 1];
  if (String(earliest.metrics.unit) !== String(latest.metrics.unit)) return null;
  if (earliest.metrics.actualValue === 0) return null; // avoid divide-by-zero fabricating a growth rate

  const yearsSpan = parseFiscalPeriod(latest.period).fiscalYear - parseFiscalPeriod(earliest.period).fiscalYear;
  const ratio = latest.metrics.actualValue / earliest.metrics.actualValue;
  const value = yearsSpan > 1
    ? Number(((ratio ** (1 / yearsSpan) - 1) * 100).toFixed(2))
    : Number(((ratio - 1) * 100).toFixed(2));

  return {
    value,
    periodsUsed: [earliest.period, latest.period],
    sourceUrls: [...new Set([earliest.source.url, latest.source.url])],
    dataAsOf: latest.date,
    derivationMethod: yearsSpan > 1
      ? `CAGR from ${earliest.period} to ${latest.period} (REAL_RESEARCH CompanyHistoricalFact)`
      : `Period-over-period growth from ${earliest.period} to ${latest.period} (REAL_RESEARCH CompanyHistoricalFact)`,
  };
};

/** debtTrend - same comparability rule as growth, expressed as a direction rather than a raw percentage. Within +/-3% is STABLE, never a false "no debt movement" claim beyond real measurement noise. */
const deriveDebtTrend = (facts) => {
  const growth = deriveGrowthMetric(facts);
  if (!growth) return null;
  const direction = growth.value > 3 ? 'INCREASING' : growth.value < -3 ? 'DECREASING' : 'STABLE';
  return { ...growth, direction, changePercent: growth.value };
};

/** operatingMargin - a level, not a trend: the single most recent verified annual figure is sufficient (no second period required). */
const deriveLatestMarginMetric = (facts) => {
  if (!facts.length) return null;
  const latest = facts[facts.length - 1];
  if (String(latest.metrics.unit).toUpperCase() !== 'PERCENTAGE') return null;
  return {
    value: latest.metrics.actualValue,
    periodsUsed: [latest.period],
    sourceUrls: [latest.source.url],
    dataAsOf: latest.date,
    derivationMethod: `Most recent verified annual figure (${latest.period}, REAL_RESEARCH CompanyHistoricalFact)`,
  };
};

/**
 * deriveFundamentalsFromHistoricalFacts - the tier-4 fallback entry point.
 * Returns null if NOTHING could be derived (never a half-empty fabricated
 * object); otherwise returns { revenueGrowth, profitGrowth, operatingMargin,
 * debtTrend, missingMetrics, provenance, dataAsOf }, each metric either a
 * real derived value+provenance or absent (never zero/null standing in for
 * "not derivable").
 */
export const deriveFundamentalsFromHistoricalFacts = async (symbol) => {
  const [revenueFacts, patFacts, marginFacts, debtFacts] = await Promise.all([
    fetchAnnualFacts(symbol, REVENUE_METRIC_ALIASES),
    fetchAnnualFacts(symbol, PAT_METRIC_ALIASES),
    fetchAnnualFacts(symbol, MARGIN_METRIC_ALIASES),
    fetchAnnualFacts(symbol, DEBT_METRIC_ALIASES),
  ]);

  const revenueGrowth = deriveGrowthMetric(revenueFacts);
  const profitGrowth = deriveGrowthMetric(patFacts);
  const operatingMargin = deriveLatestMarginMetric(marginFacts);
  const debtTrend = deriveDebtTrend(debtFacts);

  const derived = {
    revenueGrowth: revenueGrowth?.value ?? null,
    profitGrowth: profitGrowth?.value ?? null,
    operatingMargin: operatingMargin?.value ?? null,
    debtTrend: debtTrend ? { direction: debtTrend.direction, changePercent: debtTrend.changePercent } : null,
  };

  const parts = { revenueGrowth, profitGrowth, operatingMargin, debtTrend };
  const derivedKeys = Object.entries(parts).filter(([, v]) => v != null).map(([k]) => k);
  if (!derivedKeys.length) return null;

  const allDates = derivedKeys.map((key) => parts[key].dataAsOf).filter(Boolean);
  const dataAsOf = allDates.length ? new Date(Math.max(...allDates.map((d) => new Date(d).getTime()))) : new Date();
  const allPeriods = [...new Set(derivedKeys.flatMap((key) => parts[key].periodsUsed))];
  const allSourceUrls = [...new Set(derivedKeys.flatMap((key) => parts[key].sourceUrls))];
  const missingMetrics = ['revenueGrowth', 'profitGrowth', 'operatingMargin', 'debtTrend'].filter((key) => !derivedKeys.includes(key));

  return {
    ...derived,
    missingMetrics,
    dataAsOf,
    provenance: {
      sourceType: 'REAL_RESEARCH CompanyHistoricalFact',
      sourceUrls: allSourceUrls,
      periodsUsed: allPeriods,
      derivationMethod: derivedKeys.map((key) => `${key}: ${parts[key].derivationMethod}`).join(' | '),
    },
  };
};

export default { deriveFundamentalsFromHistoricalFacts };
