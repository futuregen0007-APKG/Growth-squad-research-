import { getUpstoxProvider } from './CompanyFinancialsSearchService.js';
import { resolveCompanyForFinancials } from './CompanyFinancialsResolver.js';

// Read-only adapter: use the same normalized statements as company search.
// No numerical cells are merged with historical AI extraction records.
export function annualFactsFromSections(symbol, sections) {
  const facts = [];
  for (const [name, section] of Object.entries(sections)) {
    const data = section?.data;
    if (!section?.available || data?.statementType !== 'CONSOLIDATED' || data?.period !== 'YEARLY' || data?.units !== 'INR_CRORE') continue;
    for (const m of data.metrics || []) {
      if (!Number.isFinite(m.value) || !/^FY20\d{2}$/.test(m.financialYear || '')) continue;
      let metric, label;
      if (name === 'incomeStatement') {
        if (m.verifiedDefinition === 'TOTAL_INCOME' || m.verifiedDefinition === 'REVENUE_FROM_OPERATIONS') { metric = 'REVENUE'; label = m.verifiedLabel; }
        else if (m.verifiedDefinition === 'PROFIT_AFTER_TAX') { metric = 'PAT'; label = 'Profit after tax'; }
        // Profit before tax is not EBITDA or operating profit.
      } else if (name === 'cashFlow' && m.label === 'operating') { metric = 'OPERATING_CASH_FLOW'; label = 'Operating cash flow'; }
      if (!metric) continue;
      const year = m.financialYear.slice(2);
      facts.push({ symbol, period: m.financialYear, verified: true, dataOrigin: 'REAL_RESEARCH',
        fact: `${label} for the year ended March 31, ${year} (Consolidated).`, title: label,
        metrics: { metric, actualValue: m.value, unit: 'INR_CRORE' },
        source: { type: 'UPSTOX', url: `https://api.upstox.com/v2/fundamentals/${data.isin}/${name === 'incomeStatement' ? 'income-statement' : 'cash-flow'}`, excerpt: `${label}: ${m.value} INR_CRORE for the year ended March 31, ${year} (Consolidated).` },
      });
    }
  }
  return facts;
}

export async function loadEarningsAnnualFinancials(symbol) {
  const provider = getUpstoxProvider();
  if (!provider.isConfigured) return { facts: [], status: 'UNAVAILABLE', reason: 'CONFIGURATION_ERROR', provider: 'UPSTOX' };
  const resolved = await resolveCompanyForFinancials(symbol);
  if (resolved.status !== 'RESOLVED') return { facts: [], status: 'UNAVAILABLE', reason: resolved.status, provider: 'UPSTOX' };
  const names = ['incomeStatement', 'cashFlow'];
  const results = await Promise.allSettled([
    provider.getIncomeStatement(resolved.isin, { symbol }),
    provider.getCashFlow(resolved.isin, { symbol }),
  ]);
  const sections = Object.fromEntries(names.map((name, i) => [name, results[i].status === 'fulfilled' ? { ...results[i].value, available: Boolean(results[i].value?.data) } : { available: false, error: results[i].reason?.errorCode || 'UPSTREAM_UNAVAILABLE' }]));
  const facts = annualFactsFromSections(symbol, sections);
  return { facts, provider: 'UPSTOX', status: facts.length ? Object.values(sections).some(s => !s.available) || !facts.some(f => f.metrics.metric === 'REVENUE') || !facts.some(f => f.metrics.metric === 'PAT') ? 'PARTIAL' : 'AVAILABLE' : 'UNAVAILABLE',
    sections: Object.fromEntries(Object.entries(sections).map(([name, s]) => [name, { available: s.available, error: s.error || null, fetchedAt: s.data?.fetchedAt || null, fromCache: Boolean(s.fromCache) }])) };
}
