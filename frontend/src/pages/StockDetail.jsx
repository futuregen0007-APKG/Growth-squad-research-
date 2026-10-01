import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Building2, CalendarClock, ExternalLink, FileText, Star, TrendingDown, TrendingUp } from 'lucide-react';
import StockDirectory from '@/components/widgets/StockDirectory';
import { fetchAllStocks, fetchCompanyDetails, fetchHistoricalData, fetchStockBySymbol } from '@/services/stockApi';
import { fetchStockNews } from '@/services/newsApi';

const tabs = [['overview', 'Overview'], ['financials', 'Financials'], ['keyMetrics', 'Key Metrics'], ['shareholding', 'Shareholding'], ['corporateActions', 'Corporate Actions'], ['analystView', 'Analyst View'], ['news', 'News']];
const first = (...values) => values.find((value) => value !== null && value !== undefined && value !== '');
const safeText = (value) => first(value, '—');
const safeNumber = (value) => (value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
const formatMoney = (value) => safeNumber(value) === null ? '—' : `₹${safeNumber(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const formatPercent = (value) => safeNumber(value) === null ? '—' : `${safeNumber(value) >= 0 ? '+' : ''}${safeNumber(value).toFixed(2)}%`;
// Unsigned level (e.g. annualized volatility, always a non-negative
// magnitude) -- never a "+" prefix, which would read as a positive change.
const formatLevel = (value) => safeNumber(value) === null ? '—' : `${safeNumber(value).toFixed(2)}%`;
const normalizeStocks = (stocks) => (Array.isArray(stocks) ? stocks : []).map((item) => ({ ...item, symbol: String(first(item?.symbol, item?.ticker, '')).trim().toUpperCase(), name: first(item?.name, item?.companyName, item?.symbol, item?.ticker, '—') })).filter((item) => item.symbol);

function StateMessage({ children, testId }) {
  return <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-gs-textMuted" data-testid={testId}><AlertCircle className="h-4 w-4 text-gs-textDim" />{children}</div>;
}

function Metric({ label, value }) {
  return <div className="min-w-0 border-l border-gs-border pl-3 first:border-0 first:pl-0"><div className="gs-label truncate">{label}</div><div className="mt-1 truncate font-mono text-sm font-semibold tabular-nums text-gs-text">{safeText(value)}</div></div>;
}

function Field({ label, value }) {
  return <div className="flex justify-between gap-3 border-b border-gs-border/70 py-2 last:border-0"><span className="text-[11px] text-gs-textDim">{label}</span><span className="truncate text-right font-mono text-[11px] text-gs-text">{safeText(value)}</span></div>;
}

function DataRows({ data, label }) {
  if (!Array.isArray(data) || !data.length) return <StateMessage>No {label} data reported by the provider.</StateMessage>;
  return <div className="divide-y divide-gs-border">{data.slice(0, 10).map((entry, index) => <div key={`${entry.period || entry.title || index}`} className="flex justify-between gap-4 py-3"><div className="text-sm text-gs-text">{safeText(entry.title || entry.period || entry.name)}<div className="mt-1 text-[10px] text-gs-textDim">{safeText(entry.date || entry.asOf || entry.period)}</div></div><div className="text-right font-mono text-[11px] text-gs-textMuted">{entry.value ?? entry.status ?? entry.note ?? '—'}</div></div>)}</div>;
}

// ---- Upstox-backed financial statements (details.companyFinancials) ----
// Same data shape and honesty rules as CompanyFinancials.jsx: verified
// labels when present, "(provider-reported, definition unverified)"
// otherwise; every block shows its own source/fetched/cached state; a
// failed section shows its own error, never another provider's figures.
const formatCr = (value) => { const n = safeNumber(value); return n === null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`; };
const formatPerShare = (value) => { const n = safeNumber(value); return n === null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
// Point-in-time ratio: no +/- prefix (see CompanyFinancials.jsx formatRatioValue).
const formatRatioValue = (value, unit) => {
  const n = safeNumber(value);
  if (n === null) return '—';
  return unit === 'PERCENT' ? `${n.toFixed(2)}%` : n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const formatFetchedAt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
};
const fyOrder = (fy) => Number(String(fy || '').replace(/^FY/, '')) || 0;

function SourceLine({ meta, testId }) {
  if (!meta) return null;
  if (meta.status === 'AVAILABLE' && meta.asOf) {
    return <p className="mt-2 text-[10px] text-gs-textDim" data-testid={testId}>Source: Upstox · Fetched {formatFetchedAt(meta.asOf)} ({meta.fromCache ? 'cached' : 'live fetch'}) · {Date.now() - Date.parse(meta.asOf) > 6 * 60 * 60 * 1000 ? 'Fetch older than 6h' : 'Fetched within 6h'}</p>;
  }
  return <p className="mt-2 text-[10px] text-gs-textDim" data-testid={testId}>Source: Upstox · {meta.error?.message || 'Not available for this company right now.'}</p>;
}

/** Pivots flat {label, financialYear, value} rows into one row per metric, one column per fiscal year. */
const pivotRows = (rows) => {
  const groups = new Map();
  for (const row of rows || []) {
    if (!groups.has(row.label)) groups.set(row.label, { label: row.label, rows: [] });
    groups.get(row.label).rows.push(row);
  }
  return [...groups.values()].map((group) => {
    const verifiedLabels = new Set(group.rows.map((r) => r.verifiedLabel).filter(Boolean));
    const allVerified = group.rows.every((r) => r.definitionCheck === 'VERIFIED') && verifiedLabels.size === 1;
    const noneNeeded = group.rows.every((r) => r.definitionCheck === 'NOT_REQUIRED');
    const latest = [...group.rows].sort((a, b) => fyOrder(b.financialYear) - fyOrder(a.financialYear))[0];
    let qualifier = null;
    if (!allVerified && !noneNeeded) qualifier = group.rows.some((r) => r.definitionCheck === 'VERIFIED') ? '(definition unverified for some years)' : '(provider-reported, definition unverified)';
    // operating_profit is only ever shown as Profit before tax; unverified years are already withheld (value null) by the backend.
    if (group.label === 'operating_profit') qualifier = null;
    return {
      label: group.label,
      displayLabel: allVerified ? [...verifiedLabels][0] : (latest?.displayLabel || String(group.label).replace(/_/g, ' ')),
      qualifier,
      byYear: Object.fromEntries(group.rows.map((r) => [r.financialYear, r])),
      hasData: group.rows.some((r) => safeNumber(r.value) !== null),
      withheldReason: group.rows.find((r) => r.withheldReason)?.withheldReason || null,
    };
  });
};

function UnavailableMetrics({ items, testId }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return <div className="mt-2" data-testid={testId}>
    <button type="button" onClick={() => setOpen((value) => !value)} className="font-mono text-[10px] text-gs-gold hover:underline">{open ? 'Hide' : 'Show'} unavailable metrics ({items.length})</button>
    {open && <ul className="mt-2 space-y-1">{items.map((item) => <li key={item.label} className="text-[11px] text-gs-textDim"><span className="text-gs-textMuted">{item.label}:</span> {item.reason}</li>)}</ul>}
  </div>;
}

function StatementBlock({ title, block, showChange, testId }) {
  const status = block?.status || 'UNAVAILABLE';
  const groups = pivotRows(block?.rows);
  const years = [...new Set((block?.rows || []).map((r) => r.financialYear))].sort((a, b) => fyOrder(b) - fyOrder(a));
  const shown = groups.filter((g) => g.hasData);
  const unavailable = [
    ...groups.filter((g) => !g.hasData).map((g) => ({ label: g.displayLabel, reason: g.withheldReason || 'Provider reported no value for any year.' })),
    ...(block?.unavailableMetrics || []).map((m) => ({ label: m.label, reason: m.reason })),
  ];
  return <section className="border border-gs-border bg-gs-panel/20 p-3" data-testid={testId}>
    <div className="flex items-center justify-between"><h3 className="font-display text-sm font-semibold text-gs-text">{title}</h3><span className="font-mono text-[9px] uppercase tracking-wider text-gs-textDim">{status}</span></div>
    {status === 'AVAILABLE' && shown.length > 0 && <div className="mt-2 overflow-x-auto">
      <div className="text-[10px] text-gs-textDim">Annual · {safeText(block.statementType)} · Units: ₹ Cr</div>
      <table className="mt-1 w-full text-[12px]">
        <thead><tr className="text-left text-[10px] text-gs-textDim"><th className="py-1 pr-3 font-normal">Metric</th>{years.map((fy) => <th key={fy} className="py-1 pr-3 text-right font-normal">{fy}</th>)}</tr></thead>
        <tbody className="divide-y divide-gs-border">{shown.map((group) => <tr key={group.label}>
          <td className="py-1.5 pr-3 text-gs-textMuted"><span className="capitalize">{group.displayLabel}</span>{group.qualifier && <span className="ml-1 text-[10px] text-gs-textDim">{group.qualifier}</span>}</td>
          {years.map((fy) => { const cell = group.byYear[fy]; return <td key={fy} className="py-1.5 pr-3 text-right font-mono text-gs-text" title={cell?.withheldReason || undefined}>{formatCr(cell?.value)}{showChange && safeNumber(cell?.changePct) !== null && <div className="text-[10px] text-gs-textDim">{formatPercent(cell.changePct)} YoY</div>}</td>; })}
        </tr>)}</tbody>
      </table>
    </div>}
    {status === 'AVAILABLE' && !shown.length && <p className="mt-2 text-sm text-gs-textMuted">No figures reported by the provider.</p>}
    {status !== 'AVAILABLE' && <p className="mt-2 text-sm text-gs-textMuted">{block?.error?.message || 'Not available from Upstox for this company right now.'}</p>}
    <UnavailableMetrics items={unavailable} testId={`${testId}-unavailable`} />
    <SourceLine meta={block} />
  </section>;
}

function PerShareBlock({ items, meta }) {
  const years = [...new Set((items || []).map((m) => m.financialYear))].sort((a, b) => fyOrder(b) - fyOrder(a));
  const labels = [...new Set((items || []).map((m) => m.label))];
  return <section className="border border-gs-border bg-gs-panel/20 p-3" data-testid="per-share-financials">
    <h3 className="font-display text-sm font-semibold text-gs-text">Per-share</h3>
    {items?.length ? <div className="mt-2 overflow-x-auto"><div className="text-[10px] text-gs-textDim">Annual · CONSOLIDATED · Units: ₹ per share (not ₹ Cr)</div>
      <table className="mt-1 w-full text-[12px]"><thead><tr className="text-left text-[10px] text-gs-textDim"><th className="py-1 pr-3 font-normal">Metric</th>{years.map((fy) => <th key={fy} className="py-1 pr-3 text-right font-normal">{fy}</th>)}</tr></thead>
        <tbody className="divide-y divide-gs-border">{labels.map((label) => { const rows = items.filter((m) => m.label === label); return <tr key={label}><td className="py-1.5 pr-3 text-gs-textMuted">{rows[0].displayLabel}</td>{years.map((fy) => <td key={fy} className="py-1.5 pr-3 text-right font-mono text-gs-text">{formatPerShare(rows.find((m) => m.financialYear === fy)?.value)}</td>)}</tr>; })}</tbody>
      </table></div>
      : <p className="mt-2 text-sm text-gs-textMuted">{meta?.status !== 'AVAILABLE' ? (meta?.error?.message || 'Not available from Upstox right now.') : 'EPS not reported by the provider for this company.'}</p>}
    <SourceLine meta={meta} />
  </section>;
}

function CurrentRatiosBlock({ block }) {
  const ratios = block?.ratios || [];
  return <section className="border border-dashed border-gs-border bg-gs-panel/10 p-3" data-testid="current-ratios">
    <div className="flex items-center justify-between"><h3 className="font-display text-sm font-semibold text-gs-text">Current ratios</h3><span className="font-mono text-[9px] uppercase tracking-wider text-gs-textDim">{block?.status || 'UNAVAILABLE'}</span></div>
    <p className="mt-1 text-[10px] text-gs-textDim">Point-in-time values as of the fetch below — not annual history, and not applied to any past fiscal year.</p>
    {ratios.length > 0 && <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">{ratios.map((r) => <div key={r.name} className="border border-gs-border p-2"><div className="text-[10px] text-gs-textDim">{r.name}</div><div className="font-mono text-sm text-gs-text">{formatRatioValue(r.companyValue, r.companyValueUnit)}</div><div className="text-[10px] text-gs-textDim">Sector: {formatRatioValue(r.sectorValue, r.sectorValueUnit)}</div></div>)}</div>}
    {!ratios.length && <p className="mt-2 text-sm text-gs-textMuted">{block?.error?.message || 'No ratios reported by the provider.'}</p>}
    <SourceLine meta={block} />
  </section>;
}

function CompanyFinancialsPanel({ financials }) {
  if (!financials) return <StateMessage testId="company-financials-panel-missing">Reported financial statements are not available right now.</StateMessage>;
  const annual = financials.annualFinancials || {};
  return <div className="space-y-3" data-testid="company-financials-panel">
    <p className="text-[11px] text-gs-textDim">Financial coverage: <span className="text-gs-text">{safeText(financials.status)}</span>{financials.dataCoveragePct != null ? ` · ${financials.dataCoveragePct}% of statement sections` : ''} · Reported annual statements (source: Upstox), not a real-time quote.</p>
    <StatementBlock title="Income Statement" block={annual.incomeStatement} showChange testId="statement-income" />
    <StatementBlock title="Balance Sheet" block={annual.balanceSheet} testId="statement-balance" />
    <StatementBlock title="Cash Flow" block={annual.cashFlow} testId="statement-cashflow" />
    <PerShareBlock items={financials.perShareFinancials} meta={annual.incomeStatement} />
    <CurrentRatiosBlock block={financials.currentRatios} />
  </div>;
}

const SCORE_METRICS = [['revenueGrowth', 'Revenue growth'], ['profitGrowth', 'Profit growth'], ['quality', 'Quality (ROE)'], ['operatingMargin', 'Operating margin'], ['debtTrend', 'Debt trend'], ['valuation', 'Valuation (P/E)'], ['oneYearReturn', '1Y return'], ['volatility', 'Volatility'], ['maxDrawdown', 'Max drawdown']];

/** Lists every scoring input as used vs missing, so a confidence label always explains itself. */
function ScoreInputs({ ownScore }) {
  if (!ownScore) return null;
  const available = new Set(ownScore.availableMetrics || []);
  const sources = ownScore.inputSources || {};
  return <div className="mt-3" data-testid="score-inputs">
    <div className="text-[11px] text-gs-textDim">Scoring inputs: {available.size} of {ownScore.totalMetrics || SCORE_METRICS.length} available</div>
    <ul className="mt-1 grid gap-1 sm:grid-cols-2">{SCORE_METRICS.map(([key, label]) => <li key={key} className="text-[11px]" data-testid={`score-input-${key}`}>
      <span className={available.has(key) ? 'text-gs-pos' : 'text-gs-textDim'}>{available.has(key) ? 'Used' : 'Missing'}</span>
      <span className="ml-2 text-gs-textMuted">{label}</span>
      {available.has(key) && sources[key] && <span className="ml-1 text-gs-textDim">({sources[key]})</span>}
      <span className="ml-1 text-gs-textDim">Weight: {ownScore.inputWeights?.[key] ?? 0}%</span>
      {!available.has(key) && <span className="ml-1 text-gs-textDim">(no verified value; excluded from the score)</span>}
    </li>)}</ul>
  </div>;
}

export default function StockDetail() {
  const { ticker } = useParams();
  const navigate = useNavigate();
  const symbol = useMemo(() => String(ticker || '').trim().toUpperCase(), [ticker]);
  const [stock, setStock] = useState(null);
  const [details, setDetails] = useState(null);
  const [stocks, setStocks] = useState([]);
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [watchlisted, setWatchlisted] = useState(false);

  useEffect(() => {
    if (!symbol) { setLoading(false); return undefined; }
    let active = true;
    setLoading(true);
    Promise.allSettled([fetchStockBySymbol(symbol), fetchCompanyDetails(symbol), fetchAllStocks(), fetchStockNews(symbol)]).then(([stockResult, detailsResult, stocksResult, newsResult]) => {
      if (!active) return;
      const nextStock = stockResult.status === 'fulfilled' ? stockResult.value : null;
      const nextDetails = detailsResult.status === 'fulfilled' ? detailsResult.value : {};
      setStock(nextStock || { symbol, ticker: symbol, name: symbol });
      setDetails(nextDetails || {});
      setStocks(normalizeStocks(stocksResult.status === 'fulfilled' ? stocksResult.value : []));
      setNews(newsResult.status === 'fulfilled' && Array.isArray(newsResult.value) ? newsResult.value : []);
      if (!nextStock && !nextDetails) setError('Stock data is temporarily unavailable.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [symbol]);

  const company = useMemo(() => {
    const source = details?.company || details?.profile || details || {};
    return {
      name: first(source.companyName, source.name, stock?.companyName, stock?.name, symbol),
      description: first(source.companyDescription, source.description, details?.overview?.description),
      industry: first(source.mgIndustry, source.industry, source.sector, stock?.industry, stock?.sector),
      sector: first(source.sector, stock?.sector),
      isin: first(source.isinId, source.isin, stock?.isin),
      bse: first(source.exchangeCodeBse, source.bseCode, stock?.bseCode),
      nse: first(source.exchangeCodeNse, source.nseCode, stock?.nseCode, symbol),
      provider: first(details?.summaryMetrics?.priceSource, 'Angel One quote / Upstox financials / NSE history'),
      // dataAsOf: the aggregation's own freshness (StockController); timestamp: the live quote's exchange time.
      timestamp: first(stock?.lastUpdate, stock?.lastUpdated, stock?.updatedAt, stock?.timestamp, details?.dataAsOf),
    };
  }, [details, stock, symbol]);

  const selected = useMemo(() => ({ ...stock, ...stocks.find((item) => item.symbol === symbol) }), [stock, stocks, symbol]);
  const research = details?.research || {};
  const tabData = {
    financials: research.financials?.rows,
    keyMetrics: research.keyMetrics?.entries,
    shareholding: research.shareholding?.data,
    corporateActions: research.corporateActions?.data,
    analystView: research.analystData,
  };
  const selectStock = (nextSymbol) => navigate(`/stock/${encodeURIComponent(String(nextSymbol).trim().toUpperCase())}`);

  if (!symbol) return <StateMessage testId="stock-detail-invalid">No stock selected. Choose a symbol from the directory.</StateMessage>;
  if (loading && !stock && !details) return <div className="space-y-4 animate-pulse" data-testid="stock-detail-loading"><div className="h-36 rounded-sm border border-gs-border bg-gs-card" /><div className="h-[560px] rounded-sm border border-gs-border bg-gs-card" /></div>;

  return <div className="space-y-4" data-testid="stock-detail-page">
    <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim hover:text-gs-text"><ArrowLeft className="h-3.5 w-3.5" /> Back to research</button>
    <header className="gs-card overflow-hidden border-t-2 border-t-gs-gold/60">
      <div className="flex flex-col gap-5 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-2xl font-bold tracking-[0.12em] text-gs-text">{symbol}</span><span className="border border-gs-border bg-gs-panel px-2 py-1 font-mono text-[9px] text-gs-textDim">NSE / BSE</span><span className="text-[11px] text-gs-textDim">{safeText(company.industry || company.sector)}</span></div><h1 className="mt-1 truncate font-display text-lg font-semibold text-gs-text sm:text-xl">{safeText(company.name)}</h1><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-gs-textDim"><span>NSE {safeText(company.nse)}</span><span>BSE {safeText(company.bse)}</span><span>ISIN {safeText(company.isin)}</span></div></div>
        <div className="flex items-center gap-5"><div><div className="gs-label">Current price</div><div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-gs-text">{formatMoney(first(selected.price, selected.lastPrice))}</div><div className={`mt-1 flex items-center gap-1 font-mono text-xs ${safeNumber(first(selected.changePct, selected.percentageChange)) >= 0 ? 'text-gs-pos' : 'text-gs-neg'}`}>{safeNumber(first(selected.changePct, selected.percentageChange)) >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{formatPercent(first(selected.changePct, selected.percentageChange))}</div></div><button type="button" onClick={() => navigate(`/company-financials/${encodeURIComponent(symbol)}`)} className="flex h-9 items-center gap-2 border border-gs-border px-3 font-mono text-[10px] uppercase tracking-wider text-gs-textDim hover:text-gs-text"><FileText className="h-3.5 w-3.5" />Financial statements</button><button type="button" onClick={() => setWatchlisted((value) => !value)} className={`flex h-9 items-center gap-2 border px-3 font-mono text-[10px] uppercase tracking-wider ${watchlisted ? 'border-gs-gold text-gs-gold' : 'border-gs-border text-gs-textDim'}`}><Star className={`h-3.5 w-3.5 ${watchlisted ? 'fill-current' : ''}`} />{watchlisted ? 'Watching' : 'Watchlist'}</button></div>
      </div>
      <div className="grid gap-2 border-t border-gs-border bg-gs-panel/40 px-4 py-2.5 text-[10px] text-gs-textDim sm:grid-cols-3 sm:px-5"><div className="flex items-center gap-2"><Building2 className="h-3.5 w-3.5" />Provider: <span className="text-gs-text">{safeText(company.provider)}</span></div><div className="flex items-center gap-2"><CalendarClock className="h-3.5 w-3.5" />Updated: <span className="text-gs-text" data-testid="stock-detail-updated">{formatFetchedAt(company.timestamp)}</span></div><div className="sm:text-right">{error || 'Live quote and research view'}</div></div>
    </header>

    <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]"><aside className="lg:sticky lg:top-4"><StockDirectory stocks={stocks.length ? stocks : [selected]} selectedSymbol={symbol} onSelect={selectStock} sortMode="name" onSortModeChange={() => {}} /></aside><main className="min-w-0 space-y-4">
      <div className="gs-card grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 lg:grid-cols-7"><Metric label="Market cap" value={selected.marketCap || details?.marketCap} /><Metric label="P/E" value={safeNumber(details?.pe) === null ? '—' : `${safeNumber(details?.pe).toFixed(1)}x`} /><Metric label="52W high" value={formatMoney(first(selected.fiftyTwoWeekHigh, selected.week52High, details?.fiftyTwoWeekHigh))} /><Metric label="52W low" value={formatMoney(first(selected.fiftyTwoWeekLow, selected.week52Low, details?.fiftyTwoWeekLow))} /><Metric label="1Y return" value={formatPercent(first(details?.annualizedReturn, details?.oneYearReturn))} /><Metric label="Volatility" value={formatLevel(details?.volatility)} /><Metric label="Max drawdown" value={formatPercent(details?.maxDrawdown)} /></div>
      <div className="gs-card overflow-hidden"><div className="flex gap-1 overflow-x-auto border-b border-gs-border bg-gs-panel/40 p-2">{tabs.map(([value, label]) => <button type="button" key={value} onClick={() => setActiveTab(value)} className={`shrink-0 px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${activeTab === value ? 'bg-gs-card text-gs-gold' : 'text-gs-textDim hover:text-gs-text'}`}>{label}</button>)}</div><div className="p-4 sm:p-5">
        {activeTab === 'overview' && <div className="space-y-4"><div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_250px]"><section className="border-l-2 border-l-gs-gold/60 pl-4"><div className="gs-label">About Company</div><p className="mt-2 line-clamp-4 max-w-3xl text-sm leading-6 text-gs-textMuted">{safeText(company.description)}</p><button type="button" className="mt-2 text-[11px] font-mono text-gs-gold hover:underline">Read more</button><SourceLine meta={details?.companyFinancials?.profile} testId="overview-description-source" /></section><section className="border border-gs-border bg-gs-panel/30 p-3"><Field label="Industry" value={company.industry} /><Field label="Sector" value={company.sector} /><Field label="ISIN" value={company.isin} /><Field label="NSE Symbol" value={company.nse} /><Field label="BSE Code" value={company.bse} /></section></div><StateMessage>Price history is available from the provider on the live chart surface.</StateMessage></div>}
        {activeTab === 'financials' && <div className="space-y-4">
          <CompanyFinancialsPanel financials={details?.companyFinancials} />

        </div>}
        {activeTab === 'keyMetrics' && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{(tabData.keyMetrics || []).slice(0, 24).map((entry) => <Metric key={entry.label} label={entry.label} value={entry.value} />)}{!(tabData.keyMetrics || []).length && <StateMessage>No key metrics data reported by the provider.</StateMessage>}</div>}
        {activeTab === 'shareholding' && <DataRows data={tabData.shareholding} label="shareholding" />}
        {activeTab === 'corporateActions' && <DataRows data={tabData.corporateActions} label="corporate action" />}
        {activeTab === 'analystView' && <div className="space-y-4">
          <section className="border border-gs-border bg-gs-panel/30 p-3">
            <div className="gs-label">This project's growth potential &amp; quality score</div>
            {tabData.analystView?.ownScore?.score != null
              ? <div className="mt-3 flex flex-wrap items-baseline gap-4"><div className="font-mono text-3xl font-semibold text-gs-gold">{tabData.analystView.ownScore.score}<span className="text-sm text-gs-textDim">/100</span></div><div className="text-sm text-gs-text">{tabData.analystView.ownScore.scoreLabel}</div></div>
              : <StateMessage>Insufficient verified metrics to compute a score for this stock yet.</StateMessage>}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Field label="Risk level" value={tabData.analystView?.ownScore?.riskLabel} />
              <Field label="Data coverage" value={tabData.analystView?.ownScore?.dataCoveragePct != null ? `${tabData.analystView.ownScore.dataCoveragePct}%` : null} />
              <Field label="Confidence" value={tabData.analystView?.ownScore?.confidence ? `${tabData.analystView.ownScore.confidence} (${(tabData.analystView.ownScore.availableMetrics || []).length} of ${tabData.analystView.ownScore.totalMetrics || SCORE_METRICS.length} verified inputs)` : null} />
              <Field label="Score status" value={tabData.analystView?.ownScore?.scoreStatus} />
            </div>
            <ScoreInputs ownScore={tabData.analystView?.ownScore} />
            <p className="mt-3 text-[11px] leading-5 text-gs-textDim">{tabData.analystView?.ownScore?.methodology}</p>
          </section>
          {tabData.analystView?.providerAnalystData?.available && <section className="border border-gs-border bg-gs-panel/30 p-3"><div className="gs-label">Third-party analyst data (provider)</div><p className="mt-2 text-[11px] text-gs-textDim">{tabData.analystView.providerAnalystData.data?.note}</p></section>}
          {!tabData.analystView?.providerAnalystData?.available && <StateMessage>No third-party analyst data reported by the provider.</StateMessage>}
        </div>}
        {activeTab === 'news' && <div className="grid gap-3 md:grid-cols-2">{news.length ? news.slice(0, 8).map((article, index) => <a key={article.url || article.sourceUrl || index} href={article.url || article.sourceUrl} target="_blank" rel="noreferrer" className="border border-gs-border bg-gs-panel/30 p-3 hover:border-gs-gold/50"><div className="mb-2 flex justify-between text-[10px] text-gs-textDim">News <ExternalLink className="h-3 w-3" /></div><div className="text-sm text-gs-text">{safeText(article.title || article.headline)}</div></a>) : <StateMessage>No recent news available.</StateMessage>}</div>}
      </div></div>
    </main></div>
  </div>;
}
