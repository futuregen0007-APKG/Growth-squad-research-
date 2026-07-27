import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

const CandlestickChart = ({ data, isPositive }) => {
  // Transform simple price series into candlestick format
  const candlestickData = data.map((point, index) => {
    const prevPoint = index > 0 ? data[index - 1] : point;
    const open = prevPoint.v;
    const close = point.v;
    const high = Math.max(open, close) + (Math.random() * 5);
    const low = Math.min(open, close) - (Math.random() * 5);
    
    return {
      x: point.x,
      open,
      high,
      low,
      close,
    };
  });

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const data = payload[0].payload;
    const isGreen = data.close >= data.open;
    
    return (
      <div className="bg-gs-card border border-gs-border rounded-sm px-3 py-2 shadow-lg">
        <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim mb-1">
          Tick {data.x}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px]">
          <span className="text-gs-textDim">Open:</span>
          <span className="text-gs-text">{data.open.toFixed(2)}</span>
          <span className="text-gs-textDim">High:</span>
          <span className="text-gs-pos">{data.high.toFixed(2)}</span>
          <span className="text-gs-textDim">Low:</span>
          <span className="text-gs-neg">{data.low.toFixed(2)}</span>
          <span className="text-gs-textDim">Close:</span>
          <span className={isGreen ? "text-gs-pos" : "text-gs-neg"}>{data.close.toFixed(2)}</span>
        </div>
      </div>
    );
  };

  const CandlestickBody = (props) => {
    const { x, y, width, height, payload } = props;
    const isGreen = payload.close >= payload.open;
    const color = isGreen ? '#059669' : '#DC2626';
    
    // Calculate wick position
    const bodyTop = Math.min(y, y + height);
    const bodyHeight = Math.abs(height);
    const wickTop = payload.high ? bodyTop - (payload.high - Math.max(payload.open, payload.close)) * 10 : bodyTop;
    const wickBottom = payload.low ? bodyTop + bodyHeight + (Math.min(payload.open, payload.close) - payload.low) * 10 : bodyTop + bodyHeight;
    
    return (
      <g>
        {/* Upper wick */}
        <line
          x1={x + width / 2}
          y1={bodyTop}
          x2={x + width / 2}
          y2={wickTop}
          stroke={color}
          strokeWidth={1}
        />
        {/* Body */}
        <rect
          x={x}
          y={bodyTop}
          width={width}
          height={bodyHeight}
          fill={color}
          opacity={0.8}
        />
        {/* Lower wick */}
        <line
          x1={x + width / 2}
          y1={bodyTop + bodyHeight}
          x2={x + width / 2}
          y2={wickBottom}
          stroke={color}
          strokeWidth={1}
        />
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={candlestickData} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#1E222A" strokeDasharray="2 4" />
        <XAxis
          dataKey="x"
          stroke="#475569"
          tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
          tickLine={false}
          axisLine={{ stroke: "#1E222A" }}
        />
        <YAxis
          stroke="#475569"
          tick={{ fontSize: 10, fontFamily: "JetBrains Mono" }}
          tickLine={false}
          axisLine={{ stroke: "#1E222A" }}
          domain={["dataMin - 10", "dataMax + 10"]}
          width={60}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: "#D4AF37", strokeDasharray: "3 3" }} />
        <Bar
          dataKey="close"
          shape={<CandlestickBody />}
          barSize={8}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

export default CandlestickChart;
