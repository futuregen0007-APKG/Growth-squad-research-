import { Check, X } from "lucide-react";

const ROWS = [
  { label: "Indian-equity-tuned AI", us: true, them: false },
  { label: "Earnings calendar + AI commentary", us: true, them: false },
  { label: "Sector heatmaps & capital flow telemetry", us: true, them: "partial" },
  { label: "Management tone & sentiment analysis", us: true, them: false },
  { label: "Bloomberg-style institutional dashboards", us: true, them: false },
  { label: "Conversational research copilot", us: true, them: false },
  { label: "Real-time price ticker", us: true, them: true },
  { label: "Watchlists with sparklines", us: true, them: true },
];

const Cell = ({ state }) => {
  if (state === true)
    return (
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-sm bg-gs-posBg border border-gs-pos/30">
        <Check className="w-3.5 h-3.5 text-gs-pos" />
      </span>
    );
  if (state === "partial")
    return (
      <span className="font-mono text-[10px] uppercase tracking-wider text-gs-gold bg-gs-goldMuted border border-gs-gold/30 rounded-sm px-2 py-1">
        Partial
      </span>
    );
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-sm bg-gs-bg border border-gs-border">
      <X className="w-3.5 h-3.5 text-gs-textDim" />
    </span>
  );
};

export default function WhyGrowthSquad() {
  return (
    <section
      id="why-growthsquad"
      className="relative py-20 sm:py-28"
      data-testid="why-growthsquad-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-10 items-start">
          <div className="col-span-12 lg:col-span-5">
            <div className="gs-label">// Why GrowthSquad</div>
            <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
              Built for serious investors.
              <br />
              <span className="text-gs-gold">Not for casual scrollers.</span>
            </h2>
            <p className="text-[15px] text-gs-textMuted mt-4 leading-relaxed">
              Generic stock apps optimise for engagement. GrowthSquad optimises for{" "}
              <span className="text-gs-text">conviction</span>. We don't show charts and call
              it research — we synthesise primary sources, stress-test theses, and surface
              what actually matters.
            </p>
            <div className="mt-6 grid grid-cols-3 gap-3">
              {[
                ["AI-First", "Not retrofitted"],
                ["Indian-Focused", "Not generic"],
                ["Research-Grade", "Not entertainment"],
              ].map(([t, s]) => (
                <div key={t} className="gs-card p-3">
                  <div className="font-display font-bold text-gs-text text-[13px]">{t}</div>
                  <div className="text-[10.5px] text-gs-textDim mt-1">{s}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Comparison table */}
          <div className="col-span-12 lg:col-span-7">
            <div className="gs-card p-5">
              <div className="grid grid-cols-12 gap-4 items-center pb-3 border-b border-gs-border">
                <div className="col-span-6 gs-label">Capability</div>
                <div className="col-span-3 text-center">
                  <div className="font-display font-bold text-gs-gold text-sm">GrowthSquad</div>
                  <div className="gs-label mt-0.5">Research Terminal</div>
                </div>
                <div className="col-span-3 text-center">
                  <div className="font-display font-bold text-gs-textMuted text-sm">Generic</div>
                  <div className="gs-label mt-0.5">Stock Apps</div>
                </div>
              </div>

              {ROWS.map((r, i) => (
                <div
                  key={r.label}
                  className={`grid grid-cols-12 gap-4 items-center py-3 ${
                    i < ROWS.length - 1 ? "border-b border-gs-border" : ""
                  }`}
                >
                  <div className="col-span-6 text-[13px] text-gs-text">{r.label}</div>
                  <div className="col-span-3 grid place-items-center">
                    <Cell state={r.us} />
                  </div>
                  <div className="col-span-3 grid place-items-center">
                    <Cell state={r.them} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
