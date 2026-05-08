import { TrendingUp, Database, Sparkles, Globe2 } from "lucide-react";

const STATS = [
  { value: "5,200+", label: "Stocks indexed", icon: TrendingUp },
  { value: "1.2M", label: "Filings + transcripts", icon: Database },
  { value: "7", label: "Indian sectors", icon: Globe2 },
  { value: "24/7", label: "AI synthesis engine", icon: Sparkles },
];

export default function MarketIntelligence() {
  return (
    <section
      className="relative py-12 border-b border-gs-border bg-gs-panel/40"
      data-testid="market-intelligence-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-gs-border border-x border-gs-border">
          {STATS.map((s, i) => {
            const Icon = s.icon;
            return (
              <div
                key={s.label}
                className="px-4 sm:px-6 py-6 flex items-center gap-4"
                data-testid={`stat-${i}`}
              >
                <Icon className="w-4 h-4 text-gs-gold shrink-0" />
                <div>
                  <div className="font-display text-2xl sm:text-3xl font-bold text-gs-text tabular-nums leading-none">
                    {s.value}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim mt-1.5">
                    {s.label}
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
