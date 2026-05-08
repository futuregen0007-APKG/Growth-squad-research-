import { useNavigate } from "react-router-dom";
import { CalendarClock, ArrowUpRight, Sparkles } from "lucide-react";
import { EARNINGS_CALENDAR } from "@/data/mockData";

export default function EarningsSnapshot() {
  const navigate = useNavigate();
  const upcoming = EARNINGS_CALENDAR.filter((e) => e.status === "upcoming").slice(0, 4);

  return (
    <div className="gs-card p-5" data-testid="earnings-snapshot">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="gs-label">// Earnings Snapshot · this week</div>
          <h3 className="font-display font-bold text-gs-text mt-1 text-lg">
            Upcoming Indian Prints
          </h3>
        </div>
        <button
          onClick={() => navigate("/earnings")}
          className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim hover:text-gs-gold flex items-center gap-1 transition-colors"
          data-testid="earnings-snapshot-cta"
        >
          Open Calendar <ArrowUpRight className="w-3 h-3" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {upcoming.map((e) => (
          <button
            key={e.id}
            onClick={() => navigate(`/stock/${e.ticker}`)}
            className="gs-card p-3.5 text-left hover:bg-gs-cardHover transition-colors group"
            data-testid={`earnings-snap-${e.ticker}`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-gold bg-gs-goldMuted border border-gs-gold/30 rounded-sm px-1.5 py-0.5 inline-flex items-center gap-1">
                <CalendarClock className="w-3 h-3" />
                {e.date}
              </span>
              <ArrowUpRight className="w-3 h-3 text-gs-textDim group-hover:text-gs-gold transition-colors" />
            </div>
            <div className="font-mono text-[13px] font-semibold tracking-wider text-gs-text">
              {e.ticker}
            </div>
            <div className="text-[10.5px] text-gs-textMuted truncate">{e.name}</div>

            <div className="mt-2.5 pt-2.5 border-t border-gs-border grid grid-cols-2 gap-2">
              <div>
                <div className="gs-label">EPS Est</div>
                <div className="font-mono text-[11px] text-gs-text mt-0.5">
                  ₹{e.epsEst.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="gs-label">Revenue</div>
                <div className="font-mono text-[10px] text-gs-text truncate mt-0.5">
                  {e.revenueEst}
                </div>
              </div>
            </div>

            <div className="mt-2.5 flex items-start gap-1.5">
              <Sparkles className="w-2.5 h-2.5 text-gs-gold mt-0.5 shrink-0" />
              <p className="text-[10.5px] text-gs-textMuted leading-snug line-clamp-2">
                {e.aiNote}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
