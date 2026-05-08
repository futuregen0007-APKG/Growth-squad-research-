import { STOCKS } from "@/data/mockData";

/**
 * Top-of-page horizontal scrolling market ticker.
 * Pure CSS animation, doubled content for seamless loop.
 */
export default function MarketTicker() {
  const items = STOCKS.slice(0, 18);
  return (
    <div
      className="border-y border-gs-border bg-gs-panel/70 backdrop-blur-sm overflow-hidden h-9 flex items-center"
      data-testid="market-ticker"
    >
      <div className="flex w-max animate-ticker-scroll">
        {[...items, ...items].map((s, i) => {
          const isPos = s.changePct >= 0;
          return (
            <div
              key={`${s.ticker}-${i}`}
              className="flex items-center gap-2 px-5 border-r border-gs-border whitespace-nowrap"
            >
              <span className="font-mono text-[11px] font-semibold tracking-wider text-gs-text">
                {s.ticker}
              </span>
              <span className="font-mono text-[11px] text-gs-textMuted tabular-nums">
                ₹{s.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
              <span
                className={`font-mono text-[11px] tabular-nums ${
                  isPos ? "text-gs-pos" : "text-gs-neg"
                }`}
              >
                {isPos ? "+" : ""}
                {s.changePct.toFixed(2)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
