import { useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { ChevronDown, ChevronUp } from "lucide-react";
import { isSafeBlockUrl, firstEvidenceRef } from "./blockHelpers";
import CitationMarker from "./CitationMarker";

/**
 * ChartBlock - UI Phase 1C.3. A bounded historical daily-close line chart
 * for a single symbol, backed by ONE resolved evidence reference (the
 * whole series is one claim — see services/responseBlocks.js's
 * buildChartBlock note). Mirrors CandlestickChart.jsx's existing recharts
 * conventions (colors, fonts, ResponsiveContainer sizing) — this is a line
 * chart, deliberately not a second candlestick implementation.
 *
 * Never invents a point, never smooths over a known gap: `type="linear"`
 * (no curve interpolation that could imply a value between two real
 * points) and a KNOWN gap (services/responseBlocks.js only ever sets
 * gapBefore when a row was excluded, never guessed) is rendered as a
 * genuine break in the line — see `segments` below — not a straight line
 * connecting across it.
 */
const PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isValidChartBlock = (block) => Boolean(
  block && block.type === 'chart' && typeof block.symbol === 'string'
  && Array.isArray(block.points) && block.points.length >= 2
  && block.points.every((p) => PATTERN.test(p?.date) && Number.isFinite(p?.close)),
);

/** Compact axis tick — "01 Mar"; the full year still appears in the tooltip/table so nothing is actually hidden. */
const formatAxisDate = (iso) => {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
};

/** Full display date — "01 Mar 2026", used in the tooltip and the data table. */
const formatFullDate = (iso) => {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
};

// UI Phase 1D audit: NOT_REQUIRED does NOT mean "verified free of any
// corporate action" — it means the backend's discontinuity check
// (backend/services/StockHistoricalMetricsService.js's detectDiscontinuities,
// a >=20% single-day close-to-close move) found nothing to flag for every
// consecutive pair of rows in this series. These are the raw, as-traded
// closes: no retroactive split/bonus rescaling has been applied to make
// historical prices continuous across a real corporate action, because
// this project has no corporate-action feed to drive that rescaling yet
// (same service's own module note). The label says exactly that — "not
// adjusted for corporate actions" — never "verified clean" or any implied
// performance/return claim, which this block does not compute at all.
const PRICE_BASIS_LABEL = {
  NOT_REQUIRED: 'not adjusted for corporate actions',
  ADJUSTED: 'adjusted for corporate actions',
  UNVERIFIED: 'unverified basis',
};

const ChartTooltip = ({ active, payload, currency }) => {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="bg-gs-card border border-gs-border rounded-sm px-3 py-2 shadow-lg">
      <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim mb-1">{formatFullDate(point.date)}</div>
      <div className="font-mono text-[12px] text-gs-text">{currency === 'INR' ? '₹' : `${currency} `}{point.close.toFixed(2)}</div>
    </div>
  );
};

/** Splits points into contiguous runs at every gapBefore boundary -- one <Line> per run, so the chart never draws a straight line across a known gap. */
const buildSegments = (points) => {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point.gapBefore && current.length) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
};

