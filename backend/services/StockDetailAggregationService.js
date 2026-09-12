/**
 * StockDetailAggregationService.js
 * ===================================
 * The single, verified-data aggregation point for the /stock/:symbol page.
 * Combines several already-built, independently-guarded real data sources so
 * one provider failing (IndianAPI rate-limited, a cold cache, etc.) never
 * blanks the whole page -- every section reports its own
 * AVAILABLE/PARTIAL/UNAVAILABLE/PROVIDER_ERROR status instead.
 *
 * Sources, in priority order per field (never fabricated, never guessed):
 *   - identity (ISIN, BSE scrip code, market cap): CompanyResearchProfile,
 *     synced from the real BSE scrip master (BseScripMasterProvider) --
 *     SUPPORTED_STOCKS is only the name/sector fallback when no profile
 *     exists yet.
 *   - summary metrics (52W high/low, 1Y return, volatility, max drawdown):
 *     StockHistoricalMetricsSnapshot, computed from NSE bhavcopy rows
 *     (StockHistoricalMetricsService) -- the same durable pipeline the
 *     Goals screener uses, never a live Angel One historical-candle call
 *     (which returns HTTP 403 for most symbols in this environment).
 *   - fundamentals (P/E, ROE, growth, debt trend): StockFundamentalsService,
 *     which itself prefers IndianAPI, then a fresh Mongo snapshot, then a
 *     REAL_RESEARCH CompanyHistoricalFact-derived value -- never zero
 *     standing in for missing.
 *   - financials/keyMetrics/shareholding/corporateActions/analystData/news:
 *     CompanyResearchService.getCompanyResearchBundle (IndianAPI), each
 *     section independently {available, data, error, asOf}.
 *   - the project's own deterministic "Growth Potential and Quality Score":
 *     GoalRecommendationService's verified-metric scoring engine, reused
 *     standalone (no goal-specific sector adjustment) -- never a fabricated
 *     broker price target.
 */

import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { getMetricsForSymbol } from './StockHistoricalMetricsService.js';
import { getFundamentals } from './StockFundamentalsService.js';
import { getCompanyResearchBundle } from './CompanyResearchService.js';
import { buildFinancialIntelligenceSnapshot } from './FinancialIntelligenceService.js';
import {
  buildMetricAvailability, evaluateDataQuality, computeVerifiedScore, getVerifiedRiskScore, getRiskLabel, labelForScore, calculateHistoricalMetrics,
} from './GoalRecommendationService.js';
import { logger } from '../utils/logger.js';

// Real data found always wins, even when the primary provider for this
// section separately reported an error -- e.g. IndianAPI rate-limited but a
// REAL_RESEARCH-derived fallback still produced real financials. Only
// "nothing at all, and we know why" reports PROVIDER_ERROR; "nothing at all,
// and no error either" reports the more neutral UNAVAILABLE (e.g. a real
// provider response that simply had no shareholding data for this symbol).
const sectionStatus = (hasData, hasError) => {
  if (hasData) return 'AVAILABLE';
  if (hasError) return 'PROVIDER_ERROR';
  return 'UNAVAILABLE';
};

const emptySection = (section) => ({
  available: false, data: null, status: sectionStatus(false, Boolean(section?.error)), error: section?.error || null, asOf: null,
});

/** Real IndianAPI section -> the {available,data,status,error,asOf} shape every research tab consumes. Never invents data when the section failed. */
const passthroughSection = (section) => {
  if (!section) return emptySection(null);
  const hasData = section.available && section.data != null
    && (!Array.isArray(section.data) || section.data.length > 0)
    && (typeof section.data !== 'object' || Array.isArray(section.data) || Object.keys(section.data).length > 0);
  return {
    available: Boolean(hasData),
    data: section.data ?? null,
    status: sectionStatus(hasData, Boolean(section.error)),
    error: section.error || null,
    asOf: section.asOf || null,
  };
};

/** Flattens IndianAPI's category->metrics[] key-metrics shape into simple {label,value} rows the frontend can render directly -- the raw nested shape was being rendered as "[object Object]"/"--" before. */
const flattenKeyMetrics = (keyMetricsData) => {
  const categories = keyMetricsData?.categories;
  if (!Array.isArray(categories) || !categories.length) return [];
  return categories.flatMap((category) => (category.metrics || []).map((metric) => ({
    label: `${category.label}: ${metric.name}`,
    value: metric.value,
  })));
};

const formatCroreValue = (value) => {
  if (!Number.isFinite(value)) return null;
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
};

