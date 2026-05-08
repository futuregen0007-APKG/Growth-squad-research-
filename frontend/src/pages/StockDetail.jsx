import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  Sparkles,
  ExternalLink,
  Star,
  Building,
  Users,
  Calendar,
  MapPin,
  Briefcase,
  Quote,
  TrendingUp,
  TrendingDown,
  Award,
} from "lucide-react";
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
  LineChart,
  Line,
  Legend,
} from "recharts";
import { STOCKS, NEWS_FEED, getCompanyResearch } from "@/data/mockData";
import ChangeBadge from "@/components/widgets/ChangeBadge";
import RatingPanel from "@/components/widgets/RatingPanel";
import SWOTGrid from "@/components/widgets/SWOTGrid";
import RiskFlagsList from "@/components/widgets/RiskFlagsList";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const ChartTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-gs-card border border-gs-border rounded-sm px-3 py-2 shadow-lg">
      <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
        {p.period || `Tick ${p.x}`}
      </div>
      {payload.map((it, i) => (
        <div
          key={i}
          className="font-mono text-[12px] mt-0.5 tabular-nums flex items-center gap-2"
          style={{ color: it.color }}
        >
          <span>{it.name || it.dataKey}</span>
          <span className="text-gs-text">
            {Number(it.value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
          </span>
        </div>
      ))}
    </div>
  );
};

const StatBox = ({ label, value, sub }) => (
  <div>
    <div className="gs-label">{label}</div>
    <div className="font-mono text-sm text-gs-text mt-1 tabular-nums">{value}</div>
    {sub && <div className="text-[10px] text-gs-textDim mt-0.5">{sub}</div>}
  </div>
);

const ValuationRow = ({ name, value, sectorAvg, hint }) => {
  const numericValue = parseFloat(String(value));
  const numericSector = parseFloat(String(sectorAvg));
  const diff = numericValue - numericSector;
  const cheaper = diff < 0;
  return (
    <div className="flex items-center justify-between py-2 border-b border-gs-border last:border-b-0">
      <div>
        <div className="text-[12.5px] text-gs-text">{name}</div>
        {hint && <div className="text-[10.5px] text-gs-textDim mt-0.5">{hint}</div>}
      </div>
      <div className="text-right">
        <div className="font-mono text-[13px] text-gs-text tabular-nums">{value}</div>
        <div
          className={`font-mono text-[10px] tabular-nums ${
            cheaper ? "text-gs-pos" : "text-gs-neg"
          }`}
        >
          vs sector {sectorAvg}
        </div>
      </div>
    </div>
  );
};

