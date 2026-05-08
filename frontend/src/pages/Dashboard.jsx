import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { ArrowUpRight, Sparkles, Newspaper } from "lucide-react";
import KPITile from "@/components/widgets/KPITile";
import AIInsightCard from "@/components/widgets/AIInsightCard";
import SectorHeatmap from "@/components/widgets/SectorHeatmap";
import StockTable from "@/components/widgets/StockTable";
import ResearchCard from "@/components/widgets/ResearchCard";
import MarketSentiment from "@/components/widgets/MarketSentiment";
import EarningsSnapshot from "@/components/widgets/EarningsSnapshot";
import {
  INDICES,
  AI_INSIGHTS,
  SECTOR_HEATMAP_DATA,
  TOP_MOVERS,
  RESEARCH_FEED,
  NEWS_FEED,
} from "@/data/mockData";

const niftySeries = INDICES[0].series.map((d, i) => ({
  t: i,
  v: d.v,
  ts: `09:${String(15 + Math.floor(i * 12)).padStart(2, "0")}`,
}));

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

  return (
    <div className="space-y-6 animate-fade-up" data-testid="dashboard-page">
      {/* Page Heading */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="gs-label">// Live Workspace</span>
            <span className="text-gs-textDim/40">·</span>
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-gs-pos font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-gs-pos animate-pulse-dot" />
              Market Open
            </span>
            <span className="text-gs-textDim/40">·</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim">
              Closes 15:30 IST
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
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {INDICES.map((idx) => (
          <KPITile key={idx.symbol} {...idx} />
        ))}
      </div>

      {/* Market Sentiment row */}
      <MarketSentiment />

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
                    {INDICES[0].value.toLocaleString("en-IN")}
                  </span>
                  <span className="font-mono text-sm text-gs-pos tabular-nums">
                    +{INDICES[0].change.toFixed(2)} (+{INDICES[0].changePct.toFixed(2)}%)
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
            <div style={{ height: 280 }}>
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
            </div>
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
          {AI_INSIGHTS.slice(0, 2).map((i) => (
            <AIInsightCard key={i.id} insight={i} onOpen={() => navigate("/ai-research")} />
          ))}
        </div>
      </div>

      {/* Sector heatmap + Top movers */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-7">
          <div className="gs-card p-5">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <div className="gs-label">Sector Heatmap</div>
                <h3 className="font-display font-bold text-gs-text mt-1">Sectoral Performance · 1D</h3>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-gs-textDim">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 bg-gs-pos inline-block" /> Gainers
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 bg-gs-neg inline-block" /> Losers
                </span>
              </div>
            </div>
            <SectorHeatmap data={SECTOR_HEATMAP_DATA} height={300} />
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5 grid grid-cols-1 gap-4">
          <div className="gs-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-bold text-gs-text text-sm">Top Gainers</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-pos">
                ▲ {TOP_MOVERS.gainers.length}
              </span>
            </div>
            <div className="space-y-2">
              {TOP_MOVERS.gainers.slice(0, 4).map((s) => (
                <button
                  key={s.ticker}
                  onClick={() => navigate(`/stock/${s.ticker}`)}
                  className="w-full flex items-center justify-between py-1.5 border-b border-gs-border last:border-b-0 hover:bg-gs-cardHover transition-colors px-1 -mx-1 rounded-sm"
                >
                  <div className="text-left">
                    <div className="font-mono text-[12.5px] text-gs-text font-semibold tracking-wider">
                      {s.ticker}
                    </div>
                    <div className="text-[10px] text-gs-textMuted truncate max-w-[140px]">
                      {s.sector}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xs text-gs-text tabular-nums">
                      ₹{s.price.toFixed(2)}
                    </div>
                    <div className="font-mono text-[11px] text-gs-pos tabular-nums">
                      +{s.changePct.toFixed(2)}%
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="gs-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-bold text-gs-text text-sm">Top Losers</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-neg">
                ▼ {TOP_MOVERS.losers.length}
              </span>
            </div>
            <div className="space-y-2">
              {TOP_MOVERS.losers.slice(0, 4).map((s) => (
                <button
                  key={s.ticker}
                  onClick={() => navigate(`/stock/${s.ticker}`)}
                  className="w-full flex items-center justify-between py-1.5 border-b border-gs-border last:border-b-0 hover:bg-gs-cardHover transition-colors px-1 -mx-1 rounded-sm"
                >
                  <div className="text-left">
                    <div className="font-mono text-[12.5px] text-gs-text font-semibold tracking-wider">
                      {s.ticker}
                    </div>
                    <div className="text-[10px] text-gs-textMuted truncate max-w-[140px]">
                      {s.sector}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xs text-gs-text tabular-nums">
                      ₹{s.price.toFixed(2)}
                    </div>
                    <div className="font-mono text-[11px] text-gs-neg tabular-nums">
                      {s.changePct.toFixed(2)}%
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Earnings Snapshot strip */}
      <EarningsSnapshot />

      {/* Research feed + News */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display font-bold text-gs-text">Research Feed</h2>
            <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
              {RESEARCH_FEED.length} latest
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {RESEARCH_FEED.slice(0, 4).map((r) => (
              <ResearchCard key={r.id} item={r} onOpen={() => navigate("/ai-research")} />
            ))}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4">
          <div className="flex items-center gap-2 mb-3">
            <Newspaper className="w-4 h-4 text-gs-textDim" />
            <h2 className="font-display font-bold text-gs-text">Newsflow</h2>
          </div>
          <div className="gs-card divide-y divide-gs-border">
            {NEWS_FEED.map((n) => (
              <div key={n.id} className="p-4 hover:bg-gs-cardHover transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                    {n.source}
                  </span>
                  <span className="font-mono text-[10px] text-gs-textDim">{n.timestamp}</span>
                </div>
                <p className="text-[13px] text-gs-text leading-snug">{n.headline}</p>
                {n.tickers.length > 0 && (
                  <div className="flex gap-1.5 mt-2">
                    {n.tickers.map((t) => (
                      <span
                        key={t}
                        className="font-mono text-[10px] tracking-wider px-1.5 py-0.5 bg-gs-panel border border-gs-border rounded-sm text-gs-textMuted"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
