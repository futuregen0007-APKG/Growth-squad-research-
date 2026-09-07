import { useState, useEffect, useMemo } from "react";
import { TrendingUp, TrendingDown, Info, AlertTriangle } from "lucide-react";
import SectorRotationRRG from "@/components/widgets/SectorRotationRRG";
import StockTable from "@/components/widgets/StockTable";
import { fetchAllStocks } from "@/services/stockApi";
import API_BASE from "@/config/api";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

const QUADRANT_STYLE = {
  Leading: "text-gs-pos border-gs-pos/40 bg-gs-pos/10",
  Improving: "text-blue-400 border-blue-400/40 bg-blue-400/10",
  Weakening: "text-orange-400 border-orange-400/40 bg-orange-400/10",
  Lagging: "text-gs-neg border-gs-neg/40 bg-gs-neg/10",
};

const METHODOLOGY_TEXT =
  "Each constituent's daily closes are normalized to 100 at a common start date, then equal-weighted into a sector index. " +
  "Relative strength = sector index / similarly-normalized Nifty 50 index (a ratio, not a % change — 1.0 means parity with the benchmark). " +
  "Relative momentum is the trailing rate of change of that ratio. Sectors below the minimum constituent count, coverage, or " +
  "aligned trading-day thresholds are marked insufficient rather than shown with a filled-in or neutral value.";

function formatAsOf(iso) {
  if (!iso) return "Unavailable";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";
}

