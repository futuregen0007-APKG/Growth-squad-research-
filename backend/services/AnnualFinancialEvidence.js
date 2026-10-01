// Read-time gate: preserve source records for review, but never use contradictory
// extracted metadata in an annual financial table or a derived score.
export function assessAnnualFact(fact) {
  const metric = String(fact.metrics?.metric || '').toUpperCase();
  const text = [fact.title, fact.fact, fact.source?.excerpt].filter(Boolean).join(' ');
  const sourceText = `${text} ${fact.source?.title || ''}`;
  const period = String(fact.period || '');
  const year = Number(period.match(/(?:FY)?(20\d{2})/)?.[1] || (period.match(/FY(\d{2})\b/i)?.[1] ? `20${period.match(/FY(\d{2})\b/i)[1]}` : 0));
  const reject = reason => ({ eligible: false, reason });
  if (fact.quarantine?.quarantined || fact.dataOrigin === 'SEEDED_DEMO' || fact.verified === false) return reject('UNVERIFIED_OR_QUARANTINED');
  if (!year || /(?:\bQ[1-4]|\bH[12]|\b[1-9]M)(?=FY|\b)/i.test(fact.period || '')) return reject('SUB_YEAR_PERIOD');
  if (/\b(?:quarter|three months|six months|nine months)\s+ended\b/i.test(text)) return reject('SUB_YEAR_SOURCE');
  const context = text.match(/context\s+\w+\s+(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/i);
  let annualEvidence = false;
  if (context) {
    const days = (Date.parse(context[2]) - Date.parse(context[1])) / 86400000;
    if (days < 350 || days > 370) return reject('SUB_YEAR_SOURCE');
    if (Number(context[2].slice(0, 4)) !== year) return reject('REPORTING_YEAR_MISMATCH');
    annualEvidence = true;
  }
  const ended = sourceText.match(/(?:year|as at)\s+(?:ended\s+)?(?:March\s+31,?\s+|31\s+March\s+)(20\d{2})/i);
  if (ended) {
    if (Number(ended[1]) !== year) return reject('REPORTING_YEAR_MISMATCH');
    annualEvidence = true;
  }
  // A source-backed numerical fact needs reporting-period evidence, not just
  // the extraction's own FY tag. Structured callers without a source retain
  // their existing contract; they are not advertised as primary-source verified.
  if (fact.source?.url && !annualEvidence) return reject('ANNUAL_PERIOD_UNVERIFIED');
  const monetary = !/^(EPS|BASIC_EPS|DILUTED_EPS|ROE|ROCE|NIM|GNPA|.*MARGIN)$/.test(metric);
  if (monetary && /\b(?:lac|lacs|lakh|lakhs)\b/i.test(text) && fact.metrics?.unit === 'INR_CRORE') return reject('SOURCE_UNIT_MISMATCH');
  if (/^(DEBT|TOTAL_DEBT|BORROWINGS|NET_DEBT)$/.test(metric) && /\bdeposits?\b/i.test(text)) return reject('DEPOSITS_ARE_NOT_DEBT');
  const unit = fact.metrics?.unit || (monetary ? 'INR_CRORE' : /EPS/.test(metric) ? 'INR' : 'PERCENTAGE');
  if (monetary && unit !== 'INR_CRORE') return reject('UNIT_UNVERIFIED');
  if (monetary && fact.source?.url && !context && !/\b(?:crore|crores|INR_CRORE)\b/i.test(fact.source?.excerpt || '')) return reject('SOURCE_UNIT_UNVERIFIED');
  const basis = /\bconsolidated\b/i.test(fact.fact || '') ? 'CONSOLIDATED' : /\bstandalone\b/i.test(fact.fact || '') ? 'STANDALONE' : 'UNKNOWN';
  let definition = metric;
  if (/^(REVENUE|TOTAL_REVENUE|TURNOVER)$/.test(metric)) definition = /\btotal income\b/i.test(text) ? 'TOTAL_INCOME' : /revenue from operations/i.test(text) ? 'REVENUE_FROM_OPERATIONS' : fact.source?.url ? 'UNVERIFIED_REVENUE' : 'REVENUE';
  if (/^(PAT|NET_PROFIT|PROFIT_AFTER_TAX)$/.test(metric)) definition = /attributable.*(?:owners|shareholders|group)/i.test(text) ? 'PROFIT_ATTRIBUTABLE_TO_OWNERS' : /XBRL tag ProfitLossForThePeriod/i.test(text) ? 'PROFIT_FOR_PERIOD' : fact.source?.url && basis === 'UNKNOWN' ? 'UNVERIFIED_PAT' : 'PROFIT_AFTER_TAX';
  if (/^(EPS|DILUTED_EPS)$/.test(metric)) definition = /\bbasic\b/i.test(text) ? 'BASIC_EPS' : /\bdiluted\b/i.test(text) ? 'DILUTED_EPS' : 'UNVERIFIED_EPS';
  // Annual XBRL context and explicit statement basis are stronger evidence
  // than an unstructured extracted FY label. No insertion-order precedence.
  const priority = (context ? 2 : annualEvidence ? 1 : 0) + (basis !== 'UNKNOWN' ? 1 : 0);
  return { eligible: true, year, unit, basis, definition, priority };
}

export function selectAnnualFacts(facts) {
  const rejected = [];
  const candidates = [];
  for (const fact of facts) {
    if (fact.metrics?.actualValue == null || !Number.isFinite(Number(fact.metrics.actualValue)) || !fact.metrics?.metric) continue;
    const assessment = assessAnnualFact(fact);
    if (!assessment.eligible) {
      if (assessment.reason !== 'SUB_YEAR_PERIOD') rejected.push({ id: String(fact._id || ''), metric: fact.metrics.metric, period: fact.period, reason: assessment.reason });
    }
    else candidates.push({ fact, ...assessment });
  }
  // Use one statement basis per metric across years, preferring consolidated
  // when present. Never combine standalone and consolidated in a growth rate.
  const canonical = m => ({ TOTAL_REVENUE: 'REVENUE', TURNOVER: 'REVENUE', NET_PROFIT: 'PAT', PROFIT_AFTER_TAX: 'PAT', TOTAL_DEBT: 'DEBT', BORROWINGS: 'DEBT', CASH_FLOW_OPERATIONS: 'OPERATING_CASH_FLOW', FCF: 'FREE_CASH_FLOW' }[m] || m);
  const metricBasis = new Map();
  for (const c of candidates) {
    c.metric = canonical(String(c.fact.metrics.metric).toUpperCase());
    const old = metricBasis.get(c.metric);
    if (!old || ['UNKNOWN', 'STANDALONE', 'CONSOLIDATED'].indexOf(c.basis) > ['UNKNOWN', 'STANDALONE', 'CONSOLIDATED'].indexOf(old)) metricBasis.set(c.metric, c.basis);
  }
  const groups = new Map();
  for (const c of candidates) {
    if (c.basis !== metricBasis.get(c.metric)) { rejected.push({ metric: c.metric, period: c.fact.period, reason: 'STATEMENT_BASIS_MISMATCH' }); continue; }
    const key = `${c.metric}:${c.year}`;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  const selected = [];
  for (const group of groups.values()) {
    const priority = Math.max(...group.map(c => c.priority));
    const best = group.filter(c => c.priority === priority);
    const signatures = new Set(best.map(c => JSON.stringify([Number(c.fact.metrics.actualValue), c.unit, c.definition])));
    if (signatures.size > 1) {
      rejected.push({ metric: best[0].metric, period: best[0].fact.period, reason: 'CONFLICTING_ANNUAL_VALUES' });
      continue;
    }
    best.sort((a, b) => String(a.fact.source?.url || '').localeCompare(String(b.fact.source?.url || '')) || String(a.fact._id || '').localeCompare(String(b.fact._id || '')));
    const c = best[0];
    selected.push({ ...c.fact, annualEvidence: { basis: c.basis, definition: c.definition, unit: c.unit }, metrics: { ...c.fact.metrics, metric: c.metric } });
  }
  return { selected, rejected };
}
