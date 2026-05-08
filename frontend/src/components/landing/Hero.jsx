import { useNavigate } from "react-router-dom";
import { ArrowUpRight, PlayCircle, Sparkles } from "lucide-react";
import KPITile from "@/components/widgets/KPITile";
import AIInsightCard from "@/components/widgets/AIInsightCard";
import { INDICES, AI_INSIGHTS } from "@/data/mockData";

export default function Hero() {
  const navigate = useNavigate();

  return (
    <section
      className="relative pt-28 sm:pt-36 pb-16 sm:pb-24 overflow-hidden"
      data-testid="hero-section"
    >
      {/* Decorative background */}
      <div
        className="absolute inset-0 pointer-events-none opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(700px circle at 80% 0%, rgba(212,175,55,0.10), transparent 55%), radial-gradient(900px circle at 0% 60%, rgba(37,99,235,0.06), transparent 60%)",
        }}
      />
      <div className="absolute inset-0 grid-bg opacity-40 pointer-events-none" />
      <div
        className="absolute left-0 right-0 top-16 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(212,175,55,0.45), transparent)",
        }}
      />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-8 items-start">
          {/* Left text */}
          <div className="col-span-12 lg:col-span-7 animate-fade-up">
            <div className="inline-flex items-center gap-2 bg-gs-card border border-gs-border rounded-sm px-3 py-1.5 mb-6">
              <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-gs-text">
                AI Research · Indian Equities · v1.4
              </span>
            </div>

            <h1 className="font-display font-extrabold text-gs-text text-[40px] sm:text-5xl lg:text-[64px] leading-[1.05] tracking-tight">
              The Bloomberg Terminal,
              <br />
              <span className="text-gs-gold">re-imagined for India.</span>
            </h1>

            <p className="mt-6 text-[15px] sm:text-[16px] text-gs-textMuted leading-relaxed max-w-xl">
              GrowthSquad is an AI-native institutional research terminal purpose-built for
              Indian equity investors, analysts and researchers. Earnings intelligence, sector
              flows, management commentary and an AI copilot — all in one workspace.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                onClick={() => navigate("/dashboard")}
                className="group inline-flex items-center gap-2 bg-gs-gold text-gs-bg font-semibold text-[13.5px] px-5 py-3 rounded-sm hover:bg-gs-gold/90 transition-colors"
                data-testid="hero-cta-launch"
              >
                Launch Terminal
                <ArrowUpRight className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
              </button>
              <button
                className="inline-flex items-center gap-2 border border-gs-border bg-gs-card text-gs-text font-medium text-[13.5px] px-5 py-3 rounded-sm hover:border-gs-textDim/60 transition-colors"
                data-testid="hero-cta-demo"
              >
                <PlayCircle className="w-4 h-4 text-gs-gold" />
                Watch 90-second demo
              </button>
            </div>

            <div className="mt-10 flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="flex -space-x-2">
                  {["AR", "PS", "RM"].map((i, idx) => (
                    <div
                      key={i}
                      className="w-7 h-7 rounded-full border-2 border-gs-bg grid place-items-center text-[10px] font-semibold text-gs-bg"
                      style={{
                        background: ["#D4AF37", "#059669", "#2563EB"][idx],
                      }}
                    >
                      {i}
                    </div>
                  ))}
                </div>
                <span className="text-[12px] text-gs-textMuted">
                  <span className="text-gs-text font-semibold">2,400+</span> investors and
                  analysts on the waitlist
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {[1, 2, 3, 4, 5].map((s) => (
                  <span key={s} className="text-gs-gold text-sm">★</span>
                ))}
                <span className="text-[12px] text-gs-textMuted ml-1">
                  4.9 / 5 from early access cohort
                </span>
              </div>
            </div>
          </div>

          {/* Right preview */}
          <div className="col-span-12 lg:col-span-5 animate-fade-up" style={{ animationDelay: "0.15s" }}>
            <div className="relative">
              <div
                className="absolute -inset-3 rounded-sm pointer-events-none opacity-70"
                style={{
                  background:
                    "radial-gradient(closest-side, rgba(212,175,55,0.15), transparent)",
                }}
              />
              <div className="relative gs-card p-3">
                {/* Browser-like frame */}
                <div className="flex items-center gap-1.5 px-2 pb-2 border-b border-gs-border">
                  <span className="w-2 h-2 rounded-full bg-gs-neg/70" />
                  <span className="w-2 h-2 rounded-full bg-gs-gold/70" />
                  <span className="w-2 h-2 rounded-full bg-gs-pos/70" />
                  <span className="ml-3 font-mono text-[10px] text-gs-textDim tracking-wider uppercase">
                    growthsquad.ai · /dashboard
                  </span>
                </div>

                <div className="p-3 grid grid-cols-2 gap-3">
                  <KPITile {...INDICES[0]} />
                  <KPITile {...INDICES[1]} />
                </div>
                <div className="px-3 pb-3">
                  <AIInsightCard insight={AI_INSIGHTS[0]} />
                </div>
              </div>

              {/* Floating badge */}
              <div className="hidden sm:flex absolute -left-6 top-1/2 -translate-y-1/2 items-center gap-2 bg-gs-card border border-gs-border rounded-sm px-3 py-2 shadow-inset-hi">
                <span className="w-2 h-2 rounded-full bg-gs-pos animate-pulse-dot" />
                <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textMuted">
                  Live Market
                </span>
              </div>
              <div className="hidden sm:flex absolute -right-4 -bottom-4 items-center gap-2 bg-gs-card border border-gs-gold/40 rounded-sm px-3 py-2 shadow-gold-glow">
                <Sparkles className="w-3 h-3 text-gs-gold" />
                <span className="font-mono text-[10px] uppercase tracking-wider text-gs-gold">
                  AI Insight · 92%
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