/** Converts buildFinancialIntelligenceSnapshot's flat object into the {title,period,value} row list the existing DataRows component renders -- every field is shown (including a real, explicit "--" for one the provider didn't supply), never silently dropped. */
const financialsToRows = (snapshot) => {
  if (!snapshot?.available) return [];
  const period = snapshot.latestPeriod;
  return [
    { title: 'Revenue', period, value: snapshot.revenue != null ? snapshot.revenue.toLocaleString('en-IN') : '—' },
    { title: 'Revenue Growth (YoY)', period, value: snapshot.revenueGrowth != null ? `${snapshot.revenueGrowth}%` : '—' },
    { title: 'Net Profit', period, value: snapshot.netProfit != null ? snapshot.netProfit.toLocaleString('en-IN') : '—' },
    { title: 'Net Profit Growth (YoY)', period, value: snapshot.netProfitGrowth != null ? `${snapshot.netProfitGrowth}%` : '—' },
    { title: 'Operating Margin', period, value: snapshot.operatingMargin != null ? `${snapshot.operatingMargin}%` : '—' },
    { title: 'EPS (Diluted, Normalized)', period, value: snapshot.eps != null ? snapshot.eps : '—' },
    { title: 'Debt Trend', period, value: snapshot.debtTrend || '—' },
  ];
};

/** The same fields, sourced from durable REAL_RESEARCH-derived fundamentals instead of a live IndianAPI financials fetch -- used only when IndianAPI's financials/keyMetrics sections are unavailable, so a known-rate-limited provider never blanks this tab when real data already exists in Mongo. */
const fundamentalsToRows = (fundamentals) => {
  if (!fundamentals) return [];
  const period = fundamentals.dataAsOf ? new Date(fundamentals.dataAsOf).toISOString().slice(0, 10) : null;
  const rows = [
    { title: 'Revenue Growth (YoY, derived)', period, value: fundamentals.revenueGrowth != null ? `${fundamentals.revenueGrowth}%` : '—' },
    { title: 'Profit Growth (YoY, derived)', period, value: fundamentals.profitGrowth != null ? `${fundamentals.profitGrowth}%` : '—' },
    { title: 'Operating Margin (derived)', period, value: fundamentals.operatingMargin != null ? `${fundamentals.operatingMargin}%` : '—' },
    { title: 'Debt Trend (derived)', period, value: fundamentals.debtTrend?.direction || '—' },
  ];
  return rows.filter((row) => row.value !== '—');
};

/**
 * getStockDetail - the single call the /stock/:symbol page needs. Optional
 * `livePrice` is the caller's already-fetched Angel One quote (this service
 * never constructs its own provider); when omitted, currentPrice falls back
 * to the durable historical snapshot's last close, clearly labeled by
 * source, rather than blanking the header.
 */
