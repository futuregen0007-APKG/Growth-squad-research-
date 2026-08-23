import { buildGoalProfile } from './GoalRecommendationService.js';
import { logger } from '../utils/logger.js';

export const GLIDEPATH_TIERS = {
  LONG_TERM: {
    minYears: 7,
    name: 'Growth & Compounding',
    targetMix: {
      growthSectors: 70, // IT, Manufacturing, Green Energy, Infrastructure
      coreSectors: 20,   // Banking, Financials
      defensiveSectors: 10, // FMCG, Healthcare
    },
    riskProfile: 'AGGRESSIVE',
    description: 'Maximize long-term compounding through higher-growth sectoral leaders and manageable beta.',
  },
  MEDIUM_TERM: {
    minYears: 3,
    maxYears: 7,
    name: 'Balanced Growth',
    targetMix: {
      growthSectors: 35,
      coreSectors: 45,
      defensiveSectors: 20,
    },
    riskProfile: 'MODERATE',
    description: 'Balance wealth accumulation with volatility control as target horizon approaches.',
  },
  SHORT_TERM: {
    maxYears: 3,
    name: 'Capital Preservation',
    targetMix: {
      growthSectors: 10,
      coreSectors: 30,
      defensiveSectors: 60, // FMCG, Banking, Pharma, Low-volatility
    },
    riskProfile: 'CONSERVATIVE',
    description: 'Prioritize capital safety and low drawdown to ensure funds are secure for near-term redemption.',
  },
};

export class RebalanceService {
  static getGlidepathForHorizon(yearsRemaining) {
    if (yearsRemaining > 7) return GLIDEPATH_TIERS.LONG_TERM;
    if (yearsRemaining >= 3) return GLIDEPATH_TIERS.MEDIUM_TERM;
    return GLIDEPATH_TIERS.SHORT_TERM;
  }

  static categorizeSector(sector = '') {
    const s = String(sector || '').toLowerCase();
    if (['it', 'manufacturing', 'green energy', 'renewable energy', 'infrastructure', 'defence', 'internet'].some((k) => s.includes(k))) {
      return 'growth';
    }
    if (['fmcg', 'healthcare', 'pharma', 'power', 'consumer'].some((k) => s.includes(k))) {
      return 'defensive';
    }
    return 'core';
  }

  static evaluateGoalDrift(goal = {}, profile = {}, currentRecommendations = []) {
    const goalProfile = buildGoalProfile(goal, profile);
    const yearsRemaining = goalProfile.yearsRemaining;
    const currentGlidepath = this.getGlidepathForHorizon(yearsRemaining);

    const holdingCategories = { growth: 0, core: 0, defensive: 0 };
    const totalAllocations = currentRecommendations.reduce((sum, item) => sum + (Number(item.allocationPercent) || 0), 0) || 100;

    currentRecommendations.forEach((item) => {
      const cat = this.categorizeSector(item.sector);
      const alloc = Number(item.allocationPercent) || (100 / Math.max(currentRecommendations.length, 1));
      holdingCategories[cat] = (holdingCategories[cat] || 0) + (alloc / totalAllocations) * 100;
    });

    const targetMix = currentGlidepath.targetMix;
    const growthDiff = Math.abs(holdingCategories.growth - targetMix.growthSectors);
    const defensiveDiff = Math.abs(holdingCategories.defensive - targetMix.defensiveSectors);
    const coreDiff = Math.abs(holdingCategories.core - targetMix.coreSectors);
    const maxDrift = Math.max(growthDiff, defensiveDiff, coreDiff);

    const isDrifted = maxDrift > 8 || (yearsRemaining <= 3 && holdingCategories.growth > 25);

    const sentimentAlerts = currentRecommendations
      .filter((item) => Number(item.sentimentScore) <= -0.4)
      .map((item) => ({
        symbol: item.symbol || item.ticker,
        companyName: item.companyName || item.name,
        sentimentScore: item.sentimentScore,
        warning: `Negative news sentiment (${item.sentimentScore}) detected. Consider reviewing allocation.`,
      }));

    const reasons = [];
    if (yearsRemaining <= 3 && holdingCategories.growth > 20) {
      reasons.push(`Timeline is within 3 years (${yearsRemaining}y). High growth allocation (${Math.round(holdingCategories.growth)}%) should be reduced to protect capital.`);
    }
    if (maxDrift > 8) {
      reasons.push(`Portfolio mix has drifted by ${Math.round(maxDrift)}% from the ${currentGlidepath.name} glidepath target.`);
    }
    if (sentimentAlerts.length > 0) {
      reasons.push(`${sentimentAlerts.length} asset(s) flagged with negative catalyst or sentiment warnings.`);
    }

    const actionPlan = {
      recommendedAction: isDrifted ? 'REBALANCE_RECOMMENDED' : 'PORTFOLIO_ON_TRACK',
      glidepathTier: currentGlidepath.name,
      targetRisk: currentGlidepath.riskProfile,
      yearsRemaining,
      driftPercentage: Math.round(maxDrift),
      currentMix: {
        growth: Math.round(holdingCategories.growth),
        core: Math.round(holdingCategories.core),
        defensive: Math.round(holdingCategories.defensive),
      },
      targetMix: {
        growth: targetMix.growthSectors,
        core: targetMix.coreSectors,
        defensive: targetMix.defensiveSectors,
      },
      reasons,
      sentimentAlerts,
      suggestedAdjustments: isDrifted ? [
        yearsRemaining <= 3
          ? 'Shift monthly SIP priority toward low-volatility FMCG & Banking assets.'
          : 'Reallocate top-weighted outperforming sectors to match optimal glidepath targets.',
        'Review positions with sentiment warnings for potential stop-loss or substitution.',
      ] : ['Maintain current monthly contribution schedule.'],
    };

    return actionPlan;
  }
}

export default RebalanceService;
