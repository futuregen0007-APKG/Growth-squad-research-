import { getStockNews } from './NewsAPIService.js';
import ResearchService from './ResearchService.js';
import RebalanceService from './RebalanceService.js';

const recommendationCache = new Map();

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

const nowYear = () => new Date().getFullYear();

const normalizeGoalType = (goalType = '') => {
  const value = String(goalType || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!value) return 'custom';
  return value;
};

const toNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const monthRate = (annualReturn) => Math.max((annualReturn || 0) / 12, 0.0001);

const futureValue = ({ currentAmount = 0, monthlyContribution = 0, annualReturn = 0.1, years = 5 }) => {
  const n = Math.max(years * 12, 1);
  const r = monthRate(annualReturn);
  const value = currentAmount * Math.pow(1 + r, n);
  const contributionPart = monthlyContribution * (((Math.pow(1 + r, n) - 1) / r));
  return value + contributionPart;
};

const solveForRate = ({ currentAmount = 0, monthlyContribution = 0, targetAmount = 0, years = 5 }) => {
  if (!targetAmount || targetAmount <= currentAmount) return 0.06;

  const lower = 0.0001;
  const upper = 1.5;
  let low = lower;
  let high = upper;
  let lowValue = futureValue({ currentAmount, monthlyContribution, annualReturn: low, years });
  let highValue = futureValue({ currentAmount, monthlyContribution, annualReturn: high, years });

  if (highValue < targetAmount) return 0.18;
  if (lowValue >= targetAmount) return 0.0005;

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const projected = futureValue({ currentAmount, monthlyContribution, annualReturn: mid, years });
    if (projected < targetAmount) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
};

const solveForMonthlyInvestment = ({ currentAmount = 0, targetAmount = 0, annualReturn = 0.1, years = 5 }) => {
  if (!targetAmount) return 0;
  const n = Math.max(years * 12, 1);
  const r = monthRate(annualReturn);
  if (r <= 0) return Math.max(targetAmount - currentAmount, 0) / n;
  const firstTerm = currentAmount * Math.pow(1 + r, n);
  const remainingGap = Math.max(targetAmount - firstTerm, 0);
  const annuityFactor = ((Math.pow(1 + r, n) - 1) / r);
  return remainingGap / annuityFactor;
};

const getGoalBucket = (yearsRemaining) => {
  if (yearsRemaining <= 3) return 'SHORT_TERM';
  if (yearsRemaining <= 7) return 'MEDIUM_TERM';
  return 'LONG_TERM';
};

const getRiskCapacity = (goal, profile = {}) => {
  const profileRisk = String(goal.riskProfile || profile.riskProfile || profile.riskAppetite || 'moderate').toLowerCase();
  if (['very_aggressive', 'very aggressive', 'aggressive'].includes(profileRisk)) return 'AGGRESSIVE';
  if (profileRisk === 'conservative') return 'CONSERVATIVE';
  return 'MODERATE';
};

const normalizeSector = (sector = '') => {
  const value = String(sector || '').trim().toLowerCase();
  const aliases = {
    pharma: 'Healthcare',
    healthcare: 'Healthcare',
    automobile: 'Auto',
    automotive: 'Auto',
    auto: 'Auto',
    defence: 'Defence',
    defense: 'Defence',
    infrastructure: 'Infrastructure',
    'financial services': 'Financial Services',
  };
  return aliases[value] || String(sector || '').trim();
};

const getLiquidityRequirement = (goalType, yearsRemaining) => {
  if (yearsRemaining <= 3 || ['emergency', 'house', 'car', 'marriage', 'education'].includes(goalType)) {
    return 'HIGH';
  }
  if (['passive_income', 'retirement', 'freedom'].includes(goalType)) return 'MEDIUM';
  return 'MODERATE';
};

const getGoalPriority = (goalType) => {
  if (['emergency', 'house', 'car', 'marriage'].includes(goalType)) return 'CAPITAL_PRESERVATION';
  if (['education', 'retirement', 'freedom'].includes(goalType)) return 'BALANCED_GROWTH';
  if (['passive_income', 'wealth_creation'].includes(goalType)) return 'COMPOUNDING';
  return 'BALANCED_GROWTH';
};

const getPreferredSectors = (goalType, yearsRemaining) => {
  const shortTerm = ['Banking', 'FMCG', 'Healthcare', 'Power', 'Auto'];
  const mediumTerm = ['Banking', 'IT', 'FMCG', 'Healthcare', 'Consumer', 'Infrastructure', 'Auto'];
  const longTerm = ['IT', 'Manufacturing', 'Infrastructure', 'Green Energy', 'Healthcare', 'Consumer', 'Energy'];

  if (yearsRemaining <= 3) return shortTerm;
  if (yearsRemaining <= 7) return mediumTerm;
  if (['retirement', 'passive_income', 'freedom'].includes(goalType)) return ['Banking', 'IT', 'Healthcare', 'Consumer', 'FMCG', 'Energy'];
  return longTerm;
};

