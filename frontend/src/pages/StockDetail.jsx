import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Building2, CalendarClock, ExternalLink, Star, TrendingDown, TrendingUp } from 'lucide-react';
import StockDirectory from '@/components/widgets/StockDirectory';
import { fetchAllStocks, fetchCompanyDetails, fetchHistoricalData, fetchStockBySymbol } from '@/services/stockApi';
import { fetchStockNews } from '@/services/newsApi';

const tabs = [['overview', 'Overview'], ['financials', 'Financials'], ['keyMetrics', 'Key Metrics'], ['shareholding', 'Shareholding'], ['corporateActions', 'Corporate Actions'], ['analystView', 'Analyst View'], ['news', 'News']];
const first = (...values) => values.find((value) => value !== null && value !== undefined && value !== '');
const safeText = (value) => first(value, '—');
const safeNumber = (value) => (value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
const formatMoney = (value) => safeNumber(value) === null ? '—' : `₹${safeNumber(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const formatPercent = (value) => safeNumber(value) === null ? '—' : `${safeNumber(value) >= 0 ? '+' : ''}${safeNumber(value).toFixed(2)}%`;
const normalizeStocks = (stocks) => (Array.isArray(stocks) ? stocks : []).map((item) => ({ ...item, symbol: String(first(item?.symbol, item?.ticker, '')).trim().toUpperCase(), name: first(item?.name, item?.companyName, item?.symbol, item?.ticker, '—') })).filter((item) => item.symbol);

function StateMessage({ children }) {
  return <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-gs-textMuted"><AlertCircle className="h-4 w-4 text-gs-textDim" />{children}</div>;
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
      provider: first(details?.provider, details?.dataProvider, details?.source, 'Market data provider'),
      timestamp: first(details?.updatedAt, details?.lastUpdated, stock?.updatedAt, stock?.lastUpdated),
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

  if (!symbol) return <StateMessage>No stock selected. Choose a symbol from the directory.</StateMessage>;
  if (loading && !stock && !details) return <div className="space-y-4 animate-pulse" data-testid="stock-detail-loading"><div className="h-36 rounded-sm border border-gs-border bg-gs-card" /><div className="h-[560px] rounded-sm border border-gs-border bg-gs-card" /></div>;

  return <div className="space-y-4" data-testid="stock-detail-page">
    <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim hover:text-gs-text"><ArrowLeft className="h-3.5 w-3.5" /> Back to research</button>
    <header className="gs-card overflow-hidden border-t-2 border-t-gs-gold/60">
      <div className="flex flex-col gap-5 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-2xl font-bold tracking-[0.12em] text-gs-text">{symbol}</span><span className="border border-gs-border bg-gs-panel px-2 py-1 font-mono text-[9px] text-gs-textDim">NSE / BSE</span><span className="text-[11px] text-gs-textDim">{safeText(company.industry || company.sector)}</span></div><h1 className="mt-1 truncate font-display text-lg font-semibold text-gs-text sm:text-xl">{safeText(company.name)}</h1><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-gs-textDim"><span>NSE {safeText(company.nse)}</span><span>BSE {safeText(company.bse)}</span><span>ISIN {safeText(company.isin)}</span></div></div>
        <div className="flex items-center gap-5"><div><div className="gs-label">Current price</div><div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-gs-text">{formatMoney(first(selected.price, selected.lastPrice))}</div><div className={`mt-1 flex items-center gap-1 font-mono text-xs ${safeNumber(first(selected.changePct, selected.percentageChange)) >= 0 ? 'text-gs-pos' : 'text-gs-neg'}`}>{safeNumber(first(selected.changePct, selected.percentageChange)) >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{formatPercent(first(selected.changePct, selected.percentageChange))}</div></div><button type="button" onClick={() => setWatchlisted((value) => !value)} className={`flex h-9 items-center gap-2 border px-3 font-mono text-[10px] uppercase tracking-wider ${watchlisted ? 'border-gs-gold text-gs-gold' : 'border-gs-border text-gs-textDim'}`}><Star className={`h-3.5 w-3.5 ${watchlisted ? 'fill-current' : ''}`} />{watchlisted ? 'Watching' : 'Watchlist'}</button></div>
      </div>
      <div className="grid gap-2 border-t border-gs-border bg-gs-panel/40 px-4 py-2.5 text-[10px] text-gs-textDim sm:grid-cols-3 sm:px-5"><div className="flex items-center gap-2"><Building2 className="h-3.5 w-3.5" />Provider: <span className="text-gs-text">{safeText(company.provider)}</span></div><div className="flex items-center gap-2"><CalendarClock className="h-3.5 w-3.5" />Updated: <span className="text-gs-text">{company.timestamp ? new Date(company.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</span></div><div className="sm:text-right">{error || 'Live quote and research view'}</div></div>
    </header>

    <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]"><aside className="lg:sticky lg:top-4"><StockDirectory stocks={stocks.length ? stocks : [selected]} selectedSymbol={symbol} onSelect={selectStock} sortMode="name" onSortModeChange={() => {}} /></aside><main className="min-w-0 space-y-4">
      <div className="gs-card grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 lg:grid-cols-7"><Metric label="Market cap" value={selected.marketCap || details?.marketCap} /><Metric label="P/E" value={safeNumber(first(selected.pe, details?.pe)) === null ? '—' : `${safeNumber(first(selected.pe, details?.pe)).toFixed(1)}x`} /><Metric label="52W high" value={formatMoney(first(selected.fiftyTwoWeekHigh, selected.week52High, details?.fiftyTwoWeekHigh))} /><Metric label="52W low" value={formatMoney(first(selected.fiftyTwoWeekLow, selected.week52Low, details?.fiftyTwoWeekLow))} /><Metric label="1Y return" value={formatPercent(first(details?.annualizedReturn, details?.oneYearReturn))} /><Metric label="Volatility" value={formatPercent(details?.volatility)} /><Metric label="Max drawdown" value={formatPercent(details?.maxDrawdown)} /></div>
      <div className="gs-card overflow-hidden"><div className="flex gap-1 overflow-x-auto border-b border-gs-border bg-gs-panel/40 p-2">{tabs.map(([value, label]) => <button type="button" key={value} onClick={() => setActiveTab(value)} className={`shrink-0 px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${activeTab === value ? 'bg-gs-card text-gs-gold' : 'text-gs-textDim hover:text-gs-text'}`}>{label}</button>)}</div><div className="p-4 sm:p-5">
        {activeTab === 'overview' && <div className="space-y-4"><div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_250px]"><section className="border-l-2 border-l-gs-gold/60 pl-4"><div className="gs-label">About Company</div><p className="mt-2 line-clamp-4 max-w-3xl text-sm leading-6 text-gs-textMuted">{safeText(company.description)}</p><button type="button" className="mt-2 text-[11px] font-mono text-gs-gold hover:underline">Read more</button></section><section className="border border-gs-border bg-gs-panel/30 p-3"><Field label="Industry" value={company.industry} /><Field label="Sector" value={company.sector} /><Field label="ISIN" value={company.isin} /><Field label="NSE Symbol" value={company.nse} /><Field label="BSE Code" value={company.bse} /></section></div><StateMessage>Price history is available from the provider on the live chart surface.</StateMessage></div>}
        {activeTab === 'financials' && <DataRows data={tabData.financials} label="financial" />}
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
              <Field label="Confidence" value={tabData.analystView?.ownScore?.confidence} />
              <Field label="Verified metrics used" value={(tabData.analystView?.ownScore?.availableMetrics || []).join(', ')} />
            </div>
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