export default function ChartBlock({ block, onOpenEvidence }) {
  const [showTable, setShowTable] = useState(false);
  if (!isValidChartBlock(block)) return null;

  const segments = buildSegments(block.points);
  const gapCount = segments.length - 1;
  const ref = firstEvidenceRef(block.evidence);
  const sourceUrl = block.sourceUrl && isSafeBlockUrl(block.sourceUrl) ? block.sourceUrl : null;

  // Honest "requested vs available" framing (Phase 1C.3 item 8) -- only
  // shown when a range was actually named AND the real data doesn't
  // already cover it; otherwise silent, since restating an already-met
  // request adds nothing.
  const requestedButNarrower = Number.isInteger(block.requestedRangeDays)
    && (() => {
      const spanDays = (new Date(`${block.rangeEnd}T00:00:00Z`) - new Date(`${block.rangeStart}T00:00:00Z`)) / 86400000;
      return spanDays < block.requestedRangeDays - 3; // a few days' slack for weekends/holidays around the edges
    })();

  return (
    <div className="gs-card p-3 my-2" data-testid="block-chart">
      <div className="flex items-center justify-between mb-1.5">
        <div className="gs-label">
          {block.symbol} — price history
          <CitationMarker citationIndex={ref?.citationIndex} evidenceId={ref?.evidenceId} onOpenEvidence={onOpenEvidence} />
        </div>
      </div>
      <div className="text-[10.5px] text-gs-textDim mb-2 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>{formatFullDate(block.rangeStart)} – {formatFullDate(block.rangeEnd)}</span>
        {/* UI Phase 1D: the point count is stated explicitly and separately
            from the calendar range -- a 90-calendar-day window naturally
            holds ~63 TRADING-day closes (weekends/holidays have no row at
            all), which is not a data gap and should not read as one. */}
        <span>{block.points.length} trading-day close{block.points.length !== 1 ? 's' : ''}</span>
        <span>{PRICE_BASIS_LABEL[block.priceBasis] || block.priceBasis}</span>
        {block.dataAsOf && <span>data as of {formatFullDate(String(block.dataAsOf).slice(0, 10))}</span>}
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-gs-gold hover:underline">
            {block.provider || 'source'} ↗
          </a>
        )}
      </div>
      {requestedButNarrower && (
        <div className="text-[10.5px] text-gs-gold mb-2" data-testid="chart-range-note">
          Showing the available history — not the full requested range.
        </div>
      )}
      {gapCount > 0 && (
        <div className="text-[10.5px] text-gs-textDim mb-2" data-testid="chart-gap-note">
          {gapCount} data gap{gapCount !== 1 ? 's' : ''} in this range (dates with no verified, single-basis price are not shown as a connected line).
        </div>
      )}

      <div className="h-[180px]" role="img" aria-label={`Line chart of ${block.symbol}'s closing price from ${block.rangeStart} to ${block.rangeEnd}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={block.points} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" />
            <XAxis
              dataKey="date"
              tickFormatter={formatAxisDate}
              stroke="#475569"
              tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
              tickLine={false}
              axisLine={{ stroke: "#1E222A" }}
              minTickGap={30}
            />
            <YAxis
              stroke="#475569"
              tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
              tickLine={false}
              axisLine={{ stroke: "#1E222A" }}
              domain={["auto", "auto"]}
              width={56}
              label={{ value: `Price (${block.currency})`, angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: '#475569' } }}
            />
            <Tooltip content={<ChartTooltip currency={block.currency} />} cursor={{ stroke: "#D4AF37", strokeDasharray: "3 3" }} />
            {segments.map((segment, index) => (
              <Line
                key={`segment-${index}`}
                data={segment}
                dataKey="close"
                type="linear"
                stroke="#D4AF37"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Compact accessible alternative to the visual chart -- same data, a real <table> a screen reader (or anyone who can't parse an SVG chart) can read directly. */}
      <button
        onClick={() => setShowTable((v) => !v)}
        className="mt-2 flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text"
        data-testid="chart-table-toggle"
        aria-expanded={showTable}
      >
        {showTable ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {showTable ? 'Hide' : 'Show'} data table
      </button>
      {showTable && (
        <div className="mt-1.5 max-h-40 overflow-y-auto" data-testid="chart-data-table">
          <table className="w-full text-[11px] border-collapse">
            <caption className="sr-only">{block.symbol} daily closing price, {formatFullDate(block.rangeStart)} to {formatFullDate(block.rangeEnd)}</caption>
            <thead className="border-b border-gs-border sticky top-0 bg-gs-card">
              <tr>
                <th scope="col" className="text-left px-2 py-1 gs-label">Date</th>
                <th scope="col" className="text-right px-2 py-1 gs-label">Close ({block.currency})</th>
              </tr>
            </thead>
            <tbody>
              {block.points.map((point) => (
                <tr key={point.date} className="border-b border-gs-border/50">
                  <td className="px-2 py-1 text-gs-text">{formatFullDate(point.date)}{point.gapBefore && <span className="text-gs-textDim"> (after a gap)</span>}</td>
                  <td className="px-2 py-1 text-right text-gs-text font-mono">{point.close.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
