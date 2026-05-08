import { Briefcase, BookOpen, Target, Workflow, ShieldCheck, Clock } from "lucide-react";

const BENEFITS = [
  {
    icon: Briefcase,
    title: "For Equity Analysts",
    desc: "Compress earnings season — synthesise calls, surface deltas, build comp tables and source-cite every claim.",
    metric: "10x faster turnaround",
  },
  {
    icon: BookOpen,
    title: "For Researchers",
    desc: "Cross-reference filings, transcripts and consensus across hundreds of names — auto-tagged by sector and theme.",
    metric: "5,200+ stocks indexed",
  },
  {
    icon: Target,
    title: "For PMs & Traders",
    desc: "Watchlists, sector heatmaps, real-time-style flow telemetry and risk flags — all in one institutional workspace.",
    metric: "<200ms widget latency",
  },
  {
    icon: Workflow,
    title: "For Finance Students",
    desc: "Learn equity research the institutional way — methodology pane, source citations, and AI-tutored thesis builder.",
    metric: "8 case-study modules",
  },
  {
    icon: ShieldCheck,
    title: "Audit-grade Citations",
    desc: "Every AI claim is traced to its primary source — filings, transcripts, consensus or exchange disclosures.",
    metric: "100% source-traced",
  },
  {
    icon: Clock,
    title: "Built for Indian Hours",
    desc: "Pre-market briefs, intraday flow signals, and post-close earnings synthesis — synced to NSE/BSE rhythm.",
    metric: "09:00 — 15:30 IST live",
  },
];

export default function InstitutionalBenefits() {
  return (
    <section
      className="relative py-20 sm:py-28 border-y border-gs-border bg-gs-panel/30"
      data-testid="institutional-benefits-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="max-w-3xl mb-12">
          <div className="gs-label">// Institutional Benefits</div>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
            One terminal,
            <br />
            <span className="text-gs-gold">five professional workflows.</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {BENEFITS.map((b, i) => {
            const Icon = b.icon;
            return (
              <div
                key={b.title}
                className="gs-card p-6 hover:bg-gs-cardHover transition-colors group relative"
                data-testid={`benefit-${i}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="w-10 h-10 grid place-items-center rounded-sm bg-gs-bg border border-gs-border group-hover:border-gs-gold/40 transition-colors">
                    <Icon className="w-4 h-4 text-gs-gold" />
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-gs-pos bg-gs-posBg border border-gs-pos/30 rounded-sm px-1.5 py-0.5">
                    {b.metric}
                  </span>
                </div>
                <h3 className="font-display font-bold text-gs-text text-[16px]">{b.title}</h3>
                <p className="text-[12.5px] text-gs-textMuted mt-2 leading-relaxed">
                  {b.desc}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
