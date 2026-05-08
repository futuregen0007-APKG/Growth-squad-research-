import { Database, Cpu, Sparkles, ArrowRight } from "lucide-react";

const STEPS = [
  {
    num: "01",
    icon: Database,
    title: "Ingest",
    desc: "Filings, transcripts, exchange disclosures, sector data and consensus — all normalised in real-time.",
    sources: ["NSE / BSE", "Annual Reports", "Earnings Calls", "Sell-side Consensus"],
  },
  {
    num: "02",
    icon: Cpu,
    title: "Reason",
    desc: "Domain-tuned AI synthesises signals, cross-references peers and stress-tests narratives.",
    sources: ["Earnings ML", "Sentiment NLP", "Risk Flagging", "Peer Mapping"],
  },
  {
    num: "03",
    icon: Sparkles,
    title: "Deliver",
    desc: "Institutional-grade research notes, KPI dashboards, alerts and a conversational copilot — your workspace.",
    sources: ["Research Notes", "AI Insights", "Smart Alerts", "Copilot Chat"],
  },
];

export default function AIWorkflow() {
  return (
    <section
      id="ai-workflow"
      className="relative py-20 sm:py-28 border-y border-gs-border bg-gs-panel/30"
      data-testid="ai-workflow-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="max-w-3xl mb-14">
          <div className="gs-label">// AI Workflow</div>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
            How GrowthSquad thinks,
            <br />
            in <span className="text-gs-gold">three precise stages.</span>
          </h2>
          <p className="text-[15px] text-gs-textMuted mt-3 leading-relaxed">
            A purpose-built pipeline tuned for Indian equity nuance — not a generic LLM
            wrapper.
          </p>
        </div>

        <div className="relative grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Connecting gold line on desktop */}
          <div className="hidden lg:block absolute top-12 left-[16%] right-[16%] h-px bg-gradient-to-r from-transparent via-gs-gold/40 to-transparent" />

          {STEPS.map((s, idx) => {
            const Icon = s.icon;
            return (
              <div
                key={s.num}
                className="relative gs-card p-6"
                data-testid={`workflow-step-${idx}`}
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="w-10 h-10 grid place-items-center rounded-sm bg-gs-goldMuted border border-gs-gold/30">
                    <Icon className="w-4 h-4 text-gs-gold" />
                  </div>
                  <span className="font-display font-extrabold text-3xl text-gs-textDim/40 tabular-nums">
                    {s.num}
                  </span>
                </div>
                <h3 className="font-display font-bold text-gs-text text-xl">{s.title}</h3>
                <p className="text-[13px] text-gs-textMuted mt-2 leading-relaxed">{s.desc}</p>
                <div className="mt-4 pt-4 border-t border-gs-border">
                  <div className="gs-label mb-2">Sources & Models</div>
                  <div className="flex flex-wrap gap-1.5">
                    {s.sources.map((src) => (
                      <span
                        key={src}
                        className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 bg-gs-bg border border-gs-border rounded-sm text-gs-textMuted"
                      >
                        {src}
                      </span>
                    ))}
                  </div>
                </div>

                {idx < STEPS.length - 1 && (
                  <div className="hidden lg:flex absolute -right-3 top-12 w-6 h-6 rounded-full bg-gs-bg border border-gs-border items-center justify-center z-10">
                    <ArrowRight className="w-3 h-3 text-gs-gold" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
