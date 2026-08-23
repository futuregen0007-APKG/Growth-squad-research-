const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

const normalizeRisk = (profile) => String(profile?.riskAppetite || 'moderate').toLowerCase();

const horizonYears = (goal, profile) => {
  const explicitYears = Number(goal?.targetYear) - new Date().getFullYear();
  if (Number.isFinite(explicitYears) && explicitYears > 0) return explicitYears;
  return { short: 2, medium: 5, long: 10 }[profile?.investmentHorizon] || 5;
};

const scoreRiskFit = (stock, risk) => {
  const volatility = Math.abs(Number(stock.changePct));
  if (!Number.isFinite(volatility)) return null;
  const preferred = { conservative: 1.5, moderate: 3, aggressive: 6, very_aggressive: 9 }[risk] || 3;
  return clamp(100 - Math.abs(volatility - preferred) * 12);
};

const scoreValuation = (stock) => {
  const pe = Number(stock.pe);
  if (!Number.isFinite(pe) || pe <= 0) return null;
  return clamp(100 - Math.max(0, pe - 10) * 2.4);
};

const scoreGrowth = (stock) => {
  const change = Number(stock.changePct);
  return Number.isFinite(change) ? clamp(50 + change * 10) : null;
};

const scoreFundamentals = (stock) => {
  const hasPrice = Number.isFinite(Number(stock.price)) && Number(stock.price) > 0;
  const hasValuation = scoreValuation(stock) !== null;
  if (!hasPrice && !hasValuation) return null;
  return clamp((hasPrice ? 55 : 0) + (hasValuation ? 45 : 0));
};

const scoreGoalFit = (stock, goal, years) => {
  const type = String(goal?.type || '').toLowerCase();
  const defensiveSectors = ['FMCG', 'Healthcare', 'Banking'];
  const growthSectors = ['IT', 'Manufacturing', 'Infrastructure', 'Green Energy', 'Defence'];
  let score = years < 3 && defensiveSectors.includes(stock.sector) ? 85 : 55;
  if (years >= 7 && growthSectors.includes(stock.sector)) score += 25;
  if (type === 'passive_income' && ['Banking', 'Energy', 'FMCG'].includes(stock.sector)) score += 15;
  if (type === 'retirement' && defensiveSectors.includes(stock.sector)) score += 10;
  if (type === 'emergency' && years < 3) score = defensiveSectors.includes(stock.sector) ? 90 : 35;
  return clamp(score);
};

const scoreMomentum = (stock) => {
  const change = Number(stock.changePct);
  return Number.isFinite(change) ? clamp(50 + change * 10) : null;
};

const weighted = (scores, weights) => {
  let total = 0;
  let availableWeight = 0;
  Object.entries(weights).forEach(([key, weight]) => {
    if (scores[key] !== null) {
      total += scores[key] * weight;
      availableWeight += weight;
    }
  });
  return availableWeight ? Math.round(total / availableWeight) : 0;
};

export const RECOMMENDATION_WEIGHTS = {
  fundamentals: 0.25,
  growth: 0.20,
  valuation: 0.15,
  risk: 0.15,
  momentum: 0.10,
  goalFit: 0.10,
  diversification: 0.05,
};

export function rankRecommendations(stocks, goal, profile = {}) {
  const risk = normalizeRisk(profile);
  const years = horizonYears(goal, profile);
  const ranked = stocks.map((stock) => {
    const scores = {
      fundamentals: scoreFundamentals(stock),
      growth: scoreGrowth(stock),
      valuation: scoreValuation(stock),
      risk: scoreRiskFit(stock, risk),
      momentum: scoreMomentum(stock),
      goalFit: scoreGoalFit(stock, goal, years),
      diversification: 50,
    };
    return { ...stock, score: weighted(scores, RECOMMENDATION_WEIGHTS), scores, risk: risk.replace('_', ' '), years };
  }).sort((a, b) => b.score - a.score);

  const selectedSectors = new Set();
  const diversified = [];
  for (const stock of ranked) {
    if (diversified.length >= 6) break;
    if (!selectedSectors.has(stock.sector) || diversified.length >= 4) {
      selectedSectors.add(stock.sector);
      diversified.push({
        ...stock,
        scores: { ...stock.scores, diversification: selectedSectors.size <= 4 ? 100 : 45 },
        score: weighted({ ...stock.scores, diversification: selectedSectors.size <= 4 ? 100 : 45 }, RECOMMENDATION_WEIGHTS),
      });
    }
  }

  return diversified.sort((a, b) => b.score - a.score).map((stock) => ({
    ...stock,
    recommendation: stock.score >= 75 ? 'STRONG CONSIDER' : stock.score >= 60 ? 'CONSIDER' : stock.score >= 45 ? 'WATCH' : 'AVOID FOR NOW',
    reasons: [
      stock.scores.fundamentals !== null ? 'Uses available quote and valuation data.' : 'Fundamental data is unavailable from the current provider.',
      stock.scores.goalFit >= 70 ? `Fits the ${years}-year horizon and selected goal.` : 'Goal fit is limited for the selected horizon.',
      stock.scores.diversification >= 100 ? `Adds ${stock.sector} exposure to the recommendation mix.` : 'Adds further exposure to an already represented sector.',
    ],
    risks: [
      stock.scores.risk !== null ? `${stock.risk} risk fit based on available price-change data.` : 'Risk data is unavailable from the current provider.',
      stock.scores.valuation !== null && stock.scores.valuation < 50 ? 'Valuation score is below the middle of the available range.' : 'Valuation should be reviewed before investing.',
    ],
  }));
}

export const getSectorAllocation = (recommendations) => {
  const counts = recommendations.reduce((result, stock) => {
    result[stock.sector || 'Unknown'] = (result[stock.sector || 'Unknown'] || 0) + 1;
    return result;
  }, {});
  const total = recommendations.length || 1;
  return Object.entries(counts).map(([sector, count]) => ({ sector, percentage: Math.round((count / total) * 100) }));
};