const mapSectorPreference = (goalType, yearsRemaining, sector, selectedSector = '') => {
  if (selectedSector) return normalizeSector(sector) === normalizeSector(selectedSector) ? 100 : 20;
  const preferred = getPreferredSectors(goalType, yearsRemaining);
  if (!sector) return 50;
  return preferred.includes(sector) ? 90 : 55;
};

// Each of these scorers is only ever invoked with a real, verified data point —
// never with a substituted/default value. A stock with no data for a metric
// simply does not get that metric's weight (see buildMetricAvailability /
// computeVerifiedScore below), rather than receiving a favorable placeholder.
const METRIC_SCORERS = {
  volatility: (annualizedVolatilityPct) => clamp(100 - annualizedVolatilityPct * 1.8, 0, 100),
  oneYearReturn: (oneYearReturnPct) => clamp(50 + oneYearReturnPct * 1.5, 0, 100),
  maxDrawdown: (maxDrawdownPct) => clamp(100 - Math.abs(maxDrawdownPct) * 1.2, 0, 100),
  valuation: (pe) => clamp(100 - Math.abs(pe - 20) * 2.5, 0, 100),
  quality: (roe) => clamp(roe * 4, 0, 100),
};

// Relative weights used only across whichever metrics are actually available
// for a given stock (see computeVerifiedScore) — never renormalized in a way
// that lets a missing metric quietly boost the others beyond their share.
const METRIC_WEIGHTS = {
  volatility: 30,
  oneYearReturn: 15,
  maxDrawdown: 15,
  valuation: 20,
  quality: 20,
};

const METRIC_KEYS = Object.keys(METRIC_WEIGHTS);

// A metric is "available" only when it comes from a verified source: real
// historical candles (volatility/oneYearReturn/maxDrawdown all come from the
// same fetch) or a real, positive fundamentals value (pe/roe). Zero/negative/
// missing values are treated as not-provided rather than defaulted.
const buildMetricAvailability = (stock, historical) => {
  const pe = Number(stock.pe ?? stock.PE);
  const roe = Number(stock.roe ?? stock.ROE);
  return {
    volatility: historical.available ? { available: true, value: historical.volatility } : { available: false, value: null },
    oneYearReturn: historical.available ? { available: true, value: historical.oneYearReturn } : { available: false, value: null },
    maxDrawdown: historical.available ? { available: true, value: historical.maxDrawdown } : { available: false, value: null },
    valuation: Number.isFinite(pe) && pe > 0 ? { available: true, value: pe } : { available: false, value: null },
    quality: Number.isFinite(roe) && roe > 0 ? { available: true, value: roe } : { available: false, value: null },
  };
};

// >=4/5 verified metrics => COMPLETE; 1-3/5 => PARTIAL; 0/5 => INSUFFICIENT_DATA.
// Sector match is intentionally excluded from this coverage calculation so a
// sector-only match can never read as "high confidence" on its own.
const evaluateDataQuality = (availability) => {
  const availableMetrics = METRIC_KEYS.filter((key) => availability[key].available);
  const missingMetrics = METRIC_KEYS.filter((key) => !availability[key].available);
  const dataCoveragePct = Math.round((availableMetrics.length / METRIC_KEYS.length) * 100);

  let scoreStatus;
  if (availableMetrics.length >= 4) scoreStatus = 'COMPLETE';
  else if (availableMetrics.length >= 1) scoreStatus = 'PARTIAL';
  else scoreStatus = 'INSUFFICIENT_DATA';

  const confidence = scoreStatus === 'COMPLETE' ? 'HIGH' : scoreStatus === 'PARTIAL' ? 'MEDIUM' : 'LOW';

  return { availableMetrics, missingMetrics, dataCoveragePct, scoreStatus, confidence };
};

// Computes a 0-100 score strictly from verified metrics that are actually
// available, weighted-averaged over only those metrics' weights (so a
// missing metric is excluded, never defaulted). Sector fit can only nudge
// this score by up to +/-10 points and can never produce a score by itself:
// if zero verified metrics exist, this returns null regardless of sector fit.
const computeVerifiedScore = (availability, sectorFitScore) => {
  const availableKeys = METRIC_KEYS.filter((key) => availability[key].available);
  if (availableKeys.length === 0) return null;

  const weightSum = availableKeys.reduce((sum, key) => sum + METRIC_WEIGHTS[key], 0);
  const weightedScore = availableKeys.reduce((sum, key) => {
    const subScore = METRIC_SCORERS[key](availability[key].value);
    return sum + subScore * METRIC_WEIGHTS[key];
  }, 0) / weightSum;

  const sectorAdjustment = clamp((sectorFitScore - 50) * 0.2, -10, 10);
  return Math.round(clamp(weightedScore + sectorAdjustment, 0, 100));
};

