import { useState } from 'react';

const fields = [
  ['revenue', 'Income', '₹ Cr', 'incomeStatement'], ['pbt', 'Profit before tax', '₹ Cr', 'incomeStatement'],
  ['pat', 'Profit after tax', '₹ Cr', 'incomeStatement'],
  ['basicEps', 'Basic EPS', '₹ / share', 'incomeStatement'], ['dilutedEps', 'Diluted EPS', '₹ / share', 'incomeStatement'],
  ['totalAssets', 'Total assets', '₹ Cr', 'balanceSheet'], ['totalLiabilities', 'Total liabilities', '₹ Cr', 'balanceSheet'],
  ['operatingCashFlow', 'Operating cash flow', '₹ Cr', 'cashFlow'], ['investingCashFlow', 'Investing cash flow', '₹ Cr', 'cashFlow'],
  ['financingCashFlow', 'Financing cash flow', '₹ Cr', 'cashFlow'],
  ['ebitda', 'EBITDA', '₹ Cr', 'incomeStatement', 'No verified EBITDA breakdown; profit before tax is not EBITDA.'],
  ['ebitdaMargin', 'EBITDA margin', '%', 'incomeStatement', 'Requires verified EBITDA and an explicit revenue denominator.'],
  ['adjustedPat', 'Adjusted PAT', '₹ Cr', 'incomeStatement', 'No sourced adjustment definition.'],
  ['freeCashFlow', 'Free cash flow', '₹ Cr', 'cashFlow', 'Requires verified capital expenditure; investing cash flow is not CapEx.'],
  ['debt', 'Total debt', '₹ Cr', 'balanceSheet', 'Borrowings not mapped; liabilities and bank deposits are not debt.'],
  ['roe', 'Historical ROE', '%', 'keyRatios', 'Provider ratios are current observations, not historical annual values.'],
  ['roce', 'Historical ROCE', '%', 'keyRatios', 'Provider ratios are current observations, not historical annual values.'],
];
const format = value => Number.isFinite(value) ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'N/A';

const freshness = iso => {
  const time = Date.parse(iso);
  return !Number.isFinite(time) ? 'freshness unknown' : Date.now() - time > 6 * 60 * 60 * 1000 ? 'fetch older than 6h' : 'fetched within 6h';
};

function Source({ section }) {
  return <span className="text-[10px] text-gs-textDim">Upstox · {section?.status || (section?.available ? 'AVAILABLE' : 'UNAVAILABLE')} · {section?.fetchedAt ? `Fetched ${new Date(section.fetchedAt).toLocaleString('en-IN')}` : 'Fetch time unavailable'} · {section?.fromCache ? 'cached' : section?.fetchedAt ? 'upstream fetch' : 'not fetched'} · {freshness(section?.fetchedAt)}</span>;
}

export default function AnnualFinancialHistory({ snapshot = {}, metadata = {} }) {
  const [showUnavailable, setShowUnavailable] = useState(false);
  const series = snapshot.annualSeries || [];
  const available = fields.filter(([key]) => series.some(row => Number.isFinite(row[key])));
  const unavailable = fields.filter(([key]) => !series.some(row => Number.isFinite(row[key])));
  const visible = showUnavailable ? fields : available;
  const ratioUnit = (value, unit) => Number.isFinite(value) ? `${value}${unit === 'PERCENT' ? '%' : ''}` : 'N/A';
  return <div className="space-y-4" data-testid="annual-financial-history">
    <p className="text-xs text-gs-textDim">Consolidated annual statements. PAT is consolidated profit after tax, which can differ from profit attributable to owners. EPS is reported per share; past figures may reflect a different share count.</p>
    {series.length ? <div className="overflow-x-auto"><table className="w-full text-xs font-mono border-collapse">
      <thead><tr><th className="p-3 text-left">Metric</th>{series.map(row => <th key={row.year} className="p-3 text-right text-gs-gold">{row.period}</th>)}</tr></thead>
      <tbody>{visible.map(([key, label, unit, source, reason]) => <tr key={key} className="border-t border-gs-border">
        <td className="p-3 text-left">{key === 'revenue' ? snapshot.revenueLabel || label : key === 'pat' ? snapshot.patLabel || label : label} ({unit})<div><Source section={metadata.sections?.[source]} /></div>
          {!available.some(([field]) => field === key) && <div className="mt-1 text-gs-textDim">{metadata.sections?.[source]?.error?.message || (typeof metadata.sections?.[source]?.error === 'string' ? metadata.sections[source].error : null) || reason || 'Not reported with verified units, period and statement basis.'}</div>}
        </td>{series.map(row => <td key={row.year} className="p-3 text-right">{format(row[key])}</td>)}
      </tr>)}</tbody>
    </table></div> : <p>No verified consolidated annual statements are available. {metadata.reason || ''}</p>}
    {unavailable.length > 0 && <button type="button" className="text-xs text-gs-gold" onClick={() => setShowUnavailable(value => !value)}>{showUnavailable ? 'Hide unavailable metrics' : `Show unavailable metrics (${unavailable.length})`}</button>}
    <section className="border-t border-gs-border pt-3" data-testid="earnings-current-ratios">
      <h4 className="text-sm font-semibold">Current company ratios</h4>
      <p className="text-xs text-gs-textDim">Provider-reported point-in-time observations; not assigned to past fiscal years. Fetch time is not the reporting period.</p>
      <Source section={metadata.sections?.keyRatios} />
      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">{(metadata.currentRatios || []).map(r => <div key={r.name} className="text-xs"><span className="text-gs-textDim">{r.name}</span><div>{ratioUnit(r.companyValue, r.companyValueUnit)}</div></div>)}</div>
      {!(metadata.currentRatios || []).length && <p className="text-xs">No current ratios available from Upstox.</p>}
    </section>
  </div>;
}
