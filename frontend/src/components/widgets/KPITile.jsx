import ChangeBadge from "./ChangeBadge";
import Sparkline from "./Sparkline";

/**
 * KPI / Index tile — used in market overview header.
 * Adds intraday high/low range with current-position marker.
 */
export default function KPITile({ symbol, label, value, change, changePct, series }) {
  const isPos = changePct >= 0;
  const values = (series || []).map((s) => s.v);
  const high = values.length ? Math.max(...values) : value;
  const low = values.length ? Math.min(...values) : value;
  const range = high - low || 1;
  const pos = Math.max(0, Math.min(100, ((value - low) / range) * 100));

  return (
    <div
      className="gs-card p-4 flex flex-col gap-2.5 hover:bg-gs-cardHover transition-colors cursor-pointer relative overflow-hidden"
      data-testid={`kpi-tile-${symbol}`}
    >
      {/* subtle accent corner */}
      <span
        className={`absolute top-0 right-0 w-12 h-12 pointer-events-none opacity-40`}
        style={{
          background: `radial-gradient(closest-side, ${
            isPos ? "rgba(5,150,105,0.15)" : "rgba(220,38,38,0.15)"
          }, transparent)`,
        }}
      />

      <div className="flex items-start justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-text font-semibold">
            {symbol}
          </div>
          <div className="text-[10.5px] text-gs-textDim mt-0.5">{label}</div>
        </div>
        <ChangeBadge value={changePct} />
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="gs-mono-num text-[20px] font-semibold text-gs-text leading-none">
          {Number(value).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </div>
        <div className="gs-mono-num text-[11px] text-gs-textMuted">
          {isPos ? "+" : ""}
          {Number(change).toFixed(2)}
        </div>
      </div>

      <div className="-mx-1">
        <Sparkline data={series} positive={isPos} height={32} />
      </div>

      {/* High/Low range */}
      <div className="pt-2 border-t border-gs-border">
        <div className="flex items-center justify-between font-mono text-[9.5px] text-gs-textDim mb-1">
          <span>L {low.toFixed(2)}</span>
          <span className="text-gs-textMuted uppercase tracking-[0.18em] text-[9px]">
            Range
          </span>
          <span>H {high.toFixed(2)}</span>
        </div>
        <div className="relative h-[3px] bg-gs-bg rounded-sm overflow-hidden">
          <div
            className={`absolute top-0 bottom-0 w-1 rounded-sm ${
              isPos ? "bg-gs-pos" : "bg-gs-neg"
            }`}
            style={{
              left: `calc(${pos}% - 2px)`,
              boxShadow: `0 0 6px ${isPos ? "#059669" : "#DC2626"}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
