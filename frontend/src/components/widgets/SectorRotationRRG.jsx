import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import API_BASE from '@/config/api';

const QUADRANT_COLOR = {
  Leading: '#34d399',
  Improving: '#60a5fa',
  Weakening: '#f97316',
  Lagging: '#f87171',
};

// Scatter/quadrant plot of real, normalized relative-strength values — one
// point per sector with sufficient data. Unlike the previous RRG "tail"
// chart, this never plots a fabricated historical path: the backend's
// analytics endpoint returns one current (relativeStrength, relativeMomentum)
// snapshot per sector, so that's exactly what gets drawn. Sectors flagged
// INSUFFICIENT_DATA are listed, never plotted at a made-up coordinate.
export default function SectorRotationRRG({ apiPath = `${API_BASE}/api/sector-rotation` }) {
  const svgRef = useRef(null);
  const [sectors, setSectors] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ok | error

  useEffect(() => {
    let mounted = true;
    fetch(apiPath)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (!mounted) return;
        setSectors(Array.isArray(json.data) ? json.data : []);
        setStatus('ok');
      })
      .catch((err) => {
        console.error('SectorRotationRRG fetch error', err);
        if (!mounted) return;
        setSectors([]);
        setStatus('error');
      });
    return () => { mounted = false; };
  }, [apiPath]);

  const plottable = sectors.filter((s) => s.status === 'OK' && Number.isFinite(s.relativeStrength) && Number.isFinite(s.relativeMomentum));
  const insufficient = sectors.filter((s) => s.status === 'INSUFFICIENT_DATA');

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const width = svgRef.current.clientWidth || 720;
    const height = Math.max(320, width * 0.55);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    svg.selectAll('*').remove();

    svg.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', height).attr('rx', 8).attr('fill', '#071021');

    if (!plottable.length) return;

    const padding = 48;
    const rsValues = plottable.map((s) => s.relativeStrength);
    const momValues = plottable.map((s) => s.relativeMomentum);
    const rsSpread = Math.max(0.05, d3.max(rsValues.map((v) => Math.abs(v - 1))) || 0.05);
    const momSpread = Math.max(0.02, d3.max(momValues.map((v) => Math.abs(v))) || 0.02);

    const xScale = d3.scaleLinear().domain([1 - rsSpread * 1.2, 1 + rsSpread * 1.2]).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain([-momSpread * 1.2, momSpread * 1.2]).range([height - padding, padding]);

    // quadrant shading, split at RS=1 / momentum=0 (parity with the benchmark)
    svg.append('rect').attr('x', xScale(1)).attr('y', padding).attr('width', width - padding - xScale(1)).attr('height', yScale(0) - padding).attr('fill', 'rgba(52, 211, 153, 0.08)');
    svg.append('rect').attr('x', padding).attr('y', padding).attr('width', xScale(1) - padding).attr('height', yScale(0) - padding).attr('fill', 'rgba(96, 165, 250, 0.06)');
    svg.append('rect').attr('x', padding).attr('y', yScale(0)).attr('width', xScale(1) - padding).attr('height', height - padding - yScale(0)).attr('fill', 'rgba(248, 113, 113, 0.05)');
    svg.append('rect').attr('x', xScale(1)).attr('y', yScale(0)).attr('width', width - padding - xScale(1)).attr('height', height - padding - yScale(0)).attr('fill', 'rgba(249, 115, 22, 0.05)');

    svg.append('line').attr('x1', xScale(1)).attr('y1', padding).attr('x2', xScale(1)).attr('y2', height - padding).attr('stroke', '#3b4253').attr('stroke-width', 1);
    svg.append('line').attr('x1', padding).attr('y1', yScale(0)).attr('x2', width - padding).attr('y2', yScale(0)).attr('stroke', '#3b4253').attr('stroke-width', 1);

    svg.append('text').attr('x', width - padding).attr('y', padding + 14).attr('text-anchor', 'end').attr('fill', '#9ff3d8').attr('font-size', 11).text('Leading');
    svg.append('text').attr('x', padding).attr('y', padding + 14).attr('text-anchor', 'start').attr('fill', '#93c5fd').attr('font-size', 11).text('Improving');
    svg.append('text').attr('x', padding).attr('y', height - padding - 8).attr('text-anchor', 'start').attr('fill', '#fca5a5').attr('font-size', 11).text('Lagging');
    svg.append('text').attr('x', width - padding).attr('y', height - padding - 8).attr('text-anchor', 'end').attr('fill', '#fdba74').attr('font-size', 11).text('Weakening');

    const tooltip = d3.select('body').selectAll('.rrg-tooltip').data([0]).join('div').attr('class', 'rrg-tooltip').style('position', 'absolute').style('pointer-events', 'none').style('background', '#0b1220').style('color', '#e6eef0').style('padding', '8px').style('border-radius', '6px').style('font-size', '12px').style('display', 'none').style('box-shadow', '0 4px 18px rgba(2,6,23,0.6)').style('z-index', 50);

    const group = svg.append('g');
    plottable.forEach((s) => {
      const cx = xScale(s.relativeStrength);
      const cy = yScale(s.relativeMomentum);
      const radius = 5 + Math.min(6, (s.coveragePct || 0) * 6);
      group.append('circle')
        .attr('cx', cx).attr('cy', cy).attr('r', radius)
        .attr('fill', QUADRANT_COLOR[s.quadrant] || '#94a3b8')
        .attr('stroke', '#022026').attr('stroke-width', 1.2)
        .style('cursor', 'pointer')
        .on('mousemove', (event) => {
          tooltip.style('display', 'block').style('left', `${event.pageX + 12}px`).style('top', `${event.pageY + 12}px`).html(
            `<strong>${s.sector}</strong> · rank ${s.rank ?? '—'}<br/>` +
            `RS ratio: ${s.relativeStrength.toFixed(3)}<br/>` +
            `Momentum: ${(s.relativeMomentum * 100).toFixed(2)}%/period<br/>` +
            `Quadrant: ${s.quadrant}<br/>` +
            `Coverage: ${s.constituentCount}/${s.requestedConstituentCount} (${Math.round((s.coveragePct || 0) * 100)}%)`,
          );
        })
        .on('mouseout', () => tooltip.style('display', 'none'));

      group.append('text').attr('x', cx + radius + 4).attr('y', cy + 3).attr('fill', '#e6eef0').attr('font-size', 10).text(s.sector);
    });
  }, [plottable]);

  return (
    <div className="w-full">
      {status === 'loading' && <div className="text-xs text-gs-textDim p-4">Loading sector rotation…</div>}
      {status === 'error' && <div className="text-xs text-gs-neg p-4">Sector rotation data is currently unavailable.</div>}
      {status === 'ok' && !plottable.length && (
        <div className="text-xs text-gs-textDim p-4">No sector currently has sufficient data for a reliable relative-strength reading.</div>
      )}
      <div style={{ width: '100%', display: status === 'ok' && plottable.length ? 'block' : 'none' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      </div>
      {status === 'ok' && plottable.length > 0 && (
        <div className="mt-2 text-xs text-gs-textDim">
          X = relative-strength ratio vs Nifty 50 (1.0 = parity, normalized constituent index). Y = trailing rate of change of that ratio. Point size reflects constituent coverage.
        </div>
      )}
      {insufficient.length > 0 && (
        <div className="mt-2 text-[11px] text-gs-textDim">
          Excluded (insufficient data): {insufficient.map((s) => s.sector).join(', ')}
        </div>
      )}
    </div>
  );
}
