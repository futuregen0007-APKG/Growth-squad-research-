import { useState, useMemo, useEffect } from "react";
import { Plus, Search, ListFilter, X, ChevronDown, ChevronUp } from "lucide-react";
import StockTable from "@/components/widgets/StockTable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WATCHLISTS, STOCKS } from "@/data/mockData";
import { fetchAllStocks } from "@/services/stockApi";
import { toast } from "sonner";

export default function Watchlist() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(WATCHLISTS[0].id);
  const [allStocks, setAllStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [watchlists, setWatchlists] = useState(WATCHLISTS);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [addStockDialogOpen, setAddStockDialogOpen] = useState(false);
  const [selectedStock, setSelectedStock] = useState("");
  const [sortBy, setSortBy] = useState("changePct");
  const [sortOrder, setSortOrder] = useState("desc");

  useEffect(() => {
    const loadStocks = async () => {
      try {
        const stocks = await fetchAllStocks();
        setAllStocks(stocks);
      } catch (err) {
        console.error('Error loading stocks:', err);
      } finally {
        setLoading(false);
      }
    };
    loadStocks();
  }, []);

  const filtered = useMemo(() => {
    const wl = watchlists.find((w) => w.id === active);
    const tickers = wl ? wl.tickers : [];
    let stocks = allStocks.filter((s) => 
      tickers.includes((s.symbol || s.ticker)?.toUpperCase())
    ).filter((s) =>
      query
        ? (s.symbol || s.ticker)?.toLowerCase().includes(query.toLowerCase()) ||
          (s.name || '')?.toLowerCase().includes(query.toLowerCase())
        : true,
    );

    // Sort stocks
    stocks = [...stocks].sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      if (sortOrder === "desc") return bVal - aVal;
      return aVal - bVal;
    });

    return stocks;
  }, [query, active, allStocks, watchlists, sortBy, sortOrder]);

  const totals = useMemo(() => {
    if (filtered.length === 0) return { avg: 0, gainers: 0, losers: 0 };
    const avg = filtered.reduce((a, b) => a + (b.changePct || 0), 0) / filtered.length;
    return {
      avg,
      gainers: filtered.filter((s) => (s.changePct || 0) >= 0).length,
      losers: filtered.filter((s) => (s.changePct || 0) < 0).length,
    };
  }, [filtered]);

  const handleCreateWatchlist = () => {
    if (newListName.trim()) {
      const newList = {
        id: `wl-${Date.now()}`,
        name: newListName.trim(),
        tickers: [],
        count: 0,
      };
      setWatchlists([...watchlists, newList]);
      setActive(newList.id);
      setNewListName("");
      setAddDialogOpen(false);
      toast.success("Watchlist created", {
        description: `"${newList.name}" has been added to your watchlists.`,
      });
    }
  };

  const handleAddStock = () => {
    if (selectedStock) {
      const wl = watchlists.find((w) => w.id === active);
      if (wl && !wl.tickers.includes(selectedStock)) {
        const updatedWatchlists = watchlists.map(w => 
          w.id === active 
            ? { ...w, tickers: [...w.tickers, selectedStock], count: w.tickers.length + 1 }
            : w
        );
        setWatchlists(updatedWatchlists);
        setSelectedStock("");
        setAddStockDialogOpen(false);
        toast.success("Stock added", {
          description: `${selectedStock} has been added to ${wl.name}.`,
        });
      } else if (wl && wl.tickers.includes(selectedStock)) {
        toast.error("Stock already in watchlist", {
          description: `${selectedStock} is already in ${wl.name}.`,
        });
      }
    }
  };

  const handleRemoveStock = (ticker) => {
    const wl = watchlists.find((w) => w.id === active);
    if (wl) {
      const updatedWatchlists = watchlists.map(w => 
        w.id === active 
          ? { ...w, tickers: w.tickers.filter(t => t !== ticker), count: w.tickers.length - 1 }
          : w
      );
      setWatchlists(updatedWatchlists);
      toast.success("Stock removed", {
        description: `${ticker} has been removed from ${wl.name}.`,
      });
    }
  };

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === "desc" ? "asc" : "desc");
    } else {
      setSortBy(field);
      setSortOrder("desc");
    }
  };

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
        <div className="flex items-center gap-2">
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <Button className="flex items-center gap-2 bg-gs-text text-gs-bg font-medium px-3 py-1.5 rounded-sm hover:bg-white/90 transition text-sm">
                <Plus className="w-4 h-4" />
                New Watchlist
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-gs-card border-gs-border text-gs-text">
              <DialogHeader>
                <DialogTitle>Create New Watchlist</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <Input
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder="Watchlist name..."
                  className="bg-gs-bg border-gs-border"
                />
                <Button onClick={handleCreateWatchlist} className="w-full bg-gs-gold text-gs-bg">
                  Create
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={addStockDialogOpen} onOpenChange={setAddStockDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="flex items-center gap-2 border-gs-border text-gs-text px-3 py-1.5 rounded-sm hover:bg-gs-cardHover transition text-sm">
                <Plus className="w-4 h-4" />
                Add Stock
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-gs-card border-gs-border text-gs-text">
              <DialogHeader>
                <DialogTitle>Add Stock to Watchlist</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <Select value={selectedStock} onValueChange={setSelectedStock}>
                  <SelectTrigger className="bg-gs-bg border-gs-border">
                    <SelectValue placeholder="Select stock" />
                  </SelectTrigger>
                  <SelectContent className="bg-gs-card border-gs-border max-h-60">
                    {STOCKS.map(stock => (
                      <SelectItem key={stock.ticker} value={stock.ticker}>
                        {stock.ticker} - {stock.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={handleAddStock} className="w-full bg-gs-gold text-gs-bg" disabled={!selectedStock}>
                  Add to {watchlists.find(w => w.id === active)?.name}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="gs-card p-4">
          <div className="gs-label">Active List</div>
          <div className="font-display text-lg font-bold text-gs-text mt-1 truncate">
            {watchlists.find((w) => w.id === active)?.name}
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
            {watchlists.map((w) => (
              <TabsTrigger
                key={w.id}
                value={w.id}
                className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px] group relative"
                data-testid={`tab-${w.id}`}
              >
                {w.name}
                <span className="ml-2 font-mono text-[10px] text-gs-textDim">{w.count}</span>
                {watchlists.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (watchlists.length > 1) {
                        setWatchlists(watchlists.filter(wl => wl.id !== w.id));
                        if (active === w.id) setActive(watchlists[0].id);
                        toast.success("Watchlist deleted", {
                          description: `"${w.name}" has been removed.`,
                        });
                      }
                    }}
                    className="ml-2 opacity-0 group-hover:opacity-100 text-gs-textDim hover:text-gs-neg transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
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
            <button 
              onClick={() => handleSort('changePct')}
              className="p-2 bg-gs-card border border-gs-border rounded-sm text-gs-textMuted hover:text-gs-text flex items-center gap-1"
            >
              <ListFilter className="w-4 h-4" />
              {sortBy === 'changePct' && (sortOrder === 'desc' ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}
            </button>
          </div>
        </div>

        {watchlists.map((w) => (
          <TabsContent key={w.id} value={w.id} className="mt-4">
            <StockTable 
              rows={filtered} 
              onRemoveStock={handleRemoveStock}
              showRemove={true}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
