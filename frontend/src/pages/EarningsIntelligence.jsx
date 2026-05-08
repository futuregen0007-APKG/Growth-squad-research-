import { useState, useMemo } from "react";
import { CalendarClock, Sparkles } from "lucide-react";
import EarningsCard from "@/components/widgets/EarningsCard";
import { EARNINGS_CALENDAR } from "@/data/mockData";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function EarningsIntelligence() {
  const [tab, setTab] = useState("all");

  const items = useMemo(() => {
    if (tab === "upcoming") return EARNINGS_CALENDAR.filter((e) => e.status === "upcoming");
    if (tab === "reported") return EARNINGS_CALENDAR.filter((e) => e.status === "reported");
    return EARNINGS_CALENDAR;
  }, [tab]);

  const reported = EARNINGS_CALENDAR.filter((e) => e.status === "reported");
  const beats = reported.filter((e) => (e.surprise ?? 0) > 0).length;
  const misses = reported.filter((e) => (e.surprise ?? 0) < 0).length;

  return (
    <div className="space-y-6 animate-fade-up" data-testid="earnings-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Q3 FY26 · Earnings Season</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Earnings Intelligence
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Calendar, consensus, surprises and AI-curated commentary on Indian equity prints.
          </p>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="gs-card p-4">
          <div className="gs-label">Total Coverage</div>
          <div className="font-display text-2xl font-bold text-gs-text mt-1 tabular-nums">
            {EARNINGS_CALENDAR.length}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Reported</div>
          <div className="font-display text-2xl font-bold text-gs-text mt-1 tabular-nums">
            {reported.length}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Beats</div>
          <div className="font-display text-2xl font-bold text-gs-pos mt-1 tabular-nums">
            {beats}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Misses</div>
          <div className="font-display text-2xl font-bold text-gs-neg mt-1 tabular-nums">
            {misses}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-gs-panel border border-gs-border rounded-sm h-auto p-1">
          <TabsTrigger
            value="all"
            className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
            data-testid="tab-earnings-all"
          >
            All
          </TabsTrigger>
          <TabsTrigger
            value="upcoming"
            className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
            data-testid="tab-earnings-upcoming"
          >
            <CalendarClock className="w-3.5 h-3.5 mr-1.5" />
            Upcoming
          </TabsTrigger>
          <TabsTrigger
            value="reported"
            className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
            data-testid="tab-earnings-reported"
          >
            Reported
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {items.map((e) => (
          <EarningsCard key={e.id} earnings={e} />
        ))}
      </div>

      {/* AI commentary block */}
      <div className="gs-card p-5 border-l-2 border-l-gs-gold">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-gs-gold" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
            AI Earnings Lens
          </span>
        </div>
        <h2 className="font-display text-lg font-bold text-gs-text mb-2">
          Q3 FY26 — what to watch this week
        </h2>
        <ul className="text-[13px] text-gs-textMuted leading-relaxed space-y-2 list-disc pl-5">
          <li>
            <span className="font-mono text-gs-text">HDFCBANK</span> — first major private-bank print
            of the season. NIM trajectory and merger synergy commentary will frame sector tone.
          </li>
          <li>
            <span className="font-mono text-gs-text">RELIANCE</span> — Jio ARPU progression + retail
            EBITDA recovery are the two pivots; O2C margins remain a swing factor.
          </li>
          <li>
            <span className="font-mono text-gs-text">LT</span> — order inflow guidance and margin
            commentary on hydrocarbon vertical likely to drive the engineering & capital goods basket.
          </li>
        </ul>
      </div>
    </div>
  );
}
