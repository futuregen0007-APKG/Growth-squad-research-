import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';

export default function SectorRotationRRG({ apiPath = 'http://localhost:5001/api/sector-rotation' }) {
  const svgRef = useRef(null);
  const [data, setData] = useState([]);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch(apiPath)
      .then((r) => r.json())
      .then((j) => {
        if (!mounted) return;
        const pts = j.data || [];
        console.debug('SectorRotationRRG fetched', pts);
        setData(pts);
      })
      .catch((err) => {
        console.error('SectorRotationRRG fetch error', err);
        setData([]);
      });
    return () => (mounted = false);
  }, [apiPath]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const width = svgRef.current.clientWidth || 720;
    const height = Math.max(320, width * 0.6);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    svg.selectAll('*').remove();

    // background
    svg.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', height).attr('rx', 8).attr('fill', '#071021');

    const padding = 48;

    // flatten points to compute domain
    const allPoints = data.flatMap((s) => (s.series || []).map((p) => ({ x: p.x, y: p.y, id: s.id })));
    const xExtent = d3.extent(allPoints, (d) => d.x);
    const yExtent = d3.extent(allPoints, (d) => d.y);
    const xDomain = [Math.min(-0.15, xExtent[0] ?? -0.1), Math.max(0.15, xExtent[1] ?? 0.1)];
    const yDomain = [Math.min(-0.15, yExtent[0] ?? -0.1), Math.max(0.15, yExtent[1] ?? 0.1)];

    const xScale = d3.scaleLinear().domain(xDomain).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain(yDomain).range([height - padding, padding]);

    // quadrant shading
    svg.append('rect').attr('x', xScale(0)).attr('y', padding).attr('width', width - padding - xScale(0)).attr('height', yScale(0) - padding).attr('fill', 'rgba(17, 185, 129, 0.06)');
    svg.append('rect').attr('x', padding).attr('y', padding).attr('width', xScale(0) - padding).attr('height', yScale(0) - padding).attr('fill', 'rgba(249, 115, 22, 0.04)');
    svg.append('rect').attr('x', padding).attr('y', yScale(0)).attr('width', xScale(0) - padding).attr('height', height - padding - yScale(0)).attr('fill', 'rgba(248, 113, 113, 0.03)');
    svg.append('rect').attr('x', xScale(0)).attr('y', yScale(0)).attr('width', width - padding - xScale(0)).attr('height', height - padding - yScale(0)).attr('fill', 'rgba(59, 130, 246, 0.03)');

    // axis lines
    svg.append('line').attr('x1', xScale(0)).attr('y1', padding).attr('x2', xScale(0)).attr('y2', height - padding).attr('stroke', '#3b4253').attr('stroke-width', 1);
    svg.append('line').attr('x1', padding).attr('y1', yScale(0)).attr('x2', width - padding).attr('y2', yScale(0)).attr('stroke', '#3b4253').attr('stroke-width', 1);

    // labels
    svg.append('text').attr('x', width - padding).attr('y', padding + 12).attr('text-anchor', 'end').attr('fill', '#9ff3d8').attr('font-size', 12).text('Leading');
    svg.append('text').attr('x', padding).attr('y', height - padding - 6).attr('text-anchor', 'start').attr('fill', '#ffb4b4').attr('font-size', 12).text('Lagging');

    // tooltip
    const tooltip = d3.select('body').selectAll('.rrg-tooltip').data([0]).join('div').attr('class', 'rrg-tooltip').style('position', 'absolute').style('pointer-events', 'none').style('background', '#0b1220').style('color', '#e6eef0').style('padding', '8px').style('border-radius', '6px').style('font-size', '12px').style('display', 'none').style('box-shadow', '0 4px 18px rgba(2,6,23,0.6)');

    // draw tails and points
    const group = svg.append('g');
    data.forEach((s, si) => {
      const series = (s.series || []).filter((p) => p && !isNaN(p.x) && !isNaN(p.y));
      if (series.length === 0) return;
      const lineGen = d3.line().x((d) => xScale(d.x)).y((d) => yScale(d.y)).curve(d3.curveMonotoneX);

      // faded tail with gradient opacity
      const tailPath = group.append('path').attr('d', lineGen(series)).attr('fill', 'none').attr('stroke', '#65a30d').attr('stroke-width', 2).attr('stroke-opacity', 0.9);

      // arrow: draw line from prev -> last
      const last = series[series.length - 1];
      const prev = series[series.length - 2] || last;
      group.append('line').attr('x1', xScale(prev.x)).attr('y1', yScale(prev.y)).attr('x2', xScale(last.x)).attr('y2', yScale(last.y)).attr('stroke', '#60a5fa').attr('stroke-width', 2).attr('marker-end', `url(#arrow-${si})`);

      // marker defs
      svg.append('defs').append('marker').attr('id', `arrow-${si}`).attr('markerWidth', 8).attr('markerHeight', 8).attr('refX', 6).attr('refY', 3).attr('orient', 'auto').append('path').attr('d', 'M0,0 L0,6 L6,3 z').attr('fill', '#60a5fa');

      // current circle
      group.append('circle').attr('cx', xScale(last.x)).attr('cy', yScale(last.y)).attr('r', Math.max(6, Math.min(12, (s.weight || 5) / 5))).attr('fill', '#34d399').attr('stroke', '#022026').attr('stroke-width', 1.5).on('mousemove', (event) => {
        tooltip.style('display', 'block').style('left', `${event.pageX + 12}px`).style('top', `${event.pageY + 12}px`).html(`<strong>${s.name}</strong><br/>x: ${(last.x * 100).toFixed(2)}%<br/>y: ${(last.y * 100).toFixed(2)}%<br/>leaders: ${s.leaders?.slice(0,3).join(', ')}`);
      }).on('mouseout', () => tooltip.style('display', 'none'));

      // label
      group.append('text').attr('x', xScale(last.x) + 10).attr('y', yScale(last.y) + 4).attr('fill', '#e6eef0').attr('font-size', 11).text(s.name);
    });

  }, [data]);

  return (
    <div className="w-full">
      <div style={{ width: '100%' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      </div>
      <div className="mt-2 text-xs text-gs-textDim">RRG (JdK-style): X = RS-Ratio (smoothed, 0 = parity), Y = RS-Momentum.</div>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => setShowRaw(!showRaw)} className="text-xs text-gs-accent font-medium">{showRaw ? 'Hide' : 'Show'} raw data</button>
      </div>
      {showRaw && (
        <div className="mt-2 bg-gs-panel border border-gs-border p-2 rounded overflow-auto max-h-40 text-xs font-mono text-gs-text">
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
