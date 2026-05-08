import { Activity, Gauge, Sparkles, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { MARKET_BREADTH, SENTIMENT, INSTITUTIONAL_FLOWS } from "@/data/mockData";

const FlowMini = ({ label, oneD, fiveD, oneM }) => (
  <div className="bg-gs-bg/60 border border-gs-border rounded-sm p-3">
    <div className="flex items-center justify-between mb-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim font-semibold">
        {label}
      </span>
      <span
        className={`font-mono text-[9.5px] uppercase tracking-wider ${
          oneD >= 0 ? "text-gs-pos" : "text-gs-neg"
        }`}
      >
        {oneD >= 0 ? "Buyers" : "Sellers"}
      </span>
    </div>
    <div
      className={`font-mono text-[16px] font-semibold tabular-nums ${
        oneD >= 0 ? "text-gs-pos" : "text-gs-neg"
      }`}
    >
      {oneD >= 0 ? "+" : ""}
      {oneD.toLocaleString("en-IN")}
    </div>
    <div className="mt-2 pt-2 border-t border-gs-border space-y-0.5 text-[10px] font-mono">
      <div className="flex items-center justify-between text-gs-textDim">
        <span>5D</span>
        <span className={fiveD >= 0 ? "text-gs-pos" : "text-gs-neg"}>
          {fiveD >= 0 ? "+" : ""}
          {fiveD.toLocaleString("en-IN")}
        </span>
      </div>
      <div className="flex items-center justify-between text-gs-textDim">
        <span>1M</span>
        <span className={oneM >= 0 ? "text-gs-pos" : "text-gs-neg"}>
          {oneM >= 0 ? "+" : ""}
          {oneM.toLocaleString("en-IN")}
        </span>
      </div>
    </div>
  </div>
);

export default function MarketSentiment() {
  const total =
    MARKET_BREADTH.advances + MARKET_BREADTH.declines + MARKET_BREADTH.unchanged;
  const advPct = (MARKET_BREADTH.advances / total) * 100;
  const decPct = (MARKET_BREADTH.declines / total) * 100;
  const uncPct = (MARKET_BREADTH.unchanged / total) * 100;
  const ratio = (MARKET_BREADTH.advances / MARKET_BREADTH.declines).toFixed(2);

  const score = SENTIMENT.fgScore;
  const scoreColor =
    score >= 70 ? "#059669" : score >= 50 ? "#D4AF37" : score >= 30 ? "#EA580C" : "#DC2626";

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="market-sentiment">
      {/* Market Breadth */}
      <div className="gs-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-gs-textDim" />
            <span className="gs-label">Market Breadth · {MARKET_BREADTH.exchange}</span>
          </div>
          <span className="font-mono text-[10px] text-gs-pos bg-gs-posBg border border-gs-pos/30 rounded-sm px-1.5 py-0.5">
            A/D {ratio}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <div className="font-mono text-[9.5px] text-gs-textDim uppercase tracking-wider">
              Advances
            </div>
            <div className="font-mono text-[18px] text-gs-pos tabular-nums leading-tight">
              {MARKET_BREADTH.advances}
            </div>
          </div>
          <div className="text-center">
            <div className="font-mono text-[9.5px] text-gs-textDim uppercase tracking-wider">
              Unchanged
            </div>
            <div className="font-mono text-[18px] text-gs-textMuted tabular-nums leading-tight">
              {MARKET_BREADTH.unchanged}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[9.5px] text-gs-textDim uppercase tracking-wider">
              Declines
            </div>
            <div className="font-mono text-[18px] text-gs-neg tabular-nums leading-tight">
              {MARKET_BREADTH.declines}
            </div>
          </div>
        </div>
        <div className="flex h-1.5 rounded-sm overflow-hidden bg-gs-bg">
          <div className="bg-gs-pos" style={{ width: `${advPct}%` }} />
          <div className="bg-gs-textDim/40" style={{ width: `${uncPct}%` }} />
          <div className="bg-gs-neg" style={{ width: `${decPct}%` }} />
        </div>
        <div className="mt-3 pt-3 border-t border-gs-border flex items-center justify-between text-[10.5px] font-mono">
          <span className="text-gs-textDim">
            52W Highs <span className="text-gs-pos">{MARKET_BREADTH.newHighs}</span>
          </span>
          <span className="text-gs-textDim">
            52W Lows <span className="text-gs-neg">{MARKET_BREADTH.newLows}</span>
          </span>
        </div>
      </div>

      {/* AI Sentiment Gauge */}
      <div className="gs-card gs-card-glow-gold p-4 border-l-2 border-l-gs-gold">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Gauge className="w-3.5 h-3.5 text-gs-gold" />
            <span className="gs-label">AI Sentiment Index</span>
          </div>
          <Sparkles className="w-3 h-3 text-gs-gold" />
        </div>
        <div className="flex items-baseline gap-3">
          <div className="font-display text-[34px] font-bold text-gs-text tabular-nums leading-none">
            {score}
          </div>
          <div className="leading-tight">
            <div
              className="font-display font-bold text-[14px]"
              style={{ color: scoreColor }}
            >
              {SENTIMENT.fgLabel}
            </div>
            <div className="text-[10.5px] text-gs-textDim font-mono">/ 100</div>
          </div>
        </div>
        <div className="mt-4">
          <div
            className="relative h-2 rounded-sm overflow-hidden"
            style={{
              background:
                "linear-gradient(90deg, #DC2626 0%, #EA580C 25%, #D4AF37 50%, #059669 75%, #047857 100%)",
            }}
          >
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white border-2 border-gs-bg shadow-md"
              style={{ left: `calc(${score}% - 6px)` }}
            />
          </div>
          <div className="flex items-center justify-between text-[9.5px] font-mono text-gs-textDim mt-1.5 uppercase tracking-wider">
            <span>Fear</span>
            <span>Neutral</span>
            <span>Greed</span>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-gs-border grid grid-cols-3 gap-1 text-[10px] font-mono">
          <div>
            <div className="text-gs-textDim uppercase tracking-wider text-[9px]">PCR</div>
            <div className="text-gs-text mt-0.5">{SENTIMENT.putCallRatio}</div>
          </div>
          <div>
            <div className="text-gs-textDim uppercase tracking-wider text-[9px]">VIX</div>
            <div className="text-gs-pos mt-0.5">cooling</div>
          </div>
          <div>
            <div className="text-gs-textDim uppercase tracking-wider text-[9px]">Bull/Bear</div>
            <div className="text-gs-text mt-0.5">
              {SENTIMENT.bullPct}/{SENTIMENT.bearPct}
            </div>
          </div>
        </div>
      </div>

      {/* Institutional Flows */}
      <div className="gs-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {INSTITUTIONAL_FLOWS.fii["1D"] >= 0 ? (
              <ArrowUpRight className="w-3.5 h-3.5 text-gs-pos" />
            ) : (
              <ArrowDownRight className="w-3.5 h-3.5 text-gs-neg" />
            )}
            <span className="gs-label">Institutional Flows · ₹ Cr</span>
          </div>
          <span className="font-mono text-[10px] text-gs-textDim">
            as of {INSTITUTIONAL_FLOWS.asOf}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <FlowMini
            label="FII"
            oneD={INSTITUTIONAL_FLOWS.fii["1D"]}
            fiveD={INSTITUTIONAL_FLOWS.fii["5D"]}
            oneM={INSTITUTIONAL_FLOWS.fii["1M"]}
          />
          <FlowMini
            label="DII"
            oneD={INSTITUTIONAL_FLOWS.dii["1D"]}
            fiveD={INSTITUTIONAL_FLOWS.dii["5D"]}
            oneM={INSTITUTIONAL_FLOWS.dii["1M"]}
          />
        </div>
      </div>
    </div>
  );
}
