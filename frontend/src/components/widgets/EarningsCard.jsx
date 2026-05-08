import { CalendarClock, Sparkles, CheckCircle2 } from "lucide-react";
import ChangeBadge from "./ChangeBadge";

export default function EarningsCard({ earnings }) {
  const reported = earnings.status === "reported";
  return (
    <div
      className="gs-card p-4 hover:bg-gs-cardHover transition-colors"
      data-testid={`earnings-card-${earnings.ticker}`}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold tracking-wider text-gs-text">
              {earnings.ticker}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-gs-textDim font-semibold">
              {earnings.sector}
            </span>
          </div>
          <div className="text-xs text-gs-textMuted mt-0.5">{earnings.name}</div>
        </div>
        {reported ? (
          <span className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-gs-pos bg-gs-posBg border border-gs-pos/20 rounded-sm px-1.5 py-0.5">
            <CheckCircle2 className="w-3 h-3" /> Reported
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-gs-gold bg-gs-goldMuted border border-gs-gold/30 rounded-sm px-1.5 py-0.5">
            <CalendarClock className="w-3 h-3" /> Upcoming
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 py-3 border-y border-gs-border">
        <div>
          <div className="gs-label">Date</div>
          <div className="font-mono text-xs text-gs-text mt-1">{earnings.date}</div>
        </div>
        <div>
          <div className="gs-label">EPS Est.</div>
          <div className="font-mono text-xs text-gs-text mt-1">₹{earnings.epsEst.toFixed(2)}</div>
        </div>
        <div>
          <div className="gs-label">Revenue Est.</div>
          <div className="font-mono text-xs text-gs-text mt-1">{earnings.revenueEst}</div>
        </div>
      </div>

      {reported && earnings.surprise !== null && (
        <div className="flex items-center justify-between mt-3 mb-1">
          <span className="gs-label">Surprise</span>
          <ChangeBadge value={earnings.surprise} suffix="%" size="md" />
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 bg-gs-bg/50 border border-gs-border rounded-sm p-2.5">
        <Sparkles className="w-3.5 h-3.5 text-gs-gold shrink-0 mt-0.5" />
        <p className="text-[11.5px] text-gs-textMuted leading-relaxed">{earnings.aiNote}</p>
      </div>
    </div>
  );
}
