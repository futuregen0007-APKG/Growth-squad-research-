import { getUpstoxProvider } from './CompanyFinancialsSearchService.js';
import { resolveCompanyForFinancials } from './CompanyFinancialsResolver.js';

// Read-only adapter: use the same normalized statements as company search.
// No numerical cells are merged with historical AI extraction records.
export function annualFactsFromSections(symbol, sections) {
  const facts = [];
  for (const [name, section] of Object.entries(sections)) {
    const data = section?.data;
    if (!section?.available || data?.statementType !== 'CONSOLIDATED' || data?.period !== 'YEARLY' || data?.units !== 'INR_CRORE') continue;
    for (const m of [...(data.metrics || []), ...(name === 'incomeStatement' ? data.epsMetrics || [] : [])]) {
      if (!Number.isFinite(m.value) || !/^FY20\d{2}$/.test(m.financialYear || '')) continue;
      let metric, label, unit = 'INR_CRORE';
      if (name === 'incomeStatement') {
        if (m.verifiedDefinition === 'TOTAL_INCOME' || m.verifiedDefinition === 'REVENUE_FROM_OPERATIONS') { metric = 'REVENUE'; label = m.verifiedLabel; }
        else if (m.verifiedDefinition === 'PROFIT_AFTER_TAX') { metric = 'PAT'; label = 'Profit after tax'; }
        else if (m.verifiedDefinition === 'PROFIT_BEFORE_TAX') { metric = 'PBT'; label = 'Profit before tax'; }
        else if (['eps_basic', 'eps_diluted'].includes(m.label) && m.unit === 'INR_PER_SHARE') { metric = m.label === 'eps_basic' ? 'BASIC_EPS' : 'DILUTED_EPS'; label = m.label === 'eps_basic' ? 'Basic EPS' : 'Diluted EPS'; unit = 'INR_PER_SHARE'; }
        // Profit before tax is not EBITDA or operating profit.
      } else if (name === 'cashFlow') {
        const fields = { operating: ['OPERATING_CASH_FLOW', 'Operating cash flow'], investing: ['INVESTING_CASH_FLOW', 'Investing cash flow'], financing: ['FINANCING_CASH_FLOW', 'Financing cash flow'] };
        [metric, label] = fields[m.label] || [];
      } else if (name === 'balanceSheet') {
        [metric, label] = ({ total_asset: ['TOTAL_ASSETS', 'Total assets'], total_liability: ['TOTAL_LIABILITIES', 'Total liabilities'] })[m.label] || [];
      }
      if (!metric) continue;
      const year = m.financialYear.slice(2);
      facts.push({ symbol, period: m.financialYear, verified: true, dataOrigin: 'REAL_RESEARCH',
        fact: `${label} for the year ended March 31, ${year} (Consolidated).`, title: label,
        metrics: { metric, actualValue: m.value, unit },
        source: { type: 'UPSTOX', url: `https://api.upstox.com/v2/fundamentals/${data.isin}/${name === 'incomeStatement' ? 'income-statement' : name === 'balanceSheet' ? 'balance-sheet' : 'cash-flow'}`, excerpt: `${label}: ${m.value} ${unit} for the year ended March 31, ${year} (Consolidated).` },
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
  const names = ['incomeStatement', 'cashFlow', 'balanceSheet', 'keyRatios'];
  const results = await Promise.allSettled([
    provider.getIncomeStatement(resolved.isin, { symbol }),
    provider.getCashFlow(resolved.isin, { symbol }),
    provider.getBalanceSheet(resolved.isin, { symbol }),
    provider.getKeyRatios(resolved.isin, { symbol }),
  ]);
  const sections = Object.fromEntries(names.map((name, i) => {
    const result = results[i];
    if (result.status !== 'fulfilled') return [name, { available: false, error: { code: result.reason?.errorCode || 'UPSTREAM_UNAVAILABLE', message: 'This Upstox section could not be fetched.' } }];
    const section = { ...result.value, available: Boolean(result.value?.data) };
    const data = section.data;
    if (name !== 'keyRatios' && data) {
      const reason = data.units !== 'INR_CRORE' ? 'UNIT_MISMATCH' : data.statementType !== 'CONSOLIDATED' || data.period !== 'YEARLY' ? 'STATEMENT_BASIS_MISMATCH' : null;
      if (reason) return [name, { ...section, available: false, error: { code: reason, message: 'Figures withheld: this section is not a consolidated annual statement in INR crore.' } }];
    }
    return [name, section];
  }));
  const facts = annualFactsFromSections(symbol, sections);
  return { facts, currentRatios: sections.keyRatios?.available ? sections.keyRatios.data?.ratios || [] : [], provider: 'UPSTOX', status: facts.length ? Object.values(sections).some(s => !s.available) || !facts.some(f => f.metrics.metric === 'REVENUE') || !facts.some(f => f.metrics.metric === 'PAT') ? 'PARTIAL' : 'AVAILABLE' : 'UNAVAILABLE',
    sections: Object.fromEntries(Object.entries(sections).map(([name, s]) => [name, { status: s.available ? 'AVAILABLE' : 'UNAVAILABLE', available: s.available, statementType: s.data?.statementType || null, period: s.data?.period || null, error: s.error || null, fetchedAt: s.data?.fetchedAt || null, fromCache: Boolean(s.fromCache) }])) };
}
