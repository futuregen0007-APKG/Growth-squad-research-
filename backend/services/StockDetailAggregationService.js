/** Stock Detail combines BSE company identity, Angel One quotes, verified NSE history, and on-demand Upstox financials. Legacy derived fundamentals never enter this page's financial table or score. Each section preserves its own source and failure state. */

import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { getMetricsForSymbol } from './StockHistoricalMetricsService.js';
import { getCompanyResearchBundle } from './CompanyResearchService.js';
import { getStockDetailFinancials } from './StockDetailFinancials.js';
import {
  METRIC_WEIGHTS, buildMetricAvailability, evaluateDataQuality, computeVerifiedScore, getVerifiedRiskScore, getRiskLabel, labelForScore, calculateHistoricalMetrics,
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

const formatCroreValue = (value) => {
  if (!Number.isFinite(value)) return null;
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`;
};

/**
 * getStockDetail - the single call the /stock/:symbol page needs. Optional
 * `livePrice` is the caller's already-fetched Angel One quote (this service
 * never constructs its own provider); when omitted, currentPrice falls back
 * to the durable historical snapshot's last close, clearly labeled by
 * source, rather than blanking the header.
 */
const DEFAULT_DEPS = {
  findProfile: (symbol) => CompanyResearchProfile.findOne({ symbol }).lean(),
  getMetrics: getMetricsForSymbol,
  getResearchBundle: getCompanyResearchBundle,
  getFinancials: getStockDetailFinancials,
};

/** Growth input for the score: YoY calculated from comparable Upstox annual figures, or `undefined` (never null -- Number(null) is 0, which buildMetricAvailability would treat as a real 0% growth). */
const verifiedGrowthInput = (growth) => (Number.isFinite(growth?.value) ? growth.value : undefined);

/**
 * `prefetchedFinancials` lets a caller that already holds this symbol's
 * companyFinancials (StockController re-runs getStockDetail once the live
 * quote is known) reuse it instead of calling Upstox a second time.
 * `deps` is test-only dependency injection; production uses DEFAULT_DEPS.
 */
export const getStockDetail = async (symbol, { livePrice = null, prefetchedFinancials = null, deps = {} } = {}) => {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) throw new Error('Symbol is required');
  const meta = SUPPORTED_STOCKS[normalized] || {};
  const {
    findProfile, getMetrics, getResearchBundle, getFinancials,
  } = { ...DEFAULT_DEPS, ...deps };

  const [profile, historicalMetrics, researchBundle, companyFinancials] = await Promise.all([
    Promise.resolve().then(() => findProfile(normalized)).catch((error) => {
      logger.warn(`[StockDetailAggregationService] CompanyResearchProfile lookup failed for ${normalized}: ${error.message}`);
      return null;
    }),
    Promise.resolve().then(() => getMetrics(normalized)).catch((error) => {
      logger.warn(`[StockDetailAggregationService] Historical metrics lookup failed for ${normalized}: ${error.message}`);
      return null;
    }),
    Promise.resolve().then(() => getResearchBundle(normalized)).catch((error) => {
      logger.warn(`[StockDetailAggregationService] Company research bundle failed for ${normalized}: ${error.message}`);
      return { sections: {}, provider: null };
    }),
    // getStockDetailFinancials never throws; this catch only guards a broken dependency.
    (prefetchedFinancials ? Promise.resolve(prefetchedFinancials) : Promise.resolve().then(() => getFinancials(normalized))).catch((error) => {
      logger.warn(`[StockDetailAggregationService] Upstox financials failed for ${normalized}: ${error.message}`);
      return null;
    }),
  ]);

  // P/E, revenue growth and profit growth come ONLY from Upstox here. A
  // failed/unconfigured Upstox call leaves them unavailable -- it never
  // silently restores IndianAPI's P/E or the derived growth figures.
  const upstoxPe = companyFinancials?.valuation?.pe ?? null;
  const revenueGrowthInput = verifiedGrowthInput(companyFinancials?.growthInputs?.revenueGrowth);
  const profitGrowthInput = verifiedGrowthInput(companyFinancials?.growthInputs?.profitGrowth);

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
      pe: upstoxPe ?? undefined,
      roe: companyFinancials?.currentRatios?.ratios?.find(r => r.name === 'ROE' && r.companyValueUnit === 'PERCENT')?.companyValue ?? undefined,
      revenueGrowth: revenueGrowthInput,
      profitGrowth: profitGrowthInput,
      operatingMargin: undefined,
      debtTrend: undefined,
    },
    historical,
  );
  const quality = evaluateDataQuality(availability);
  if (quality.missingMetrics.length && quality.scoreStatus === 'COMPLETE') { quality.scoreStatus = 'PARTIAL'; quality.confidence = 'MEDIUM'; }
  const weightSum = quality.availableMetrics.reduce((sum, key) => sum + METRIC_WEIGHTS[key], 0);
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
    pe: upstoxPe,
    peSource: upstoxPe != null ? 'Upstox key ratios (current)' : null,
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
  // Description is Upstox-only (see P/E note above): no IndianAPI fallback.
  const upstoxProfile = companyFinancials?.profile || null;
  const hasDescription = Boolean(upstoxProfile?.description);
  const overview = {
    description: upstoxProfile?.description || null,
    industry: providerProfile?.mgIndustry || researchBundle.sections?.profile?.data?.identity?.industry || identity.sector,
    status: sectionStatus(hasDescription, Boolean(upstoxProfile?.error) || !companyFinancials),
    provider: hasDescription ? 'UPSTOX' : null,
    asOf: hasDescription ? (upstoxProfile.asOf || null) : null,
    fromCache: hasDescription ? Boolean(upstoxProfile.fromCache) : false,
    error: hasDescription ? null : (upstoxProfile?.error || null),
  };

  const financials = { rows: [], sourceProvider: 'UPSTOX', status: companyFinancials?.status || 'UNAVAILABLE' };
  const keyMetrics = { entries: [], status: companyFinancials?.currentRatios?.status || 'UNAVAILABLE' };

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
    inputWeights: Object.fromEntries(Object.keys(METRIC_WEIGHTS).map(key => [key, availability[key].available && weightSum ? Number((METRIC_WEIGHTS[key] / weightSum * 100).toFixed(2)) : 0])),
    totalMetrics: quality.availableMetrics.length + quality.missingMetrics.length,
    inputSources: {
      quality: availability.quality.available ? 'Upstox current ROE' : null,
      volatility: availability.volatility.available ? 'NSE verified historical prices' : null,
      oneYearReturn: availability.oneYearReturn.available ? 'NSE verified historical prices' : null,
      maxDrawdown: availability.maxDrawdown.available ? 'NSE verified historical prices' : null,
      valuation: upstoxPe != null ? 'Upstox key ratios (current P/E)' : null,
      revenueGrowth: revenueGrowthInput !== undefined
        ? `Upstox ${companyFinancials.growthInputs.revenueGrowth.verifiedLabel || 'revenue'} YoY change, ${companyFinancials.growthInputs.revenueGrowth.financialYear}`
        : null,
      profitGrowth: profitGrowthInput !== undefined
        ? `Upstox ${companyFinancials.growthInputs.profitGrowth.verifiedLabel || 'net profit'} YoY change, ${companyFinancials.growthInputs.profitGrowth.financialYear}`
        : null,
    },
    methodology: 'Deterministic weighted average over the available verified inputs; missing inputs receive zero weight. Remaining weights are normalized and shown explicitly. This is this project\'s own suitability score, never a broker price target or a return forecast.',
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
    companyFinancials: companyFinancials || null,
    generatedAt: new Date().toISOString(),
  };
};

export default { getStockDetail };