export const getStockDetail = async (symbol, { livePrice = null } = {}) => {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) throw new Error('Symbol is required');
  const meta = SUPPORTED_STOCKS[normalized] || {};

  const [profile, historicalMetrics, fundamentals, researchBundle] = await Promise.all([
    CompanyResearchProfile.findOne({ symbol: normalized }).lean().catch((error) => {
      logger.warn(`[StockDetailAggregationService] CompanyResearchProfile lookup failed for ${normalized}: ${error.message}`);
      return null;
    }),
    getMetricsForSymbol(normalized).catch((error) => {
      logger.warn(`[StockDetailAggregationService] Historical metrics lookup failed for ${normalized}: ${error.message}`);
      return null;
    }),
    getFundamentals(normalized).catch((error) => {
      logger.warn(`[StockDetailAggregationService] Fundamentals lookup failed for ${normalized}: ${error.message}`);
      return null;
    }),
    getCompanyResearchBundle(normalized).catch((error) => {
      logger.warn(`[StockDetailAggregationService] Company research bundle failed for ${normalized}: ${error.message}`);
      return { sections: {}, provider: null };
    }),
  ]);

  const identity = {
    symbol: normalized,
    companyName: profile?.companyName || meta.name || normalized,
    sector: profile?.sector || meta.sector || null,
    isin: profile?.isin || null,
    bseScripCode: profile?.bseScripCode || null,
    nseSymbol: profile?.nseSymbol || normalized,
    marketCapCr: profile?.marketCapCr ?? null,
    marketCapDisplay: formatCroreValue(profile?.marketCapCr),
    // A CompanyResearchProfile document always exists (even for a symbol
    // whose BSE scrip code couldn't be resolved -- see
    // CompanyResearchProfileSync.js), so "the record exists" is not the same
    // as "we have real identifying data" -- only count it AVAILABLE once at
    // least one of the three real BSE-sourced fields is actually present.
    status: sectionStatus(Boolean(profile?.isin || profile?.bseScripCode || profile?.marketCapCr), false),
  };

  const historical = calculateHistoricalMetrics(historicalMetrics);
  const availability = buildMetricAvailability(
    {
      pe: fundamentals?.pe,
      roe: fundamentals?.roe,
      revenueGrowth: fundamentals?.revenueGrowth,
      profitGrowth: fundamentals?.profitGrowth,
      operatingMargin: fundamentals?.operatingMargin,
      debtTrend: fundamentals?.debtTrend,
    },
    historical,
  );
  const quality = evaluateDataQuality(availability);
  const score = quality.scoreStatus === 'INSUFFICIENT_DATA' ? null : computeVerifiedScore(availability, 50);
  const riskScore = getVerifiedRiskScore(availability);

  const currentPrice = livePrice?.price ?? historicalMetrics?.lastClose ?? null;
  const priceSource = livePrice?.price != null
    ? 'Angel One live quote'
    : (historicalMetrics?.lastClose != null ? `NSE bhavcopy (${new Date(historicalMetrics.dataAsOf).toISOString().slice(0, 10)})` : null);

  const summaryMetrics = {
    currentPrice,
    priceSource,
    change: livePrice?.change ?? null,
    changePct: livePrice?.changePct ?? null,
    marketCapCr: identity.marketCapCr,
    marketCap: identity.marketCapDisplay,
    pe: fundamentals?.pe ?? null,
    fiftyTwoWeekHigh: historicalMetrics?.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: historicalMetrics?.fiftyTwoWeekLow ?? null,
    oneYearReturn: historical.oneYearReturn,
    volatility: historical.volatility,
    maxDrawdown: historical.maxDrawdown,
    liquidityClassification: historical.liquidityClassification,
    corporateActionAdjustmentStatus: historical.corporateActionAdjustmentStatus,
    dataAsOf: historicalMetrics?.dataAsOf ?? null,
    status: sectionStatus(currentPrice != null, false),
  };

  const profileSection = researchBundle.sections?.profile;
  const providerProfile = profileSection?.data?.profile || null;
  const overview = {
    description: providerProfile?.description || null,
    industry: providerProfile?.mgIndustry || researchBundle.sections?.profile?.data?.identity?.industry || identity.sector,
    status: sectionStatus(Boolean(providerProfile?.description), Boolean(profileSection?.error)),
    provider: profileSection?.available ? researchBundle.provider : null,
    asOf: profileSection?.asOf || null,
  };

  const financialsSection = researchBundle.sections?.financials;
  const keyMetricsSection = researchBundle.sections?.keyMetrics;
  const providerFinancialsAvailable = Boolean(financialsSection?.available && Array.isArray(financialsSection?.data) && financialsSection.data.length);
  const providerKeyMetricsAvailable = Boolean(keyMetricsSection?.available && keyMetricsSection?.data?.categories?.length);

  let financials;
  if (providerFinancialsAvailable || providerKeyMetricsAvailable) {
    const snapshot = buildFinancialIntelligenceSnapshot({
      financials: financialsSection?.data || [],
      keyMetricsCategories: keyMetricsSection?.data?.categories || [],
      provider: researchBundle.provider,
      fetchedAt: financialsSection?.asOf || keyMetricsSection?.asOf,
    });
    financials = {
      rows: financialsToRows(snapshot),
      dataMode: snapshot.dataMode,
      sourceProvider: snapshot.sourceProvider,
      fetchedAt: snapshot.fetchedAt,
      status: sectionStatus(snapshot.available, false),
    };
  } else {
    const fallbackRows = fundamentalsToRows(fundamentals);
    financials = {
      rows: fallbackRows,
      dataMode: fallbackRows.length ? 'REAL_RESEARCH_DERIVED_FALLBACK' : null,
      sourceProvider: fallbackRows.length ? (fundamentals?.source || 'REAL_RESEARCH_DERIVED') : null,
      fetchedAt: fallbackRows.length ? fundamentals?.dataAsOf : null,
      status: sectionStatus(fallbackRows.length > 0, Boolean(financialsSection?.error)),
    };
  }

  const keyMetrics = {
    entries: flattenKeyMetrics(keyMetricsSection?.data),
    status: sectionStatus(providerKeyMetricsAvailable, Boolean(keyMetricsSection?.error)),
    asOf: keyMetricsSection?.asOf || null,
  };

  const shareholding = passthroughSection(researchBundle.sections?.shareholding);
  const corporateActions = passthroughSection(researchBundle.sections?.corporateActions);
  const news = passthroughSection(researchBundle.sections?.news);
  const providerAnalystData = passthroughSection(researchBundle.sections?.analystData);

  const ownScore = {
    score,
    scoreLabel: score == null ? 'Insufficient evidence to label' : labelForScore(score, null),
    riskScore,
    riskLabel: getRiskLabel(riskScore),
    dataCoveragePct: quality.dataCoveragePct,
    scoreStatus: quality.scoreStatus,
    confidence: quality.confidence,
    availableMetrics: quality.availableMetrics,
    missingMetrics: quality.missingMetrics,
    methodology: 'Deterministic weighted score over verified metrics only (growth, quality, balance sheet, valuation, price trend, liquidity/drawdown risk). This is this project\'s own suitability score, never a broker price target or a return forecast.',
  };
  const analystData = {
    ownScore,
    providerAnalystData,
    status: sectionStatus(score != null || providerAnalystData.available, false),
  };

  return {
    symbol: normalized,
    identity,
    summaryMetrics,
    overview,
    research: {
      financials, keyMetrics, shareholding, corporateActions, analystData, news,
    },
    generatedAt: new Date().toISOString(),
  };
};

export default { getStockDetail };
