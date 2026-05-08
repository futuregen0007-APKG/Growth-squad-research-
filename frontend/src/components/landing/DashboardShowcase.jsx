import { useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import KPITile from "@/components/widgets/KPITile";
import AIInsightCard from "@/components/widgets/AIInsightCard";
import SectorHeatmap from "@/components/widgets/SectorHeatmap";
import { INDICES, AI_INSIGHTS, SECTOR_HEATMAP_DATA, TOP_MOVERS } from "@/data/mockData";

export default function DashboardShowcase() {
  const navigate = useNavigate();

  return (
    <section
      id="dashboard-showcase"
      className="relative py-20 sm:py-28 border-y border-gs-border bg-gs-panel/20"
      data-testid="dashboard-showcase-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-end justify-between flex-wrap gap-4 mb-10">
          <div>
            <div className="gs-label">// Institutional Dashboard</div>
            <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight max-w-3xl">
              A control room for your
              <span className="text-gs-gold"> entire research workflow.</span>
            </h2>
            <p className="text-[15px] text-gs-textMuted mt-3 max-w-2xl leading-relaxed">
              Built like a Bloomberg Terminal — but with AI-native context. KPI tiles,
              sector heatmaps, real-time-style flows, and an embedded research copilot.
            </p>
          </div>
          <button
            onClick={() => navigate("/dashboard")}
            className="inline-flex items-center gap-1.5 text-gs-gold hover:text-gs-text text-[12.5px] font-mono uppercase tracking-wider"
            data-testid="showcase-cta"
          >
            Open Live Dashboard <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Mock terminal frame */}
        <div className="relative">
          <div
            className="absolute -inset-4 rounded-sm pointer-events-none opacity-60"
            style={{
              background:
                "radial-gradient(closest-side, rgba(212,175,55,0.10), transparent)",
            }}
          />
          <div className="relative gs-card p-3 sm:p-4">
            {/* Title strip */}
            <div className="flex items-center justify-between border-b border-gs-border pb-3 mb-4 px-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gs-pos animate-pulse-dot" />
                <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-gs-textMuted">
                  Workspace · Market Pulse · Q3 FY26
                </span>
              </div>
              <span className="font-mono text-[10.5px] text-gs-textDim tracking-wider">
                NSE · BSE · DELAYED
              </span>
            </div>

            <div className="grid grid-cols-12 gap-3 sm:gap-4">
              {/* KPI Row */}
              <div className="col-span-12 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {INDICES.map((i) => (
                  <KPITile key={i.symbol} {...i} />
                ))}
              </div>

              {/* AI insight + Heatmap */}
              <div className="col-span-12 lg:col-span-5">
                <AIInsightCard insight={AI_INSIGHTS[0]} />
              </div>
              <div className="col-span-12 lg:col-span-7 gs-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="gs-label">Sector Heatmap · 1D</div>
                  <span className="font-mono text-[10px] text-gs-textDim">7 sectors</span>
                </div>
                <SectorHeatmap data={SECTOR_HEATMAP_DATA} height={200} />
              </div>

              {/* Top Movers strip */}
              <div className="col-span-12 grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { title: "Top Gainers", data: TOP_MOVERS.gainers.slice(0, 3), pos: true },
                  { title: "Top Losers", data: TOP_MOVERS.losers.slice(0, 3), pos: false },
                ].map((blk) => (
                  <div key={blk.title} className="gs-card p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-display font-bold text-gs-text text-sm">
                        {blk.title}
                      </h4>
                      <span
                        className={`font-mono text-[10px] uppercase tracking-wider ${
                          blk.pos ? "text-gs-pos" : "text-gs-neg"
                        }`}
                      >
                        {blk.pos ? "▲" : "▼"} {blk.data.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {blk.data.map((s) => (
                        <div key={s.ticker} className="bg-gs-bg/50 border border-gs-border rounded-sm p-2">
                          <div className="font-mono text-[11px] font-semibold text-gs-text tracking-wider">
                            {s.ticker}
                          </div>
                          <div
                            className={`font-mono text-[11px] tabular-nums mt-1 ${
                              blk.pos ? "text-gs-pos" : "text-gs-neg"
                            }`}
                          >
                            {blk.pos ? "+" : ""}
                            {s.changePct.toFixed(2)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
