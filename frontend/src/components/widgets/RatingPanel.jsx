import { Sparkles, ArrowUpRight, TrendingUp } from "lucide-react";

const verdictStyle = (v) => {
  switch (v) {
    case "BUY":
    case "STRONG BUY":
      return "bg-gs-posBg text-gs-pos border-gs-pos/40";
    case "ACCUMULATE":
      return "bg-gs-posBg text-gs-pos border-gs-pos/40";
    case "HOLD":
    case "NEUTRAL":
      return "bg-gs-goldMuted text-gs-gold border-gs-gold/40";
    case "REDUCE":
    case "SELL":
      return "bg-gs-negBg text-gs-neg border-gs-neg/40";
    default:
      return "bg-gs-card text-gs-textMuted border-gs-border";
  }
};

export default function RatingPanel({ rating, currentPrice }) {
  const total = rating.breakdown.buy + rating.breakdown.hold + rating.breakdown.sell;
  const buyPct = (rating.breakdown.buy / total) * 100;
  const holdPct = (rating.breakdown.hold / total) * 100;
  const sellPct = (rating.breakdown.sell / total) * 100;
  const upsidePct = +(((rating.target - currentPrice) / currentPrice) * 100).toFixed(1);
  const isUp = upsidePct >= 0;

  return (
    <div
      className="gs-card gs-card-glow-gold p-5 border-l-2 border-l-gs-gold relative overflow-hidden"
      data-testid="rating-panel"
    >
      <span
        className="absolute top-0 right-0 w-32 h-32 pointer-events-none opacity-50"
        style={{
          background:
            "radial-gradient(closest-side, rgba(212,175,55,0.10), transparent)",
        }}
      />

      <div className="flex items-center justify-between mb-4 relative">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
            Institutional Rating
          </span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
          updated {rating.lastUpdated}
        </span>
      </div>

      <div className="grid grid-cols-12 gap-4 items-center">
        {/* Verdict + score */}
        <div className="col-span-12 md:col-span-5">
          <div
            className={`inline-flex items-center gap-2 font-display font-extrabold rounded-sm px-3 py-1.5 border text-base tracking-wider ${verdictStyle(
              rating.verdict,
            )}`}
          >
            {rating.verdict}
          </div>
          <div className="flex items-baseline gap-3 mt-3">
            <span className="font-display font-extrabold text-5xl text-gs-text tabular-nums leading-none">
              {rating.score}
            </span>
            <span className="font-mono text-xs text-gs-textDim leading-none">/ 100</span>
          </div>
          <div className="mt-2 text-[12px] text-gs-textMuted">
            <span className="text-gs-text font-semibold">{rating.sentiment}</span> ·{" "}
            <span className="text-gs-textDim">{rating.conviction} conviction</span>
          </div>
        </div>

        {/* Target + upside */}
        <div className="col-span-12 md:col-span-4 border-y md:border-y-0 md:border-x border-gs-border md:px-4 py-3 md:py-0">
          <div className="gs-label">Consensus Target</div>
          <div className="font-display text-2xl font-bold text-gs-text tabular-nums mt-1">
            ₹{rating.target.toLocaleString("en-IN")}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={`font-mono text-xs font-semibold tabular-nums ${
                isUp ? "text-gs-pos" : "text-gs-neg"
              }`}
            >
              {isUp ? "+" : ""}
              {upsidePct}% upside
            </span>
            <TrendingUp
              className={`w-3 h-3 ${isUp ? "text-gs-pos" : "text-gs-neg rotate-180"}`}
            />
          </div>
        </div>

        {/* Analyst breakdown */}
        <div className="col-span-12 md:col-span-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="gs-label">Analysts</div>
            <span className="font-mono text-[10px] text-gs-textDim">
              n={rating.analystCount}
            </span>
          </div>
          <div className="flex h-1.5 rounded-sm overflow-hidden bg-gs-bg">
            <div className="bg-gs-pos" style={{ width: `${buyPct}%` }} />
            <div className="bg-gs-gold" style={{ width: `${holdPct}%` }} />
            <div className="bg-gs-neg" style={{ width: `${sellPct}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-1 mt-2 text-[10px] font-mono uppercase tracking-wider">
            <div>
              <span className="text-gs-pos">●</span>{" "}
              <span className="text-gs-textMuted">Buy</span>{" "}
              <span className="text-gs-text">{rating.breakdown.buy}</span>
            </div>
            <div className="text-center">
              <span className="text-gs-gold">●</span>{" "}
              <span className="text-gs-textMuted">Hold</span>{" "}
              <span className="text-gs-text">{rating.breakdown.hold}</span>
            </div>
            <div className="text-right">
              <span className="text-gs-neg">●</span>{" "}
              <span className="text-gs-textMuted">Sell</span>{" "}
              <span className="text-gs-text">{rating.breakdown.sell}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
