import { useEffect, useRef, useState } from "react";
import { fetchAllStocks } from "@/services/stockApi";

const REFRESH_INTERVAL_MS = 60000;
const MAX_ITEMS = 18;

const isValidTickerItem = (s) =>
  !!s &&
  typeof s.ticker === "string" &&
  s.ticker.trim().length > 0 &&
  Number.isFinite(Number(s.price)) &&
  Number.isFinite(Number(s.changePct));

/**
 * Top-of-page horizontal scrolling market ticker.
 * Pure CSS animation, doubled content for seamless loop.
 * Backed by a single live /api/stocks request, refreshed every 60s.
 */
export default function MarketTicker() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("loading"); // 'loading' | 'ready' | 'unavailable'
  const [stale, setStale] = useState(false);
  const hasDataRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const stocks = await fetchAllStocks();
        if (cancelled) return;
        const validStocks = Array.isArray(stocks) ? stocks.filter(isValidTickerItem) : [];
        if (validStocks.length) {
          setItems(validStocks.slice(0, MAX_ITEMS));
          setStatus("ready");
          setStale(false);
          hasDataRef.current = true;
        } else if (!hasDataRef.current) {
          setStatus("unavailable");
        } else {
          setStale(true);
        }
      } catch {
        if (cancelled) return;
        if (hasDataRef.current) {
          setStale(true);
        } else {
          setStatus("unavailable");
        }
      }
    };

    load();
    const intervalId = setInterval(load, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  if (status === "loading") {
    return (
      <div
        className="border-y border-gs-border bg-gs-panel/70 backdrop-blur-sm h-9 flex items-center px-5"
        data-testid="market-ticker"
      >
        <span className="font-mono text-[11px] text-gs-textDim uppercase tracking-wider">
          Loading market data…
        </span>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div
        className="border-y border-gs-border bg-gs-panel/70 backdrop-blur-sm h-9 flex items-center px-5"
        data-testid="market-ticker"
      >
        <span className="font-mono text-[11px] text-gs-textDim uppercase tracking-wider">
          Market data unavailable
        </span>
      </div>
    );
  }

  return (
    <div
      className="border-y border-gs-border bg-gs-panel/70 backdrop-blur-sm overflow-hidden h-9 flex items-center"
      data-testid="market-ticker"
    >
      {stale && (
        <span className="shrink-0 px-3 font-mono text-[10px] text-gs-textDim uppercase tracking-wider border-r border-gs-border">
          Delayed
        </span>
      )}
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
                ₹{Number(s.price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
              <span
                className={`font-mono text-[11px] tabular-nums ${
                  isPos ? "text-gs-pos" : "text-gs-neg"
                }`}
              >
                {isPos ? "+" : ""}
                {Number(s.changePct).toFixed(2)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