const calculateHistoricalMetrics = (history = []) => {
  const closes = history.map((item) => Number(item.close)).filter((value) => Number.isFinite(value) && value > 0);
  if (closes.length < 2) {
    return { available: false, source: null, oneYearReturn: null, volatility: null, maxDrawdown: null, observations: 0 };
  }

  const returns = closes.slice(1).map((value, index) => (value / closes[index]) - 1).filter(Number.isFinite);
  const mean = returns.reduce((sum, value) => sum + value, 0) / Math.max(returns.length, 1);
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(returns.length - 1, 1);
  let peak = closes[0];
  let maxDrawdown = 0;
  closes.forEach((close) => {
    peak = Math.max(peak, close);
    maxDrawdown = Math.min(maxDrawdown, (close / peak) - 1);
  });

  return {
    available: true,
    source: 'Angel One historical candles',
    oneYearReturn: Number((((closes[closes.length - 1] / closes[0]) - 1) * 100).toFixed(2)),
    volatility: Number((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(2)),
    maxDrawdown: Number((maxDrawdown * 100).toFixed(2)),
    observations: closes.length,
    series: history,
  };
};

const getResearchMetrics = (stock, researchBySymbol) => {
  const historical = researchBySymbol.get(String(stock.ticker || stock.symbol).toUpperCase());
  return calculateHistoricalMetrics(historical?.history || []);
};

// Risk can only be computed from real measured volatility/drawdown. Missing
// historical data must lower data coverage (see evaluateDataQuality), never
// get smuggled into a risk score via a default — so this returns null rather
// than a fabricated "safe" number when no verified history exists.
const getRiskScore = (metrics) => {
  if (!metrics.available) return null;
  const volatilityScore = clamp((metrics.volatility - 10) * 2.2, 0, 65);
  const drawdownScore = clamp(Math.abs(metrics.maxDrawdown) * 0.75, 0, 25);
  return Math.round(clamp(volatilityScore + drawdownScore, 0, 100));
};

const getRiskLabel = (riskScore) => {
  if (riskScore == null) return 'UNKNOWN';
  if (riskScore <= 30) return 'LOW';
  if (riskScore <= 60) return 'MODERATE';
  return 'HIGH';
};

const buildWhyRecommended = (stock, goalProfile) => {
  const historical = stock.historical;
  const historyClause = historical.available
    ? `its measured one-year return was ${historical.oneYearReturn}% with ${historical.volatility}% annualized volatility and a ${historical.maxDrawdown}% maximum drawdown`
    : 'historical candle data is unavailable from the configured provider';
  const valuationClause = stock.pe
    ? `the available P/E is ${stock.pe}, which was included in the valuation score`
    : 'valuation data was unavailable and was not invented';
  const fundingClause = goalProfile.monthlyShortfall > 0
    ? `the current contribution is approximately ₹${Math.round(goalProfile.monthlyShortfall).toLocaleString('en-IN')} below the planning contribution needed for this goal`
    : 'the current contribution meets the deterministic planning contribution estimate';

  return `${stock.name || stock.ticker} was ranked for your ${goalProfile.goalName} goal of ₹${goalProfile.targetAmount.toLocaleString('en-IN')} over ${goalProfile.yearsRemaining} years because ${historyClause}; ${valuationClause}; and its ${stock.sector || 'available'} sector fit was evaluated against your ${goalProfile.riskCapacity.toLowerCase()} risk setting. ${fundingClause}. This is a suitability assessment, not a return guarantee.`;
};

const riskTierAllows = (riskCapacity, riskScore, hasHistoricalData) => {
  if (!hasHistoricalData) return true;
  if (riskCapacity === 'CONSERVATIVE') return riskScore <= 25;
  if (riskCapacity === 'AGGRESSIVE') return riskScore >= 35;
  return riskScore >= 20 && riskScore <= 78;
};

// Bundles metric availability, data-quality classification, and the verified
// score for one stock. This is the single source of truth for both the
// recommendation ranking and the transparency fields (scoreStatus,
// dataCoveragePct, availableMetrics, missingMetrics, confidence) returned to
// the client — they are derived from the same availability object, never
// computed independently, so they cannot disagree with each other.
const evaluateStockForGoal = (stock, goalProfile, historical) => {
  const sectorFitScore = mapSectorPreference(goalProfile.goalType, goalProfile.yearsRemaining, stock.sector || stock.industry, goalProfile.selectedSector);
  const availability = buildMetricAvailability(stock, historical);
  const dataQuality = evaluateDataQuality(availability);
  const goalFitScore = computeVerifiedScore(availability, sectorFitScore);
  return { availability, sectorFitScore, goalFitScore, ...dataQuality };
};

const riskCapacityCenter = (riskCapacity) => (riskCapacity === 'CONSERVATIVE' ? 25 : riskCapacity === 'AGGRESSIVE' ? 70 : 50);

const buildGoalFitComponents = (evaluation, historical, riskScore, goalProfile) => {
  const { availability, sectorFitScore } = evaluation;
  return {
    goalHorizonFit: Math.round(clamp(60 + Math.min(goalProfile.yearsRemaining, 15) * 2.5, 0, 100)),
    riskFit: riskScore == null ? null : Math.round(clamp(100 - Math.abs(riskScore - riskCapacityCenter(goalProfile.riskCapacity)), 0, 100)),
    historicalStability: historical.available ? Math.round(clamp(100 - historical.volatility * 1.8 - Math.abs(historical.maxDrawdown) * 0.45, 0, 100)) : null,
    businessQuality: availability.quality.available ? Math.round(METRIC_SCORERS.quality(availability.quality.value)) : null,
    growthPotential: availability.oneYearReturn.available ? Math.round(METRIC_SCORERS.oneYearReturn(availability.oneYearReturn.value)) : null,
    valuation: availability.valuation.available ? Math.round(METRIC_SCORERS.valuation(availability.valuation.value)) : null,
    sectorOutlook: sectorFitScore,
    newsSentiment: null,
  };
};

const getPlanningAnnualReturn = (goalType = 'custom', yearsRemaining = 5, riskCapacity = 'MODERATE') => {
  if (['retirement', 'passive_income', 'freedom', 'wealth_creation'].includes(goalType)) return 0.1;
  if (['education', 'house', 'marriage', 'car'].includes(goalType)) return 0.09;
  if (riskCapacity === 'AGGRESSIVE') return 0.12;
  if (riskCapacity === 'CONSERVATIVE') return 0.07;
  return yearsRemaining > 7 ? 0.1 : 0.09;
};

const toRiskBadge = (value) => String(value || '').toUpperCase();

export const buildGoalProfile = (goal = {}, profile = {}) => {
  const targetAmount = toNumber(goal.targetAmount ?? goal.target ?? 0, 0);
  const currentAmount = toNumber(goal.currentAmount ?? goal.current ?? 0, 0);
  const requestedHorizon = toNumber(goal.horizonYears, 0);
  const targetYear = requestedHorizon > 0 ? nowYear() + requestedHorizon : toNumber(goal.targetYear ?? 2035, nowYear() + 5);
  const monthlyContribution = toNumber(goal.monthlyContribution ?? goal.monthlySavings ?? 0, 0);
  const yearsRemaining = Math.max(1, targetYear - nowYear());
  const monthsRemaining = yearsRemaining * 12;
  const remainingAmount = Math.max(targetAmount - currentAmount, 0);
  const goalType = normalizeGoalType(goal.type || goal.goalType || 'custom');
  const requiredAnnualReturn = solveForRate({ currentAmount, monthlyContribution, targetAmount, years: yearsRemaining });
  const requiredFutureValue = Math.max(targetAmount, currentAmount);
  const planningAnnualReturn = getPlanningAnnualReturn(goalType, yearsRemaining, getRiskCapacity(goal, profile));
  const requiredMonthlyInvestment = solveForMonthlyInvestment({
    currentAmount,
    targetAmount,
    annualReturn: planningAnnualReturn,
    years: yearsRemaining,
  });

  const riskCapacity = getRiskCapacity(goal, profile);
  const legacyRiskProfile = String(profile.riskProfile || profile.riskAppetite || goal.riskProfile || 'moderate').toLowerCase();
  const contributionStatus = requiredMonthlyInvestment > 0 && monthlyContribution > 0
    ? (monthlyContribution >= requiredMonthlyInvestment * 0.9 ? 'SUFFICIENT' : monthlyContribution >= requiredMonthlyInvestment * 0.7 ? 'SLIGHTLY_INSUFFICIENT' : 'SIGNIFICANTLY_INSUFFICIENT')
    : 'NEEDS_REVIEW';

  return {
    goalId: goal.id || goal.goalId || `goal-${Date.now()}`,
    goalType,
    goalName: goal.name || goal.goalName || 'Custom Goal',
    targetAmount,
    currentAmount,
    targetYear,
    monthlyContribution,
    yearsRemaining,
    monthsRemaining,
    remainingAmount,
    requiredFutureValue,
    requiredReturn: Number((requiredAnnualReturn * 100).toFixed(2)),
    requiredAnnualReturn: Number((requiredAnnualReturn * 100).toFixed(2)),
    requiredMonthlyInvestment: Number(requiredMonthlyInvestment.toFixed(2)),
    requiredCorpus: targetAmount,
    investmentHorizon: getGoalBucket(yearsRemaining),
    riskCapacity,
    liquidityRequirement: getLiquidityRequirement(goalType, yearsRemaining),
    goalPriority: getGoalPriority(goalType),
    riskProfile: legacyRiskProfile,
    selectedSector: normalizeSector(goal.sector || goal.selectedSector || ''),
    requestedHorizonYears: requestedHorizon || yearsRemaining,
    aiAnalysisEnabled: Boolean(goal.enableAiAnalysis || profile.enableAiAnalysis),
    recommendedApproach: getGoalBucket(yearsRemaining) === 'SHORT_TERM'
      ? 'Protect capital with higher-quality, lower-volatility allocations and keep a larger cash reserve.'
      : getGoalBucket(yearsRemaining) === 'MEDIUM_TERM'
        ? 'Target a balanced mix of quality compounders and diversified sectors with manageable volatility.'
        : 'Favor long-duration compounding, high-quality businesses, and diversified growth sectors.' ,
    contributionStatus,
    monthlyShortfall: Number(Math.max(requiredMonthlyInvestment - monthlyContribution, 0).toFixed(2)),
    status: contributionStatus === 'SUFFICIENT' ? 'ON_TRACK' : contributionStatus === 'SLIGHTLY_INSUFFICIENT' ? 'SLIGHTLY_UNDERFUNDED' : contributionStatus === 'SIGNIFICANTLY_INSUFFICIENT' ? 'UNDERFUNDED' : 'REVIEW',
  };
};

const explainStockHistory = (stock, goalProfile) => {
  const direction = Number(stock.changePct || 0) >= 0 ? 'positive momentum' : 'mixed performance';
  const sector = stock.sector || 'equity';
  return `Historically, ${stock.name || stock.ticker} has been assessed in the ${sector} universe with ${direction} relative context. The investment case is based on available market behavior, sector trends, and valuation context rather than a guarantee of future returns.`;
};

const explainStockPresent = (stock, goalProfile) => {
  const price = Number(stock.price || 0);
  const pe = Number(stock.pe || 0);
  const sector = stock.sector || 'equity';
  return `At the current price of ₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}, ${stock.name || stock.ticker} is being evaluated against a ${goalProfile.investmentHorizon.toLowerCase().replace('_', ' ')} goal. Its current position in ${sector} is reviewed using available market price, valuation, sector backdrop, and recent company context.`;
};

const explainStockFuture = (stock, goalProfile) => {
  const sector = stock.sector || 'equity';
  return `The future outlook for ${stock.name || stock.ticker} depends on business execution, sector tailwinds, earnings quality, and valuation discipline. For a ${goalProfile.goalType} goal, the relevant scenario is whether ${sector} exposure can support the target without creating excessive risk or timeline mismatch.`;
};

const buildProjection = (goalProfile) => {
  const { currentAmount, monthlyContribution, targetAmount, yearsRemaining } = goalProfile;
  const base = futureValue({ currentAmount, monthlyContribution, annualReturn: 0.08, years: yearsRemaining });
  const baseCase = futureValue({ currentAmount, monthlyContribution, annualReturn: 0.10, years: yearsRemaining });
  const optimistic = futureValue({ currentAmount, monthlyContribution, annualReturn: 0.12, years: yearsRemaining });

  return {
    conservative: Number(base.toFixed(2)),
    base: Number(baseCase.toFixed(2)),
    optimistic: Number(optimistic.toFixed(2)),
    requiredAmount: targetAmount,
    currentAmount,
    fundingGap: Math.max(targetAmount - baseCase, 0),
  };
};

const deriveAllocation = (goalProfile, index, length) => {
  const base = 100 / Math.max(length, 1);
  return Number((base + (index === 0 ? 5 : 0) - (length > 3 ? 2 : 0)).toFixed(1));
};

const getGoalText = (goalProfile) => {
  if (goalProfile.goalType === 'house') return 'buying a home';
  if (goalProfile.goalType === 'education') return 'funding education';
  if (goalProfile.goalType === 'retirement') return 'retirement planning';
  if (goalProfile.goalType === 'car') return 'buying a car';
  if (goalProfile.goalType === 'marriage') return 'wedding planning';
  if (goalProfile.goalType === 'passive_income') return 'creating passive income';
  return 'achieving this financial goal';
};

export const createRecommendationSummary = (goalProfile, recommendations = []) => {
  if (!recommendations.length) {
    return `No equity stock currently meets the required risk and horizon profile for this ${goalProfile.goalType} goal. The gap suggests a stronger focus on cash-flow discipline, extra contribution, or a lower-risk mix.`;
  }

  const best = recommendations[0];
  return `For a ${goalProfile.investmentHorizon.toLowerCase().replace('_', ' ')} goal aimed at ${getGoalText(goalProfile)}, the model prioritizes ${best.companyName || best.name} because it offers the best balance of goal fit, valuation, liquidity, and sector suitability while keeping the portfolio diversified.`;
};

export const buildGoalRecommendation = async (goal = {}, stocks = [], profile = {}, context = {}) => {
  const goalProfile = buildGoalProfile(goal, profile);
  const universe = Array.isArray(stocks) ? stocks : [];
  const researchBySymbol = new Map((context.researchData || []).map((item) => [String(item.symbol).toUpperCase(), item]));
  const cacheKey = JSON.stringify({
    goalId: goalProfile.goalId,
    goalType: goalProfile.goalType,
    targetAmount: goalProfile.targetAmount,
    currentAmount: goalProfile.currentAmount,
    targetYear: goalProfile.targetYear,
    monthlyContribution: goalProfile.monthlyContribution,
    riskProfile: goalProfile.riskProfile,
    selectedSector: goalProfile.selectedSector,
    requestedHorizonYears: goalProfile.requestedHorizonYears,
  });

  if (recommendationCache.has(cacheKey)) {
    return recommendationCache.get(cacheKey);
  }

  if (!universe.length) {
    const emptyResponse = {
      goalId: goalProfile.goalId,
      goalName: goalProfile.goalName,
      summary: `No market universe was available for ${goalProfile.goalName}. Please retry after the stock feed loads.`,
      goalAnalysis: goalProfile,
      strategy: {
        riskLevel: goalProfile.riskCapacity,
        horizon: goalProfile.investmentHorizon,
        recommendedApproach: goalProfile.recommendedApproach,
      },
      recommendations: [],
      disclaimer: 'Investment returns are market-dependent and not guaranteed. This analysis is for informational purposes and should not be treated as personalized financial advice.',
      projection: buildProjection(goalProfile),
    };
    recommendationCache.set(cacheKey, emptyResponse);
    return emptyResponse;
  }

  const filtered = universe.filter((stock) => {
    const sector = stock.sector || stock.industry || 'Unknown';
    const volatility = Number(stock.volatility ?? stock.annualVolatility ?? 0.18);
    const pe = Number(stock.pe ?? stock.PE ?? 0);
    const metrics = getResearchMetrics(stock, researchBySymbol);
    const riskScore = getRiskScore(metrics);
    if (goalProfile.investmentHorizon === 'SHORT_TERM' && volatility > 0.26) return false;
    if (goalProfile.investmentHorizon === 'SHORT_TERM' && pe > 35) return false;
    if (goalProfile.goalType === 'retirement' && sector === 'Green Energy' && volatility > 0.3) return false;
    if (goalProfile.goalType === 'house' && goalProfile.yearsRemaining <= 3 && sector === 'IT') return false;
    if (goalProfile.selectedSector && normalizeSector(sector) !== goalProfile.selectedSector) return false;
    if (!riskTierAllows(goalProfile.riskCapacity, riskScore, metrics.available)) return false;
    return Boolean(stock.ticker || stock.symbol) && sector !== 'Unknown';
  });

  // STATUS_RANK enforces "complete candidates first, then partial" — stocks
  // with insufficient verified data are ranked last within `scored` and are
  // excluded from `rankable` a few lines down, so they are never surfaced as
  // recommendations regardless of any sector match.
  const STATUS_RANK = { COMPLETE: 0, PARTIAL: 1, INSUFFICIENT_DATA: 2 };
  const rankComparator = (a, b) => {
    const statusDiff = STATUS_RANK[a.scoreStatus] - STATUS_RANK[b.scoreStatus];
    if (statusDiff !== 0) return statusDiff;
    return (b.goalFitScore ?? -1) - (a.goalFitScore ?? -1);
  };

  const scored = filtered.map((stock) => {
    const historical = getResearchMetrics(stock, researchBySymbol);
    const riskScore = getRiskScore(historical);
    const evaluation = evaluateStockForGoal(stock, goalProfile, historical);
    return {
      ...stock,
      goalFitScore: evaluation.goalFitScore,
      scoreStatus: evaluation.scoreStatus,
      dataCoveragePct: evaluation.dataCoveragePct,
      availableMetrics: evaluation.availableMetrics,
      missingMetrics: evaluation.missingMetrics,
      confidence: evaluation.confidence,
      riskScore,
      historical,
      goalFitComponents: buildGoalFitComponents(evaluation, historical, riskScore, goalProfile),
      rejectionReasons: [
        goalProfile.investmentHorizon === 'SHORT_TERM' && Number(stock.volatility ?? stock.annualVolatility ?? 0.18) > 0.26 ? 'Volatility is too high for the target timeline.' : null,
        goalProfile.goalType === 'house' && goalProfile.yearsRemaining <= 3 && (stock.sector || stock.industry) === 'IT' ? 'Short-term goal makes technology exposure less suitable.' : null,
      ].filter(Boolean),
    };
  }).sort(rankComparator);

  // Stocks with zero verified metrics are never ranked as recommendations,
  // no matter how well their sector matches the goal.
  const rankable = scored.filter((stock) => stock.scoreStatus !== 'INSUFFICIENT_DATA');

  // `rankable` is already sorted best-first (COMPLETE before PARTIAL, higher
  // score first within each). The per-sector diversity pick below keeps the
  // FIRST (best) stock seen for each sector, so a higher-quality candidate
  // can never be silently displaced by a lower-status same-sector stock.
  const sectorCandidates = goalProfile.selectedSector
    ? rankable
    : [...rankable.reduce((bySector, stock) => {
        const key = normalizeSector(stock.sector || stock.industry);
        if (!bySector.has(key)) bySector.set(key, stock);
        return bySector;
      }, new Map()).values()];
  const topCandidates = sectorCandidates.slice(0, goalProfile.selectedSector ? 5 : 20);

  const newsData = await Promise.all(
    topCandidates.map(async (stock) => {
      try {
        const articles = await getStockNews(stock.ticker || stock.symbol);
        return { symbol: stock.ticker || stock.symbol, articles: articles.slice(0, 4) };
      } catch (error) {
        return { symbol: stock.ticker || stock.symbol, articles: [] };
      }
    })
  );

  const newsMap = new Map(newsData.map((item) => [item.symbol, item.articles]));

  let recommendations = topCandidates.map((stock, index) => {
    const symbol = stock.ticker || stock.symbol;
    const news = newsMap.get(symbol) || [];
    const allocationPercent = deriveAllocation(goalProfile, index, topCandidates.length || 1);
    const investmentPlanMonthly = Math.max(goalProfile.monthlyContribution * (allocationPercent / 100), 50);
    const roi = Number(stock.changePct || stock.oneYearReturn || 0) / 100;

    return {
      symbol,
      companyName: stock.name || stock.companyName || symbol,
      goalFitScore: stock.goalFitScore,
      scoreStatus: stock.scoreStatus,
      dataCoveragePct: stock.dataCoveragePct,
      availableMetrics: stock.availableMetrics,
      missingMetrics: stock.missingMetrics,
      confidence: stock.confidence,
      riskScore: stock.riskScore,
      components: stock.goalFitComponents,
      recommendation: stock.goalFitScore == null ? 'INSUFFICIENT_DATA' : stock.goalFitScore >= 78 ? 'CONSIDER' : stock.goalFitScore >= 65 ? 'WATCH' : 'AVOID',
      allocationPercent,
      risk: getRiskLabel(stock.riskScore),
      whyRecommended: buildWhyRecommended(stock, goalProfile),
      reasons: [
        stock.historical.available ? `${stock.historical.volatility}% measured annualized volatility and ${stock.historical.maxDrawdown}% maximum drawdown were included.` : 'Historical volatility and drawdown data are unavailable from the configured provider and were excluded from the score.',
        stock.pe ? `Available valuation input: P/E ${stock.pe}.` : 'Valuation data was unavailable and excluded from the score.',
        stock.roe ? `Available quality input: ROE ${stock.roe}.` : 'Quality (ROE) data was unavailable and excluded from the score.',
        `Data coverage: ${stock.dataCoveragePct}% of verified metrics available (${stock.confidence} confidence). Missing: ${stock.missingMetrics.length ? stock.missingMetrics.join(', ') : 'none'}.`,
      ],
      history: stock.historical.available
        ? `The provider returned ${stock.historical.observations} daily observations. The one-year price change was ${stock.historical.oneYearReturn}%, annualized volatility was ${stock.historical.volatility}%, and maximum drawdown was ${stock.historical.maxDrawdown}%. These are historical measurements, not a forecast.`
        : 'Historical candle data was unavailable from the configured provider for this stock, so historical performance metrics are not asserted.',
      present: explainStockPresent(stock, goalProfile),
      future: explainStockFuture(stock, goalProfile),
      risks: [
        `Market volatility and sector cyclicality can affect ${stock.name || symbol} during the goal period.`,
        `Valuation compression or a change in earnings trend may reduce the expected risk-adjusted payoff.`,
        goalProfile.investmentHorizon === 'SHORT_TERM' ? 'Short-duration goals are more exposed to temporary drawdowns and interest-rate moves.' : 'Longer-duration goals still require periodic review as the company and sector evolve.',
      ],
      investmentPlan: {
        monthly: Number(investmentPlanMonthly.toFixed(0)),
        weekly: Number((investmentPlanMonthly / 4.33).toFixed(0)),
        quarterly: Number((investmentPlanMonthly * 3).toFixed(0)),
        annual: Number((investmentPlanMonthly * 12).toFixed(0)),
        suggestedApproach: goalProfile.investmentHorizon === 'SHORT_TERM' ? 'Allocate in staggered tranches to reduce timing risk.' : 'Create a steady monthly allocation and review the position when the goal timeline shortens.',
      },
      projection: {
        requiredAmount: goalProfile.requiredFutureValue,
        currentAmount: goalProfile.currentAmount,
        projectedAmount: Number((goalProfile.currentAmount + (goalProfile.monthlyContribution * 12 * Math.max(roi, 0.08) * goalProfile.yearsRemaining)).toFixed(2)),
        fundingGap: Math.max(goalProfile.targetAmount - (goalProfile.currentAmount + (goalProfile.monthlyContribution * 12 * Math.max(roi, 0.08) * goalProfile.yearsRemaining)), 0),
      },
      news: news.map((article) => ({
        title: article.title,
        source: article.source,
        url: article.url,
        imageUrl: article.imageUrl,
        publishedAt: article.publishedAt,
      })),
      sector: stock.sector || stock.industry || 'Unknown',
      price: Number(stock.price || 0),
      changePct: Number(stock.changePct || 0),
      marketCap: stock.marketCap || 'N/A',
      pe: stock.pe || null,
      historical: stock.historical,
      fundamentals: {
        pe: stock.pe ?? null,
        marketCap: stock.marketCap ?? null,
        roe: stock.roe ?? null,
        debtEquity: stock.debtEquity ?? stock.debtToEquity ?? null,
        source: stock.fundamentalSource || null,
      },
      present: {
        price: Number(stock.price || 0),
        dayChangePct: Number(stock.changePct || 0),
        high: stock.high ?? null,
        low: stock.low ?? null,
        source: stock.priceSource || 'Active market-data provider',
      },
      future: {
        growthDrivers: news.slice(0, 3).map((article) => article.title).filter(Boolean),
        risks: [
          'Historical volatility and drawdowns can cause temporary or sustained capital loss.',
          stock.pe ? `Valuation risk remains relevant while the stock trades at a P/E of ${stock.pe}.` : 'Valuation data was not supplied by the active provider.',
        ],
        sources: news.map((article) => ({ title: article.title, source: article.source, url: article.url, publishedAt: article.publishedAt })),
        label: 'Evidence-based inference only; no future return is guaranteed.',
      },
    };
  });

  if (goalProfile.aiAnalysisEnabled && recommendations.length) {
    try {
      const research = await ResearchService.enrichSymbols(recommendations.slice(0, 5).map((item) => item.symbol));
      const researchBySymbol = new Map(research.map((item) => [String(item.ticker).toUpperCase(), item]));
      recommendations = recommendations.map((item) => {
        const enriched = researchBySymbol.get(String(item.symbol).toUpperCase());
        // News/AI sentiment is never allowed to manufacture a score for a
        // candidate that lacks verified financial metrics — only items that
        // already carry a real goalFitScore (COMPLETE/PARTIAL) get blended.
        if (!enriched || item.goalFitScore == null) return item;

        const rawScore = item.goalFitScore;
        let sentimentScore = enriched.sentimentScore ?? 0;
        let sentimentConfidence = enriched.sentimentConfidence ?? 0.5;
        let sentimentDrivers = enriched.sentimentDrivers || [];
        let sentimentFit = Math.round(clamp(50 + (sentimentScore * 50), 0, 100));
        let sentimentBadge = sentimentScore >= 0.25 ? 'BULLISH' : sentimentScore <= -0.25 ? 'BEARISH' : 'NEUTRAL';

        // Apply Severe Negative Sentiment Penalty (-15 points if scandal/downgrade)
        const penalty = sentimentScore <= -0.5 ? -15 : 0;
        const adjustedGoalFitScore = Math.round(clamp(0.85 * rawScore + 0.15 * sentimentFit + penalty, 0, 100));

        return {
          ...item,
          goalFitScore: adjustedGoalFitScore,
          sentimentScore,
          sentimentConfidence,
          sentimentDrivers,
          sentimentFit,
          sentimentBadge,
          components: {
            ...item.components,
            newsSentiment: sentimentFit,
          },
          recommendation: adjustedGoalFitScore >= 78 ? 'CONSIDER' : adjustedGoalFitScore >= 65 ? 'WATCH' : 'AVOID',
          history: enriched.historySummary || item.history,
          present: enriched.presentSummary || item.present,
          future: enriched.futureSummary || item.future,
          news: enriched.news?.length ? enriched.news : item.news,
          aiAnalysis: enriched.historySummary || enriched.presentSummary || enriched.futureSummary ? 'AI-enriched with live news sentiment weighting.' : 'Deterministic analysis used because AI research was unavailable.',
        };
      });

      // Re-sort after sentiment weighting, preserving complete-before-partial
      // ranking; sentiment never overrides the data-quality tier.
      recommendations.sort((a, b) => {
        const statusDiff = STATUS_RANK[a.scoreStatus] - STATUS_RANK[b.scoreStatus];
        if (statusDiff !== 0) return statusDiff;
        return (b.goalFitScore ?? -1) - (a.goalFitScore ?? -1);
      });
    } catch (error) {
      // The deterministic scoring and explanations remain usable when AI research is unavailable.
    }
  }

  const rebalanceAnalysis = RebalanceService.evaluateGoalDrift(goalProfile, profile, recommendations);

  const recommendationPayload = {
    goalId: goalProfile.goalId,
    goalName: goalProfile.goalName,
    summary: createRecommendationSummary(goalProfile, recommendations),
    goalAnalysis: {
      ...goalProfile,
      requiredReturn: Number(goalProfile.requiredReturn.toFixed(2)),
      requiredMonthlyInvestment: Number(goalProfile.requiredMonthlyInvestment.toFixed(2)),
      riskAssessment: goalProfile.contributionStatus,
    },
    filters: {
      risk: goalProfile.riskProfile,
      sector: goalProfile.selectedSector || 'ALL',
      horizonYears: goalProfile.yearsRemaining,
      monthlyContribution: goalProfile.monthlyContribution,
    },
    strategy: {
      riskLevel: goalProfile.riskCapacity,
      horizon: goalProfile.investmentHorizon,
      recommendedApproach: goalProfile.recommendedApproach,
    },
    recommendations,
    dataQualitySummary: {
      screenedCount: scored.length,
      completeCount: scored.filter((stock) => stock.scoreStatus === 'COMPLETE').length,
      partialCount: scored.filter((stock) => stock.scoreStatus === 'PARTIAL').length,
      insufficientDataExcludedCount: scored.filter((stock) => stock.scoreStatus === 'INSUFFICIENT_DATA').length,
    },
    rebalanceAnalysis,
    projection: buildProjection(goalProfile),
    disclaimer: 'Investment returns are market-dependent and not guaranteed. This analysis is for informational purposes and should not be treated as personalized financial advice.',
    generatedAt: new Date().toISOString(),
  };

  if (!recommendations.length) {
    recommendationPayload.summary = `No equity stock currently meets the required risk/horizon criteria for this goal. Increase contribution, extend the horizon, or use lower-risk options such as debt, fixed income, or a larger cash reserve.`;
    recommendationPayload.recommendations = [];
  }

  recommendationCache.set(cacheKey, recommendationPayload);
  return recommendationPayload;
};

export default { buildGoalProfile, buildGoalRecommendation, createRecommendationSummary };

