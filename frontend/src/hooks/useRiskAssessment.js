import { RISK_LEVELS } from '@/data/financialProfileData';

export function calculateRiskScore(profile) {
  let score = 0;
  let maxScore = 100;

  // Age factor (younger = higher risk capacity)
  const age = parseInt(profile.age) || 30;
  if (age < 25) score += 20;
  else if (age < 35) score += 15;
  else if (age < 45) score += 10;
  else if (age < 55) score += 5;
  else score += 0;

  // Income stability (profession)
  const profession = profile.profession;
  const stableProfessions = ['Senior Level (5-10 years)', 'Executive (10+ years)', 'Retired', 'Business Owner'];
  if (stableProfessions.includes(profession)) score += 15;
  else if (['Mid Level (2-5 years)'].includes(profession)) score += 10;
  else score += 5;

  // Dependents (fewer dependents = higher risk capacity)
  const dependents = parseInt(profile.dependents) || 0;
  if (dependents === 0) score += 15;
  else if (dependents <= 2) score += 10;
  else if (dependents <= 4) score += 5;
  else score += 0;

  // Emergency fund (having one = higher risk capacity)
  if (profile.hasEmergencyFund) score += 10;
  else score -= 5;

  // Insurance coverage
  if (profile.hasInsurance) score += 5;

  // Debt obligations
  if (!profile.hasEMI) score += 10;
  else score -= 5;

  // Investment horizon (longer = higher risk capacity)
  const horizon = profile.investmentHorizon;
  if (horizon === 'long') score += 15;
  else if (horizon === 'medium') score += 10;
  else score += 5;

  // Investment experience
  const experience = profile.investmentExperience;
  if (experience === 'expert') score += 15;
  else if (experience === 'advanced') score += 12;
  else if (experience === 'intermediate') score += 8;
  else score += 3;

  // Volatility tolerance
  if (profile.canHandleVolatility) score += 10;
  else score -= 5;

  // Normalize score to 0-100 range
  score = Math.max(0, Math.min(100, score));

  return score;
}

export function getRiskProfile(score) {
  if (score >= 75) return RISK_LEVELS.find(r => r.id === 'very_aggressive');
  if (score >= 55) return RISK_LEVELS.find(r => r.id === 'aggressive');
  if (score >= 35) return RISK_LEVELS.find(r => r.id === 'moderate');
  return RISK_LEVELS.find(r => r.id === 'conservative');
}

export function getRecommendedAllocation(riskProfile) {
  const allocations = {
    conservative: {
      largeCap: 40,
      midCap: 15,
      smallCap: 5,
      debt: 30,
      gold: 10,
      international: 0,
    },
    moderate: {
      largeCap: 40,
      midCap: 20,
      smallCap: 10,
      debt: 20,
      gold: 10,
      international: 0,
    },
    aggressive: {
      largeCap: 35,
      midCap: 25,
      smallCap: 25,
      debt: 10,
      gold: 5,
      international: 0,
    },
    very_aggressive: {
      largeCap: 25,
      midCap: 30,
      smallCap: 35,
      debt: 5,
      gold: 0,
      international: 5,
    },
  };

  return allocations[riskProfile.id] || allocations.moderate;
}

export function generateRiskReport(profile) {
  const score = calculateRiskScore(profile);
  const riskProfile = getRiskProfile(score);
  const allocation = getRecommendedAllocation(riskProfile);

  return {
    score,
    riskProfile: riskProfile.id,
    riskLabel: riskProfile.label,
    riskDescription: riskProfile.description,
    allocation,
    recommendations: generateRecommendations(profile, riskProfile),
  };
}

function generateRecommendations(profile, riskProfile) {
  const recommendations = [];

  // Age-based recommendations
  const age = parseInt(profile.age) || 30;
  if (age < 30) {
    recommendations.push({
      type: 'opportunity',
      title: 'Maximize Growth Potential',
      description: 'At your age, you have time on your side. Consider increasing equity allocation to 70-80% for long-term wealth creation.',
    });
  } else if (age > 45) {
    recommendations.push({
      type: 'caution',
      title: 'Focus on Capital Preservation',
      description: 'Consider increasing debt allocation and reducing small-cap exposure to protect your accumulated wealth.',
    });
  }

  // Emergency fund recommendation
  if (!profile.hasEmergencyFund) {
    recommendations.push({
      type: 'urgent',
      title: 'Build Emergency Fund First',
      description: 'Before aggressive investing, build an emergency fund covering 6 months of expenses in a liquid debt fund.',
    });
  }

  // Insurance recommendation
  if (!profile.hasInsurance && profile.dependents > 0) {
    recommendations.push({
      type: 'urgent',
      title: 'Get Insurance Coverage',
      description: 'With dependents, ensure you have adequate life and health insurance to protect your family.',
    });
  }

  // EMI recommendation
  if (profile.hasEMI) {
    recommendations.push({
      type: 'caution',
      title: 'Manage Debt Wisely',
      description: 'High EMIs can impact your investment capacity. Consider prioritizing high-interest debt repayment.',
    });
  }

  // Horizon-based recommendations
  if (profile.investmentHorizon === 'short') {
    recommendations.push({
      type: 'caution',
      title: 'Conservative Approach Recommended',
      description: 'For short-term goals, focus on debt funds and large-cap equity to minimize volatility.',
    });
  } else if (profile.investmentHorizon === 'long') {
    recommendations.push({
      type: 'opportunity',
      title: 'Benefit from Compounding',
      description: 'With a long horizon, small-cap and mid-cap investments can generate significant returns through compounding.',
    });
  }

  // Experience-based recommendations
  if (profile.investmentExperience === 'beginner') {
    recommendations.push({
      type: 'education',
      title: 'Start with Index Funds',
      description: 'Begin with index funds or large-cap mutual funds before exploring individual stocks or small-cap funds.',
    });
  }

  return recommendations;
}
