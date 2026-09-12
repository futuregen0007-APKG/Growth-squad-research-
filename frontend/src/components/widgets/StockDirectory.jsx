import { useMemo, useState } from 'react';
import { Search, X, Star } from 'lucide-react';

const formatMoney = (value) => {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  return `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};

const getInitials = (symbol) => (String(symbol || '').replace(/[^A-Z]/gi, '').slice(0, 2) || 'ST').toUpperCase();

export default function StockDirectory({ stocks = [], selectedSymbol, onSelect, watchlistSymbols = [], sortMode = 'name', onSortModeChange }) {
  const [query, setQuery] = useState('');
  const [sectorFilter, setSectorFilter] = useState('all');
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const sectors = useMemo(() => {
    const set = new Set();
    stocks.forEach((stock) => {
      const sector = stock.sector || stock.industry || stock.companySector;
      if (sector) set.add(sector);
    });
    return Array.from(set).sort();
  }, [stocks]);

  const filteredStocks = useMemo(() => {
    const text = query.trim().toLowerCase();
    return [...stocks]
      .filter((stock) => {
        const symbol = (stock.symbol || stock.ticker || '').toUpperCase();
        const name = (stock.name || stock.companyName || '').toLowerCase();
        const sector = (stock.sector || stock.industry || stock.companySector || '').toLowerCase();
        const matchesText = !text || symbol.toLowerCase().includes(text) || name.includes(text);
        const matchesSector = sectorFilter === 'all' || (stock.sector || stock.industry || stock.companySector || '') === sectorFilter;
        const matchesWatchlist = !watchlistOnly || watchlistSymbols.includes(symbol);
        return matchesText && matchesSector && matchesWatchlist;
      })
      .sort((a, b) => {
        const aSym = (a.symbol || a.ticker || '').toUpperCase();
        const bSym = (b.symbol || b.ticker || '').toUpperCase();
        const aName = (a.name || a.companyName || '').toLowerCase();
        const bName = (b.name || b.companyName || '').toLowerCase();
        if (sortMode === 'symbol') return aSym.localeCompare(bSym);
        if (sortMode === 'change') return (Number(b.changePct ?? b.change ?? 0) || 0) - (Number(a.changePct ?? a.change ?? 0) || 0);
        return aName.localeCompare(bName);
      });
  }, [stocks, query, sectorFilter, watchlistOnly, sortMode, watchlistSymbols]);

  const clearFilters = () => {
    setQuery('');
    setSectorFilter('all');
    setWatchlistOnly(false);
    if (onSortModeChange) onSortModeChange('name');
  };

  return (
    <div className="gs-card h-full flex flex-col min-h-[420px]">
      <div className="border-b border-gs-border p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="font-display text-lg font-bold text-gs-text">Stock Directory</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim">{filteredStocks.length} results</div>
        </div>

        <div className="mt-3 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gs-textDim" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full bg-gs-panel border border-gs-border rounded-sm pl-9 pr-8 py-2 text-sm text-gs-text placeholder-gs-textDim"
            placeholder="Search symbol or company"
            aria-label="Search stock directory"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gs-textDim hover:text-gs-text" aria-label="Clear directory search">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <select value={sectorFilter} onChange={(event) => setSectorFilter(event.target.value)} className="bg-gs-panel border border-gs-border text-gs-text text-xs px-2 py-1.5 rounded-sm min-w-[110px]">
            <option value="all">All sectors</option>
            {sectors.map((sector) => (
              <option key={sector} value={sector}>{sector}</option>
            ))}
          </select>
          <select value={sortMode} onChange={(event) => onSortModeChange && onSortModeChange(event.target.value)} className="bg-gs-panel border border-gs-border text-gs-text text-xs px-2 py-1.5 rounded-sm min-w-[110px]">
            <option value="name">Sort by name</option>
            <option value="symbol">Sort by symbol</option>
            <option value="change">Sort by change</option>
          </select>
          <label className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-gs-textDim border border-gs-border rounded-sm px-2 py-1.5">
            <input type="checkbox" checked={watchlistOnly} onChange={(event) => setWatchlistOnly(event.target.checked)} className="accent-gs-gold" />
            Watchlist only
          </label>
          <button type="button" onClick={clearFilters} className="ml-auto text-[10px] uppercase tracking-[0.18em] text-gs-textDim hover:text-gs-text">Clear</button>
        </div>
      </div>

      <div className="stock-directory-list p-2">
        {filteredStocks.length === 0 ? (
          <div className="flex h-full min-h-[220px] items-center justify-center px-4 text-center text-sm text-gs-textMuted">
            No matching stocks. Adjust filters or search for another symbol.
          </div>
        ) : (
          filteredStocks.map((stock) => {
            const symbol = (stock.symbol || stock.ticker || '').toUpperCase();
            const price = stock.price ?? stock.lastPrice ?? null;
            const changePct = Number(stock.changePct ?? stock.change ?? 0);
            const isSelected = (selectedSymbol || '').toUpperCase() === symbol;
            const isPositive = Number.isFinite(changePct) ? changePct >= 0 : null;
            const inWatchlist = watchlistSymbols.includes(symbol);

            return (
              <button
                key={symbol}
                type="button"
                onClick={() => onSelect(symbol)}
                className={`w-full text-left p-2.5 rounded-sm border transition-colors ${isSelected ? 'bg-gs-panel border-l-2 border-l-gs-gold border-gs-gold/40' : 'border-transparent hover:bg-gs-panel hover:border-gs-border'}`}
                aria-pressed={isSelected}
                aria-label={`Select ${symbol}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-8 w-8 rounded-sm bg-gs-card border border-gs-border flex items-center justify-center font-mono text-[10px] text-gs-text font-semibold">
                    {getInitials(symbol)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gs-text">{symbol}</span>
                      {inWatchlist && <Star className="w-3 h-3 text-gs-gold fill-current" />}
                    </div>
                    <div className="text-[11px] text-gs-textMuted truncate">{stock.name || stock.companyName || symbol}</div>
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-[1fr_auto_auto] items-center gap-2">
                  <div className="truncate text-[10px] text-gs-textDim">{stock.name || stock.companyName || symbol}</div>
                  <div className="font-mono text-[11px] text-gs-text tabular-nums">{formatMoney(price)}</div>
                  <div className={`font-mono text-[10px] tabular-nums ${isPositive == null ? 'text-gs-textDim' : isPositive ? 'text-gs-pos' : 'text-gs-neg'}`}>
                    {Number.isFinite(changePct) ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` : '—'}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
