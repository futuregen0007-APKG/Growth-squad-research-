import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowLeft, Sparkles, ExternalLink, Star } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import { STOCKS, FINANCIAL_HIGHLIGHTS, NEWS_FEED } from "@/data/mockData";
import ChangeBadge from "@/components/widgets/ChangeBadge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const ChartTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-gs-card border border-gs-border rounded-sm px-3 py-2 shadow-lg">
      <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
        {p.period || `Tick ${p.x}`}
      </div>
      <div className="font-mono text-sm text-gs-text mt-0.5 tabular-nums">
        {(p.v ?? p.value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
      </div>
    </div>
  );
};

export default function StockDetail() {
  const { ticker } = useParams();
  const navigate = useNavigate();
  const stock = STOCKS.find((s) => s.ticker === ticker?.toUpperCase()) || STOCKS[0];
  const isPos = stock.changePct >= 0;
  const fundamentals = FINANCIAL_HIGHLIGHTS[stock.ticker] || {
    revenue: [
      { period: "FY22", value: 18200 },
      { period: "FY23", value: 22100 },
      { period: "FY24", value: 26800 },
      { period: "FY25E", value: 31600 },
      { period: "FY26E", value: 37200 },
    ],
    ebitdaMargin: [
      { period: "FY22", value: 18.4 },
      { period: "FY23", value: 19.6 },
      { period: "FY24", value: 21.2 },
      { period: "FY25E", value: 22.4 },
      { period: "FY26E", value: 23.6 },
    ],
    keyMetrics: {
      "Market Cap": stock.marketCap,
      Sector: stock.sector,
      "P/E (TTM)": `${stock.pe}x`,
      "ROE FY24": "18.4%",
      "EPS FY26E (Cons.)": `₹${(stock.price / (stock.pe * 0.85)).toFixed(2)}`,
      "Dividend Yield": "0.8%",
    },
    peers: STOCKS.filter((s) => s.sector === stock.sector && s.ticker !== stock.ticker)
      .slice(0, 3)
      .map((s) => s.ticker),
  };

  const peers = STOCKS.filter((s) => fundamentals.peers.includes(s.ticker));

  return (
    <div className="space-y-5 animate-fade-up" data-testid="stock-detail-page">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-2 text-[12px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back
      </button>

      {/* Header */}
      <div className="gs-card p-5">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-3xl font-bold text-gs-text tracking-tight">
                {stock.ticker}
              </h1>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim bg-gs-panel border border-gs-border px-2 py-1 rounded-sm">
                NSE · {stock.sector}
              </span>
              <button className="text-gs-textDim hover:text-gs-gold">
                <Star className="w-4 h-4" />
              </button>
            </div>
            <div className="text-sm text-gs-textMuted mt-1">{stock.name}</div>
            <div className="flex items-baseline gap-3 mt-3">
              <span className="font-display text-3xl font-bold text-gs-text tabular-nums">
                ₹{stock.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
              <ChangeBadge value={stock.changePct} size="lg" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 sm:gap-6 text-right">
            <div>
              <div className="gs-label">Mkt Cap</div>
              <div className="font-mono text-sm text-gs-text mt-1">{stock.marketCap}</div>
            </div>
            <div>
              <div className="gs-label">P/E</div>
              <div className="font-mono text-sm text-gs-text mt-1">{stock.pe?.toFixed(1)}x</div>
            </div>
            <div>
              <div className="gs-label">52W</div>
              <div className="font-mono text-sm text-gs-text mt-1">High</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Left: Chart + tabs */}
        <div className="col-span-12 lg:col-span-8 space-y-4">
          <div className="gs-card p-5">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="gs-label">Price · Intraday</div>
              <div className="flex items-center gap-1">
                {["1D", "5D", "1M", "6M", "1Y", "5Y"].map((r, i) => (
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
            <div style={{ height: 320 }}>
              <ResponsiveContainer>
                <AreaChart data={stock.series} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="stockGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor={isPos ? "#059669" : "#DC2626"}
                        stopOpacity={0.3}
                      />
                      <stop
                        offset="100%"
                        stopColor={isPos ? "#059669" : "#DC2626"}
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" />
                  <XAxis
                    dataKey="x"
                    stroke="#475569"
                    tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                    tickLine={false}
                    axisLine={{ stroke: "#1E222A" }}
                  />
                  <YAxis
                    stroke="#475569"
                    tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                    tickLine={false}
                    axisLine={{ stroke: "#1E222A" }}
                    domain={["dataMin - 5", "dataMax + 5"]}
                    width={60}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#D4AF37", strokeDasharray: "3 3" }} />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={isPos ? "#059669" : "#DC2626"}
                    strokeWidth={1.8}
                    fill="url(#stockGrad)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Fundamentals tabs */}
          <Tabs defaultValue="financials">
            <TabsList className="bg-gs-panel border border-gs-border rounded-sm h-auto p-1">
              <TabsTrigger
                value="financials"
                className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
              >
                Financials
              </TabsTrigger>
              <TabsTrigger
                value="margins"
                className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
              >
                Margins
              </TabsTrigger>
              <TabsTrigger
                value="ai"
                className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
              >
                <Sparkles className="w-3.5 h-3.5 mr-1.5 text-gs-gold" />
                AI Lens
              </TabsTrigger>
            </TabsList>

            <TabsContent value="financials" className="mt-4">
              <div className="gs-card p-5">
                <div className="gs-label mb-3">Revenue · ₹ Cr · 5Y</div>
                <div style={{ height: 220 }}>
                  <ResponsiveContainer>
                    <BarChart data={fundamentals.revenue}>
                      <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="period"
                        stroke="#475569"
                        tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                        tickLine={false}
                        axisLine={{ stroke: "#1E222A" }}
                      />
                      <YAxis
                        stroke="#475569"
                        tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                        tickLine={false}
                        axisLine={{ stroke: "#1E222A" }}
                      />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(212,175,55,0.05)" }} />
                      <Bar dataKey="value" fill="#D4AF37" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="margins" className="mt-4">
              <div className="gs-card p-5">
                <div className="gs-label mb-3">EBITDA Margin · % · 5Y</div>
                <div style={{ height: 220 }}>
                  <ResponsiveContainer>
                    <AreaChart data={fundamentals.ebitdaMargin}>
                      <defs>
                        <linearGradient id="marginGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#059669" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="#059669" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" />
                      <XAxis
                        dataKey="period"
                        stroke="#475569"
                        tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                        tickLine={false}
                        axisLine={{ stroke: "#1E222A" }}
                      />
                      <YAxis
                        stroke="#475569"
                        tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
                        tickLine={false}
                        axisLine={{ stroke: "#1E222A" }}
                      />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#D4AF37", strokeDasharray: "3 3" }} />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#059669"
                        strokeWidth={1.8}
                        fill="url(#marginGrad)"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="ai" className="mt-4">
              <div className="gs-card p-5 border-l-2 border-l-gs-gold">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
                    AI Equity Lens
                  </span>
                </div>
                <h3 className="font-display text-lg font-bold text-gs-text mb-2">
                  {stock.name} · Investment Thesis
                </h3>
                <ul className="space-y-2 text-[13px] text-gs-textMuted leading-relaxed list-disc pl-5">
                  <li>
                    Sector tailwind: <span className="text-gs-text">{stock.sector}</span> capex
                    cycle and policy support remain structurally supportive.
                  </li>
                  <li>
                    Order intake ahead of consensus; book-to-bill ratio supports 25%+ revenue
                    visibility into FY27.
                  </li>
                  <li>
                    Margin expansion path of 80–120 bps over 2 years given operating leverage and
                    indigenisation mix.
                  </li>
                  <li>
                    Risk: government dependency, working-capital cycle, and execution timeline
                    slippage.
                  </li>
                </ul>
                <div className="mt-4 pt-3 border-t border-gs-border flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                    Verdict
                  </span>
                  <span className="font-mono text-[11px] uppercase tracking-wider rounded-sm px-2 py-1 bg-gs-posBg text-gs-pos border border-gs-pos/30">
                    BUY · TP ₹{(stock.price * 1.18).toFixed(0)}
                  </span>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        {/* Right: key metrics + peers + news */}
        <div className="col-span-12 lg:col-span-4 space-y-4">
          <div className="gs-card p-5">
            <h3 className="font-display font-bold text-gs-text mb-3">Key Metrics</h3>
            <div className="space-y-2.5">
              {Object.entries(fundamentals.keyMetrics)
                .filter(([, v]) => v && v !== "—")
                .map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center justify-between py-2 border-b border-gs-border last:border-b-0"
                >
                  <span className="text-[12.5px] text-gs-textMuted">{k}</span>
                  <span className="font-mono text-[12.5px] text-gs-text tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="gs-card p-5">
            <h3 className="font-display font-bold text-gs-text mb-3">Peers</h3>
            <div className="space-y-2">
              {peers.map((p) => (
                <Link
                  to={`/stock/${p.ticker}`}
                  key={p.ticker}
                  className="flex items-center justify-between py-2 border-b border-gs-border last:border-b-0 hover:bg-gs-cardHover px-1 -mx-1 rounded-sm transition-colors"
                >
                  <div>
                    <div className="font-mono text-[12.5px] text-gs-text font-semibold tracking-wider">
                      {p.ticker}
                    </div>
                    <div className="text-[10.5px] text-gs-textMuted">{p.sector}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[11.5px] text-gs-text tabular-nums">
                      ₹{p.price.toFixed(2)}
                    </div>
                    <div
                      className={`font-mono text-[10.5px] tabular-nums ${
                        p.changePct >= 0 ? "text-gs-pos" : "text-gs-neg"
                      }`}
                    >
                      {p.changePct >= 0 ? "+" : ""}
                      {p.changePct.toFixed(2)}%
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <div className="gs-card p-5">
            <h3 className="font-display font-bold text-gs-text mb-3">Related News</h3>
            <div className="space-y-3">
              {NEWS_FEED.slice(0, 3).map((n) => (
                <div key={n.id} className="border-b border-gs-border pb-3 last:border-b-0 last:pb-0">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                      {n.source}
                    </span>
                    <span className="font-mono text-[10px] text-gs-textDim">{n.timestamp}</span>
                  </div>
                  <p className="text-[12.5px] text-gs-text leading-snug flex items-start gap-1.5">
                    {n.headline}
                    <ExternalLink className="w-3 h-3 text-gs-textDim shrink-0 mt-0.5" />
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
