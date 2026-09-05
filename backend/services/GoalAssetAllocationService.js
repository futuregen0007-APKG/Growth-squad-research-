const METHODOLOGY_VERSION = 'goal-allocation-v1';

export const BASE_ALLOCATIONS = Object.freeze({
  CONSERVATIVE: Object.freeze({ equityMutualFundsPct: 25, directEquityPct: 5, debtPct: 45, goldPct: 15, liquidPct: 10 }),
  MODERATE: Object.freeze({ equityMutualFundsPct: 40, directEquityPct: 15, debtPct: 25, goldPct: 10, liquidPct: 10 }),
  AGGRESSIVE: Object.freeze({ equityMutualFundsPct: 45, directEquityPct: 30, debtPct: 10, goldPct: 10, liquidPct: 5 }),
});

const EXPECTED_ANNUAL_RETURN = Object.freeze({ CONSERVATIVE: 0.07, MODERATE: 0.09, AGGRESSIVE: 0.12 });
const SUPPORTED_RISKS = new Set(Object.keys(BASE_ALLOCATIONS));
const money = (value) => Math.round(value * 100) / 100;
const integerPct = (value) => Math.max(0, Number(value) || 0);

const normalizeRisk = (riskLevel) => String(riskLevel || '').trim().toUpperCase().replace(/[- ]/g, '_');

export const futureValue = ({ currentAmount, monthlyContribution, annualRate, months }) => {
  const monthlyRate = annualRate / 12;
  if (monthlyRate === 0) return currentAmount + (monthlyContribution * months);
  const factor = Math.pow(1 + monthlyRate, months);
  return (currentAmount * factor) + (monthlyContribution * ((factor - 1) / monthlyRate));
};

export const requiredMonthlyContribution = ({ targetAmount, currentAmount, annualRate, months }) => {
  const monthlyRate = annualRate / 12;
  const growth = monthlyRate === 0 ? currentAmount : currentAmount * Math.pow(1 + monthlyRate, months);
  const gap = Math.max(targetAmount - growth, 0);
  if (gap === 0) return 0;
  if (monthlyRate === 0) return gap / months;
  return gap / ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
};

const normalizeAllocation = (allocation) => {
  const keys = Object.keys(BASE_ALLOCATIONS.MODERATE);
  const total = keys.reduce((sum, key) => sum + integerPct(allocation[key]), 0);
  const normalized = keys.reduce((result, key) => ({ ...result, [key]: total ? (integerPct(allocation[key]) / total) * 100 : 0 }), {});
  const rounded = keys.reduce((result, key) => ({ ...result, [key]: Number(normalized[key].toFixed(2)) }), {});
  rounded.liquidPct = 100 - keys.filter((key) => key !== 'liquidPct').reduce((sum, key) => sum + rounded[key], 0);
  return rounded;
};

const applyHorizonAdjustment = (base, horizonYears, riskLevel) => {
  const adjusted = { ...base };
  if (horizonYears <= 2) {
    const equityReduction = adjusted.equityMutualFundsPct * 0.55 + adjusted.directEquityPct * 0.85;
    adjusted.equityMutualFundsPct *= 0.45;
    adjusted.directEquityPct *= 0.15;
    adjusted.debtPct += equityReduction * 0.7;
    adjusted.liquidPct += equityReduction * 0.3;
  } else if (horizonYears <= 5) {
    const directReduction = adjusted.directEquityPct * 0.35;
    adjusted.directEquityPct -= directReduction;
    adjusted.debtPct += directReduction * 0.7;
    adjusted.liquidPct += directReduction * 0.3;
  } else if (horizonYears > 10) {
    const increase = riskLevel === 'AGGRESSIVE' ? 5 : riskLevel === 'MODERATE' ? 3 : 1;
    adjusted.equityMutualFundsPct += increase * 0.6;
    adjusted.directEquityPct += increase * 0.4;
    adjusted.debtPct -= increase * 0.7;
    adjusted.liquidPct -= increase * 0.3;
  }
  return normalizeAllocation(adjusted);
};

const monthlySplit = (allocation, monthlyContribution) => {
  const keys = ['equityMutualFunds', 'directEquity', 'debt', 'gold', 'liquid'];
  const pctKeys = ['equityMutualFundsPct', 'directEquityPct', 'debtPct', 'goldPct', 'liquidPct'];
  const split = keys.reduce((result, key, index) => ({ ...result, [`${key}Amount`]: money(monthlyContribution * allocation[pctKeys[index]] / 100) }), {});
  const total = money(Object.values(split).reduce((sum, value) => sum + value, 0));
  split.liquidAmount = money(split.liquidAmount + (monthlyContribution - total));
  split.total = money(Object.values(split).reduce((sum, value) => sum + value, 0));
  return split;
};

