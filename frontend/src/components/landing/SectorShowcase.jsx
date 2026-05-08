import { Building2, Train, Leaf, Factory, Landmark, HardHat, HeartPulse } from "lucide-react";
import Sparkline from "@/components/widgets/Sparkline";
import { SECTORS, STOCKS } from "@/data/mockData";

const SECTOR_ICON = {
  Defence: Building2,
  Railways: Train,
  "Green Energy": Leaf,
  Manufacturing: Factory,
  Banking: Landmark,
  Infrastructure: HardHat,
  Healthcare: HeartPulse,
};

export default function SectorShowcase() {
  return (
    <section
      id="sector-showcase"
      className="relative py-20 sm:py-28"
      data-testid="sector-showcase-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-end justify-between flex-wrap gap-4 mb-10">
          <div className="max-w-3xl">
            <div className="gs-label">// Sector Intelligence</div>
            <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
              Seven Indian sectors.
              <br />
              <span className="text-gs-gold">One unified intelligence layer.</span>
            </h2>
            <p className="text-[15px] text-gs-textMuted mt-3 leading-relaxed">
              Capital flows, leadership rotation and AI-curated narratives across the
              themes shaping India's next decade.
            </p>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-wider text-gs-textDim bg-gs-panel border border-gs-border px-3 py-1.5 rounded-sm">
            Q3 FY26 · live
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 gs-stagger">
          {SECTORS.map((s, i) => {
            const Icon = SECTOR_ICON[s.name] || Building2;
            const isPos = s.changePct >= 0;
            const sample = STOCKS.find((x) => x.sector === s.name);
            return (
              <div
                key={s.id}
                className="gs-card p-5 hover:bg-gs-cardHover transition-colors group relative overflow-hidden"
                data-testid={`sector-card-${s.id}`}
              >
                <span className="absolute top-2 right-3 font-mono text-[10px] text-gs-textDim/50">
                  0{i + 1}
                </span>
                <div className="flex items-start justify-between mb-3">
                  <div className="w-9 h-9 grid place-items-center rounded-sm bg-gs-bg border border-gs-border group-hover:border-gs-gold/40 transition-colors">
                    <Icon className="w-4 h-4 text-gs-textMuted group-hover:text-gs-gold transition-colors" />
                  </div>
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      isPos ? "text-gs-pos" : "text-gs-neg"
                    }`}
                  >
                    {isPos ? "+" : ""}
                    {s.changePct.toFixed(2)}%
                  </span>
                </div>
                <h3 className="font-display font-bold text-gs-text text-[16px]">{s.name}</h3>
                <p className="text-[11.5px] text-gs-textMuted mt-1 leading-snug line-clamp-2">
                  {s.headline}
                </p>

                <div className="mt-3 -mx-1">
                  {sample && <Sparkline data={sample.series} positive={isPos} height={32} />}
                </div>

                <div className="mt-3 pt-3 border-t border-gs-border flex items-center justify-between">
                  <div>
                    <div className="gs-label">Mkt Cap</div>
                    <div className="font-mono text-[11.5px] text-gs-text mt-0.5">
                      {s.marketCap}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="gs-label">Leaders</div>
                    <div className="font-mono text-[11px] text-gs-text mt-0.5">
                      {s.leaders.slice(0, 2).join(" · ")}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
