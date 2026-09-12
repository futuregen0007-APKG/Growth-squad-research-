import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ArrowUpRight, ArrowDownRight, Star, StarOff } from 'lucide-react';

const normalizeChange = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatMoney = (value) => {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  return `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};

const formatChange = (value) => {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}`;
};

const getPriceRangeWidth = (stock) => {
  const low = Number(stock?.dayLow ?? stock?.low ?? 0);
  const high = Number(stock?.dayHigh ?? stock?.high ?? 0);
  const price = Number(stock?.price ?? stock?.lastPrice ?? 0);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low || !Number.isFinite(price)) return 0;
  return Math.max(12, Math.min(100, ((price - low) / (high - low)) * 100));
};

const getInitials = (symbol) => (String(symbol || '').replace(/[^A-Z]/gi, '').slice(0, 2) || 'ST').toUpperCase();

export default function PopularStocksRail({ stocks = [], highlightedSymbol, onSelectSymbol, watchlistSymbols = [], onToggleWatchlist }) {
  const navigate = useNavigate();
  const railRef = useRef(null);
  const [flippedSymbol, setFlippedSymbol] = useState(highlightedSymbol || null);

  const normalizedStocks = useMemo(
    () =>
      stocks
        .filter(Boolean)
        .map((stock) => ({
          symbol: stock.symbol || stock.ticker || '',
          name: stock.name || stock.companyName || stock.shortName || 'Unknown',
          price: stock.price ?? stock.lastPrice ?? null,
          change: normalizeChange(stock.change ?? stock.changeValue ?? stock.dayChange),
          changePct: normalizeChange(stock.changePct ?? stock.percentageChange ?? stock.dayChangePct),
          dayLow: stock.dayLow ?? stock.low ?? null,
          dayHigh: stock.dayHigh ?? stock.high ?? null,
          marketCap: stock.marketCap ?? null,
          pe: stock.pe ?? stock.peRatio ?? null,
          sector: stock.sector ?? null,
          volume: stock.volume ?? null,
          updatedAt: stock.updatedAt ?? stock.lastUpdated ?? stock.timestamp ?? null,
          isin: stock.isin ?? stock.ISIN ?? null,
          fiftyTwoWeekLow: stock.fiftyTwoWeekLow ?? stock.week52Low ?? stock['52WeekLow'] ?? null,
          fiftyTwoWeekHigh: stock.fiftyTwoWeekHigh ?? stock.week52High ?? stock['52WeekHigh'] ?? null,
        }))
        .filter((stock) => stock.symbol),
    [stocks],
  );

  const handleScroll = (direction) => {
    if (!railRef.current) return;
    const amount = direction === 'next' ? 280 : -280;
    railRef.current.scrollBy({ left: amount, behavior: 'smooth' });
  };

  const toggleCard = (symbol) => {
    setFlippedSymbol((current) => (current === symbol ? null : symbol));
  };

  const handleAction = (event, action, symbol) => {
    event.stopPropagation();
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    if (action === 'details') {
      navigate(`/stock/${encodeURIComponent(normalizedSymbol)}`);
      setFlippedSymbol(null);
      if (onSelectSymbol) onSelectSymbol(normalizedSymbol);
      return;
    }
    if (action === 'watchlist') {
      if (onToggleWatchlist) onToggleWatchlist(symbol);
    }
  };

  return (
    <div className="gs-card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3"> 
        <div className="gs-label">MARKET INDICES | POPULAR STOCKS</div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => handleScroll('prev')} className="p-1.5 border border-gs-border bg-gs-panel text-gs-textDim hover:text-gs-text" aria-label="Scroll popular stocks left">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => handleScroll('next')} className="p-1.5 border border-gs-border bg-gs-panel text-gs-textDim hover:text-gs-text" aria-label="Scroll popular stocks right">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div ref={railRef} className="popular-stocks-rail mt-4 flex gap-3 overflow-x-auto pb-2">
        {normalizedStocks.map((stock, index) => {
          const isPositive = normalizeChange(stock.changePct) == null ? null : Number(stock.changePct) >= 0;
          const changeClass = isPositive == null ? 'text-gs-textDim' : isPositive ? 'text-gs-pos' : 'text-gs-neg';
          const isSelected = flippedSymbol === stock.symbol;
          const inWatchlist = watchlistSymbols.includes(stock.symbol.toUpperCase());
          const rangePct = getPriceRangeWidth(stock);

          return (
            <div key={`${stock.symbol}-${index}`} className={`popular-stock-card ${isSelected ? 'is-flipped' : ''}`}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isSelected}
                aria-label={`Toggle details for ${stock.symbol}`}
                className="popular-stock-card-inner"
                onClick={() => toggleCard(stock.symbol)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleCard(stock.symbol);
                  }
                }}
              >
                <div className="popular-stock-face bg-gs-card border border-gs-border p-3 sm:p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="h-8 w-8 rounded-sm bg-gs-panel border border-gs-border flex items-center justify-center font-mono text-[10px] font-semibold text-gs-text">
                        {getInitials(stock.symbol)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-gs-textDim">{stock.symbol}</div>
                        <div className="text-[10px] text-gs-textMuted truncate max-w-[110px]">{stock.name}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={inWatchlist ? `Remove ${stock.symbol} from watchlist` : `Add ${stock.symbol} to watchlist`}
                      className="p-1 text-gs-textDim hover:text-gs-gold"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (onToggleWatchlist) onToggleWatchlist(stock.symbol);
                      }}
                    >
                      {inWatchlist ? <Star className="w-3.5 h-3.5 fill-current text-gs-gold" /> : <StarOff className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  <div className="mt-5">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-gs-textDim">Last price</div>
                    <div className="mt-1 font-display text-2xl font-bold text-gs-text tabular-nums">{formatMoney(stock.price)}</div>
                  </div>

                  <div className="mt-4 flex items-end justify-between gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-gs-textDim">Change</div>
                      <div className={`mt-1 font-mono text-sm font-semibold tabular-nums ${changeClass}`}>
                        {formatChange(stock.change)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-gs-textDim">Trend</div>
                      <div className={`mt-1 font-mono text-sm font-semibold tabular-nums ${changeClass}`}>
                        {stock.changePct == null ? '—' : `${Number(stock.changePct) >= 0 ? '+' : ''}${Number(stock.changePct).toFixed(2)}%`}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-gs-textDim">
                      <span>{stock.updatedAt ? 'Live' : 'Status'}</span>
                      <span>{stock.updatedAt ? 'Fresh' : 'Unavailable'}</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full bg-gs-panel border border-gs-border overflow-hidden">
                      <div className={`h-full ${isPositive == null ? 'bg-gs-textDim' : isPositive ? 'bg-gs-pos' : 'bg-gs-neg'}`} style={{ width: `${rangePct}%` }} />
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-gs-textDim">
                    <span>{stock.dayLow == null || stock.dayHigh == null ? 'Range' : `${formatMoney(stock.dayLow)} - ${formatMoney(stock.dayHigh)}`}</span>
                    <span className="text-gs-gold">Tap for metrics</span>
                  </div>
                </div>

                <div className="popular-stock-face popular-stock-back bg-gs-panel border border-gs-border p-3 sm:p-4">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-gold">Snapshot</div>
                    <button type="button" onClick={(event) => handleAction(event, 'watchlist', stock.symbol)} className="text-gs-textDim hover:text-gs-gold text-[10px] font-mono uppercase tracking-[0.18em]">
                      {inWatchlist ? 'In watchlist' : 'Add to watchlist'}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="text-gs-textDim">Sector</div>
                    <div className="text-gs-text text-right truncate">{stock.sector || '—'}</div>
                    <div className="text-gs-textDim">Mkt Cap</div>
                    <div className="text-gs-text text-right">{stock.marketCap || '—'}</div>
                    <div className="text-gs-textDim">P/E</div>
                    <div className="text-gs-text text-right">{stock.pe == null ? '—' : `${Number(stock.pe).toFixed(1)}x`}</div>
                    <div className="text-gs-textDim">52W High</div>
                    <div className="text-gs-text text-right">{stock.fiftyTwoWeekHigh == null ? '—' : formatMoney(stock.fiftyTwoWeekHigh)}</div>
                    <div className="text-gs-textDim">52W Low</div>
                    <div className="text-gs-text text-right">{stock.fiftyTwoWeekLow == null ? '—' : formatMoney(stock.fiftyTwoWeekLow)}</div>
                    <div className="text-gs-textDim">Volume</div>
                    <div className="text-gs-text text-right">{stock.volume == null ? '—' : Number(stock.volume).toLocaleString('en-IN')}</div>
                    <div className="text-gs-textDim">Source</div>
                    <div className="text-gs-text text-right">{stock.updatedAt ? 'Live feed' : 'Unavailable'}</div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <button type="button" onClick={(event) => handleAction(event, 'details', stock.symbol)} className="flex-1 bg-gs-gold text-gs-bg px-2 py-2 font-mono text-[10px] uppercase tracking-[0.18em]">
                      View Details
                    </button>
                    <button type="button" onClick={(event) => handleAction(event, 'watchlist', stock.symbol)} className="flex-1 border border-gs-border bg-gs-card px-2 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-gs-text hover:border-gs-gold/40">
                      {inWatchlist ? 'In Watchlist' : 'Watchlist'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
