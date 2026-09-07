import { useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useMarketStatus } from "@/hooks/useMarketStatus";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { ArrowUpRight, Sparkles, Newspaper, AlertCircle, TrendingUp, TrendingDown } from "lucide-react";
import KPITile from "@/components/widgets/KPITile";
import { fetchAllStocks, fetchIndexQuotes, fetchHistoricalData, fetchSectorRotation } from "@/services/stockApi";
import { fetchNewsWithStatus } from "@/services/newsApi";
import API_BASE from "@/config/api";

const DASHBOARD_NEWS_SYMBOLS = ['AXISBANK', 'HDFCBANK', 'TCS', 'INFY'];

const getRequestError = (error) => ({
  status: error?.response?.status || error?.statusCode || null,
  message: error?.response?.data?.error?.message
    || error?.response?.data?.error
    || error?.message
    || 'Request failed',
});

const getUserError = (error, section) => {
  const details = getRequestError(error);
  if (error?.code === 'ECONNABORTED') return 'The request timed out. Please try again.';
  if (!details.status) {
    if (error?.code === 'ERR_NETWORK') {
      return `Unable to connect to the backend. Configured API: ${API_BASE}`;
    }
    return `${section} request failed. Please try again.`;
  }
  if (details.status === 500 || details.status === 502 || details.status === 503 || details.status === 504) {
    return `${section} service is temporarily unavailable.`;
  }
  if (details.status === 404) return 'The requested service is unavailable.';
  return `${section} request failed. Please try again.`;
};

const logDashboardError = (request, endpoint, error) => {
  if (process.env.NODE_ENV !== 'production') {
    const details = getRequestError(error);
    console.error('Dashboard request failed', {
      request,
      endpoint,
      status: details.status || 'NETWORK_ERROR',
      message: details.message,
      requestType: 'GET',
    });
  }
};

const SectionError = ({ message }) => (
  <div className="flex items-start gap-2 text-sm text-gs-textMuted">
    <AlertCircle className="w-4 h-4 text-gs-neg flex-shrink-0 mt-0.5" />
    <span>{message}</span>
  </div>
);

const ChartTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-gs-card border border-gs-border rounded-sm px-3 py-2 shadow-lg">
      <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
        {p.ts} IST
      </div>
      <div className="font-mono text-sm text-gs-text mt-0.5 tabular-nums">
        {p.v.toFixed(2)}
      </div>
    </div>
  );
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const marketStatus = useMarketStatus();
  const [stockState, setStockState] = useState({ loading: true, data: [], error: null });
  const [indexState, setIndexState] = useState({ loading: true, data: [], error: null });
  const [newsState, setNewsState] = useState({ loading: true, data: [], error: null, failedSymbols: [], providerStatus: 'OK' });
  const [niftyHistoryState, setNiftyHistoryState] = useState({ loading: true, candles: [], error: null, meta: null });
  const [sectorState, setSectorState] = useState({ loading: true, data: [], error: null });

  const stocks = stockState.data;
  const dynamicIndexData = indexState.data.reduce((map, index) => {
    map[index.symbol] = index;
    return map;
  }, {});
  const indices = Object.values(dynamicIndexData);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    const requestOptions = { signal: controller.signal };
    const updateState = (setter, state) => {
      if (isActive) setter(state);
    };
    const loadNews = (symbols) => fetchNewsWithStatus(symbols, requestOptions)
      .then(({ articles, failedSymbols, providerStatus }) => updateState(setNewsState, {
        loading: false, data: articles, error: null, failedSymbols, providerStatus,
      }))
      .catch((error) => {
        if (!isActive || error?.code === 'ERR_CANCELED') return;
        logDashboardError('News', '/api/news', error);
        updateState(setNewsState, { loading: false, data: [], error: getUserError(error, 'News'), failedSymbols: [], providerStatus: 'DOWN' });
      });

    fetchHistoricalData('NIFTY 50', '1D', undefined, requestOptions)
      .then((result) => updateState(setNiftyHistoryState, { loading: false, candles: result?.candles || [], error: null, meta: result }))
      .catch((error) => {
        if (!isActive || error?.code === 'ERR_CANCELED') return;
        logDashboardError('Nifty history', '/api/stocks/NIFTY 50/history', error);
        updateState(setNiftyHistoryState, { loading: false, candles: [], error: getUserError(error, 'Index chart'), meta: null });
      });

    fetchSectorRotation(requestOptions)
      .then((data) => updateState(setSectorState, { loading: false, data, error: null }))
      .catch((error) => {
        if (!isActive || error?.code === 'ERR_CANCELED') return;
        logDashboardError('Sector rotation', '/api/sector-rotation', error);
        updateState(setSectorState, { loading: false, data: [], error: getUserError(error, 'Sector data') });
      });

    fetchAllStocks(requestOptions)
      .then((data) => {
        updateState(setStockState, { loading: false, data, error: null });
        const symbols = [...new Set(data
          .map((stock) => stock?.ticker || stock?.symbol)
          .map((symbol) => String(symbol || '').trim().toUpperCase())
          .filter(Boolean))].slice(0, 8);
        return loadNews(symbols.length ? symbols : DASHBOARD_NEWS_SYMBOLS);
      })
      .catch((error) => {
        if (!isActive || error?.code === 'ERR_CANCELED') return;
        logDashboardError('Stocks', '/api/stocks', error);
        updateState(setStockState, { loading: false, data: [], error: getUserError(error, 'Market data') });
        void loadNews(DASHBOARD_NEWS_SYMBOLS);
      });

    fetchIndexQuotes(['NIFTY 50', 'NIFTYIT', 'SENSEX'], requestOptions)
      .then((data) => updateState(setIndexState, { loading: false, data, error: null }))
      .catch((error) => {
        if (!isActive || error?.code === 'ERR_CANCELED') return;
        logDashboardError('Indices', '/api/stocks/indices', error);
        updateState(setIndexState, { loading: false, data: [], error: getUserError(error, 'Market indices') });
      });

    return () => {
      isActive = false;
      controller.abort();
    };
  }, []);

  const news = newsState.data;

  // Real Angel One intraday candles -> recharts points, labeled in IST
  // regardless of the viewer's browser timezone.
  const niftySeries = niftyHistoryState.candles.map((candle) => ({
    ts: new Date(candle.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
    v: candle.close,
  }));

  const niftyIndex = dynamicIndexData['NIFTY 50'];
  const niftyValue = niftyIndex?.price ?? niftyIndex?.value;
  const niftyChange = niftyIndex?.change;
  const niftyChangePct = niftyIndex?.changePct;

  // Sort stocks by change% to get gainers and losers
  const sortedByChange = [...stocks].sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  const gainers = sortedByChange.slice(0, 4);
  const losers = sortedByChange.slice(-4).reverse();

  return (
    <div className="space-y-6 animate-fade-up" data-testid="dashboard-page">
      {/* Page Heading */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="gs-label">// Live Workspace</span>
            <span className="text-gs-textDim/40">·</span>
            <span className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] font-semibold ${marketStatus.isOpen ? 'text-gs-pos' : 'text-gs-neg'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${marketStatus.isOpen ? 'bg-gs-pos' : 'bg-gs-neg'} ${marketStatus.isOpen ? 'animate-pulse-dot' : ''}`} />
              Market {marketStatus.isOpen ? 'Open' : 'Closed'}
            </span>
            <span className="text-gs-textDim/40">·</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim">
              {marketStatus.isOpen ? 'Closes 15:30 IST' : 'Opens 09:15 IST'}
            </span>
            <span className="text-gs-textDim/40">·</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim">
              {marketStatus.session}
            </span>
          </div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-2">
            Market Pulse
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Live institutional view of Nifty, sectors, AI signals and capital flows.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10.5px] font-mono text-gs-textDim flex-wrap">
          <div className="px-3 py-2 bg-gs-panel border border-gs-border rounded-sm min-w-[180px]">
            <div className="text-[10px] uppercase tracking-[0.18em] text-gs-textDim">Signed in as</div>
            <div className="mt-1 font-semibold text-gs-text">
              {user?.username || user?.email || 'Guest'}
            </div>
            <div className="text-[11px] text-gs-textMuted">{user?.email || 'No profile loaded yet'}</div>
          </div>
          <span className="px-2 py-1 bg-gs-panel border border-gs-border rounded-sm">
            FY26 · Q3
          </span>
          <span className="px-2 py-1 bg-gs-panel border border-gs-border rounded-sm">
            NSE · BSE · 15-min delay
          </span>
          <span className="px-2 py-1 bg-gs-goldMuted border border-gs-gold/30 text-gs-gold rounded-sm flex items-center gap-1.5">
            <Sparkles className="w-3 h-3" />
            AI Synced · 13:42 IST
          </span>
        </div>
      </div>

      {/* Indices KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 gs-stagger">
        {indexState.loading ? <div className="col-span-full text-sm text-gs-textMuted">Loading market indices...</div>
          : indices.length ? indices.map((idx) => <KPITile key={idx.symbol} {...idx} />)
            : <div className="col-span-full"><SectionError message={indexState.error || 'No market index data available.'} /></div>}
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-12 gap-4">
        {/* Nifty 50 chart */}
        <div className="col-span-12 lg:col-span-8">
          <div className="gs-card p-5">
            <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
              <div>
                <div className="gs-label">Index · Nifty 50 · Intraday</div>
                <div className="flex items-baseline gap-3 mt-1">
                  <span className="font-display text-2xl font-bold text-gs-text tabular-nums">
                    {niftyValue == null ? 'Unavailable' : niftyValue.toLocaleString("en-IN")}
                  </span>
                  <span className="font-mono text-sm text-gs-pos tabular-nums">
                    {niftyChange == null || niftyChangePct == null ? 'Change unavailable' : `${niftyChange >= 0 ? '+' : ''}${niftyChange.toFixed(2)} (${niftyChangePct >= 0 ? '+' : ''}${niftyChangePct.toFixed(2)}%)`}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {["1D", "5D", "1M", "3M", "1Y", "5Y"].map((r, i) => (
                  <button
                    key={r}
                    className={`font-mono text-[11px] px-2 py-1 rounded-sm border ${
                      i === 0
                        ? "bg-gs-card text-gs-gold border-gs-gold/40"
                        : "bg-transparent text-gs-textDim border-gs-border hover:text-gs-text hover:border-gs-textDim/50"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ height: 280 }} data-testid="nifty-chart">
              {niftyHistoryState.loading ? (
                <div className="h-full grid place-items-center text-sm text-gs-textDim" data-testid="nifty-chart-loading">
                  Loading intraday chart…
                </div>
              ) : niftyHistoryState.error ? (
                <div className="h-full grid place-items-center text-sm text-gs-textMuted" data-testid="nifty-chart-error">
                  <SectionError message={niftyHistoryState.error} />
                </div>
              ) : niftySeries.length === 0 ? (
                <div className="h-full grid place-items-center text-sm text-gs-textMuted" data-testid="nifty-chart-empty">
                  No intraday candles available yet today.
                </div>
              ) : (
                <ResponsiveContainer>
                  <AreaChart data={niftySeries} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="niftyGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#D4AF37" stopOpacity={0.32} />
                        <stop offset="100%" stopColor="#D4AF37" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="ts"
                      stroke="#475569"
                      tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                      tickLine={false}
                      axisLine={{ stroke: "#1E222A" }}
                      minTickGap={32}
                    />
                    <YAxis
                      stroke="#475569"
                      tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                      tickLine={false}
                      axisLine={{ stroke: "#1E222A" }}
                      domain={["dataMin - 20", "dataMax + 20"]}
                      width={60}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#D4AF37", strokeDasharray: "3 3" }} />
                    <Area
                      type="monotone"
                      dataKey="v"
                      stroke="#D4AF37"
                      strokeWidth={1.8}
                      fill="url(#niftyGrad)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
            {niftyHistoryState.meta && (
              <div className="mt-2 text-[10px] text-gs-textDim font-mono">
                Source: {niftyHistoryState.meta.source} · as of {new Date(niftyHistoryState.meta.asOf).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
              </div>
            )}
          </div>
        </div>

        {/* AI insights column */}
        <div className="col-span-12 lg:col-span-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-gs-gold" />
              <h2 className="font-display font-bold text-gs-text">AI Insights</h2>
            </div>
            <button
              onClick={() => navigate("/ai-research")}
              className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim hover:text-gs-gold flex items-center gap-1"
            >
              View All <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>
          <div className="gs-card p-4 text-sm text-gs-textMuted">No evidence-backed AI insights available.</div>
        </div>
      </div>

      {/* Sector heatmap + Top movers */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-7">
          <div className="gs-card p-5">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <div className="gs-label">Sector Rotation</div>
                <h3 className="font-display font-bold text-gs-text mt-1">Ranked by Relative Strength · Weekly</h3>
              </div>
              <button
                onClick={() => navigate("/sectors")}
                className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim hover:text-gs-gold flex items-center gap-1"
              >
                Full Analysis <ArrowUpRight className="w-3 h-3" />
              </button>
            </div>
            {sectorState.loading ? (
              <div className="flex items-center justify-center h-[220px] text-sm text-gs-textMuted" data-testid="sector-loading">
                Loading sector data...
              </div>
            ) : sectorState.error ? (
              <div className="flex items-center justify-center h-[220px]" data-testid="sector-error">
                <SectionError message={sectorState.error} />
              </div>
            ) : sectorState.data.length === 0 ? (
              <div className="flex items-center justify-center h-[220px] text-sm text-gs-textMuted" data-testid="sector-empty">
                Sector data currently unavailable.
              </div>
            ) : (
              <div className="space-y-1.5" data-testid="sector-list">
                {/* current.x is a raw composite-price ratio (avg leader price /
                    Nifty index level), not a normalized return — its absolute
                    magnitude isn't a meaningful "% vs Nifty" figure, so only
                    its rank order is shown here, never a fabricated percentage.
                    current.y (momentum: % change of the smoothed ratio) is
                    scale-invariant and shown as a real percentage. */}
                {[...sectorState.data]
                  .sort((a, b) => (b.current?.x ?? -Infinity) - (a.current?.x ?? -Infinity))
                  .slice(0, 8)
                  .map((sector, index) => {
                    const momentumPct = sector.current?.y != null ? sector.current.y * 100 : null;
                    const improving = momentumPct != null && momentumPct >= 0;
                    return (
                      <div key={sector.id} className="flex items-center justify-between py-1.5 border-b border-gs-border last:border-b-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-[10px] text-gs-textDim w-4 shrink-0">#{index + 1}</span>
                          <span className="text-[12.5px] text-gs-text truncate">{sector.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-right shrink-0">
                          <div>
                            <div className="text-[9px] text-gs-textDim uppercase tracking-wider">Momentum</div>
                            <div className={`font-mono text-[12px] tabular-nums flex items-center gap-1 justify-end ${momentumPct == null ? 'text-gs-textMuted' : improving ? 'text-gs-pos' : 'text-gs-neg'}`}>
                              {momentumPct != null && (improving ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />)}
                              {momentumPct == null ? 'N/A' : `${momentumPct >= 0 ? '+' : ''}${momentumPct.toFixed(2)}%`}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5 grid grid-cols-1 gap-4">
          <div className="gs-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-bold text-gs-text text-sm">Top Gainers</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-pos">
                ▲ {gainers.length}
              </span>
            </div>
            <div className="space-y-2">
              {stockState.loading ? (
                <div className="text-center py-4 text-gs-textMuted text-sm">Loading market data...</div>
              ) : stockState.error ? (
                <SectionError message={stockState.error} />
              ) : stocks.length === 0 ? (
                <div className="text-center py-4 text-gs-textMuted text-sm">No market data is currently available.</div>
              ) : gainers.length > 0 ? (
                gainers.map((s) => (
                  <button
                    key={s.symbol || s.ticker}
                    onClick={() => navigate(`/stock/${s.symbol || s.ticker}`)}
                    className="w-full flex items-center justify-between py-1.5 border-b border-gs-border last:border-b-0 hover:bg-gs-cardHover transition-colors px-1 -mx-1 rounded-sm"
                  >
                    <div className="text-left">
                      <div className="font-mono text-[12.5px] text-gs-text font-semibold tracking-wider">
                        {s.symbol || s.ticker}
                      </div>
                      <div className="text-[10px] text-gs-textMuted truncate max-w-[140px]">
                        {s.name || s.sector}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-xs text-gs-text tabular-nums">
                        ₹{(s.price || 0).toFixed(2)}
                      </div>
                      <div className="font-mono text-[11px] text-gs-pos tabular-nums">
                        +{(s.changePct || 0).toFixed(2)}%
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="text-center py-4 text-gs-textMuted text-sm">No gainers</div>
              )}
            </div>
          </div>

          <div className="gs-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-bold text-gs-text text-sm">Top Losers</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-neg">
                ▼ {losers.length}
              </span>
            </div>
            <div className="space-y-2">
              {stockState.loading ? (
                <div className="text-center py-4 text-gs-textMuted text-sm">Loading market data...</div>
              ) : stockState.error ? (
                <SectionError message={stockState.error} />
              ) : stocks.length === 0 ? (
                <div className="text-center py-4 text-gs-textMuted text-sm">No market data is currently available.</div>
              ) : losers.length > 0 ? (
                losers.map((s) => (
                  <button
                    key={s.symbol || s.ticker}
                    onClick={() => navigate(`/stock/${s.symbol || s.ticker}`)}
                    className="w-full flex items-center justify-between py-1.5 border-b border-gs-border last:border-b-0 hover:bg-gs-cardHover transition-colors px-1 -mx-1 rounded-sm"
                  >
                    <div className="text-left">
                      <div className="font-mono text-[12.5px] text-gs-text font-semibold tracking-wider">
                        {s.symbol || s.ticker}
                      </div>
                      <div className="text-[10px] text-gs-textMuted truncate max-w-[140px]">
                        {s.name || s.sector}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-xs text-gs-text tabular-nums">
                        ₹{(s.price || 0).toFixed(2)}
                      </div>
                      <div className="font-mono text-[11px] text-gs-neg tabular-nums">
                        {(s.changePct || 0).toFixed(2)}%
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="text-center py-4 text-gs-textMuted text-sm">No losers</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Research feed + News */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display font-bold text-gs-text">Research Feed</h2>
          </div>
          <div className="gs-card p-4 text-sm text-gs-textMuted">Research feed coming soon — no verified, source-backed research records are wired to this view yet.</div>
        </div>

        <div className="col-span-12 lg:col-span-4">
          <div className="flex items-center gap-2 mb-3">
            <Newspaper className="w-4 h-4 text-gs-textDim" />
            <h2 className="font-display font-bold text-gs-text">Newsflow</h2>
          </div>
          {!newsState.loading && !newsState.error && newsState.providerStatus === 'PARTIAL' && (
            <div className="mb-2 text-[10.5px] text-gs-textDim flex items-center gap-1.5" data-testid="news-degraded">
              <AlertCircle className="w-3 h-3 text-gs-gold shrink-0" />
              News unavailable for {newsState.failedSymbols.length} symbol{newsState.failedSymbols.length === 1 ? '' : 's'} — showing available results.
            </div>
          )}
          <div className="gs-card divide-y divide-gs-border">
            {newsState.loading ? <div className="p-4 text-sm text-gs-textMuted">Loading news...</div>
              : newsState.error ? <div className="p-4"><SectionError message={newsState.error === 'News request failed.' ? 'News temporarily unavailable.' : newsState.error} /></div>
              : news.length ? news.slice(0, 6).map((n) => (
              <a key={n.url} href={n.url} target="_blank" rel="noreferrer" className="block p-4 hover:bg-gs-cardHover transition-colors">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                    {n.source || 'Unknown source'}
                  </span>
                  <span className="font-mono text-[10px] text-gs-textDim">{n.publishedAt ? new Date(n.publishedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }) : 'Date unavailable'}</span>
                </div>
                <p className="text-[13px] text-gs-text leading-snug">{n.title}</p>
                {n.symbols?.length > 0 && (
                  <div className="flex gap-1.5 mt-2">
                    {n.symbols.slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="font-mono text-[10px] tracking-wider px-1.5 py-0.5 bg-gs-panel border border-gs-border rounded-sm text-gs-textMuted"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </a>
            )) : <div className="p-4 text-sm text-gs-textMuted">No recent news available.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