const createGlidepath = (allocation, horizonYears) => Array.from({ length: horizonYears }, (_, index) => {
  const yearsRemaining = horizonYears - index;
  const progress = (horizonYears - yearsRemaining) / Math.max(horizonYears - 1, 1);
  const directEquityPct = Math.max(0, allocation.directEquityPct * (1 - 0.75 * progress));
  const equityMutualFundsPct = Math.max(0, allocation.equityMutualFundsPct * (1 - 0.45 * progress));
  const reducedEquity = (allocation.directEquityPct - directEquityPct) + (allocation.equityMutualFundsPct - equityMutualFundsPct);
  const debtPct = allocation.debtPct + reducedEquity * 0.75;
  const liquidPct = allocation.liquidPct + reducedEquity * 0.25;
  const row = normalizeAllocation({ equityMutualFundsPct, directEquityPct, debtPct, goldPct: allocation.goldPct, liquidPct });
  return {
    year: index + 1,
    yearsRemaining,
    ...row,
    explanationCode: yearsRemaining <= 2 ? 'CAPITAL_PRESERVATION' : index === 0 ? 'INITIAL_ALLOCATION' : 'EQUITY_REDUCED_AS_GOAL_APPROACHES',
    reason: yearsRemaining <= 2 ? 'Final years prioritize debt and liquid assets to reduce equity timing risk.' : 'Direct equity reduces first, followed by equity mutual funds, while gold remains bounded.',
  };
});

const emptyProductBuckets = (allocation, split) => ({
  mutualFunds: { status: 'AWAITING_DATA', allocationPct: allocation.equityMutualFundsPct, monthlyAmount: split.equityMutualFundsAmount, items: [], requiredData: ['NAV history', 'expense ratio', 'Riskometer', 'AUM', 'drawdown'] },
  stocks: { status: 'AWAITING_FUNDAMENTALS', allocationPct: allocation.directEquityPct, monthlyAmount: split.directEquityAmount, items: [] },
  debt: { status: 'CATEGORY_GUIDANCE_ONLY', allocationPct: allocation.debtPct, monthlyAmount: split.debtAmount, items: [] },
  gold: { status: 'CATEGORY_GUIDANCE_ONLY', allocationPct: allocation.goldPct, monthlyAmount: split.goldAmount, items: [] },
  liquid: { status: 'CATEGORY_GUIDANCE_ONLY', allocationPct: allocation.liquidPct, monthlyAmount: split.liquidAmount, items: [] },
});

export const buildGoalAssetAllocation = (input = {}) => {
  const targetAmount = Number(input.targetAmount);
  const currentAmount = Number(input.currentAmount);
  const monthlyContribution = Number(input.monthlyContribution);
  const horizonYears = Number(input.horizonYears);
  const riskLevel = normalizeRisk(input.riskLevel);
  if (![targetAmount, currentAmount, monthlyContribution, horizonYears].every(Number.isFinite) || targetAmount <= 0 || currentAmount < 0 || monthlyContribution < 0 || horizonYears <= 0 || !SUPPORTED_RISKS.has(riskLevel)) {
    return { feasibility: { status: 'INSUFFICIENT_INPUT' }, methodologyVersion: METHODOLOGY_VERSION, assumptions: { supportedRiskLevels: [...SUPPORTED_RISKS] } };
  }

  const wholeYears = Math.max(1, Math.ceil(horizonYears));
  const months = wholeYears * 12;
  const annualRate = EXPECTED_ANNUAL_RETURN[riskLevel];
  const projectedValue = futureValue({ currentAmount, monthlyContribution, annualRate, months });
  const requiredMonthly = requiredMonthlyContribution({ targetAmount, currentAmount, annualRate, months });
  const shortfallSurplus = monthlyContribution - requiredMonthly;
  const status = projectedValue >= targetAmount ? (monthlyContribution > requiredMonthly ? 'AHEAD' : 'ON_TRACK') : 'BEHIND';
  const allocation = applyHorizonAdjustment(BASE_ALLOCATIONS[riskLevel], wholeYears, riskLevel);
  const split = monthlySplit(allocation, monthlyContribution);
  return {
    feasibility: { status, projectedValue: money(projectedValue), requiredMonthlyContribution: money(requiredMonthly), currentMonthlyContribution: money(monthlyContribution), monthlyShortfallSurplus: money(shortfallSurplus), fundingRatio: targetAmount ? money(projectedValue / targetAmount) : null },
    allocation,
    monthlySplit: split,
    glidepath: createGlidepath(allocation, wholeYears),
    rebalance: { frequency: 'ANNUAL', trigger: 'Review when any bucket drifts by 5 percentage points from its glidepath target.', guidance: 'Rebalance toward the applicable glidepath row; do not use this as personalized regulated advice.' },
    methodologyVersion: METHODOLOGY_VERSION,
    assumptions: { expectedAnnualReturn: annualRate, expectedAnnualReturnPct: annualRate * 100, expectedAnnualReturnIsGuaranteed: false, compounding: 'monthly, contributions at month end', riskLevel, goalType: input.goalType || 'custom' },
    productBuckets: emptyProductBuckets(allocation, split),
  };
};

export default buildGoalAssetAllocation;