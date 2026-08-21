import { useNavigate } from "react-router-dom";
import { Star, X } from "lucide-react";
import Sparkline from "./Sparkline";
import ChangeBadge from "./ChangeBadge";
import { useLiveStocks } from "@/hooks/useLiveStocks";

export default function StockTable({ rows, showSector = true, dense = false, title, onRemoveStock, showRemove = false }) {
  const navigate = useNavigate();
  const liveQuotes = useLiveStocks(rows.map((row) => row.ticker || row.symbol));

  return (
    <div className="gs-card overflow-hidden" data-testid="stock-table">
      {title && (
        <div className="px-4 py-3 border-b border-gs-border flex items-center justify-between">
          <h3 className="font-display font-bold text-gs-text text-sm">{title}</h3>
          <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
            {rows.length} rows
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gs-border bg-gs-panel/50">
              {showRemove && <th className="gs-label text-left px-4 py-2 w-8" />}
              <th className="gs-label text-left px-2 py-2">Ticker</th>
              {showSector && <th className="gs-label text-left px-2 py-2 hidden md:table-cell">Sector</th>}
              <th className="gs-label text-right px-2 py-2">Price</th>
              <th className="gs-label text-right px-2 py-2">Chg</th>
              <th className="gs-label text-right px-2 py-2 hidden lg:table-cell">Mkt Cap</th>
              <th className="gs-label text-right px-2 py-2 hidden xl:table-cell">P/E</th>
              <th className="gs-label text-right px-2 py-2 w-32">7D</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((stock) => {
              const ticker = stock.ticker || stock.symbol;
              const liveQuote = liveQuotes[ticker];
              const s = liveQuote
                ? { ...stock, ...liveQuote, changePct: liveQuote.percentage }
                : stock;
              const isPos = s.changePct >= 0;
              return (
                <tr
                  key={ticker}
                  className={`border-b border-gs-border hover:bg-gs-cardHover transition-colors cursor-pointer ${
                    dense ? "" : ""
                  }`}
                  onClick={() => navigate(`/stock/${ticker}`)}
                  data-testid={`stock-row-${ticker}`}
                >
                  {showRemove && (
                    <td className="px-4 py-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveStock(ticker);
                        }}
                        className="p-1 text-gs-textDim hover:text-gs-neg transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  )}
                  <td className="px-2 py-3">
                    <div className="font-mono text-[12.5px] font-semibold tracking-wider text-gs-text">
                      {ticker}
                    </div>
                    <div className="text-[11px] text-gs-textMuted truncate max-w-[180px]">
                      {s.name}
                    </div>
                  </td>
                  {showSector && (
                    <td className="px-2 py-3 hidden md:table-cell">
                      <span className="text-[11px] text-gs-textMuted">{s.sector}</span>
                    </td>
                  )}
                  <td className="px-2 py-3 text-right">
                    <span className="font-mono text-[12.5px] text-gs-text tabular-nums">
                      ₹{s.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                    </span>
                  </td>
                  <td className="px-2 py-3 text-right">
                    <ChangeBadge value={s.changePct} />
                  </td>
                  <td className="px-2 py-3 text-right hidden lg:table-cell">
                    <span className="font-mono text-[11.5px] text-gs-textMuted">{s.marketCap}</span>
                  </td>
                  <td className="px-2 py-3 text-right hidden xl:table-cell">
                    <span className="font-mono text-[11.5px] text-gs-textMuted">{s.pe?.toFixed(1)}</span>
                  </td>
                  <td className="px-2 py-3 w-32">
                    <Sparkline data={s.series} positive={isPos} height={28} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
