import ChangeBadge from "./ChangeBadge";
import Sparkline from "./Sparkline";

/**
 * KPI / Index tile — used in market overview header.
 */
export default function KPITile({ symbol, label, value, change, changePct, series }) {
  const isPos = changePct >= 0;
  return (
    <div
      className="gs-card p-4 flex flex-col gap-3 hover:bg-gs-cardHover transition-colors cursor-pointer"
      data-testid={`kpi-tile-${symbol}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="gs-label">{symbol}</div>
          <div className="text-[11px] text-gs-textDim mt-0.5">{label}</div>
        </div>
        <ChangeBadge value={changePct} />
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="gs-mono-num text-xl font-semibold text-gs-text">
          {Number(value).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </div>
        <div className="gs-mono-num text-xs text-gs-textMuted">
          {isPos ? "+" : ""}
          {Number(change).toFixed(2)}
        </div>
      </div>
      <div className="-mx-1">
        <Sparkline data={series} positive={isPos} height={36} />
      </div>
    </div>
  );
}
