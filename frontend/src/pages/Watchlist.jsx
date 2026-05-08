import { useState, useMemo } from "react";
import { Plus, Search, ListFilter } from "lucide-react";
import StockTable from "@/components/widgets/StockTable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { WATCHLISTS, STOCKS } from "@/data/mockData";

export default function Watchlist() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(WATCHLISTS[0].id);

  const filtered = useMemo(() => {
    const wl = WATCHLISTS.find((w) => w.id === active);
    const tickers = wl ? wl.tickers : [];
    return STOCKS.filter((s) => tickers.includes(s.ticker)).filter((s) =>
      query
        ? s.ticker.toLowerCase().includes(query.toLowerCase()) ||
          s.name.toLowerCase().includes(query.toLowerCase())
        : true,
    );
  }, [query, active]);

  const totals = useMemo(() => {
    if (filtered.length === 0) return { avg: 0, gainers: 0, losers: 0 };
    const avg = filtered.reduce((a, b) => a + b.changePct, 0) / filtered.length;
    return {
      avg,
      gainers: filtered.filter((s) => s.changePct >= 0).length,
      losers: filtered.filter((s) => s.changePct < 0).length,
    };
  }, [filtered]);

  return (
    <div className="space-y-6 animate-fade-up" data-testid="watchlist-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Tracked Baskets</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Watchlists
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Curated thematic baskets — track every move with sparklines & AI alerts.
          </p>
        </div>
        <button className="flex items-center gap-2 bg-gs-text text-gs-bg font-medium px-3 py-1.5 rounded-sm hover:bg-white/90 transition text-sm">
          <Plus className="w-4 h-4" />
          New Watchlist
        </button>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="gs-card p-4">
          <div className="gs-label">Active List</div>
          <div className="font-display text-lg font-bold text-gs-text mt-1 truncate">
            {WATCHLISTS.find((w) => w.id === active)?.name}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Avg Change</div>
          <div
            className={`font-mono text-lg font-semibold mt-1 tabular-nums ${
              totals.avg >= 0 ? "text-gs-pos" : "text-gs-neg"
            }`}
          >
            {totals.avg >= 0 ? "+" : ""}
            {totals.avg.toFixed(2)}%
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Gainers</div>
          <div className="font-mono text-lg font-semibold text-gs-pos mt-1 tabular-nums">
            {totals.gainers}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Losers</div>
          <div className="font-mono text-lg font-semibold text-gs-neg mt-1 tabular-nums">
            {totals.losers}
          </div>
        </div>
      </div>

      <Tabs value={active} onValueChange={setActive}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="bg-gs-panel border border-gs-border rounded-sm h-auto p-1">
            {WATCHLISTS.map((w) => (
              <TabsTrigger
                key={w.id}
                value={w.id}
                className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
                data-testid={`tab-${w.id}`}
              >
                {w.name}
                <span className="ml-2 font-mono text-[10px] text-gs-textDim">{w.count}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gs-textDim" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter ticker…"
                className="pl-8 bg-gs-card border-gs-border text-gs-text h-9 w-44 text-sm rounded-sm"
                data-testid="watchlist-filter-input"
              />
            </div>
            <button className="p-2 bg-gs-card border border-gs-border rounded-sm text-gs-textMuted hover:text-gs-text">
              <ListFilter className="w-4 h-4" />
            </button>
          </div>
        </div>

        {WATCHLISTS.map((w) => (
          <TabsContent key={w.id} value={w.id} className="mt-4">
            <StockTable rows={filtered} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
