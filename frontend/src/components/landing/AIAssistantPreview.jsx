import { Link } from "react-router-dom";
import { Sparkles, ArrowUpRight, Send, CheckCircle2 } from "lucide-react";

const PREVIEW_QUERY = "Build a thesis on Indian railway capex theme.";

const PREVIEW_REPLY = [
  { type: "h", text: "Indian Railway Capex Theme — Thesis" },
  { type: "h2", text: "Macro setup" },
  { type: "li", text: "FY26 budgetary capex ₹2.65L Cr — highest ever, +12% YoY" },
  { type: "li", text: "5-year cumulative outlay ₹13L Cr across track, rolling stock, electrification" },
  { type: "h2", text: "Beneficiary mapping" },
  { type: "li", text: "Rolling stock: TITAGARH, TEXRAIL (Vande Bharat, metro coaches)" },
  { type: "li", text: "EPC + Track: RVNL, IRCON, KEC (high-margin L1 contracts)" },
  { type: "verdict", text: "Verdict — OVERWEIGHT · Top picks: RVNL, TITAGARH, RAILTEL" },
];

export default function AIAssistantPreview() {
  return (
    <section
      id="ai-assistant-preview"
      className="relative py-20 sm:py-28"
      data-testid="ai-assistant-preview-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-10 items-center">
          {/* Chat preview frame (left on desktop) */}
          <div className="col-span-12 lg:col-span-7 order-2 lg:order-1">
            <div className="relative">
              <div
                className="absolute -inset-4 rounded-sm pointer-events-none opacity-70"
                style={{
                  background:
                    "radial-gradient(closest-side, rgba(212,175,55,0.10), transparent)",
                }}
              />
              <div className="relative gs-card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gs-border">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm">
                      <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
                    </div>
                    <div className="leading-tight">
                      <div className="font-display font-bold text-gs-text text-sm">
                        GS Research Copilot
                      </div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                        Indian Equities · v1.4
                      </div>
                    </div>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-gs-pos flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-gs-pos animate-pulse-dot" />
                    online
                  </span>
                </div>

                <div className="p-5 space-y-5 max-h-[420px] overflow-hidden">
                  {/* User msg */}
                  <div className="flex justify-end">
                    <div className="bg-gs-card border border-gs-border rounded-sm px-4 py-2.5 max-w-[80%] text-[13px] text-gs-text">
                      {PREVIEW_QUERY}
                    </div>
                  </div>

                  {/* AI msg */}
                  <div className="flex gap-3">
                    <div className="w-7 h-7 shrink-0 grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm">
                      <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
                    </div>
                    <div className="flex-1 max-w-[90%] pt-0.5 space-y-1">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-gs-gold mb-2">
                        GS Copilot · synthesised from filings + budget docs
                      </div>
                      {PREVIEW_REPLY.map((r, i) => {
                        if (r.type === "h")
                          return (
                            <h4
                              key={i}
                              className="font-display font-bold text-gs-text mt-2 mb-1.5 text-[14px]"
                            >
                              {r.text}
                            </h4>
                          );
                        if (r.type === "h2")
                          return (
                            <div
                              key={i}
                              className="font-display font-semibold text-gs-text mt-3 mb-1 text-[12.5px]"
                            >
                              {r.text}
                            </div>
                          );
                        if (r.type === "li")
                          return (
                            <div
                              key={i}
                              className="flex items-start gap-2 text-[12.5px] text-gs-textMuted leading-relaxed"
                            >
                              <CheckCircle2 className="w-3 h-3 text-gs-gold mt-1 shrink-0" />
                              <span
                                dangerouslySetInnerHTML={{
                                  __html: r.text.replace(
                                    /\b([A-Z]{3,10})\b/g,
                                    '<span class="font-mono text-gs-text">$1</span>',
                                  ),
                                }}
                              />
                            </div>
                          );
                        if (r.type === "verdict")
                          return (
                            <div
                              key={i}
                              className="mt-4 inline-flex items-center gap-2 bg-gs-posBg text-gs-pos border border-gs-pos/30 rounded-sm px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider"
                            >
                              {r.text}
                            </div>
                          );
                        return null;
                      })}
                    </div>
                  </div>
                </div>

                {/* Input mock */}
                <div className="border-t border-gs-border p-3 flex gap-2 items-center">
                  <div className="flex-1 bg-gs-bg border border-gs-border rounded-sm px-3 py-2.5 text-[12px] text-gs-textDim">
                    Ask about a stock, sector, earnings call or thesis…
                  </div>
                  <div className="bg-gs-gold text-gs-bg px-3 py-2.5 rounded-sm font-medium text-[12px] flex items-center gap-1.5">
                    <Send className="w-3.5 h-3.5" /> Send
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Copy (right on desktop) */}
          <div className="col-span-12 lg:col-span-5 order-1 lg:order-2">
            <div className="gs-label">// AI Research Copilot</div>
            <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
              An analyst on every desk.
              <br />
              <span className="text-gs-gold">Trained on Indian markets.</span>
            </h2>
            <p className="text-[15px] text-gs-textMuted mt-4 leading-relaxed">
              Conversational equity research that thinks like a sell-side analyst — earnings
              synthesis, sector theses, peer comps and risk flagging in seconds.
            </p>
            <Link
              to="/ai-research"
              className="inline-flex items-center gap-1.5 mt-6 bg-gs-card border border-gs-border text-gs-text px-4 py-2.5 rounded-sm hover:border-gs-gold/40 transition-colors text-[13px]"
              data-testid="ai-preview-cta"
            >
              <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
              Open AI Copilot
              <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