export default function StockDetail() {
  const { ticker } = useParams();
  const navigate = useNavigate();
  const stock = STOCKS.find((s) => s.ticker === ticker?.toUpperCase()) || STOCKS[0];
  const research = getCompanyResearch(stock);
  const isPos = stock.changePct >= 0;

  const peers = STOCKS.filter(
    (s) => s.sector === stock.sector && s.ticker !== stock.ticker,
  ).slice(0, 4);

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
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="font-display text-3xl font-bold text-gs-text tracking-tight">
                {stock.ticker}
              </h1>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim bg-gs-panel border border-gs-border px-2 py-1 rounded-sm">
                NSE · {stock.sector}
              </span>
              <span
                className={`font-display font-extrabold text-[12px] tracking-wider px-2 py-1 rounded-sm border ${
                  research.rating.verdict === "BUY"
                    ? "bg-gs-posBg text-gs-pos border-gs-pos/40"
                    : research.rating.verdict === "ACCUMULATE"
                      ? "bg-gs-posBg text-gs-pos border-gs-pos/40"
                      : research.rating.verdict === "HOLD"
                        ? "bg-gs-goldMuted text-gs-gold border-gs-gold/40"
                        : "bg-gs-negBg text-gs-neg border-gs-neg/40"
                }`}
              >
                {research.rating.verdict}
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
            <StatBox label="Mkt Cap" value={stock.marketCap} />
            <StatBox label="P/E TTM" value={`${stock.pe?.toFixed(1)}x`} sub={`Sector ${research.valuation.peSector}x`} />
            <StatBox label="Target" value={`₹${research.rating.target.toLocaleString("en-IN")}`} sub={`${research.rating.upside >= 0 ? "+" : ""}${research.rating.upside}% upside`} />
          </div>
        </div>
      </div>

      {/* Institutional Rating Panel */}
      <RatingPanel rating={research.rating} currentPrice={stock.price} />

      {/* Main Grid: Chart + Tabs (left) | Overview + Sector Pos + Valuation (right) */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8 space-y-4">
          {/* Price chart */}
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
            <div style={{ height: 280 }}>
              <ResponsiveContainer>
                <AreaChart data={stock.series} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="stockGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={isPos ? "#059669" : "#DC2626"} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={isPos ? "#059669" : "#DC2626"} stopOpacity={0} />
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

          {/* Financial Tabs */}
          <Tabs defaultValue="financials">
            <TabsList className="bg-gs-panel border border-gs-border rounded-sm h-auto p-1 flex-wrap">
              {[
                { v: "financials", l: "Financials" },
                { v: "margins", l: "Margins" },
                { v: "debt", l: "Debt Analysis" },
                { v: "ai", l: "AI Outlook", icon: Sparkles },
              ].map((t) => (
                <TabsTrigger
                  key={t.v}
                  value={t.v}
                  className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
                  data-testid={`tab-${t.v}`}
                >
                  {t.icon && <t.icon className="w-3.5 h-3.5 mr-1.5 text-gs-gold" />}
                  {t.l}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Financials Tab — Revenue + Profitability */}
            <TabsContent value="financials" className="mt-4 space-y-4">
              <div className="gs-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="gs-label">Revenue · ₹ Cr · 5Y</div>
                  <span className="font-mono text-[10px] text-gs-pos">
                    +{(((research.profitability[4].eps - research.profitability[0].eps) / research.profitability[0].eps) * 100).toFixed(0)}% EPS CAGR
                  </span>
                </div>
                <div style={{ height: 220 }}>
                  <ResponsiveContainer>
                    <BarChart data={[
                      { period: "FY22", value: 24618 },
                      { period: "FY23", value: 26928 },
                      { period: "FY24", value: 30381 },
                      { period: "FY25E", value: 36500 },
                      { period: "FY26E", value: 43800 },
                    ]}>
                      <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="period" stroke="#475569" tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#1E222A" }} />
                      <YAxis stroke="#475569" tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#1E222A" }} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(212,175,55,0.05)" }} />
                      <Bar dataKey="value" name="Revenue" fill="#D4AF37" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="gs-card p-5">
                <div className="gs-label mb-3">Profitability · EPS / ROE / ROCE</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gs-border bg-gs-panel/50">
                        <th className="gs-label text-left px-2 py-2">Period</th>
                        <th className="gs-label text-right px-2 py-2">EPS (₹)</th>
                        <th className="gs-label text-right px-2 py-2">ROE %</th>
                        <th className="gs-label text-right px-2 py-2">ROCE %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {research.profitability.map((p) => (
                        <tr key={p.period} className="border-b border-gs-border last:border-b-0">
                          <td className="px-2 py-2.5 font-mono text-[12px] text-gs-text">{p.period}</td>
                          <td className="px-2 py-2.5 text-right font-mono text-[12px] text-gs-text tabular-nums">{p.eps}</td>
                          <td className="px-2 py-2.5 text-right font-mono text-[12px] text-gs-pos tabular-nums">{p.roe}%</td>
                          <td className="px-2 py-2.5 text-right font-mono text-[12px] text-gs-pos tabular-nums">{p.roce}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </TabsContent>

            {/* Margins Tab */}
            <TabsContent value="margins" className="mt-4">
              <div className="gs-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="gs-label">Margin Analysis · Gross / EBITDA / Net</div>
                  <span className="font-mono text-[10px] text-gs-pos">
                    +{(research.margins[4].ebitda - research.margins[0].ebitda).toFixed(1)} bps EBITDA expansion
                  </span>
                </div>
                <div style={{ height: 260 }}>
                  <ResponsiveContainer>
                    <LineChart data={research.margins}>
                      <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" />
                      <XAxis dataKey="period" stroke="#475569" tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#1E222A" }} />
                      <YAxis stroke="#475569" tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={{ stroke: "#1E222A" }} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#D4AF37", strokeDasharray: "3 3" }} />
                      <Legend wrapperStyle={{ fontSize: 11, fontFamily: "JetBrains Mono", color: "#94A3B8" }} />
                      <Line type="monotone" dataKey="gross" name="Gross" stroke="#D4AF37" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                      <Line type="monotone" dataKey="ebitda" name="EBITDA" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                      <Line type="monotone" dataKey="net" name="Net" stroke="#2563EB" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </TabsContent>

            {/* Debt Tab */}
            <TabsContent value="debt" className="mt-4">
              <div className="gs-card p-5">
                <div className="gs-label mb-4">Debt Analysis · Capital Structure</div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {[
                    { l: "Debt / Equity", v: research.debt.debtEquity, hint: research.debt.debtEquity < 0.3 ? "Conservative" : "Moderate" },
                    { l: "Interest Coverage", v: `${research.debt.interestCoverage}x`, hint: research.debt.interestCoverage > 10 ? "Excellent" : "Adequate" },
                    { l: "Net Cash", v: research.debt.netCash, hint: "FY24" },
                    { l: "Credit Rating", v: research.debt.creditRating, hint: "External" },
                    { l: "Current Ratio", v: research.debt.currentRatio, hint: "Liquidity" },
                    { l: "Cash Conversion", v: research.debt.cashConversion, hint: "OCF / EBITDA" },
                  ].map((m) => (
                    <div key={m.l} className="gs-card p-3.5 bg-gs-bg/50">
                      <div className="gs-label">{m.l}</div>
                      <div className="font-mono text-[16px] font-semibold text-gs-text mt-1 tabular-nums">
                        {m.v}
                      </div>
                      <div className="text-[10.5px] text-gs-textDim mt-0.5">{m.hint}</div>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            {/* AI Outlook Tab */}
            <TabsContent value="ai" className="mt-4">
              <div className="gs-card p-5 border-l-2 border-l-gs-gold">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
                    AI Investment Lens · {research.aiOutlook.conviction} conviction · {research.aiOutlook.score}/100
                  </span>
                </div>
                <h3 className="font-display text-lg font-bold text-gs-text mb-2">
                  {stock.name} · {research.aiOutlook.verdict} thesis
                </h3>
                <p className="text-[13px] text-gs-textMuted leading-relaxed mb-5">
                  {research.aiOutlook.thesis}
                </p>

                <div className="grid grid-cols-3 gap-3 mb-5">
                  {[
                    { label: "Bull case", data: research.aiOutlook.bullCase, color: "text-gs-pos", border: "border-gs-pos/40", bg: "bg-gs-posBg" },
                    { label: "Base case", data: research.aiOutlook.baseCase, color: "text-gs-gold", border: "border-gs-gold/40", bg: "bg-gs-goldMuted" },
                    { label: "Bear case", data: research.aiOutlook.bearCase, color: "text-gs-neg", border: "border-gs-neg/40", bg: "bg-gs-negBg" },
                  ].map((c) => (
                    <div key={c.label} className={`gs-card p-3.5 border ${c.border}`}>
                      <div className="flex items-center justify-between">
                        <span className={`font-mono text-[10px] uppercase tracking-wider ${c.color}`}>
                          {c.label}
                        </span>
                        <span className={`font-mono text-[10px] tabular-nums ${c.bg} ${c.color} px-1.5 py-0.5 rounded-sm`}>
                          {c.data.prob}%
                        </span>
                      </div>
                      <div className="font-display text-xl font-bold text-gs-text tabular-nums mt-2">
                        ₹{c.data.target.toLocaleString("en-IN")}
                      </div>
                      <div className={`font-mono text-[11px] tabular-nums mt-0.5 ${c.color}`}>
                        {c.data.upside >= 0 ? "+" : ""}
                        {c.data.upside}%
                      </div>
                    </div>
                  ))}
                </div>

                <div>
                  <div className="gs-label mb-2">Key catalysts to watch</div>
                  <ul className="space-y-1.5">
                    {research.aiOutlook.catalysts.map((c, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-[12.5px] text-gs-textMuted leading-relaxed"
                      >
                        <span className="mt-1.5 w-1 h-1 rounded-full bg-gs-gold shrink-0" />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        {/* Right column: Overview + Sector Positioning + Valuation */}
        <div className="col-span-12 lg:col-span-4 space-y-4">
          {/* Company Overview */}
          <div className="gs-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Building className="w-3.5 h-3.5 text-gs-textDim" />
              <h3 className="font-display font-bold text-gs-text">Company Overview</h3>
            </div>
            <p className="text-[12.5px] text-gs-textMuted leading-relaxed">
              {research.overview.description}
            </p>
            <div className="mt-4 pt-4 border-t border-gs-border space-y-2.5 text-[12px]">
              {[
                { icon: Calendar, label: "Founded", value: research.overview.founded },
                { icon: MapPin, label: "Headquarters", value: research.overview.hq },
                { icon: Users, label: "Employees", value: research.overview.employees },
                { icon: Briefcase, label: "CEO", value: research.overview.ceo },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-gs-textMuted">
                    <row.icon className="w-3 h-3 text-gs-textDim" />
                    {row.label}
                  </span>
                  <span className="font-mono text-[11.5px] text-gs-text">{row.value}</span>
                </div>
              ))}
              <div className="flex items-start justify-between gap-2">
                <span className="text-gs-textMuted">Indices</span>
                <div className="flex flex-wrap gap-1 justify-end">
                  {research.overview.indices.map((idx) => (
                    <span
                      key={idx}
                      className="font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 bg-gs-panel border border-gs-border rounded-sm text-gs-text"
                    >
                      {idx}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Sector Positioning */}
          <div className="gs-card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Award className="w-3.5 h-3.5 text-gs-gold" />
                <h3 className="font-display font-bold text-gs-text">Sector Positioning</h3>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-pos bg-gs-posBg border border-gs-pos/30 rounded-sm px-1.5 py-0.5">
                Rank #{research.sectorPositioning.rank} / {research.sectorPositioning.total}
              </span>
            </div>
            <div className="space-y-2.5">
              {research.sectorPositioning.metrics.map((m) => (
                <div key={m.name} className="flex items-center justify-between py-2 border-b border-gs-border last:border-b-0">
                  <div>
                    <div className="text-[12.5px] text-gs-text">{m.name}</div>
                    <div className="text-[10.5px] text-gs-textDim">Sector avg {m.sectorAvg}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[12.5px] text-gs-text tabular-nums">{m.value}</div>
                    <div className="font-mono text-[10px] text-gs-gold">#{m.rank}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Valuation */}
          <div className="gs-card p-5">
            <h3 className="font-display font-bold text-gs-text mb-3">Valuation Overview</h3>
            <ValuationRow name="P/E (TTM)" value={`${research.valuation.pe}x`} sectorAvg={`${research.valuation.peSector}x`} />
            <ValuationRow name="P/B" value={`${research.valuation.pb}x`} sectorAvg={`${research.valuation.pbSector}x`} />
            <ValuationRow name="EV / EBITDA" value={`${research.valuation.evEbitda}x`} sectorAvg={`${research.valuation.evEbitdaSector}x`} />
            <ValuationRow name="PEG Ratio" value={research.valuation.pegRatio} sectorAvg="1.20" hint="Growth-adjusted" />
            <ValuationRow name="Dividend Yield" value={`${research.valuation.dividendYield}%`} sectorAvg="1.0%" />
            <div className="mt-3 pt-3 border-t border-gs-border bg-gs-bg/30 -mx-5 -mb-5 px-5 py-3">
              <div className="flex items-start gap-2">
                <Sparkles className="w-3 h-3 text-gs-gold mt-0.5 shrink-0" />
                <p className="text-[11.5px] text-gs-textMuted leading-relaxed italic">
                  {research.valuation.verdict}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Earnings Highlights — last 4 quarters */}
      <div className="gs-card p-5" data-testid="earnings-highlights">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div>
            <div className="gs-label">// Quarterly Performance</div>
            <h3 className="font-display font-bold text-gs-text mt-1 text-lg">
              Earnings Highlights · Last 4 Quarters
            </h3>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {research.earningsQuarters.map((q) => (
            <div key={q.period} className="gs-card p-4 bg-gs-bg/40">
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-[11px] uppercase tracking-wider text-gs-text font-semibold">
                  {q.period}
                </span>
                <span
                  className={`font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded-sm border ${
                    q.surprise >= 0
                      ? "bg-gs-posBg text-gs-pos border-gs-pos/30"
                      : "bg-gs-negBg text-gs-neg border-gs-neg/30"
                  }`}
                >
                  {q.surprise >= 0 ? "Beat +" : "Miss "}
                  {q.surprise}%
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <div>
                  <div className="gs-label">Revenue</div>
                  <div className="font-mono text-[13px] text-gs-text mt-1">₹{q.revenue.toLocaleString("en-IN")}</div>
                  <div className={`font-mono text-[10.5px] tabular-nums mt-0.5 ${q.revGrowth >= 0 ? "text-gs-pos" : "text-gs-neg"}`}>
                    {q.revGrowth >= 0 ? "+" : ""}{q.revGrowth}% YoY
                  </div>
                </div>
                <div>
                  <div className="gs-label">PAT</div>
                  <div className="font-mono text-[13px] text-gs-text mt-1">₹{q.pat.toLocaleString("en-IN")}</div>
                  <div className={`font-mono text-[10.5px] tabular-nums mt-0.5 ${q.patGrowth >= 0 ? "text-gs-pos" : "text-gs-neg"}`}>
                    {q.patGrowth >= 0 ? "+" : ""}{q.patGrowth}% YoY
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SWOT */}
      <div data-testid="swot-section">
        <div className="flex items-center gap-2 mb-3">
          <span className="gs-label">// SWOT Snapshot</span>
        </div>
        <SWOTGrid swot={research.swot} />
      </div>

      {/* Risk Flags + Management Commentary */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-7">
          <div className="flex items-center gap-2 mb-3">
            <span className="gs-label">// Risk Flags</span>
          </div>
          <RiskFlagsList risks={research.risks} />
        </div>
        <div className="col-span-12 lg:col-span-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="gs-label">// Management Commentary</span>
          </div>
          <div className="space-y-2.5">
            {research.management.map((m, i) => {
              const sentColor =
                m.sentiment === "positive"
                  ? "border-l-gs-pos"
                  : m.sentiment === "negative"
                    ? "border-l-gs-neg"
                    : "border-l-gs-textDim";
              return (
                <div
                  key={i}
                  className={`gs-card p-4 border-l-2 ${sentColor}`}
                  data-testid={`mgmt-quote-${i}`}
                >
                  <Quote className="w-3.5 h-3.5 text-gs-gold mb-2 opacity-70" />
                  <p className="text-[12.5px] text-gs-text leading-relaxed font-display font-medium">
                    {m.quote}
                  </p>
                  <div className="mt-3 pt-3 border-t border-gs-border flex items-center justify-between">
                    <div>
                      <div className="font-mono text-[11px] text-gs-text">{m.author}</div>
                      <div className="font-mono text-[9.5px] uppercase tracking-wider text-gs-textDim mt-0.5">
                        {m.role}
                      </div>
                    </div>
                    <span className="font-mono text-[9.5px] uppercase tracking-wider text-gs-textDim">
                      {m.source}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Peer Comparison */}
      <div data-testid="peer-comparison">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <span className="gs-label">// Peer Comparison · {stock.sector}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
            {peers.length} peers
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {peers.map((p) => (
            <Link
              to={`/stock/${p.ticker}`}
              key={p.ticker}
              className="gs-card p-4 hover:bg-gs-cardHover transition-colors group"
              data-testid={`peer-card-${p.ticker}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-[12.5px] font-semibold text-gs-text tracking-wider">
                  {p.ticker}
                </span>
                {p.changePct >= 0 ? (
                  <TrendingUp className="w-3.5 h-3.5 text-gs-pos" />
                ) : (
                  <TrendingDown className="w-3.5 h-3.5 text-gs-neg" />
                )}
              </div>
              <div className="text-[11px] text-gs-textMuted truncate">{p.name}</div>
              <div className="mt-3 pt-3 border-t border-gs-border grid grid-cols-2 gap-2">
                <div>
                  <div className="gs-label">Price</div>
                  <div className="font-mono text-[12px] text-gs-text mt-0.5 tabular-nums">
                    ₹{p.price.toFixed(2)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="gs-label">1D</div>
                  <div
                    className={`font-mono text-[12px] mt-0.5 tabular-nums ${
                      p.changePct >= 0 ? "text-gs-pos" : "text-gs-neg"
                    }`}
                  >
                    {p.changePct >= 0 ? "+" : ""}{p.changePct.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="gs-label">Mkt Cap</div>
                  <div className="font-mono text-[11px] text-gs-text mt-0.5">{p.marketCap}</div>
                </div>
                <div className="text-right">
                  <div className="gs-label">P/E</div>
                  <div className="font-mono text-[11px] text-gs-text mt-0.5 tabular-nums">
                    {p.pe?.toFixed(1)}x
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* News */}
      <div className="gs-card p-5" data-testid="related-news">
        <h3 className="font-display font-bold text-gs-text mb-3">Related News</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {NEWS_FEED.slice(0, 4).map((n) => (
            <div
              key={n.id}
              className="gs-card p-3.5 bg-gs-bg/40 hover:bg-gs-cardHover transition-colors cursor-pointer"
            >
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
  );
}
