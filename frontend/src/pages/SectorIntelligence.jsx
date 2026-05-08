import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { TrendingUp, TrendingDown, Sparkles } from "lucide-react";
import { SECTORS, STOCKS, SECTOR_HEATMAP_DATA } from "@/data/mockData";
import SectorHeatmap from "@/components/widgets/SectorHeatmap";
import StockTable from "@/components/widgets/StockTable";

export default function SectorIntelligence() {
  const [active, setActive] = useState(SECTORS[0]);
  const navigate = useNavigate();

  const sectorStocks = STOCKS.filter((s) => s.sector === active.name);

  return (
    <div className="space-y-6 animate-fade-up" data-testid="sectors-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Sectoral Intelligence</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Sector Intelligence
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Capital flows, leadership rotation and AI-curated narratives across Indian sectors.
          </p>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim bg-gs-panel border border-gs-border px-2 py-1 rounded-sm">
          7 sectors • Q3 FY26
        </span>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Heatmap */}
        <div className="col-span-12 xl:col-span-8">
          <div className="gs-card p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-bold text-gs-text">
                Sector Performance · 1D
              </h3>
              <div className="flex items-center gap-2 text-[10px] font-mono text-gs-textDim">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 bg-gs-pos inline-block" /> Up
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 bg-gs-neg inline-block" /> Down
                </span>
              </div>
            </div>
            <SectorHeatmap data={SECTOR_HEATMAP_DATA} height={360} />
          </div>
        </div>

        {/* Sector list */}
        <div className="col-span-12 xl:col-span-4 space-y-2">
          <div className="gs-label mb-2">Sectors</div>
          {SECTORS.map((s) => {
            const isPos = s.changePct >= 0;
            const isActive = s.id === active.id;
            return (
              <button
                key={s.id}
                onClick={() => setActive(s)}
                className={`w-full text-left gs-card p-4 transition-colors ${
                  isActive
                    ? "border-l-2 border-l-gs-gold bg-gs-cardHover"
                    : "hover:bg-gs-cardHover"
                }`}
                data-testid={`sector-${s.id}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-display font-bold text-[14px] text-gs-text">
                      {s.name}
                    </div>
                    <div className="text-[11px] text-gs-textMuted">{s.marketCap}</div>
                  </div>
                  <div
                    className={`font-mono text-sm tabular-nums flex items-center gap-1 ${
                      isPos ? "text-gs-pos" : "text-gs-neg"
                    }`}
                  >
                    {isPos ? (
                      <TrendingUp className="w-3.5 h-3.5" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" />
                    )}
                    {isPos ? "+" : ""}
                    {s.changePct.toFixed(2)}%
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Sector deep-dive */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8 space-y-4">
          <div className="gs-card p-5 border-l-2 border-l-gs-gold">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
                AI Sector Narrative
              </span>
            </div>
            <h2 className="font-display text-xl font-bold text-gs-text mb-2">
              {active.name} — {active.headline}
            </h2>
            <p className="text-[13px] text-gs-textMuted leading-relaxed">
              The {active.name.toLowerCase()} basket is exhibiting a{" "}
              <span className={active.changePct >= 0 ? "text-gs-pos" : "text-gs-neg"}>
                {active.changePct >= 0 ? "constructive" : "defensive"}
              </span>{" "}
              tone, with leadership concentrated in {active.leaders.join(", ")}. Capital flow
              indicators suggest{" "}
              {active.changePct >= 0 ? "accumulation" : "rotation out of"} the basket over the
              past three sessions. Watch for institutional reposition into Q3FY26 prints.
            </p>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <div className="gs-label">Market Cap</div>
                <div className="font-mono text-sm text-gs-text mt-1">{active.marketCap}</div>
              </div>
              <div>
                <div className="gs-label">Index Wt.</div>
                <div className="font-mono text-sm text-gs-text mt-1">{active.weight}%</div>
              </div>
              <div>
                <div className="gs-label">Leaders</div>
                <div className="font-mono text-sm text-gs-text mt-1">{active.leaders[0]}</div>
              </div>
            </div>
          </div>

          <StockTable rows={sectorStocks} title={`${active.name} · Constituents`} showSector={false} />
        </div>

        <div className="col-span-12 lg:col-span-4">
          <div className="gs-card p-5">
            <h3 className="font-display font-bold text-gs-text mb-3">Sector Snapshot</h3>
            <div className="space-y-3">
              {[
                ["Headline P/E", "28.4x"],
                ["FY26E EPS Growth", "21.3%"],
                ["FII Flow (1M)", "+₹3,420 Cr"],
                ["DII Flow (1M)", "+₹1,820 Cr"],
                ["Institutional Sentiment", "Positive"],
                ["AI Confidence Score", "84 / 100"],
              ].map(([k, v]) => (
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
        </div>
      </div>
    </div>
  );
}
