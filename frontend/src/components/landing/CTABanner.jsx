import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Sparkles } from "lucide-react";

export default function CTABanner() {
  const navigate = useNavigate();
  return (
    <section
      className="relative py-20 sm:py-28 border-y border-gs-border overflow-hidden"
      data-testid="cta-banner-section"
    >
      {/* Decorative gold wash */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(900px circle at 80% 50%, rgba(212,175,55,0.10), transparent 55%), radial-gradient(700px circle at 0% 100%, rgba(37,99,235,0.06), transparent 60%)",
        }}
      />
      <div className="absolute inset-0 grid-bg opacity-50 pointer-events-none" />
      <div
        className="absolute left-0 right-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(212,175,55,0.5), transparent)",
        }}
      />

      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 text-center">
        <div className="inline-flex items-center gap-2 bg-gs-card border border-gs-border rounded-sm px-3 py-1.5 mb-6">
          <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
          <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-gs-text">
            Early Access · Q1 FY27 cohort
          </span>
        </div>
        <h2 className="font-display text-3xl sm:text-5xl lg:text-6xl font-extrabold text-gs-text leading-[1.05] tracking-tight">
          Stop reading charts.
          <br />
          <span className="text-gs-gold">Start understanding markets.</span>
        </h2>
        <p className="text-[15px] sm:text-[16px] text-gs-textMuted mt-5 max-w-2xl mx-auto leading-relaxed">
          Join 2,400+ Indian investors, analysts and researchers who are upgrading from
          generic stock apps to an institutional-grade AI research terminal.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => navigate("/dashboard")}
            className="group inline-flex items-center gap-2 bg-gs-gold text-gs-bg font-semibold text-[14px] px-6 py-3.5 rounded-sm hover:bg-gs-gold/90 transition-colors"
            data-testid="cta-launch"
          >
            Launch Terminal
            <ArrowUpRight className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
          </button>
          <button
            className="inline-flex items-center gap-2 bg-gs-card border border-gs-border text-gs-text font-medium text-[14px] px-6 py-3.5 rounded-sm hover:border-gs-gold/40 transition-colors"
            data-testid="cta-waitlist"
          >
            Join Waitlist
          </button>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-gs-textDim">
          <span>· No credit card</span>
          <span>· SEBI Research compliant</span>
          <span>· Cancel anytime</span>
        </div>
      </div>
    </section>
  );
}
