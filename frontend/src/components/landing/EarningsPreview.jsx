import { CalendarClock, Sparkles, ArrowUpRight, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { EARNINGS_CALENDAR } from "@/data/mockData";

export default function EarningsPreview() {
  const upcoming = EARNINGS_CALENDAR.filter((e) => e.status === "upcoming").slice(0, 3);
  const reported = EARNINGS_CALENDAR.find((e) => e.status === "reported");

  return (
    <section
      id="earnings-preview"
      className="relative py-20 sm:py-28 border-y border-gs-border bg-gs-panel/30"
      data-testid="earnings-preview-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-10 items-start">
          <div className="col-span-12 lg:col-span-5">
            <div className="gs-label">// Earnings Intelligence</div>
            <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
              Never miss a print.
              <br />
              <span className="text-gs-gold">Always know what to ask.</span>
            </h2>
            <p className="text-[15px] text-gs-textMuted mt-4 leading-relaxed">
              A unified earnings command center — calendar, consensus estimates,
              beat/miss telemetry, and post-print AI commentary on every Indian print.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "Live calendar with consensus EPS & revenue estimates",
                "AI-curated 'what to watch' notes before each print",
                "Surprise telemetry & sector-wide beat/miss heatmap",
                "Earnings call sentiment + management tone analysis",
              ].map((b) => (
                <li key={b} className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-gs-pos shrink-0 mt-0.5" />
                  <span className="text-[13px] text-gs-textMuted">{b}</span>
                </li>
              ))}
            </ul>
            <Link
              to="/earnings"
              className="inline-flex items-center gap-1.5 text-gs-gold hover:text-gs-text text-[12.5px] font-mono uppercase tracking-wider mt-7"
              data-testid="earnings-preview-cta"
            >
              Explore Earnings Calendar <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* Earnings preview frame */}
          <div className="col-span-12 lg:col-span-7">
            <div className="gs-card p-4">
              <div className="flex items-center justify-between border-b border-gs-border pb-3 mb-4">
                <div className="flex items-center gap-2">
                  <CalendarClock className="w-3.5 h-3.5 text-gs-gold" />
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-gs-textMuted">
                    Earnings Calendar · Q3 FY26
                  </span>
                </div>
                <span className="font-mono text-[10.5px] text-gs-textDim">live</span>
              </div>

              <div className="space-y-2">
                {upcoming.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-4 px-3 py-2.5 bg-gs-bg/40 border border-gs-border rounded-sm hover:bg-gs-cardHover transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-gs-gold bg-gs-goldMuted border border-gs-gold/30 rounded-sm px-2 py-1 shrink-0">
                        {e.date}
                      </div>
                      <div className="min-w-0">
                        <div className="font-mono text-[12.5px] font-semibold text-gs-text tracking-wider">
                          {e.ticker}
                        </div>
                        <div className="text-[11px] text-gs-textMuted truncate">{e.name}</div>
                      </div>
                    </div>
                    <div className="hidden sm:block text-right">
                      <div className="gs-label">EPS Est.</div>
                      <div className="font-mono text-[12px] text-gs-text">
                        ₹{e.epsEst.toFixed(2)}
                      </div>
                    </div>
                    <div className="hidden md:block text-right">
                      <div className="gs-label">Revenue</div>
                      <div className="font-mono text-[12px] text-gs-text">{e.revenueEst}</div>
                    </div>
                  </div>
                ))}
              </div>

              {reported && (
                <div className="mt-3 gs-card p-4 border-l-2 border-l-gs-gold">
                  <div className="flex items-center gap-2 mb-2">
                    <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
                      Post-print AI lens · {reported.ticker}
                    </span>
                    <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-gs-pos bg-gs-posBg border border-gs-pos/30 rounded-sm px-1.5 py-0.5">
                      Beat +{reported.surprise.toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-[12.5px] text-gs-textMuted leading-relaxed">
                    {reported.aiNote}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
