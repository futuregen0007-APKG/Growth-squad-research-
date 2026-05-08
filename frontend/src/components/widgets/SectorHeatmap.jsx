import { ResponsiveContainer, Treemap } from "recharts";

const colorFor = (changePct) => {
  if (changePct >= 3) return "#047857";
  if (changePct >= 1.5) return "#059669";
  if (changePct >= 0.3) return "#10b981";
  if (changePct > -0.3) return "#475569";
  if (changePct > -1.5) return "#dc2626";
  return "#991b1b";
};

const HeatCell = (props) => {
  const { x, y, width, height, name, changePct, depth } = props;
  if (!width || !height || depth === 0 || changePct === undefined || changePct === null)
    return null;
  const fill = colorFor(changePct);
  const showLabel = width > 70 && height > 38;
  const isPos = changePct >= 0;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill}
        stroke="#060709"
        strokeWidth={2}
        opacity={0.92}
      />
      {showLabel && (
        <>
          <text
            x={x + 10}
            y={y + 22}
            fill="#ffffff"
            fontFamily="'IBM Plex Sans', system-ui, sans-serif"
            fontSize={13}
            fontWeight={700}
            style={{ paintOrder: "stroke" }}
          >
            {name}
          </text>
          <text
            x={x + 10}
            y={y + 40}
            fill="#ffffff"
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
            fontSize={11}
            opacity={0.92}
          >
            {`${isPos ? "+" : ""}${changePct.toFixed(2)}%`}
          </text>
        </>
      )}
    </g>
  );
};

export default function SectorHeatmap({ data, height = 280 }) {
  return (
    <div style={{ width: "100%", height }} data-testid="sector-heatmap">
      <ResponsiveContainer>
        <Treemap
          data={data}
          dataKey="size"
          stroke="#060709"
          isAnimationActive={false}
          content={<HeatCell />}
        />
      </ResponsiveContainer>
    </div>
  );
}