function MethodologyTooltip() {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="Methodology" className="text-gs-textDim hover:text-gs-text">
            <Info className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs bg-gs-panel text-gs-text border border-gs-border">
          {METHODOLOGY_TEXT}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function SectorIntelligence() {
  const [activeSector, setActiveSector] = useState(null);
  const [rotation, setRotation] = useState([]);
  const [allStocks, setAllStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [asOf, setAsOf] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [stocksResponse, rotationResponse] = await Promise.all([
          fetchAllStocks({ signal: controller.signal }),
          fetch(`${API_BASE}/api/sector-rotation`, { signal: controller.signal }).then((response) => {
            if (!response.ok) throw new Error(`Sector rotation request failed (HTTP ${response.status}).`);
            return response.json();
          }),
        ]);
        if (!active) return;
        const data = Array.isArray(rotationResponse.data) ? rotationResponse.data : [];
        setAllStocks(stocksResponse);
        setRotation(data);
        setAsOf(rotationResponse.asOf || data[0]?.asOf || null);
        setActiveSector((current) => current || data[0]?.sector || null);
      } catch (err) {
        if (!active || err.name === 'AbortError') return;
        console.error('Error loading sector intelligence:', err);
        setError('Unable to load sector intelligence right now.');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; controller.abort(); };
  }, []);

  const sortedRotation = useMemo(() => {
    return [...rotation].sort((a, b) => {
      if (a.rank == null && b.rank == null) return a.sector.localeCompare(b.sector);
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });
  }, [rotation]);

  const active = sortedRotation.find((s) => s.sector === activeSector) || null;
  const sufficientCount = rotation.filter((s) => s.status === 'OK').length;

  const sectorStocks = useMemo(() => {
    if (!active?.sector) return [];
    return allStocks.filter((s) => String(s.sector || '').toLowerCase() === active.sector.toLowerCase());
  }, [allStocks, active]);

  return (
    <div className="space-y-6 animate-fade-up" data-testid="sectors-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Sectoral Intelligence</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Sector Intelligence
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Normalized relative-strength and momentum vs Nifty 50, computed from live constituent data.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-gs-textDim">
          <span className="bg-gs-panel border border-gs-border px-2 py-1 rounded-sm">
            {rotation.length ? `${sufficientCount}/${rotation.length} sectors reliable` : 'Sector data unavailable'}
          </span>
          <span className="bg-gs-panel border border-gs-border px-2 py-1 rounded-sm">As of {formatAsOf(asOf)}</span>
        </div>
      </div>

      {loading && (
        <div className="gs-card p-8 text-center text-sm text-gs-textDim" data-testid="sectors-loading">
          Loading sector intelligence…
        </div>
      )}

      {!loading && error && (
        <div className="gs-card p-8 text-center" data-testid="sectors-error">
          <p className="text-sm text-gs-textMuted">{error}</p>
        </div>
      )}

      {!loading && !error && rotation.length === 0 && (
        <div className="gs-card p-8 text-center" data-testid="sectors-empty">
          <p className="text-sm text-gs-textMuted">No sector data is currently available.</p>
        </div>
      )}

      {!loading && !error && rotation.length > 0 && (
        <>
          <div className="grid grid-cols-12 gap-4">
            {/* Rotation chart */}
            <div className="col-span-12 xl:col-span-8">
              <div className="gs-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <h3 className="font-display font-bold text-gs-text">Sector Rotation (Relative Strength)</h3>
                    <MethodologyTooltip />
                  </div>
                </div>
                <div className="w-full" style={{ minHeight: 360 }}>
                  <SectorRotationRRG />
                </div>
              </div>
            </div>

            {/* Sector list */}
            <div className="col-span-12 xl:col-span-4 space-y-2">
              <div className="gs-label mb-2">Sectors (by rank)</div>
              {sortedRotation.map((s) => {
                const isActive = s.sector === active?.sector;
                const insufficient = s.status !== 'OK';
                const isPos = Number(s.relativeMomentum) >= 0;
                return (
                  <button
                    key={s.sector}
                    onClick={() => setActiveSector(s.sector)}
                    className={`w-full text-left gs-card p-4 transition-colors ${
                      isActive ? "border-l-2 border-l-gs-gold bg-gs-cardHover" : "hover:bg-gs-cardHover"
                    }`}
                    data-testid={`sector-${s.sector}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[10px] text-gs-textDim">
                            {s.rank ? `#${s.rank}` : '—'}
                          </span>
                          <span className="font-display font-bold text-[14px] text-gs-text truncate">
                            {s.sector}
                          </span>
                        </div>
                        {insufficient ? (
                          <div className="flex items-center gap-1 text-[11px] text-gs-gold mt-0.5">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            <span>Insufficient coverage ({s.constituentCount}/{s.requestedConstituentCount})</span>
                          </div>
                        ) : (
                          <div className={`inline-block mt-0.5 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${QUADRANT_STYLE[s.quadrant] || ''}`}>
                            {s.quadrant}
                          </div>
                        )}
                      </div>
                      {!insufficient && (
                        <div className={`font-mono text-sm tabular-nums flex items-center gap-1 shrink-0 ${isPos ? "text-gs-pos" : "text-gs-neg"}`}>
                          {isPos ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                          {isPos ? "+" : ""}
                          {(s.relativeMomentum * 100).toFixed(2)}%
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active sector deep-dive */}
          {active && (
            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-12 lg:col-span-8 space-y-4">
                <div className="gs-card p-5 border-l-2 border-l-gs-gold">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
                      Sector Rotation Summary
                    </span>
                    <MethodologyTooltip />
                  </div>
                  <h2 className="font-display text-xl font-bold text-gs-text mb-2">
                    {active.sector}
                  </h2>

                  {active.status !== 'OK' ? (
                    <div className="flex items-start gap-2 text-[13px] text-gs-gold bg-gs-gold/10 border border-gs-gold/30 rounded-sm p-3">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        This sector does not currently have enough constituent coverage or aligned trading history for a
                        reliable relative-strength reading ({active.constituentCount}/{active.requestedConstituentCount} constituents
                        with data). No relative strength, momentum, or rank is shown — a fallback/neutral value would be misleading.
                      </span>
                    </div>
                  ) : (
                    <p className="text-[13px] text-gs-textMuted leading-relaxed">
                      {active.sector} is in the <span className="font-semibold text-gs-text">{active.quadrant}</span> quadrant vs
                      Nifty 50, with a relative-strength ratio of <span className="font-mono text-gs-text">{active.relativeStrength.toFixed(3)}</span> and
                      a relative momentum of <span className="font-mono text-gs-text">{(active.relativeMomentum * 100).toFixed(2)}%</span> per
                      period, based on {active.constituentCount}/{active.requestedConstituentCount} constituents
                      ({Math.round((active.coveragePct || 0) * 100)}% coverage) over {active.period?.observations ?? '—'} aligned
                      trading days ({active.period?.from} to {active.period?.to}).
                    </p>
                  )}

                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <div className="gs-label">Rank</div>
                      <div className="font-mono text-sm text-gs-text mt-1">{active.rank ? `#${active.rank}` : 'Unranked'}</div>
                    </div>
                    <div>
                      <div className="gs-label">Coverage</div>
                      <div className="font-mono text-sm text-gs-text mt-1">
                        {active.constituentCount}/{active.requestedConstituentCount} ({Math.round((active.coveragePct || 0) * 100)}%)
                      </div>
                    </div>
                    <div>
                      <div className="gs-label">Source</div>
                      <div className="font-mono text-sm text-gs-text mt-1">{active.source}</div>
                    </div>
                    <div>
                      <div className="gs-label">Methodology</div>
                      <div className="font-mono text-sm text-gs-text mt-1">{active.methodologyVersion}</div>
                    </div>
                  </div>
                </div>

                <StockTable rows={sectorStocks} title={`${active.sector} · Constituents`} showSector={false} />
              </div>

              <div className="col-span-12 lg:col-span-4">
                <div className="gs-card p-5">
                  <h3 className="font-display font-bold text-gs-text mb-3">Analytics Detail</h3>
                  <div className="space-y-3">
                    {[
                      ["Relative Strength Ratio", active.status === 'OK' ? active.relativeStrength.toFixed(4) : 'Unavailable'],
                      ["Relative Momentum", active.status === 'OK' ? `${(active.relativeMomentum * 100).toFixed(2)}%/period` : 'Unavailable'],
                      ["Quadrant", active.status === 'OK' ? active.quadrant : 'Unavailable'],
                      ["Aligned Trading Days", active.period?.observations ?? 'Unavailable'],
                      ["As Of", formatAsOf(active.asOf)],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between py-2 border-b border-gs-border last:border-b-0">
                        <span className="text-[12.5px] text-gs-textMuted">{k}</span>
                        <span className="font-mono text-[12.5px] text-gs-text tabular-nums text-right">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
