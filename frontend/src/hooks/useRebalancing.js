export function analyzeRebalance(holdings) {
  if (!Array.isArray(holdings) || holdings.length === 0) return [];

  const total = holdings.reduce((s, h) => s + (h.currentValue || 0), 0) || 1;
  const alerts = [];

  // Sector concentration
  const sectorAgg = holdings.reduce((acc, h) => {
    const sector = h.sector || 'Other';
    acc[sector] = (acc[sector] || 0) + (h.currentValue || 0);
    return acc;
  }, {});

  Object.entries(sectorAgg).forEach(([sector, value]) => {
    const pct = (value / total) * 100;
    if (pct > 40) {
      alerts.push({
        id: `sector-${sector}`,
        type: 'sector_concentration',
        message: `Your portfolio is ${Math.round(pct)}% allocated to ${sector}. Consider rebalancing to reduce sector concentration.`,
      });
    }
  });

  // Single holding concentration
  holdings.forEach((h) => {
    const pct = ((h.currentValue || 0) / total) * 100;
    if (pct > 30) {
      alerts.push({
        id: `holding-${h.symbol}`,
        type: 'holding_concentration',
        message: `${h.symbol} represents ${Math.round(pct)}% of your portfolio. Consider trimming this position to diversify risk.`,
      });
    }
  });

  return alerts;
}

export default analyzeRebalance;
