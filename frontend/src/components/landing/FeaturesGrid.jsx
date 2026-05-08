import {
  CalendarClock,
  Layers,
  MessageSquare,
  Sparkles,
  ShieldAlert,
  Star,
  TrendingUp,
  FileText,
} from "lucide-react";

const FEATURES = [
  {
    icon: Sparkles,
    title: "AI-Generated Equity Research",
    desc: "Synthesise filings, transcripts and consensus into institutional-quality research notes — in seconds.",
    accent: true,
  },
  {
    icon: CalendarClock,
    title: "Earnings Intelligence",
    desc: "Real-time earnings calendar, beat/miss telemetry and post-print AI commentary on every key Indian print.",
  },
  {
    icon: Layers,
    title: "Sector Intelligence",
    desc: "Heatmaps and capital-flow analytics across Defence, Railways, Banking, Green Energy and 4 more sectors.",
  },
  {
    icon: MessageSquare,
    title: "Management Commentary Lens",
    desc: "Surface tone, sentiment and forward-looking signals from earnings calls — automatically tagged.",
  },
  {
    icon: TrendingUp,
    title: "Institutional Dashboards",
    desc: "Bloomberg-style KPI grids, intraday charts and multi-asset views purpose-built for Indian markets.",
    accent: true,
  },
  {
    icon: ShieldAlert,
    title: "Risk Analysis",
    desc: "AI-flagged red flags across leverage, working-capital, governance and disclosure quality.",
  },
  {
    icon: Star,
    title: "Smart Watchlists",
    desc: "Thematic baskets with sparklines, sector tagging and AI alerts on material moves.",
  },
  {
    icon: FileText,
    title: "AI Research Assistant",
    desc: "A conversational copilot that thinks like a sell-side analyst — built for Indian equity nuance.",
  },
];

export default function FeaturesGrid() {
  return (
    <section
      id="features-grid"
      className="relative py-20 sm:py-28"
      data-testid="features-grid-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="max-w-3xl mb-12">
          <div className="gs-label">// Capabilities</div>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
            Everything an institutional desk has,
            <br />
            <span className="text-gs-gold">re-built around AI.</span>
          </h2>
          <p className="text-[15px] text-gs-textMuted mt-3 leading-relaxed">
            Eight purpose-built modules that compress hours of analyst grind into seconds.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 gs-stagger">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className={`gs-card p-5 hover:bg-gs-cardHover transition-colors group relative overflow-hidden ${
                  f.accent ? "border-l-2 border-l-gs-gold" : ""
                }`}
                data-testid={`feature-${i}`}
              >
                <span className="absolute top-2 right-2 font-mono text-[10px] text-gs-textDim/60">
                  0{i + 1}
                </span>
                <div className="w-9 h-9 grid place-items-center rounded-sm bg-gs-bg border border-gs-border mb-4 group-hover:border-gs-gold/40 transition-colors">
                  <Icon
                    className={`w-4 h-4 ${
                      f.accent ? "text-gs-gold" : "text-gs-textMuted group-hover:text-gs-gold"
                    } transition-colors`}
                  />
                </div>
                <h3 className="font-display font-bold text-gs-text text-[15px] leading-snug">
                  {f.title}
                </h3>
                <p className="text-[12.5px] text-gs-textMuted mt-2 leading-relaxed">
                  {f.desc}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
